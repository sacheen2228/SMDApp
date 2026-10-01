// ═══════════════════════════════════════════════════════════════════════════
// Telegram TP/SL Alert Sender — sends alerts with dedup and retry
// Uses existing telegram.ts sendTelegramMessage — no duplicate infrastructure
//
// DELIVERY FLAGS: *AlertSent flags mean "Telegram confirmed delivery".
// They are set ONLY after a successful send — never at detection time —
// so failed sends stay retryable and successful ones never duplicate.
// Flags persist via activeTradeTracker data/tpsl-alert-flags.json.
// ═══════════════════════════════════════════════════════════════════════════

import type { TPSLAlert, TPSLAlertType } from './agent-contract';
import { sendTelegramMessage } from '../telegram';
import {
  storeAlert, markAlertSent, markAlertFailed, isAlertAlreadySent,
  getFailedAlerts, getAlertHistory, getMonitoredTrade, getAllMonitoredTrades,
} from './trade-monitor';
import { markTradeAlertSent, getTradeAlertFlag } from '../activeTradeTracker';

// ─── Injectable sender (tests) ────────────────────────────────────
type AlertSender = (text: string) => Promise<boolean>;
let alertSender: AlertSender = sendTelegramMessage;

/** Override the Telegram sender (tests only). Returns previous sender. */
export function __setAlertSenderForTests(fn: AlertSender | null): AlertSender {
  const prev = alertSender;
  alertSender = fn ?? sendTelegramMessage;
  return prev;
}

// ─── Delivery dedup (flags + history) ─────────────────────────────

function alreadyDelivered(tradeId: string, alertType: TPSLAlertType): boolean {
  // 1. In-memory delivery flags on the agents monitor state
  if (isAlertAlreadySent(tradeId, alertType)) return true;
  // 2. Persistent flags on the active trade (survives restart)
  if (getTradeAlertFlag(tradeId, alertType)) return true;
  // 3. Alert history already has a sent record for this type
  const history = getAlertHistory(tradeId);
  if (history.some(a => a.alertType === alertType && a.sent)) return true;
  return false;
}

function onDelivered(alert: TPSLAlert): void {
  markAlertSent(alert.alertId, alert.tradeId);
  // Sync delivery flag onto agents monitor state
  const state = getMonitoredTrade(alert.tradeId);
  if (state) {
    if (alert.alertType === 'TP1_HIT') state.tp1AlertSent = true;
    else if (alert.alertType === 'TP2_HIT') state.tp2AlertSent = true;
    else if (alert.alertType === 'TP3_HIT') state.tp3AlertSent = true;
    else if (alert.alertType === 'SL_HIT') state.slAlertSent = true;
  }
  // Persist flag so a restart never re-sends this alert
  markTradeAlertSent(alert.tradeId, alert.alertType);
}

// ─── Send TP/SL Alert ─────────────────────────────────────────────

export async function sendTPSLAlert(alert: TPSLAlert): Promise<boolean> {
  // Dedup check — only skip if delivery already CONFIRMED
  if (alreadyDelivered(alert.tradeId, alert.alertType)) {
    console.log(`[TPSLAlert] Dedup: ${alert.alertType} for ${alert.tradeId} already delivered`);
    return true;
  }

  // Store alert in history (idempotent on alertId)
  storeAlert(alert);

  // Send via Telegram
  try {
    const sent = await alertSender(alert.message);
    if (sent) {
      onDelivered(alert);
      console.log(`[TPSLAlert] Sent: ${alert.alertType} for ${alert.tradeId}`);
      // Audit event on the Hermes bus (best-effort, non-fatal)
      try {
        const { getEventBus } = await import('../hermes/event-bus');
        const bus = getEventBus();
        const eventId = await bus.emit(alert.alertType, {
          tradeId: alert.tradeId,
          symbol: alert.symbol,
          entry: alert.entry,
          current: alert.currentLTP,
          pnl: alert.pnl,
          // SL/TP values + exit price so the queue-format alert shows real
          // levels instead of ₹- (hit time = event timestamp)
          sl: alert.sl ?? (alert.alertType === 'SL_HIT' ? alert.triggerPrice : undefined),
          exit: alert.alertType === 'SL_HIT' ? alert.currentLTP : undefined,
          tp1: alert.tp1,
          tp2: alert.tp2,
          tp3: alert.tp3,
        });
        await bus.markDelivered(eventId);
      } catch { /* event bus offline — non-fatal */ }
      return true;
    } else {
      markAlertFailed(alert.alertId, alert.tradeId, 'Telegram send returned false');
      console.error(`[TPSLAlert] Failed: ${alert.alertType} for ${alert.tradeId}`);
      return false;
    }
  } catch (err: any) {
    markAlertFailed(alert.alertId, alert.tradeId, err.message);
    console.error(`[TPSLAlert] Error: ${alert.alertType} for ${alert.tradeId}: ${err.message}`);
    return false;
  }
}

// ─── Retry Failed Alerts ──────────────────────────────────────────

export async function retryFailedAlerts(): Promise<{ sent: number; failed: number }> {
  const failed = getFailedAlerts();
  let sent = 0;
  let failedCount = 0;

  for (const alert of failed) {
    if (alert.retryCount >= 3) {
      failedCount++;
      continue;
    }
    // alreadyDelivered guards against double-send if a parallel path won
    const success = await sendTPSLAlert(alert);
    if (success) sent++;
    else failedCount++;
  }

  return { sent, failed: failedCount };
}

// ─── Get Delivery Status ──────────────────────────────────────────

export function getDeliveryStatus(tradeId: string): {
  alerts: TPSLAlert[];
  totalSent: number;
  totalFailed: number;
  lastAlert: TPSLAlert | null;
} {
  const alerts = getAlertHistory(tradeId);
  const sent = alerts.filter(a => a.sent);
  const failed = alerts.filter(a => !a.sent);
  const lastAlert = alerts.length > 0 ? alerts[alerts.length - 1] : null;

  return {
    alerts,
    totalSent: sent.length,
    totalFailed: failed.length,
    lastAlert,
  };
}

// ─── Global delivery stats (EOD report + Hermes diagnostics) ──────

export function getGlobalDeliveryStats(): {
  totalSent: number;
  totalPending: number;
  totalFailed: number;
  failures: Array<{ tradeId: string; alertType: string; error?: string; retryCount: number }>;
} {
  const failed = getFailedAlerts();
  const failures = failed.map(a => ({
    tradeId: a.tradeId,
    alertType: a.alertType,
    error: a.lastError,
    retryCount: a.retryCount,
  }));
  const totalPending = failed.filter(a => a.retryCount < 3).length;
  const totalFailed = failed.filter(a => a.retryCount >= 3).length;
  // Sent = delivery flags set on monitored trades
  let totalSent = 0;
  for (const t of getAllMonitoredTrades()) {
    if (t.tp1AlertSent) totalSent++;
    if (t.tp2AlertSent) totalSent++;
    if (t.tp3AlertSent) totalSent++;
    if (t.slAlertSent) totalSent++;
  }
  return { totalSent, totalPending, totalFailed, failures };
}
