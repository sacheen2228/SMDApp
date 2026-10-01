// lib/activeTradeTracker.ts
//
// Tracks active trades in memory, monitors SL/TP hits, and notifies Telegram.
// Persists all trades to SQLite via tradeStore for reporting and export.
// The intraday scanner checks this before generating new trades.
// When SL is hit the trade is closed and the next scan can pick a new setup.
// SAFETY: Integrates with active-trade-lock for one-trade-per-underlying.
//
// EVENT FLOW (fixed):
//   Live LTP (tiger-monitor) → checkSLTP/monitorTick → updateTradeStatus
//   → DB status + lock update/release → telegram-alerts (flags + retry)
//   → telegram.ts → delivery audit (alert history + flags JSON)

import { createTrade, updateTrade } from "./tradeStore";
import { recordSignal, closeTrade, updatePrice } from "./trade-audit-client";
import { computeEodClose, holdingMinutes } from "./eod-squareoff";
import { istSession } from "./audit-recorders";
import { acquireTradeLock, releaseTradeLock, updateTradeStatus as updateLockStatus, isTradeActive } from "./active-trade-lock";
import * as fs from "fs";
import * as path from "path";

export interface ActiveTrade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  instrument: string;
  strike: number;
  optionType: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3?: number;
  status: 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT';
  sentAt: string;
  tp1HitAt?: string;
  tp2HitAt?: string;
  slHitAt?: string;
  source: string;
  snapshotId?: string;
  spotPrice?: number;
  confidence?: number;
  positionSize?: number;
  riskPerTrade?: number;
  qualityScore?: number;
  qualityGrade?: string;
  exchange?: string;
  // Expiry of the traded contract (YYYY-MM-DD). Passed to the audit sidecar so
  // backtests can pin the exact premium series — records with expiry=null must
  // fall back to entry-premium matching (option-bhavcopy.pickPremiumExpiry).
  expiry?: string;
  // Persistent TP/SL alert-delivery flags (true = Telegram alert delivered).
  // Survive restarts via data/tpsl-alert-flags.json — never re-send on boot.
  tp1AlertSent?: boolean;
  tp2AlertSent?: boolean;
  tp3AlertSent?: boolean;
  slAlertSent?: boolean;
}

const activeTrades = new Map<string, ActiveTrade>();

// ─── Persistent alert flags (restart safety) ─────────────────────
const ALERT_FLAGS_PATH = path.join(process.cwd(), "data", "tpsl-alert-flags.json");

function loadAlertFlagsFile(): Record<string, Partial<Record<'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT', boolean>>> {
  try {
    if (fs.existsSync(ALERT_FLAGS_PATH)) {
      return JSON.parse(fs.readFileSync(ALERT_FLAGS_PATH, "utf8"));
    }
  } catch { /* corrupted file — start fresh */ }
  return {};
}

function saveAlertFlagsFile(): void {
  try {
    // Start from what is already on disk (keeps terminal-trade flags)
    const out = loadAlertFlagsFile();
    for (const t of activeTrades.values()) {
      const flags: any = out[t.id] || {};
      if (t.tp1AlertSent) flags.TP1_HIT = true;
      if (t.tp2AlertSent) flags.TP2_HIT = true;
      if (t.tp3AlertSent) flags.TP3_HIT = true;
      if (t.slAlertSent) flags.SL_HIT = true;
      if (flags.TP1_HIT || flags.TP2_HIT || flags.TP3_HIT || flags.SL_HIT) {
        out[t.id] = flags;
      }
    }
    fs.mkdirSync(path.dirname(ALERT_FLAGS_PATH), { recursive: true });
    fs.writeFileSync(ALERT_FLAGS_PATH, JSON.stringify(out, null, 2));
  } catch { /* non-fatal */ }
}

/** Restore alert flags onto a trade (called on reload/restart). */
export function applyAlertFlags(trade: ActiveTrade): void {
  const flags = loadAlertFlagsFile()[trade.id];
  if (!flags) return;
  if (flags.TP1_HIT) trade.tp1AlertSent = true;
  if (flags.TP2_HIT) trade.tp2AlertSent = true;
  if (flags.TP3_HIT) trade.tp3AlertSent = true;
  if (flags.SL_HIT) trade.slAlertSent = true;
}

