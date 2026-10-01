// ═══════════════════════════════════════════════════════════════════════════
// Trade Monitor — deterministic TP/SL detection for ALL trade types
// This is NOT an AI agent — it is pure math monitoring live prices
// Works for: BUY CE, BUY PE, equity BUY, equity SELL, futures, MCX
// ═══════════════════════════════════════════════════════════════════════════

import type {
  TradeMonitorState, TradeMonitorStatus, TPSLAlert, TPSLAlertType,
} from './agent-contract';
import { updateTradeStatus, releaseTradeLock, isTradeActive } from '../active-trade-lock';

// ─── In-Memory Trade Monitor State ────────────────────────────────

const monitoredTrades = new Map<string, TradeMonitorState>();
const alertHistory = new Map<string, TPSLAlert[]>();

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

  // Update LTP
  state.currentLTP = currentLTP;
  state.lastCheckedAt = new Date().toISOString();

  // Calculate P&L
  if (state.side === 'BUY') {
    state.pnl = (currentLTP - state.entry) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((currentLTP - state.entry) / state.entry) * 100 : 0;
  } else {
    // SELL positions
    state.pnl = (state.entry - currentLTP) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((state.entry - currentLTP) / state.entry) * 100 : 0;
  }

  // Update MFE/MAE
  if (state.side === 'BUY') {
    state.mfe = Math.max(state.mfe, currentLTP - state.entry);
    state.mae = Math.max(state.mae, state.entry - currentLTP);
  } else {
    state.mfe = Math.max(state.mfe, state.entry - currentLTP);
    state.mae = Math.max(state.mae, currentLTP - state.entry);
  }

  // Detect TP/SL
  const alerts = detectTPSL(state);

  return { state, alerts };
}

// ─── TP/SL Detection (pure math, deterministic) ───────────────────
// Detection is gated by STATUS sequencing (never re-fires once status
// advanced). Delivery flags (*AlertSent) are set ONLY after Telegram
// confirms send — see telegram-alerts.markAlertSent — so a failed send
// can be retried without duplicating a successful one.

function detectTPSL(state: TradeMonitorState): TPSLAlert[] {
  const alerts: TPSLAlert[] = [];

  if (state.status === 'CLOSED' || state.status === 'CANCELLED' || state.status === 'ERROR') {
    return alerts; // Terminal — no more detection
  }
  // Terminal hit statuses stop detection (SL / final TP)
  if (state.status === 'SL_HIT' || state.status === 'TP3_HIT') {
    return alerts;
  }
  if (state.status === 'TP2_HIT' && !(state.tp3 && state.tp3 > 0)) {
    return alerts; // TP2 was the final target
  }

  const ltp = state.currentLTP;

  if (state.side === 'BUY') {
    // BUY positions: SL if price drops, TP if price rises
    // SL check (works from any non-terminal status — includes trailed SL after TP1)
    if (state.stopLoss > 0 && ltp <= state.stopLoss) {
      alerts.push(createAlert(state, 'SL_HIT', state.stopLoss));
      state.status = 'SL_HIT';
    }
    // TP1 check (only from OPEN/ACTIVE)
    else if (state.status === 'OPEN' && state.tp1 > 0 && ltp >= state.tp1) {
      alerts.push(createAlert(state, 'TP1_HIT', state.tp1));
      state.status = 'TP1_HIT';
      // Trail SL to breakeven after TP1 (mirrors activeTradeTracker)
      state.stopLoss = state.entry;
    }
    // TP2 check (only after TP1)
    else if (state.status === 'TP1_HIT' && state.tp2 > 0 && ltp >= state.tp2) {
      alerts.push(createAlert(state, 'TP2_HIT', state.tp2));
      state.status = 'TP2_HIT';
    }
    // TP3 check (only after TP2)
    else if (state.status === 'TP2_HIT' && state.tp3 && state.tp3 > 0 && ltp >= state.tp3) {
      alerts.push(createAlert(state, 'TP3_HIT', state.tp3));
      state.status = 'TP3_HIT';
    }
  } else {
    // SELL positions: SL if price rises, TP if price drops
    if (state.stopLoss > 0 && ltp >= state.stopLoss) {
      alerts.push(createAlert(state, 'SL_HIT', state.stopLoss));
      state.status = 'SL_HIT';
    }
    // TP check (single TP for SELL)
    else if (state.status === 'OPEN' && state.tp1 > 0 && ltp <= state.tp1) {
      alerts.push(createAlert(state, 'TP1_HIT', state.tp1));
      state.status = 'TP1_HIT';
      state.stopLoss = state.entry;
    }
  }

  return alerts;
}

// ─── Create Alert ─────────────────────────────────────────────────

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

  // Update final P&L
  if (state.side === 'BUY') {
    state.pnl = (exitPrice - state.entry) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((exitPrice - state.entry) / state.entry) * 100 : 0;
  } else {
    state.pnl = (state.entry - exitPrice) * (state.quantity || 1);
    state.pnlPct = state.entry > 0 ? ((state.entry - exitPrice) / state.entry) * 100 : 0;
  }

  // Release trade lock
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
  // Idempotent on alertId — retries must not duplicate history entries
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

// ─── Get Failed Alerts (for retry) ────────────────────────────────

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
