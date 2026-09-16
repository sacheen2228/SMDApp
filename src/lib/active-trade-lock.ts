// ═══════════════════════════════════════════════════════════════════════════
// Active Trade Lock — ONE active trade per underlying, server-side enforced
// Uses in-memory cache for speed + DB for persistence across restarts
// Atomic acquisition prevents race conditions between simultaneous requests
// ═══════════════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

// ─── Types ───────────────────────────────────────────────────────

export type LockStatus =
  | 'FREE'
  | 'LOCKED'
  | 'RELEASING';

export type TradeTerminalState =
  | 'TP2_HIT'
  | 'SL_HIT'
  | 'EXIT'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'WIN'
  | 'LOSS'
  | 'BREAKEVEN';

export type TradeActiveState =
  | 'PENDING'
  | 'ACTIVE'
  | 'MONITORING'
  | 'TP1_HIT';

export interface ActiveTradeLock {
  tradeId: string;
  strategy: string;
  underlying: string;
  exchange: string;
  optionType: 'CE' | 'PE' | 'FUT' | 'EQ';
  strike: number;
  expiry: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  status: TradeActiveState;
  createdAt: string;
  lastCheckedAt?: string;
}

// ─── Terminal states that release the lock ────────────────────────
const TERMINAL_STATES = new Set<string>([
  'TP2_HIT', 'SL_HIT', 'EXIT', 'CANCELLED', 'EXPIRED',
  'WIN', 'LOSS', 'BREAKEVEN', 'CLOSED', 'OPEN',
]);

// ─── Active states that hold the lock ────────────────────────────
const ACTIVE_STATES = new Set<string>([
  'PENDING', 'ACTIVE', 'MONITORING', 'TP1_HIT',
]);

// ─── In-Memory Lock Cache (fast path) ────────────────────────────
// Key: `${underlying}:${exchange}`
const memLocks = new Map<string, ActiveTradeLock>();

// ─── Acquisition lock (prevents concurrent acquisition) ──────────
const acquiring = new Map<string, Promise<ActiveTradeLock | { blocked: true; activeTrade: ActiveTradeLock }>>();

// ─── Lock Key ────────────────────────────────────────────────────
function lockKey(underlying: string, exchange: string): string {
  return `${underlying}:${exchange}`;
}

// ─── Rebuild in-memory locks from DB (call on startup) ───────────
export async function restoreLocksFromDB(): Promise<void> {
  try {
    const activeTrades = await db.trade.findMany({
      where: {
        status: { in: ['OPEN', 'ACTIVE', 'PENDING', 'TP1_HIT'] },
      },
    });

    for (const trade of activeTrades) {
      const key = lockKey(trade.symbol, trade.exchange);
      if (!memLocks.has(key)) {
        memLocks.set(key, {
          tradeId: trade.tradeId,
          strategy: trade.strategy,
          underlying: trade.symbol,
          exchange: trade.exchange,
          optionType: (trade.type as any) ?? 'CE',
          strike: trade.strike,
          expiry: '',
          entry: trade.entryPrice,
          stopLoss: trade.stopLoss,
          target1: trade.target1 ?? 0,
          target2: trade.target2 ?? undefined,
          status: trade.status === 'TP1_HIT' ? 'TP1_HIT' : 'ACTIVE',
          createdAt: trade.entryTime?.toISOString() ?? trade.createdAt.toISOString(),
          lastCheckedAt: new Date().toISOString(),
        });
      }
    }
    console.log(`[ActiveTradeLock] Restored ${memLocks.size} locks from DB`);
  } catch (err: any) {
    console.error(`[ActiveTradeLock] Failed to restore from DB: ${err.message}`);
  }
}

// ─── Check if a trade is active (fast: in-memory) ────────────────
export function isTradeActive(underlying: string, exchange: string): ActiveTradeLock | null {
  const key = lockKey(underlying, exchange);
  const lock = memLocks.get(key);
  if (!lock) return null;
  if (ACTIVE_STATES.has(lock.status)) return lock;
  // Terminal state in cache — clean up
  memLocks.delete(key);
  return null;
}

// ─── Atomic acquire (prevents race conditions) ───────────────────
// Uses a per-underlying mutex to ensure only one acquisition at a time
export async function acquireTradeLock(trade: {
  tradeId: string;
  strategy: string;
  underlying: string;
  exchange: string;
  optionType: 'CE' | 'PE' | 'FUT' | 'EQ';
  strike: number;
  expiry: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2?: number;
}): Promise<ActiveTradeLock | { blocked: true; activeTrade: ActiveTradeLock }> {
  const key = lockKey(trade.underlying, trade.exchange);

  // Wait for any in-progress acquisition on the same underlying
  while (acquiring.has(key)) {
    await acquiring.get(key);
  }

  // Start acquisition
  const resultPromise = doAcquire(trade);
  acquiring.set(key, resultPromise);

  try {
    return await resultPromise;
  } finally {
    acquiring.delete(key);
  }
}