/** Mark a TP/SL alert as delivered for a trade + persist to disk. */
export function markTradeAlertSent(
  tradeId: string,
  alertType: 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT'
): void {
  const trade = activeTrades.get(tradeId);
  if (trade) {
    if (alertType === 'TP1_HIT') trade.tp1AlertSent = true;
    else if (alertType === 'TP2_HIT') trade.tp2AlertSent = true;
    else if (alertType === 'TP3_HIT') trade.tp3AlertSent = true;
    else if (alertType === 'SL_HIT') trade.slAlertSent = true;
    saveAlertFlagsFile();
  } else {
    // Trade already left memory (terminal) — still persist the delivery flag
    try {
      const onDisk = loadAlertFlagsFile();
      onDisk[tradeId] = onDisk[tradeId] || {};
      onDisk[tradeId][alertType] = true;
      fs.mkdirSync(path.dirname(ALERT_FLAGS_PATH), { recursive: true });
      fs.writeFileSync(ALERT_FLAGS_PATH, JSON.stringify(onDisk, null, 2));
    } catch { /* non-fatal */ }
  }
}

/** Read persisted/in-memory alert flag (for delivery dedup). */
export function getTradeAlertFlag(
  tradeId: string,
  alertType: 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT'
): boolean {
  const trade = activeTrades.get(tradeId);
  if (trade) {
    if (alertType === 'TP1_HIT') return !!trade.tp1AlertSent;
    if (alertType === 'TP2_HIT') return !!trade.tp2AlertSent;
    if (alertType === 'TP3_HIT') return !!trade.tp3AlertSent;
    if (alertType === 'SL_HIT') return !!trade.slAlertSent;
  }
  // Fall back to persisted flags (trade may have left memory after terminal)
  const flags = loadAlertFlagsFile()[tradeId];
  return !!(flags && flags[alertType]);
}

/** True when a status is terminal — monitoring must stop, lock releases. */
export function isTerminalTradeStatus(trade: ActiveTrade, status: ActiveTrade['status']): boolean {
  if (status === 'SL_HIT' || status === 'TP3_HIT') return true;
  if (status === 'TP2_HIT') return !(trade.tp3 && trade.tp3 > 0);
  if (status === 'TP1_HIT') {
    // SELL trades have a single target; BUY with no real TP2 ends at TP1.
    if (trade.side === 'SELL') return true;
    return !(trade.tp2 && trade.tp2 > 0 && trade.tp2 !== trade.tp1);
  }
  return false;
}

function getPnl(trade: ActiveTrade, hitPrice: number): number {
  if (trade.side === 'BUY') return hitPrice - trade.entry;
  return trade.entry - hitPrice;
}

function getPnlPct(trade: ActiveTrade, hitPrice: number): number {
  return trade.entry > 0 ? (getPnl(trade, hitPrice) / trade.entry) * 100 : 0;
}

function getHoldingMins(trade: ActiveTrade): number {
  const now = new Date().getTime();
  const start = new Date(trade.sentAt).getTime();
  return Math.round((now - start) / 60000);
}

