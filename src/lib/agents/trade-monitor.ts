// ════════════════════════════════════════════════════════════════════════════════════
// Universal Trade Monitor — single TP/SL event loop for ALL trade types
//
// Replaces tiger-monitor.ts as the ONLY monitoring loop in the app.
// Polls live prices every 5s during market hours, detects TP/SL hits,
// and sends all alerts through the central alert funnel
// (src/lib/trade-event-coordinator.ts → sendTradeEvent).
//
// Works for: BUY CE, BUY PE, equity BUY, equity SELL, futures, MCX
// ════════════════════════════════════════════════════════════════════════════════════

import type {
  TradeMonitorState, TradeMonitorStatus, TPSLAlert, TPSLAlertType,
} from './agent-contract';
import { updateTradeStatus, isTradeActive, getMonitoredTrades } from '../activeTradeTracker';
import { isTerminalTradeStatus } from '../activeTradeTracker';
import { releaseTradeLock } from '../active-trade-lock';
import { sendTradeEvent } from '../trade-event-coordinator';

// ─── In-Memory Trade Monitor State ────────────────────────────────
const monitoredTrades = new Map<string, TradeMonitorState>();
const alertHistory = new Map<string, TPSLAlert[]>;
const ltpFailCounts = new Map<string, number>();

// ─── Register Trade for Monitoring ────────────────────────────────
export function registerTradeForMonitoring(trade: Omit<TradeMonitorState,
  'currentLTP' | 'status' | 'pnl' | 'pnlPct' | 'mfe' | 'mae' |
  'tp1AlertSent' | 'tp2AlertSent' | 'tp3AlertSent' | 'slAlertSent' |
  'lastCheckedAt' | 'entryTime'
> & { entryTime?: string }): TradeMonitorState {
  const state: TradeMonitorState = {
    ...trade,
    entryTime: trade.entryTime || new Date().toISOString(),
    currentLTP: trade.entry,
    status: 'OPEN',
    pnl: 0,
    pnlPct: 0,
    mfe: 0,
    mae: 0,
    tp1AlertSent: false,
    tp2AlertSent: false,
    tp3AlertSent: false,
    slAlertSent: false,
    lastCheckedAt: new Date().toISOString(),
  };

  monitoredTrades.set(trade.tradeId, state);
  return state;
}

// ─── Update Price and Detect TP/SL ────────────────────────────────
export function updateAndDetect(
  tradeId: string,
  currentLTP: number
): { state: TradeMonitorState; alerts: TPSLAlert[] } {
  const state = monitoredTrades.get(tradeId);
  if (!state) {
    throw new Error(`Trade ${tradeId} not found in monitor`);
  }

  state.currentLTP = currentLTP;
  state.lastCheckedAt = new Date().toISOString();

  if (state.side === 'BUY') {
    state.pnl = (currentLTP - state.entry) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((currentLTP - state.entry) / state.entry) * 100 : 0;
  } else {
    state.pnl = (state.entry - currentLTP) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((state.entry - currentLTP) / state.entry) * 100 : 0;
  }

  if (state.side === 'BUY') {
    state.mfe = Math.max(state.mfe, currentLTP - state.entry);
    state.mae = Math.max(state.mae, state.entry - currentLTP);
  } else {
    state.mfe = Math.max(state.mfe, state.entry - currentLTP);
    state.mae = Math.max(state.mae, currentLTP - state.entry);
  }

  const alerts = detectTPSL(state);

  return { state, alerts };
}

// ─── TP/SL Detection (pure math, deterministic) ───────────────────

