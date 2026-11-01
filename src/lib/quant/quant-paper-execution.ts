// quant-paper-execution.ts — deterministic, pure paper-execution model for
// the quant engine. No orders, no network, no clock (all timestamps are
// parameters). The position monitor (quant-position-monitor.ts) persists
// what these functions produce.
//
// Fill model:
//   simulateEntry — fill = roundToTick(ask + 1 tick): a BUY pays one tick of
//   slippage over the ask. ask missing → rejected (never filled from ltp).
//
// Level-evaluation ordering policy (documented): when one observation's
// range crosses multiple levels, evaluate CONSERVATIVELY — SL first, then
// TP1..TP4 ascending. Touch ≠ fill — a crossing is required: TP (long)
// fills only if high ≥ tp; SL (long) if low ≤ sl. A gap through the SL
// fills at min(ltp, configuredSL) — the worst realistic price for a long
// (the open of the observation would be ideal but the monitor's LTP feed
// carries no open; ltp IS the observation price available).
//
// Partial policy: TP1 exits half the remaining quantity (floor; a remainder
// smaller than 1 unit exits fully — quantity is in units, partial exits by
// unit are fine on paper). TP2..TP4, SL, trailing SL exit everything.
//
// Trailing policy: after TP1 the stop is first moved to entry
// (applyBreakevenAfterTp1), then trailed at highestSinceTp1 − 1×atrPremium
// (applyTrail); the trail never loosens the stop (max only).

import { roundToTick } from "@/lib/symbol-config";
import type { QuantContractSelection, QuantPlan } from "./quant-types";

// ── Entry ────────────────────────────────────────────────────────────

export type SimulateEntryResult =
  | { rejected: false; fillPrice: number; quantity: number; slippage: number; ts: number }
  | { rejected: true; reason: string };

export function simulateEntry(
  contract: QuantContractSelection,
  plan: QuantPlan,
  nowMs: number,
): SimulateEntryResult {
  if (contract.rejected || contract.ask == null || !(contract.ask > 0)) {
    return { rejected: true, reason: "ask missing — no entry fill without a real ask" };
  }
  const lots = plan.lots ?? null;
  if (lots == null || !Number.isFinite(lots) || lots < 1) {
    return { rejected: true, reason: "no approved quantity (risk sizing did not approve lots)" };
  }
  const lotSize = contract.lotSize ?? 0;
  if (!(lotSize > 0)) return { rejected: true, reason: "lot size unknown — cannot size entry" };
  const tick = contract.tickSize && contract.tickSize > 0 ? contract.tickSize : 0.05;
  const slippage = tick;
  const fillPrice = roundToTick(contract.ask + slippage, tick);
  return { rejected: false, fillPrice, quantity: lots * lotSize, slippage, ts: nowMs };
}

// ── Execution state (mirrors the QuantPaperTrade row; rebuilt from DB) ──

export interface QuantExecutionTrade {
  tradeId: string;
  direction: "BUY_CE" | "BUY_PE" | "BUY";
  entryPrice: number;
  stopLoss: number; // currently active stop
  initialStopLoss: number;
  targets: { tp1?: number | null; tp2?: number | null; tp3?: number | null; tp4?: number | null };
  quantity: number;
  remainingQuantity: number;
  tp1Hit: boolean;
  tpHitLevel: string | null;
  highestSinceTp1: number | null;
  breakevenArmed: boolean;
  atrPremium: number | null;
}

export interface QuantObservationTick {
  ltp: number;
  high?: number | null;
  low?: number | null;
  ts: number;
}

export interface QuantLevelEvent {
  eventId: string;
  type:
    | "SL_HIT"
    | "TP1_HIT"
    | "TP2_HIT"
    | "TP3_HIT"
    | "TP4_HIT"
    | "TRAILING_SL_HIT"
    | "BREAKEVEN_SL_HIT"
    | "GAP_THROUGH_SL"
    | "PARTIAL_PROFIT";
  level: number | null;
  fillPrice: number;
  quantityExited: number;
  remainingQuantity: number;
  ts: number;
  ambiguity?: string;
  partial?: boolean;
}

export interface EvaluateLevelsInput {
  trade: QuantExecutionTrade;
  observation: QuantObservationTick;
  levels?: { stopLoss?: number | null; tp1?: number | null; tp2?: number | null; tp3?: number | null; tp4?: number | null } | null;
}

/**
 * Evaluate one observation against the levels. Ordering: SL first, then
 * TPs ascending (conservative — the stop always wins an ambiguous bar).
 */