export async function addTrade(trade: ActiveTrade, skipAlert = false): Promise<void> {
  // Restore any persisted alert flags (re-add after restart must not re-alert)
  applyAlertFlags(trade);

  // SAFETY: Acquire active trade lock before creating trade
  const lockResult = await acquireTradeLock({
    tradeId: trade.id,
    strategy: trade.source,
    underlying: trade.symbol,
    exchange: trade.exchange || 'NFO',
    optionType: (trade.optionType as 'CE' | 'PE' | 'FUT' | 'EQ') ?? 'CE',
    strike: trade.strike,
    expiry: trade.expiry || '',
    entry: trade.entry,
    stopLoss: trade.sl,
    target1: trade.tp1,
    target2: trade.tp2,
  });
  if ('blocked' in lockResult) {
    console.log(`[ActiveTrade] BLOCKED: ${trade.symbol} — active trade ${lockResult.activeTrade.tradeId} exists`);
    return;
  }

  activeTrades.set(trade.id, trade);

  // Training: record trade snapshot in background (non-blocking).
  // Skip test/synthetic trades — fake symbols (e2e IDs) would fire REAL
  // NSE/Breeze requests from collectMarketSnapshot (60+ provider calls
  // per test run). Same predicate as reloadActiveTrades.
  const snapshotEligible =
    !isTestSource(trade.source || "") && !/^(e2e|persist|chain|sell|prod)-/.test(trade.id);
  if (snapshotEligible) {
  try {
    const { collectMarketSnapshot, recordTrade } = await import("./training/trade-trainer");
    const instrumentType = (trade.optionType === "CE" || trade.optionType === "PE")
      ? trade.optionType as "CE" | "PE"
      : trade.optionType === "FUT" ? "FUT" : "EQ";

    collectMarketSnapshot(trade.symbol, trade.strike, trade.optionType)
      .then(snapshot => {
        recordTrade({
          id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          instrumentType,
          strike: trade.strike || undefined,
          entryPrice: trade.entry,
          sl: trade.sl,
          tp1: trade.tp1,
          tp2: trade.tp2,
          tp3: trade.tp3,
          source: trade.source,
          confidence: trade.confidence || 0,
          qualityScore: trade.qualityScore,
          qualityGrade: trade.qualityGrade,
          strategy: trade.source,
          snapshot,
          createdAt: trade.sentAt,
        });
        console.log(`[Training] Snapshot recorded for ${trade.symbol} (${trade.id})`);
      })
      .catch(() => { /* non-fatal */ });
  } catch { /* training module not available — non-fatal */ }
  }

  // TIGER alert: send Telegram notification for new trade (skip if caller already sent alert)
  if (!skipAlert) {
    try {
      const { alertNewTrade } = await import("./tiger-monitor");
      await alertNewTrade(trade);
    } catch { /* tiger-monitor offline — non-fatal */ }
  }

  // Persist to database (idempotent — trade-journal route upserts on tradeId).
  // Fire-and-forget: must never block the in-memory monitor loop (tests + prod).
  createTrade({
    tradeId: trade.id,
    symbol: trade.symbol,
    strike: trade.strike,
    type: trade.optionType,
    side: trade.side,
    entryPrice: trade.entry,
    stopLoss: trade.sl,
    target1: trade.tp1,
    target2: trade.tp2,
    target3: trade.tp3,
    confidence: trade.confidence ?? 0,
    strategy: trade.source,
    riskPerTrade: trade.riskPerTrade ?? 0,
    positionSize: trade.positionSize ?? 0,
    qualityScore: trade.qualityScore ?? 0,
    qualityGrade: trade.qualityGrade ?? "N/A",
  }).catch(() => { /* non-fatal */ });

  // Mirror the signal into the Trade Audit (backtest verification) engine so
  // every strategy — SDM, SMC, Zero Hero AI, BTST, Intraday — lives in the
  // same verification store. recordSignal is idempotent on tradeId.
  recordAuditSignal(trade).catch(() => { /* non-fatal */ });
}

function auditInstrumentType(trade: ActiveTrade): "EQUITY" | "OPTIONS" | "FUTURES" | "INDEX" {
  if (trade.optionType === "CE" || trade.optionType === "PE") return "OPTIONS";
  if ((trade.source || "").toLowerCase().includes("index")) return "INDEX";
  return "EQUITY";
}

function auditTrend(trade: ActiveTrade): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (trade.side === "BUY") return trade.optionType === "PE" ? "BEARISH" : "BULLISH";
  return "BEARISH";
}

/** Test sources must not pollute the audit sidecar (1,105 junk rows with
 * fake tickers already did — they drowned real trades in backtests and
 * skewed sidecar stats). Set AUDIT_RECORD_TEST_TRADES=1 when you're
 * deliberately verifying the recorder itself. */
const RECORD_TEST_SOURCES = process.env.AUDIT_RECORD_TEST_TRADES === "1";
function isTestSource(source: string): boolean {
  return source === "e2e-test" || source === "prod-verify";
}