function detectTPSL(state: TradeMonitorState): TPSLAlert[] {
  const alerts: TPSLAlert[] = [];

  if (state.status === 'CLOSED' || state.status === 'CANCELLED' || state.status === 'ERROR') {
    return alerts;
  }
  if (state.status === 'SL_HIT' || state.status === 'TP3_HIT') {
    return alerts;
  }
  if (state.status === 'TP2_HIT' && !(state.tp3 && state.tp3 > 0)) {
    return alerts;
  }

  const ltp = state.currentLTP;

  if (state.side === 'BUY') {
    if (state.stopLoss > 0 && ltp <= state.stopLoss) {
      alerts.push(createAlert(state, 'SL_HIT', state.stopLoss));
      state.status = 'SL_HIT';
    } else if (state.status === 'OPEN' && state.tp1 > 0 && ltp >= state.tp1) {
      alerts.push(createAlert(state, 'TP1_HIT', state.tp1));
      state.status = 'TP1_HIT';
      state.stopLoss = state.entry;
    } else if (state.status === 'TP1_HIT' && state.tp2 > 0 && ltp >= state.tp2) {
      alerts.push(createAlert(state, 'TP2_HIT', state.tp2));
      state.status = 'TP2_HIT';
    } else if (state.status === 'TP2_HIT' && state.tp3 && state.tp3 > 0 && ltp >= state.tp3) {
      alerts.push(createAlert(state, 'TP3_HIT', state.tp3));
      state.status = 'TP3_HIT';
    }
  } else {
    if (state.stopLoss > 0 && ltp >= state.stopLoss) {
      alerts.push(createAlert(state, 'SL_HIT', state.stopLoss));
      state.status = 'SL_HIT';
    } else if (state.status === 'OPEN' && state.tp1 > 0 && ltp <= state.tp1) {
      alerts.push(createAlert(state, 'TP1_HIT', state.tp1));
      state.status = 'TP1_HIT';
      state.stopLoss = state.entry;
    }
  }

  return alerts;
}