async function doAcquire(trade: {
  tradeId: string;
  strategy: string;
  underlying: string;
  exchange: string;
  optionType: 'CE' | 'PE' | 'FUT' | 'EQ';
  strike: number;
  expiry: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2?: number;
}): Promise<ActiveTradeLock | { blocked: true; activeTrade: ActiveTradeLock }> {
  const key = lockKey(trade.underlying, trade.exchange);

  // 1. Check in-memory cache first (fast path)
  const existingMem = memLocks.get(key);
  if (existingMem && ACTIVE_STATES.has(existingMem.status)) {
    return { blocked: true, activeTrade: existingMem };
  }

  // 2. Check DB (persistence path — catches restart cases)
  try {
    const dbTrade = await db.trade.findFirst({
      where: {
        symbol: trade.underlying,
        exchange: trade.exchange,
        status: { in: ['OPEN', 'ACTIVE', 'PENDING', 'TP1_HIT'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (dbTrade) {
      const lock: ActiveTradeLock = {
        tradeId: dbTrade.tradeId,
        strategy: dbTrade.strategy,
        underlying: dbTrade.symbol,
        exchange: dbTrade.exchange,
        optionType: (dbTrade.type as any) ?? 'CE',
        strike: dbTrade.strike,
        expiry: '',
        entry: dbTrade.entryPrice,
        stopLoss: dbTrade.stopLoss,
        target1: dbTrade.target1 ?? 0,
        target2: dbTrade.target2 ?? undefined,
        status: dbTrade.status === 'TP1_HIT' ? 'TP1_HIT' : 'ACTIVE',
        createdAt: dbTrade.entryTime?.toISOString() ?? dbTrade.createdAt.toISOString(),
        lastCheckedAt: new Date().toISOString(),
      };
      memLocks.set(key, lock);
      return { blocked: true, activeTrade: lock };
    }
  } catch {
    // DB check failed — fall through to in-memory only
  }

  // 3. No active trade — acquire lock
  const lock: ActiveTradeLock = {
    tradeId: trade.tradeId,
    strategy: trade.strategy,
    underlying: trade.underlying,
    exchange: trade.exchange,
    optionType: trade.optionType,
    strike: trade.strike,
    expiry: trade.expiry,
    entry: trade.entry,
    stopLoss: trade.stopLoss,
    target1: trade.target1,
    target2: trade.target2,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  };
  memLocks.set(key, lock);
  return lock;
}

// ─── Release lock (called by TradeMonitor on terminal events) ────
export function releaseTradeLock(underlying: string, exchange: string): void {
  const key = lockKey(underlying, exchange);
  memLocks.delete(key);
}

// ─── Update trade status (called by TradeMonitor) ───────────────
export function updateTradeStatus(
  tradeId: string,
  underlying: string,
  exchange: string,
  newStatus: string,
): ActiveTradeLock | null {
  const key = lockKey(underlying, exchange);
  const lock = memLocks.get(key);
  if (!lock || lock.tradeId !== tradeId) return null;

  if (ACTIVE_STATES.has(newStatus)) {
    lock.status = newStatus as TradeActiveState;
    lock.lastCheckedAt = new Date().toISOString();
    return lock;
  }

  if (TERMINAL_STATES.has(newStatus)) {
    memLocks.delete(key);
    return null;
  }

  return lock;
}

// ─── Get all active locks (for health/debug) ────────────────────
export function getActiveLocks(): Array<{
  underlying: string;
  exchange: string;
  status: 'ACTIVE' | 'FREE';
  tradeId?: string;
  entry?: number;
  sl?: number;
  t1?: number;
  t2?: number;
  lastCheckedAt?: string;
}> {
  const result: Array<{
    underlying: string;
    exchange: string;
    status: 'ACTIVE' | 'FREE';
    tradeId?: string;
    entry?: number;
    sl?: number;
    t1?: number;
    t2?: number;
    lastCheckedAt?: string;
  }> = [];

  const underlyings = [
    { u: 'NIFTY', e: 'NFO' },
    { u: 'BANKNIFTY', e: 'NFO' },
    { u: 'FINNIFTY', e: 'NFO' },
    { u: 'MIDCPNIFTY', e: 'NFO' },
    { u: 'SENSEX', e: 'BSE' },
    { u: 'BANKEX', e: 'BSE' },
  ];

  for (const { u, e } of underlyings) {
    const lock = isTradeActive(u, e);
    if (lock) {
      result.push({
        underlying: u,
        exchange: e,
        status: 'ACTIVE',
        tradeId: lock.tradeId,
        entry: lock.entry,
        sl: lock.stopLoss,
        t1: lock.target1,
        t2: lock.target2,
        lastCheckedAt: lock.lastCheckedAt,
      });
    } else {
      result.push({ underlying: u, exchange: e, status: 'FREE' });
    }
  }

  return result;
}

// ─── Force release (admin/debug) ─────────────────────────────────
export function forceRelease(underlying: string, exchange: string): boolean {
  const key = lockKey(underlying, exchange);
  const existed = memLocks.has(key);
  memLocks.delete(key);
  return existed;
}

// ─── Get lock status ─────────────────────────────────────────────
export function getLockStatus(underlying: string, exchange: string): {
  active: boolean;
  lock: ActiveTradeLock | null;
} {
  const lock = isTradeActive(underlying, exchange);
  return { active: lock !== null, lock };
}