/** Build + send a SignalInput to the audit engine for an ActiveTrade. */
async function recordAuditSignal(trade: ActiveTrade): Promise<void> {
  if (!RECORD_TEST_SOURCES && isTestSource(trade.source || "")) return;
  const isOption = trade.optionType === "CE" || trade.optionType === "PE";
  try {
    await recordSignal({
      tradeId: trade.id,
      strategyId: trade.source,
      strategyVersion: "1.0",
      symbol: trade.symbol,
      exchange: "NSE",
      instrumentType: auditInstrumentType(trade),
      spotPrice: trade.spotPrice ?? trade.entry,
      strikePrice: isOption ? trade.strike : null,
      optionType: isOption ? (trade.optionType as "CE" | "PE") : null,
      expiry: trade.expiry || null,
      entryPrice: trade.entry,
      stopLoss: trade.sl,
      tp1: trade.tp1,
      tp2: trade.tp2,
      tp3: trade.tp3,
      signalConfidence: trade.confidence ?? 0,
      trendDirection: auditTrend(trade),
      signalReason: `${trade.source} signal`,
      marketSession: istSession(),
      marketContext: { source: trade.source, snapshotId: trade.snapshotId },
    });
  } catch {
    /* audit engine offline — non-fatal */
  }
}

export function getActiveTrades(): ActiveTrade[] {
  return Array.from(activeTrades.values())
    .filter(t => t.status === 'ACTIVE');
}

/**
 * Trades that must keep being monitored for TP/SL — every non-terminal
 * status including TP1_HIT / TP2_HIT (trailing still active).
 * THIS is what the TIGER poll loop must iterate. getActiveTrades() is only
 * for "can we open a fresh entry" checks.
 */
export function getMonitoredTrades(): ActiveTrade[] {
  return Array.from(activeTrades.values())
    .filter(t => !isTerminalTradeStatus(t, t.status));
}