function createAlert(
  state: TradeMonitorState,
  alertType: TPSLAlertType,
  triggerPrice: number
): TPSLAlert {
  const isTP = alertType.startsWith('TP');
  const emoji = isTP ? '🎯' : '🛑';
  const label = isTP ? 'TP HIT' : 'SL HIT';

  const message = [
    `${'━'.repeat(20)}`,
    `${emoji} ${label}`,
    `${'━'.repeat(20)}`,
    `Symbol: ${state.symbol}${state.strike ? ` ${state.strike}` : ''} ${state.instrument}`,
    `Side: ${state.side}`,
    `Entry: ₹${state.entry}`,
    `Current: ₹${state.currentLTP}`,
    `${isTP ? 'TP' : 'SL'}: ₹${triggerPrice}`,
    `P&L: ₹${state.pnl.toFixed(2)} (${state.pnlPct.toFixed(2)}%)`,
    `Hit time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
    `Trade ID: ${state.tradeId}`,
    `Final status: ${alertType}`,
    `${'━'.repeat(20)}`,
  ].join('\n');

  return {
    alertId: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tradeId: state.tradeId,
    alertType,
    symbol: state.symbol,
    side: state.side,
    instrument: state.instrument,
    strike: state.strike,
    entry: state.entry,
    currentLTP: state.currentLTP,
    triggerPrice,
    sl: state.stopLoss,
    tp1: state.tp1,
    tp2: state.tp2,
    tp3: state.tp3,
    pnl: state.pnl,
    pnlPct: state.pnlPct,
    timestamp: new Date().toISOString(),
    message,
    sent: false,
    retryCount: 0,
  };
}

// ─── Get Monitored Trade ──────────────────────────────────────────

export function getMonitoredTrade(tradeId: string): TradeMonitorState | undefined {
  return monitoredTrades.get(tradeId);
}

// ─── Get All Monitored Trades ─────────────────────────────────────

export function getAllMonitoredTrades(): TradeMonitorState[] {
  return Array.from(monitoredTrades.values());
}

// ─── Get Active Trades (non-terminal) ─────────────────────────────

export function getActiveMonitoredTrades(): TradeMonitorState[] {
  return Array.from(monitoredTrades.values()).filter(
    t => !['CLOSED', 'CANCELLED', 'ERROR', 'SL_HIT', 'TP3_HIT'].includes(t.status)
      && !(t.status === 'TP2_HIT' && !(t.tp3 && t.tp3 > 0))
  );
}

// ─── Close Trade ──────────────────────────────────────────────────

export function closeTrade(tradeId: string, exitPrice: number, reason: string): void {
  const state = monitoredTrades.get(tradeId);
  if (!state) return;

  state.status = 'CLOSED';
  state.exitPrice = exitPrice;
  state.exitTime = new Date().toISOString();
  state.exitReason = reason;

  if (state.side === 'BUY') {
    state.pnl = (exitPrice - state.entry) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((exitPrice - state.entry) / state.entry) * 100 : 0;
  } else {
    state.pnl = (state.entry - exitPrice) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((state.entry - exitPrice) / state.entry) * 100 : 0;
  }

  releaseTradeLock(state.symbol, state.exchange);
}

// ─── Alert State Check (prevents duplicate alerts) ────────────────

export function isAlertAlreadySent(tradeId: string, alertType: TPSLAlertType): boolean {
  const state = monitoredTrades.get(tradeId);
  if (!state) return false;

  switch (alertType) {
    case 'TP1_HIT': return state.tp1AlertSent;
    case 'TP2_HIT': return state.tp2AlertSent;
    case 'TP3_HIT': return state.tp3AlertSent;
    case 'SL_HIT': return state.slAlertSent;
    default: return false;
  }
}

// ─── Get Alert History ────────────────────────────────────────────

export function getAlertHistory(tradeId: string): TPSLAlert[] {
  return alertHistory.get(tradeId) || [];
}

// ─── Store Alert ──────────────────────────────────────────────────

export function storeAlert(alert: TPSLAlert): void {
  const history = alertHistory.get(alert.tradeId) || [];
  if (!history.some(a => a.alertId === alert.alertId)) {
    history.push(alert);
  }
  alertHistory.set(alert.tradeId, history);
}

// ─── Mark Alert Sent ──────────────────────────────────────────────

export function markAlertSent(alertId: string, tradeId: string): void {
  const history = alertHistory.get(tradeId) || [];
  const alert = history.find(a => a.alertId === alertId);
  if (alert) {
    alert.sent = true;
    alert.sentAt = new Date().toISOString();
  }
}

// ─── Mark Alert Failed ────────────────────────────────────────────

export function markAlertFailed(alertId: string, tradeId: string, error: string): void {
  const history = alertHistory.get(tradeId) || [];
  const alert = history.find(a => a.alertId === alertId);
  if (alert) {
    alert.retryCount++;
    alert.lastError = error;
  }
}

// ─── Get Failed Alerts (for retry) ──────────────────────────────────

export function getFailedAlerts(): TPSLAlert[] {
  const all: TPSLAlert[] = [];
  for (const history of alertHistory.values()) {
    all.push(...history.filter(a => !a.sent && a.retryCount < 3));
  }
  return all;
}

// ─── Monitor Summary ──────────────────────────────────────────────

export function getMonitorSummary(): {
  totalTrades: number;
  activeTrades: number;
  tp1Hits: number;
  tp2Hits: number;
  tp3Hits: number;
  slHits: number;
  closedTrades: number;
  totalPnL: number;
} {
  const all = Array.from(monitoredTrades.values());
  return {
    totalTrades: all.length,
    activeTrades: all.filter(t => !['CLOSED', 'CANCELLED', 'ERROR', 'SL_HIT', 'TP3_HIT'].includes(t.status)).length,
    tp1Hits: all.filter(t => t.status === 'TP1_HIT' || t.status === 'TP2_HIT' || t.status === 'TP3_HIT').length,
    tp2Hits: all.filter(t => t.status === 'TP2_HIT' || t.status === 'TP3_HIT').length,
    tp3Hits: all.filter(t => t.status === 'TP3_HIT').length,
    slHits: all.filter(t => t.status === 'SL_HIT').length,
    closedTrades: all.filter(t => t.status === 'CLOSED').length,
    totalPnL: all.reduce((sum, t) => sum + t.pnl, 0),
  };
}

// ─── LTP fetcher (MO → Breeze → NSE) ─────────────────────────────
export interface LTPFetchDeps {
  moPath?: (ref: {
    symbol: string;
    strike: number;
    optionType: string;
    expiry?: string;
  }) => Promise<number>;
  breezeChain?: (symbol: string, strike: number, optionType: string) => Promise<number>;
  nseChain?: (symbol: string, strike: number, optionType: string) => Promise<number>;
}

async function defaultMOPath(ref: {
  symbol: string;
  strike: number;
  optionType: string;
  expiry?: string;
}): Promise<number> {
  const { resolveMOOptionLTP } = await import('@/lib/motilal/quote');
  const result = await resolveMOOptionLTP({
    symbol: ref.symbol,
    strike: ref.strike,
    optionType: ref.optionType,
    expiry: ref.expiry,
  });
  return result.ltp > 0 ? result.ltp : 0;
}

async function defaultBreezeChain(
  symbol: string,
  strike: number,
  optionType: string
): Promise<number> {
  try {
    const { getOptionChain } = await import('@/lib/icici-breeze/option-chain');
    const chain = await getOptionChain(symbol, "");
    if (chain) {
      const idx = chain.strikes.indexOf(strike);
      if (idx >= 0) {
        const call = chain.calls[idx];
        const put = chain.puts[idx];
        const leg = optionType === "CE" ? call : put;
        if (leg?.ltp && leg.ltp > 0) return leg.ltp;
      }
    }
  } catch {}
  return 0;
}

async function defaultNSEChain(
  symbol: string,
  strike: number,
  optionType: string
): Promise<number> {
  try {
    const { getNSEOptionChain } = await import("@/lib/nse-api");
    const data = await getNSEOptionChain(symbol);
    if (data?.records?.data) {
      const row = data.records.data.find((r: any) => r.strikePrice === strike);
      if (row) {
        const leg = optionType === "CE" ? row.CE : row.PE;
        if (leg?.lastPrice && leg.lastPrice > 0) return leg.lastPrice;
      }
    }
  } catch {}
  return 0;
}

export async function fetchLTP(
  symbol: string,
  strike: number,
  optionType: string,
  expiry?: string,
  deps?: LTPFetchDeps
): Promise<number> {
  const isOption = optionType === "CE" || optionType === "PE";

  if (isOption && strike > 0) {
    const moPath = deps?.moPath ?? defaultMOPath;
    const mo = await moPath({ symbol, strike, optionType, expiry });
    if (mo > 0) return mo;

    const breezeChain = deps?.breezeChain ?? defaultBreezeChain;
    const breeze = await breezeChain(symbol, strike, optionType);
    if (breeze > 0) return breeze;

    const nseChain = deps?.nseChain ?? defaultNSEChain;
    const nse = await nseChain(symbol, strike, optionType);
    if (nse > 0) return nse;

    return 0;
  }

  try {
    const { getQuotes } = await import("@/lib/icici-breeze/option-chain");
    const q = await getQuotes(symbol, "NSE");
    const ltp = Number(q?.[0]?.ltp ?? q?.ltp ?? 0);
    if (ltp > 0) return ltp;
  } catch {}

  try {
    const { fetchStockQuotes } = await import("@/lib/nse-stock-data");
    const quotes = await fetchStockQuotes([symbol]);
    const ltp = Number(quotes?.[symbol]?.ltp ?? quotes?.[symbol.toUpperCase()]?.ltp ?? 0);
    if (ltp > 0) return ltp;
  } catch {}

  return 0;
}

// ─── Market hours check ──────────────────────────────────────────

const MARKET_START_HOUR = 9;
const MARKET_START_MIN = 15;
const MARKET_END_HOUR = 15;
const MARKET_END_MIN = 30;

function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  const dow = ist.getDay();
  if (dow === 0 || dow === 6) return false;
  const mins = h * 60 + m;
  return mins >= MARKET_START_HOUR * 60 + MARKET_START_MIN && mins <= MARKET_END_HOUR * 60 + MARKET_END_MIN;
}

// ─── Polling loop ────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const LTP_FAIL_THRESHOLD = 10;

let monitorRunning = false;
let monitorTimer: ReturnType<typeof setInterval> | null = null;

export async function pollTradesOnce(
  resolveLTP?: (t: TradeMonitorState) => Promise<number>
): Promise<{ detected: number; sent: number; errors: string[] }> {
  const errors: string[] = [];
  let detected = 0;
  let sent = 0;
  const resolver =
    resolveLTP ??
    ((t: TradeMonitorState) => fetchLTP(t.symbol, t.strike ?? 0, t.instrument === 'CALL' ? 'CE' : t.instrument === 'PUT' ? 'PUT' : t.instrument === 'FUTURES' ? 'FUTURES' : 'EQ', t.expiry));

  const trades = Array.from(monitoredTrades.values()).filter(
    t => !['CLOSED', 'CANCELLED', 'ERROR', 'SL_HIT', 'TP3_HIT'].includes(t.status)
      && !(t.status === 'TP2_HIT' && !(t.tp3 && t.tp3 > 0))
  );

  for (const trade of trades) {
    try {
      const ltp = await resolver(trade);
      if (ltp <= 0) {
        const fails = (ltpFailCounts.get(trade.tradeId) || 0) + 1;
        ltpFailCounts.set(trade.tradeId, fails);
        if (fails === LTP_FAIL_THRESHOLD) {
          const msg = [
            "⚠️ MONITORING ERROR",
            `Symbol: ${trade.symbol}`,
            `Strike: ${trade.strike}`,
            `Type: ${trade.instrument}`,
            `LTP feed unavailable after ${fails} consecutive attempts`,
            `Trade remains OPEN — no TP/SL detection until feed recovers`,
            `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
          ].join("\n");
          await sendTradeEvent({
            tradeId: trade.tradeId,
            eventType: 'SL_HIT',
            targetLevel: trade.stopLoss,
            symbol: trade.symbol,
            action: trade.side,
            strike: trade.strike,
            optionType: trade.instrument,
            entry: trade.entry,
            spot: trade.currentLTP,
            source: 'trade-monitor',
            confidence: (trade as any).confidence ?? 50,
          }).catch(() => {});
          errors.push(`LTP unavailable for ${trade.symbol} (${trade.tradeId}) after ${fails} attempts`);
        }
        continue;
      }
      ltpFailCounts.delete(trade.tradeId);

      const { state, alerts } = await updateAndDetect(trade.tradeId, ltp);
      if (!alerts || alerts.length === 0) continue;

      detected += alerts.length;

      for (const alert of alerts) {
        const ok = await sendTradeEvent({
          tradeId: alert.tradeId,
          eventType: alert.alertType,
          targetLevel: alert.triggerPrice,
          symbol: alert.symbol,
          action: alert.side,
          strike: alert.strike,
          optionType: alert.instrument,
          entry: alert.entry,
          stopLoss: alert.sl,
          target1: alert.tp1,
          target2: alert.tp2,
          spot: alert.currentLTP,
          source: 'trade-monitor',
          confidence: state.confidence,
        }).catch(() => {});

        if (ok) sent++;
      }

      if (
        state.status === 'SL_HIT' ||
        state.status === 'TP3_HIT' ||
        (state.status === 'TP2_HIT' && !(trade.tp3 && trade.tp3 > 0))
      ) {
        ltpFailCounts.delete(trade.tradeId);
        console.log(`[TradeMonitor] ${trade.symbol} ${state.status} — monitoring stopped`);
      }
    } catch (err: any) {
      errors.push(`${trade.tradeId}: ${err.message}`);
    }
  }

  return { detected, sent, errors };
}