export function evaluateLevels(input: EvaluateLevelsInput): QuantLevelEvent[] {
  const { trade, observation } = input;
  const levels = input.levels ?? trade.targets;
  const stopLoss = levels?.stopLoss ?? trade.stopLoss;
  const events: QuantLevelEvent[] = [];
  let remaining = trade.remainingQuantity;
  if (remaining <= 0) return events;

  const hi = observation.high != null && observation.high > 0 ? observation.high : observation.ltp;
  const lo = observation.low != null && observation.low > 0 ? observation.low : observation.ltp;
  const mkEventId = (type: string, level: number | null) =>
    `${trade.tradeId}:${type}:${level ?? "-"}:${observation.ts}`;

  // 1. STOP first — conservative ordering.
  if (lo <= stopLoss) {
    const gapped = observation.ltp < stopLoss; // filled worse than the stop
    const fillPrice = Math.min(observation.ltp, stopLoss);
    const type: QuantLevelEvent["type"] = gapped
      ? "GAP_THROUGH_SL"
      : trade.breakevenArmed && stopLoss >= trade.entryPrice
        ? "BREAKEVEN_SL_HIT"
        : stopLoss > trade.initialStopLoss
          ? "TRAILING_SL_HIT"
          : "SL_HIT";
    events.push({
      eventId: mkEventId(type, stopLoss),
      type,
      level: stopLoss,
      fillPrice,
      quantityExited: remaining,
      remainingQuantity: 0,
      ts: observation.ts,
      ...(gapped
        ? { ambiguity: `gap through stop: observation ltp ${observation.ltp} below stop ${stopLoss} — filled at worst realistic price ${fillPrice}` }
        : {}),
    });
    return events;
  }

  // 2. Targets ascending. Levels already reached (trade.tpHitLevel) are
  //    skipped — a later tick above a hit TP must never re-fire it.
  const tpOrder = ["TP1", "TP2", "TP3", "TP4"] as const;
  const alreadyHitIdx = trade.tpHitLevel ? tpOrder.indexOf(trade.tpHitLevel as (typeof tpOrder)[number]) : -1;
  const tps: Array<["TP1" | "TP2" | "TP3" | "TP4", number | null | undefined]> = [
    ["TP1", levels?.tp1 ?? trade.targets.tp1],
    ["TP2", levels?.tp2 ?? trade.targets.tp2],
    ["TP3", levels?.tp3 ?? trade.targets.tp3],
    ["TP4", levels?.tp4 ?? trade.targets.tp4],
  ];
  for (let i = 0; i < tps.length; i++) {
    const [name, tp] = tps[i];
    if (i <= alreadyHitIdx) continue; // already taken — never re-fire
    if (tp == null || !Number.isFinite(tp) || remaining <= 0) continue;
    if (hi < tp) continue; // touch ≠ fill: the high must CROSS the target
    const isFirstTp = name === "TP1" && !trade.tp1Hit;
    let exited = isFirstTp ? Math.floor(remaining / 2) : remaining;
    if (exited < 1) exited = remaining; // cannot split below one unit
    if (remaining - exited < 1 && exited !== remaining) exited = remaining;
    remaining -= exited;
    const partial = remaining > 0;
    events.push({
      eventId: mkEventId(`${name}_HIT`, tp),
      type: `${name}_HIT` as QuantLevelEvent["type"],
      level: tp,
      fillPrice: tp,
      quantityExited: exited,
      remainingQuantity: remaining,
      ts: observation.ts,
      ...(isFirstTp ? { partial: true, ambiguity: partial ? `partial exit ${exited}/${exited + remaining} at TP1 (50% policy)` : "TP1 exit = full quantity (too small to split)" } : partial ? { partial: true } : {}),
    });
  }
  return events;
}

// ── Trailing / breakeven (pure state transforms) ─────────────────────

/** After TP1: move the stop to entry (never lower it). */
export function applyBreakevenAfterTp1(trade: QuantExecutionTrade): QuantExecutionTrade {
  if (!trade.tp1Hit) return trade;
  return {
    ...trade,
    stopLoss: Math.max(trade.stopLoss, trade.entryPrice),
    breakevenArmed: true,
  };
}

/**
 * After TP1: trail = max(current stop, highestSinceTp1 − 1×atrPremium).
 * Before TP1 (or without an ATR premium) the state is unchanged.
 */
export function applyTrail(trade: QuantExecutionTrade, observation: QuantObservationTick): QuantExecutionTrade {
  if (!trade.tp1Hit || trade.atrPremium == null || !(trade.atrPremium > 0)) return trade;
  const hi = observation.high != null && observation.high > 0 ? observation.high : observation.ltp;
  const highWater = Math.max(trade.highestSinceTp1 ?? trade.entryPrice, hi);
  const trail = highWater - 1 * trade.atrPremium;
  return {
    ...trade,
    highestSinceTp1: highWater,
    stopLoss: Math.max(trade.stopLoss, trail),
  };
}

/** Status string for a terminal SL event type. */
export function statusForStopEvent(type: QuantLevelEvent["type"]): string {
  switch (type) {
    case "TRAILING_SL_HIT": return "CLOSED_TRAILING_SL";
    case "BREAKEVEN_SL_HIT": return "CLOSED_BREAKEVEN";
    case "GAP_THROUGH_SL":
    case "SL_HIT":
    default: return "CLOSED_SL";
  }
}