// Reload active trades from database on server restart.
// MUST read via Prisma directly — HTTP self-fetch fails during instrumentation
// (server is not listening yet) and left 0 trades monitored after every boot.
export async function reloadActiveTrades(): Promise<number> {
  try {
    const { db } = await import("./db");
    // Load ALL non-terminal statuses (not just ACTIVE) so TP1/TP2 trailed
    // trades resume monitoring after a restart.
    const resumable = new Set(["ACTIVE", "OPEN", "PENDING", "TP1_HIT", "TP2_HIT"]);
    const rows = await db.trade.findMany({
      where: {
        status: { in: ["ACTIVE", "OPEN", "PENDING", "TP1_HIT", "TP2_HIT"] },
        // Skip ancient junk / test pollution; keep recent real + resumable
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    let loaded = 0;
    for (const t of rows) {
      const tradeId = t.tradeId;
      if (!tradeId || activeTrades.has(tradeId)) continue;
      if (!resumable.has(t.status)) continue;
      // Skip synthetic test IDs that would never have real LTP
      if (/^(e2e|persist|chain|sell|prod)-/.test(tradeId)) continue;
      const trade: ActiveTrade = {
        id: tradeId,
        symbol: t.symbol,
        side: (t.side || "BUY") as "BUY" | "SELL",
        instrument: `${t.symbol} ${t.strike || ""} ${t.type || ""}`.trim(),
        strike: t.strike || 0,
        optionType: t.type || "",
        entry: t.entryPrice || 0,
        sl: t.stopLoss || 0,
        tp1: t.target1 || t.entryPrice || 0,
        tp2: t.target2 || t.target1 || t.entryPrice || 0,
        tp3: t.target3 ?? undefined,
        status: (t.status === "OPEN" || t.status === "PENDING") ? "ACTIVE" : t.status as ActiveTrade["status"],
        sentAt: (t.createdAt instanceof Date ? t.createdAt : new Date()).toISOString(),
        source: t.strategy || "unknown",
        spotPrice: (t as any).spotPrice,
        confidence: t.confidence ?? undefined,
        qualityScore: t.qualityScore ?? undefined,
        qualityGrade: t.qualityGrade ?? undefined,
        exchange: t.exchange || "NFO",
      };
      // Invalid levels (entry/SL/TP missing or SL on wrong side) — do not monitor
      if (!(trade.entry > 0) || !(trade.sl > 0) || !(trade.tp1 > 0)) continue;
      applyAlertFlags(trade); // restore TP1_ALERT_SENT etc. — no re-alert after restart
      activeTrades.set(trade.id, trade);
      loaded++;
    }
    console.log(`[ActiveTrade] Reloaded ${loaded} active trades from database`);
    return loaded;
  } catch (err: any) {
    console.warn(`[ActiveTrade] Failed to reload trades: ${err.message}`);
    return 0;
  }
}

export function getAllTrades(): ActiveTrade[] {
  return Array.from(activeTrades.values());
}

export function getTrade(id: string): ActiveTrade | undefined {
  return activeTrades.get(id);
}

export async function updateTradeStatus(id: string, status: ActiveTrade['status']): Promise<void> {
  const trade = activeTrades.get(id);
  if (!trade) return;
  // Guard: never reopen / regress a terminal trade
  if (isTerminalTradeStatus(trade, trade.status) && status !== trade.status) {
    console.log(`[ActiveTrade] IGNORED ${status} on terminal trade ${id} (${trade.status})`);
    return;
  }
  trade.status = status;
  const now = new Date().toISOString();
  if (status === 'TP1_HIT') trade.tp1HitAt = now;
  else if (status === 'TP2_HIT') trade.tp2HitAt = now;
  else if (status === 'TP3_HIT') trade.tp2HitAt = now;
  else if (status === 'SL_HIT') trade.slHitAt = now;

  const terminal = isTerminalTradeStatus(trade, status);
  const exchange = trade.exchange || 'NFO';

  // SAFETY: Update active trade lock status.
  // Non-terminal TP2 (TP3 still pending) must NOT hit the lock module's
  // TP2_HIT terminal path — keep lock as TP1_HIT/ACTIVE instead.
  if (terminal) {
    updateLockStatus(id, trade.symbol, exchange, status);
  } else if (status !== 'TP2_HIT') {
    updateLockStatus(id, trade.symbol, exchange, status);
  }
  // status === 'TP2_HIT' && !terminal → lock untouched (still active)

  // TRAILING SL: After TP1 hit, move SL to breakeven (entry price)
  if (status === 'TP1_HIT' && (trade.side === 'BUY' || trade.side === 'SELL')) {
    const oldSL = trade.sl;
    trade.sl = trade.entry;
    console.log(`[ActiveTrade] Trailing SL: ${trade.symbol} SL moved from ${oldSL} → ${trade.entry} (breakeven) after TP1 hit`);
  }

  if (terminal) {
    // ── FINAL EXIT: write exit fields, close audit, release lock ──
    const hitPrice = status === 'SL_HIT' ? trade.sl
      : status === 'TP1_HIT' ? trade.tp1
      : status === 'TP2_HIT' ? trade.tp2
      : status === 'TP3_HIT' ? (trade.tp3 ?? trade.tp2)
      : 0;
    const pnl = getPnl(trade, hitPrice);
    const pnlPct = getPnlPct(trade, hitPrice);

    // 1. Persist update to the Prisma journal (source of truth for dashboard/
    //    Telegram/Agent reports).
    await updateTrade(trade.id, {
      status,
      exitPrice: hitPrice,
      exitReason: status,
      pnl: Math.round(pnl * 100) / 100,
      pnlPercent: Math.round(pnlPct * 100) / 100,
      holdingTimeMin: getHoldingMins(trade),
      tpHitLevel: status === 'TP1_HIT' ? 'TP1' : status === 'TP2_HIT' ? 'TP2' : status === 'TP3_HIT' ? 'TP3' : null,
    });

    // 2. Sync the exit to the Trade Audit engine (idempotent).
    const reason = status === 'SL_HIT' ? 'stop_loss' : status === 'TP1_HIT' ? 'tp1' : status === 'TP2_HIT' ? 'tp2' : 'tp3';
    try {
      await updatePrice(trade.id, hitPrice);
      await closeTrade(trade.id, hitPrice, reason);
    } catch {
      /* audit engine offline — non-fatal */
    }

    // 3. Remove from the in-memory active list so it no longer appears as open
    //    and cannot block a fresh entry for the same symbol.
    activeTrades.delete(id);

    // Training: record trade outcome (non-blocking)
    try {
      const { resolveTrade } = await import("./training/trade-trainer");
      const outcome = status === 'SL_HIT' ? 'LOSS' : 'WIN';
      resolveTrade(trade.id, outcome, hitPrice, status, undefined, undefined);
      console.log(`[Training] Outcome recorded: ${trade.symbol} ${trade.id} → ${outcome}`);
    } catch { /* training module not available — non-fatal */ }

    // 4. SAFETY: Release active trade lock on terminal events
    releaseTradeLock(trade.symbol, exchange);
    console.log(`[ActiveTrade] Lock released for ${trade.symbol} — trade ${id} closed (${status})`);
  } else {
    // ── INTERMEDIATE HIT (e.g. TP1 with TP2 pending): status only ──
    // Do NOT write exitPrice/pnl — trade is still open and monitored.
    await updateTrade(trade.id, {
      status,
      tpHitLevel: status === 'TP1_HIT' ? 'TP1' : status === 'TP2_HIT' ? 'TP2' : undefined,
    });
    console.log(`[ActiveTrade] ${trade.symbol} → ${status} (still monitored, lock held)`);
  }
}

/**
 * Force-close an open journal trade at a REAL market price (EOD square-off).
 * Mirrors the terminal SL/TP close sequence — Prisma journal, audit sidecar,
 * training outcome, in-memory list, lock release — but for exits that never
 * hit a level. Never writes a fabricated price (exitPrice <= 0 is refused).
 */
export async function forceCloseTrade(
  row: {
    tradeId: string;
    symbol: string;
    side?: string | null;
    entryPrice: number;
    entryTime?: Date | string | null;
    exchange?: string | null;
  },
  exitPrice: number,
  reason: string
): Promise<{ closed: boolean; inMemory: boolean }> {
  const t = activeTrades.get(row.tradeId);
  const inMemory = !!t;
  const side = (t?.side ?? row.side ?? "BUY") as "BUY" | "SELL";
  const entry = t?.entry ?? row.entryPrice ?? 0;
  const calc = computeEodClose(side, entry, exitPrice);
  if (!calc) return { closed: false, inMemory }; // non-positive price → never write

  const entryAt = t?.sentAt ?? row.entryTime ?? null;
  const holdingMin = entryAt ? holdingMinutes(entryAt, new Date()) : 0;

  // 1. Prisma journal (PATCH auto-sets exitTime for terminal CLOSED status)
  await updateTrade(row.tradeId, {
    status: "CLOSED",
    exitPrice,
    exitReason: reason,
    pnl: calc.pnl,
    pnlPercent: calc.pnlPercent,
    holdingTimeMin: holdingMin,
    tpHitLevel: reason,
  });

  // 2. Trade Audit engine (idempotent; offline is non-fatal)
  try {
    await updatePrice(row.tradeId, exitPrice);
    await closeTrade(row.tradeId, exitPrice, reason);
  } catch { /* audit engine offline — non-fatal */ }

  // 3. Training outcome (same as terminal SL/TP closes)
  if (t) {
    try {
      const { resolveTrade } = await import("./training/trade-trainer");
      resolveTrade(t.id, calc.pnl >= 0 ? "WIN" : "LOSS", exitPrice, reason, undefined, undefined);
    } catch { /* training module not available — non-fatal */ }
    activeTrades.delete(row.tradeId);
  }

  // 4. Release one-trade-per-underlying lock (no-op when none held)
  const exchange = t?.exchange || row.exchange || "NFO";
  releaseTradeLock(row.symbol, exchange);
  console.log(
    `[ActiveTrade] EOD force-close ${row.tradeId} @ ${exitPrice} pnl=${calc.pnl} (${reason})${inMemory ? " [in-memory]" : ""}`
  );
  return { closed: true, inMemory };
}

/** Human-friendly status label for dashboards, Telegram and Agent outputs. */
export function formatTradeStatus(status: string | undefined): string {
  switch (status) {
    case 'TP1_HIT':
      return '🟢 TP1 HIT | TP2/TP3 PENDING';
    case 'TP2_HIT':
      return '🟢 TP2 HIT | TP3 PENDING';
    case 'TP3_HIT':
      return '🟢 TP3 HIT | TRADE COMPLETED';
    case 'SL_HIT':
      return '🔴 SL HIT | TRADE CLOSED';
    case 'CLOSED':
      return '🔴 TRADE CLOSED';
    default:
      return '🟢 ACTIVE';
  }
}

export function hasActiveTrade(symbol: string): boolean {
  // Check both in-memory tracker AND active trade lock
  const inTracker = getActiveTrades().some(t => t.symbol === symbol);
  const inLock = isTradeActive(symbol, 'NFO') !== null;
  return inTracker || inLock;
}

export interface SLTPCheckResult {
  hitSL: ActiveTrade[];
  hitTP1: ActiveTrade[];
  hitTP2: ActiveTrade[];
  hitTP3: ActiveTrade[];
}

export async function checkSLTP(
  getCurrentPrice: (symbol: string, strike: number, optionType: string) => Promise<number>
): Promise<SLTPCheckResult> {
  const hitSL: ActiveTrade[] = [];
  const hitTP1: ActiveTrade[] = [];
  const hitTP2: ActiveTrade[] = [];
  const hitTP3: ActiveTrade[] = [];

  // Use getMonitoredTrades (non-terminal) — NOT getActiveTrades (ACTIVE only),
  // otherwise TP1-trailed trades are never re-checked for TP2/SL.
  for (const trade of getMonitoredTrades()) {
    try {
      const currentPrice = await getCurrentPrice(trade.symbol, trade.strike, trade.optionType);
      if (currentPrice <= 0) continue;

      if (trade.side === 'BUY') {
        if (currentPrice <= trade.sl && trade.status !== 'SL_HIT') {
          await updateTradeStatus(trade.id, 'SL_HIT');
          hitSL.push({ ...trade, status: 'SL_HIT' });
        } else if (trade.status === 'TP2_HIT' && currentPrice >= (trade.tp3 ?? Infinity)) {
          await updateTradeStatus(trade.id, 'TP3_HIT');
          hitTP3.push({ ...trade, status: 'TP3_HIT' });
        } else if (trade.status === 'TP1_HIT' && currentPrice >= trade.tp2) {
          await updateTradeStatus(trade.id, 'TP2_HIT');
          hitTP2.push({ ...trade, status: 'TP2_HIT' });
        } else if (trade.status === 'ACTIVE' && currentPrice >= trade.tp1) {
          await updateTradeStatus(trade.id, 'TP1_HIT');
          hitTP1.push({ ...trade, status: 'TP1_HIT' });
        }
      } else {
        if (currentPrice >= trade.sl && trade.status !== 'SL_HIT') {
          await updateTradeStatus(trade.id, 'SL_HIT');
          hitSL.push({ ...trade, status: 'SL_HIT' });
        } else if (trade.status === 'TP2_HIT' && currentPrice <= (trade.tp3 ?? -Infinity)) {
          await updateTradeStatus(trade.id, 'TP3_HIT');
          hitTP3.push({ ...trade, status: 'TP3_HIT' });
        } else if (trade.status === 'TP1_HIT' && currentPrice <= trade.tp2) {
          await updateTradeStatus(trade.id, 'TP2_HIT');
          hitTP2.push({ ...trade, status: 'TP2_HIT' });
        } else if (trade.status === 'ACTIVE' && currentPrice <= trade.tp1) {
          await updateTradeStatus(trade.id, 'TP1_HIT');
          hitTP1.push({ ...trade, status: 'TP1_HIT' });
        }
      }
    } catch {
      // skip if price fetch fails
    }
  }

  return { hitSL, hitTP1, hitTP2, hitTP3 };
}

// Format SL/TP hit message for Telegram
export function formatSLTPHit(trade: ActiveTrade, hitType: 'SL' | 'TP1' | 'TP2' | 'TP3'): string {
  const isLoss = hitType === 'SL';
  const header = isLoss ? '❌ STOP LOSS HIT' : hitType === 'TP3' ? '✅ TARGET 3 HIT (1:4)' : hitType === 'TP2' ? '✅ TARGET 2 HIT (1:3)' : '✅ TARGET 1 HIT (1:2)';
  const emoji = isLoss ? '🔴' : '🟢';
  const hitPrice = isLoss ? trade.sl : hitType === 'TP3' ? (trade.tp3 ?? trade.tp2) : hitType === 'TP2' ? trade.tp2 : trade.tp1;
  const pnl = getPnl(trade, hitPrice);
  const pnlPct = getPnlPct(trade, hitPrice);

  return `
${emoji} ${header}

📊 ${trade.symbol} — ${trade.instrument}
💰 Entry: ₹${trade.entry.toFixed(2)}
🎯 Strike: ${trade.strike}
${isLoss ? `Loss: ₹${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)` : `Gain: ₹${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`}

${isLoss ? '🔄 Moving to next setup on next scan...' : '📈 Let the remaining ride or book full profits as per your plan'}

⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
  `.trim();
}