async function monitorTick(): Promise<void> {
  if (!isMarketOpen()) return;
  try {
    const result = await pollTradesOnce();
    if (result.detected > 0 || result.errors.length > 0) {
      console.log(
        `[TradeMonitor] tick detected=${result.detected} sent=${result.sent} errors=${result.errors.length}`,
        result.errors.slice(0, 3)
      );
    }
  } catch (err: any) {
    console.warn(`[TradeMonitor] tick error: ${err.message}`);
  }
}

// ── Public API ──────────────────────────────────────────────

export async function startUniversalMonitor(): Promise<void> {
  const g = globalThis as any;
  if (!g.__tradeMonitor) g.__tradeMonitor = { running: false, timer: null };
  const state = g.__tradeMonitor;
  if (state.running) return;

  try {
    const { reloadActiveTrades } = await import('../activeTradeTracker');
    const loaded = await reloadActiveTrades();
    console.log(`[TradeMonitor] Reloaded ${loaded} active trades from database`);
  } catch (err: any) {
    console.warn(`[TradeMonitor] Failed to reload trades: ${err.message}`);
  }

  state.running = true;
  state.timer = setInterval(monitorTick, POLL_INTERVAL_MS);
  monitorRunning = true;
  monitorTimer = state.timer;
  console.log("[TradeMonitor] Trade monitor started — polling every 5s");
}

export function stopUniversalMonitor(): void {
  const g = globalThis as any;
  const state = g.__tradeMonitor;
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (state) state.running = false;
  monitorRunning = false;
  console.log("[TradeMonitor] Trade monitor stopped");
}

export function isUniversalMonitorRunning(): boolean {
  const g = globalThis as any;
  return g.__tradeMonitor?.running || monitorRunning;
}

export function detectHitForTest(trade: ActiveTrade, currentLTP: number): TPSLAlertType | null {
  return detectPlanHit(trade, currentLTP);
}

