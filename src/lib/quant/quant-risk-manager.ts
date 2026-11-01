// quant-risk-manager.ts — rupee-risk sizing + portfolio guards for the quant
// engine. PURE (cooldown check takes nowMs — never calls the clock itself).
//
// ISOLATION: no orders, no alerts — produces an assessment the caller acts on.
//
// Rupee risk model (user rule: "if I spend ₹10,000 I take ₹2,000 of risk"):
//   riskBudget  = capital × perTradeRiskPct/100
//   riskPerLot  = (entry − stopLoss) × lotSize          (premium points × lot)
//   lots        = floor(min(riskBudget/riskPerLot, capital×0.35/(entry×lotSize)))
//   lots < 1    → reject "1 lot exceeds risk budget/capital" — never rounds
//                 up, never widens the stop to fit.
//
// estCosts model (exported pure for reuse by execution/performance):
//   brokerage ₹20 entry order + ₹20 exit order (flat per order)
//   + STT 0.1% of sell premium value + slippage 0.05% each side.

import { QUANT_FLAGS } from "./quant-config";
import type { QuantContractSelection, QuantPlan, QuantRiskAssessment } from "./quant-types";

/** Estimated round-trip costs in ₹: brokerage 20+20, STT 0.1% sell, slippage 0.05%/side. */
export function estimateCosts(entry: number, exit: number, lots: number, lotSize: number): number {
  const quantity = lots * lotSize;
  if (!(quantity > 0) || !(entry > 0) || !(exit > 0)) return 0;
  const brokerage = 20 + 20; // ₹20 per order, entry + exit
  const stt = exit * quantity * 0.001; // 0.1% on the SELL premium value
  const slippage = (entry + exit) * quantity * 0.0005; // 0.05% each side
  return Math.round((brokerage + stt + slippage) * 100) / 100;
}

export interface QuantRiskInput {
  symbol: string;
  contract: QuantContractSelection;
  plan: QuantPlan;
  account: { capital: number | null };
  openPositions: Array<{ symbol: string; direction: string }>;
  todayRealizedPnl: number | null;
  todayTradeCount: number;
  lastLossAt?: number | null;
  nowMs?: number | null; // required for the cooldown check; absent → cooldown skipped
  /** Runtime tuning overrides — default to QUANT_FLAGS when absent. null = unlimited. */
  overrides?: { maxTradesPerDay?: number | null; maxConcurrentPositions?: number | null };
}

function blocked(
  capital: number | null, riskBudget: number | null, riskAmount: number | null,
  lots: number, quantity: number, maxLoss: number | null, estCosts: number | null,
  affordable: boolean, reasons: string[],
): QuantRiskAssessment {
  return { capital, riskBudget, riskAmount, lots, quantity, maxLoss, estCosts, affordable, passesAll: false, reasons };
}

export function assessRisk(input: QuantRiskInput): QuantRiskAssessment {
  const { contract, plan, account } = input;
  const capital = account.capital;

  if (capital == null || !(capital > 0)) {
    return blocked(null, null, null, 0, 0, null, null, false, ["capital not configured"]);
  }

  const entry = plan.entry ?? contract.premium;
  const stopLoss = plan.stopLoss;
  const lotSize = contract.lotSize;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0 || !lotSize || lotSize <= 0) {
    return blocked(capital, null, null, 0, 0, null, null, false, ["plan entry/stop/lot size missing or invalid"]);
  }

  const riskBudget = capital * (QUANT_FLAGS.perTradeRiskPct / 100);
  if (stopLoss >= entry) {
    return blocked(capital, riskBudget, null, 0, 0, null, null, false, ["stop not below entry (long) — invalid risk geometry"]);
  }
  const riskPerLot = (entry - stopLoss) * lotSize;
  const lotsByRisk = Math.floor(riskBudget / riskPerLot);
  const lotsByCapital = Math.floor((capital * 0.35) / (entry * lotSize));
  const lots = Math.max(0, Math.min(lotsByRisk, lotsByCapital));
  const quantity = lots * lotSize;
  const riskAmount = lots > 0 ? riskPerLot * lots : null;

  const reasons: string[] = [];
  if (lots < 1) {
    reasons.push("1 lot exceeds risk budget/capital");
    return blocked(capital, riskBudget, null, 0, 0, null, null, false, reasons);
  }

  const deployed = entry * quantity;
  const affordable = deployed <= capital;
  if (!affordable) reasons.push(`deployment ₹${deployed.toFixed(0)} exceeds capital ₹${capital.toFixed(0)}`);

  if (input.todayRealizedPnl != null && input.todayRealizedPnl <= -(capital * QUANT_FLAGS.dailyLossCapPct) / 100) {
    reasons.push(`daily loss cap reached (realized ₹${input.todayRealizedPnl.toFixed(0)} ≤ −${QUANT_FLAGS.dailyLossCapPct}% of capital)`);
  }
  // Caps are OFF unless a number is configured (null = unlimited). An explicit
  // null override means "unlimited" even if a flag default changes later.
  const maxConcurrent =
    input.overrides?.maxConcurrentPositions !== undefined
      ? input.overrides.maxConcurrentPositions
      : QUANT_FLAGS.maxConcurrentPositions;
  const maxTradesPerDay =
    input.overrides?.maxTradesPerDay !== undefined
      ? input.overrides.maxTradesPerDay
      : QUANT_FLAGS.maxTradesPerDay;
  if (maxConcurrent != null && input.openPositions.length >= maxConcurrent) {
    reasons.push(`max concurrent positions reached (${input.openPositions.length}/${maxConcurrent})`);
  }
  if (maxTradesPerDay != null && input.todayTradeCount >= maxTradesPerDay) {
    reasons.push(`max trades per day reached (${input.todayTradeCount}/${maxTradesPerDay})`);
  }
  if (
    input.lastLossAt != null && input.nowMs != null &&
    input.nowMs - input.lastLossAt < QUANT_FLAGS.cooldownMinutesAfterLoss * 60_000
  ) {
    const mins = Math.round((input.nowMs - input.lastLossAt) / 60_000);
    reasons.push(`cooldown after loss active (${mins}m ago, ${QUANT_FLAGS.cooldownMinutesAfterLoss}m required)`);
  }
  const duplicate = input.openPositions.some((p) => p.symbol === input.symbol && p.direction === (contract.optionType === "CE" ? "BUY_CE" : contract.optionType === "PE" ? "BUY_PE" : plan.entry != null ? "BUY" : ""));
  if (duplicate) reasons.push(`duplicate exposure: same symbol+direction (${input.symbol}) already open`);

  const estCosts = estimateCosts(entry, stopLoss, lots, lotSize); // costs priced at the stop (worst case)
  const maxLoss = riskAmount != null ? riskAmount + estCosts : null;

  return {
    capital,
    riskBudget,
    riskAmount,
    lots,
    quantity,
    maxLoss,
    estCosts,
    affordable,
    passesAll: reasons.length === 0,
    reasons,
  };
}
