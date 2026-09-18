// lib/activeTradeTracker.ts
//
// Tracks active trades in memory, monitors SL/TP hits, and notifies Telegram.
// Persists all trades to SQLite via tradeStore for reporting and export.
// The intraday scanner checks this before generating new trades.
// When SL is hit the trade is closed and the next scan can pick a new setup.
// SAFETY: Integrates with active-trade-lock for one-trade-per-underlying.

import { createTrade, updateTrade } from "./tradeStore";
import { recordSignal, closeTrade, updatePrice } from "./trade-audit-client";
import { istSession } from "./audit-recorders";
import { acquireTradeLock, releaseTradeLock, updateTradeStatus as updateLockStatus, isTradeActive } from "./active-trade-lock";

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
}

const activeTrades = new Map<string, ActiveTrade>();

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
  // SAFETY: Acquire active trade lock before creating trade
  const lockResult = await acquireTradeLock({
    tradeId: trade.id,
    strategy: trade.source,
    underlying: trade.symbol,
    exchange: 'NFO',
    optionType: (trade.optionType as 'CE' | 'PE' | 'FUT' | 'EQ') ?? 'CE',
    strike: trade.strike,
    expiry: '',
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

  // Training: record trade snapshot in background (non-blocking)
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

  // TIGER alert: send Telegram notification for new trade (skip if caller already sent alert)
  if (!skipAlert) {
    try {
      const { alertNewTrade } = await import("./tiger-monitor");
      await alertNewTrade(trade);
    } catch { /* tiger-monitor offline — non-fatal */ }
  }

  // Persist to database (idempotent — trade-journal route upserts on tradeId)
  await createTrade({
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
  });

  // Mirror the signal into the Trade Audit (backtest verification) engine so
  // every strategy — SDM, SMC, Zero Hero AI, BTST, Intraday — lives in the
  // same verification store. recordSignal is idempotent on tradeId.
  await recordAuditSignal(trade);
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

/** Build + send a SignalInput to the audit engine for an ActiveTrade. */
async function recordAuditSignal(trade: ActiveTrade): Promise<void> {
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

// Reload active trades from database on server restart
export async function reloadActiveTrades(): Promise<number> {
  try {
    const res = await fetch(`${process.env.INTERNAL_API_BASE || "http://localhost:3000"}/api/trade-journal?status=ACTIVE`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const trades = data.trades || [];
    let loaded = 0;
    for (const t of trades) {
      if (!t.tradeId || activeTrades.has(t.tradeId)) continue;
      activeTrades.set(t.tradeId, {
        id: t.tradeId,
        symbol: t.symbol,
        side: (t.side || 'BUY') as 'BUY' | 'SELL',
        instrument: `${t.symbol} ${t.strike || ''} ${t.type || ''}`.trim(),
        strike: t.strike || 0,
        optionType: t.type || '',
        entry: t.entryPrice || 0,
        sl: t.stopLoss || 0,
        tp1: t.target1 || t.entryPrice || 0,
        tp2: t.target2 || t.target1 || t.entryPrice || 0,
        tp3: t.target3,
        status: t.status || 'ACTIVE',
        sentAt: t.createdAt || new Date().toISOString(),
        source: t.strategy || 'unknown',
        spotPrice: t.spotPrice,
        confidence: t.confidence,
        qualityScore: t.qualityScore,
        qualityGrade: t.qualityGrade,
      });
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
  trade.status = status;
  const now = new Date().toISOString();
  if (status === 'TP1_HIT') trade.tp1HitAt = now;
  else if (status === 'TP2_HIT') trade.tp2HitAt = now;
  else if (status === 'TP3_HIT') trade.tp2HitAt = now;
  else if (status === 'SL_HIT') trade.slHitAt = now;

  // SAFETY: Update active trade lock status
  const lockStatus = updateLockStatus(id, trade.symbol, 'NFO', status);
  
  // TRAILING SL: After TP1 hit, move SL to breakeven (entry price)
  if (status === 'TP1_HIT' && trade.side === 'BUY') {
    const oldSL = trade.sl;
    trade.sl = trade.entry;
    console.log(`[ActiveTrade] Trailing SL: ${trade.symbol} SL moved from ${oldSL} → ${trade.entry} (breakeven) after TP1 hit`);
  } else if (status === 'TP1_HIT' && trade.side === 'SELL') {
    const oldSL = trade.sl;
    trade.sl = trade.entry;
    console.log(`[ActiveTrade] Trailing SL: ${trade.symbol} SL moved from ${oldSL} → ${trade.entry} (breakeven) after TP1 hit`);
  }

  // Calculate P&L at hit price
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
      tpHitLevel: status === 'TP1_HIT' ? 'TP1' : status === 'TP2_HIT' ? 'TP2' : status === 'TP3_HIT' ? 'TP3' : 'SL_HIT',
  });

  // 2. Sync the exit to the Trade Audit (backtest verification) engine. Feed
  //    the exit price as a tracking tick first so the engine marks the correct
  //    tp/sl-hit flag + MFE/MAE, then explicitly close it. Both are idempotent
  //    (no-op if the trade is already closed or was never recorded).
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
  if (status === 'SL_HIT' || status === 'TP1_HIT' || status === 'TP2_HIT' || status === 'TP3_HIT') {
    try {
      const { resolveTrade } = await import("./training/trade-trainer");
      const outcome = status === 'SL_HIT' ? 'LOSS'
        : status === 'TP3_HIT' ? 'WIN'
        : status === 'TP2_HIT' ? 'WIN'
        : 'WIN'; // TP1 is treated as win ( trailed to breakeven)
      resolveTrade(trade.id, outcome, hitPrice, status, undefined, undefined);
      console.log(`[Training] Outcome recorded: ${trade.symbol} ${trade.id} → ${outcome}`);
    } catch { /* training module not available — non-fatal */ }
  }

  // 4. SAFETY: Release active trade lock on terminal events
  const terminalStatuses = ['TP2_HIT', 'TP3_HIT', 'SL_HIT'];
  if (terminalStatuses.includes(status)) {
    releaseTradeLock(trade.symbol, 'NFO');
    console.log(`[ActiveTrade] Lock released for ${trade.symbol} — trade ${id} closed (${status})`);
  }
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

  for (const trade of getActiveTrades()) {
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
