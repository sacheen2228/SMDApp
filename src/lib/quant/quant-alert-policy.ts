// quant-alert-policy.ts — alert-type policy for UNIVERSAL_QUANT_V1 notifications.
//
// ISOLATION: quant-namespace policy only. No senders, no DB, no network here —
// the outbox queue consults this policy before persisting and before
// delivering. Immediate types are drained by the sender as soon as they are
// seen; non-immediate types stay PENDING for the aggregate window
// (AGGREGATE_WINDOW_MINUTES) and are delivered by a future aggregation pass.

export type QuantAlertType =
  | "QUANT_STARTUP"
  | "QUANT_TRADE_CANDIDATE"
  | "QUANT_NO_TRADE"
  | "QUANT_PAPER_ENTRY"
  | "QUANT_SL_HIT"
  | "QUANT_TP1_HIT"
  | "QUANT_TP2_HIT"
  | "QUANT_TP3_HIT"
  | "QUANT_TP4_HIT"
  | "QUANT_TRAILING_SL_HIT"
  | "QUANT_BREAKEVEN_SL_HIT"
  | "QUANT_PARTIAL_PROFIT_BOOKED"
  | "QUANT_PAPER_EXIT"
  | "QUANT_GAP_THROUGH_SL"
  | "QUANT_RISK_BLOCK"
  | "QUANT_DATA_FAILURE"
  | "QUANT_DATA_WARNING"
  | "QUANT_DAILY_SUMMARY"
  | "QUANT_ENGINE_ERROR";

export interface QuantAlertTypePolicy {
  enabled: boolean;
  priority: "HIGH" | "MEDIUM" | "LOW";
  immediate: boolean;
}

/**
 * Single source of truth for which quant alerts reach Telegram and when.
 * All types are enabled; level hits, exits, risk blocks and engine errors are
 * immediate + HIGH; NO_TRADE / DATA_FAILURE are aggregated (non-immediate);
 * DAILY_SUMMARY and STARTUP are immediate but lower priority.
 */
export const QUANT_ALERT_POLICY: Record<QuantAlertType, QuantAlertTypePolicy> = {
  QUANT_STARTUP: { enabled: true, priority: "LOW", immediate: true },
  QUANT_TRADE_CANDIDATE: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_NO_TRADE: { enabled: true, priority: "MEDIUM", immediate: false },
  QUANT_PAPER_ENTRY: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_SL_HIT: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_TP1_HIT: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_TP2_HIT: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_TP3_HIT: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_TP4_HIT: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_TRAILING_SL_HIT: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_BREAKEVEN_SL_HIT: { enabled: true, priority: "HIGH", immediate: true },
  // Intentionally producer-less: the TP1_HIT alert IS the partial-booking
  // notice (its payload carries remainingQuantity after the 50% exit). A
  // second event would double-alert every TP1. If a future flow needs a
  // dedicated booking notice, emit it from quant-position-monitor.
  QUANT_PARTIAL_PROFIT_BOOKED: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_PAPER_EXIT: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_GAP_THROUGH_SL: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_RISK_BLOCK: { enabled: true, priority: "HIGH", immediate: true },
  QUANT_DATA_FAILURE: { enabled: true, priority: "LOW", immediate: false },
  // Per-trade data-quality warning (e.g. option LTP unavailable for a tick).
  // One per trade per IST day (deduped by key) → immediate, never a stream.
  QUANT_DATA_WARNING: { enabled: true, priority: "MEDIUM", immediate: true },
  QUANT_DAILY_SUMMARY: { enabled: true, priority: "MEDIUM", immediate: true },
  QUANT_ENGINE_ERROR: { enabled: true, priority: "HIGH", immediate: true },
};

/** enabled && immediate — the outbox sender may deliver this type right now. */
export function shouldDeliverNow(type: QuantAlertType): boolean {
  const p = QUANT_ALERT_POLICY[type];
  return !!p && p.enabled && p.immediate;
}

/** !immediate && enabled — this type belongs to the aggregate window. */
export function isAggregated(type: QuantAlertType): boolean {
  const p = QUANT_ALERT_POLICY[type];
  return !!p && !p.immediate && p.enabled;
}

/** Window (minutes) after which non-immediate alerts may be batched into a digest. */
export const AGGREGATE_WINDOW_MINUTES = 60;
