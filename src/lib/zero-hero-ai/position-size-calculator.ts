// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Position Size Calculator
// Kelly Criterion + Risk-based sizing
//
// PER-TRADE MODEL (user rule, 2026-10-20):
//   "if I spend ₹10,000 I take ₹2,000 of risk"
//     deployed = the ₹ committed to THIS trade (≤ ₹20,000 — the per-trade cap)
//     risk     = 20% of the amount DEPLOYED
// The old model ("risk = X% of an account capital") is gone: the account
// capital can only SHRINK the per-trade deployment budget, never be the risk
// base. GATE_CONFIG (src/lib/agent-brain-gate.ts) owns the numbers.

import { GATE_CONFIG } from "../agent-brain-gate";

export interface PositionSizeInput {
  /** Account capital. It can only SHRINK the per-trade deployment budget. */
  capital: number;
  /** % of the amount DEPLOYED (never % of the account). Clamped to the model. */
  riskPercent: number;
  entryPremium: number;      // Option premium
  stopLossPremium: number;   // SL premium
  lotSize: number;
  confidence: number;        // AI confidence 0-100
  probProfit: number;        // Probability of profit 0-1
  winRate?: number;          // Historical win rate (optional)
}

export interface PositionSizeOutput {
  maxLossAmount: number;
  riskPerUnit: number;       // Loss per lot
  recommendedLots: number;
  kellyLots: number;
  positionValue: number;     // Total premium outlay
  riskRewardRatio: number;
  confidenceScaledLots: number;
}

export function positionSizeCalculator(input: PositionSizeInput): PositionSizeOutput {
  const {
    capital, riskPercent, entryPremium, stopLossPremium,
    lotSize, confidence, probProfit, winRate,
  } = input;

  // ₹ committed to this trade — the per-trade budget, shrunk by the account.
  const deployedBudget = Math.min(
    GATE_CONFIG.tradeBudget,
    Number(capital) > 0 ? Number(capital) : GATE_CONFIG.capital
  );
  // % of the DEPLOYED amount, clamped to the model's ceiling.
  const riskPct = Math.min(
    GATE_CONFIG.riskPctOfTrade,
    Math.max(0.1, Number(riskPercent) || GATE_CONFIG.riskPctOfTrade)
  );
  const maxLossAmount = (deployedBudget * riskPct) / 100;
  const riskPerUnit = Math.max(0.01, entryPremium - stopLossPremium) * lotSize;

  // Lots: the risk budget AND the deployment budget both bind.
  const riskLimitedLots = riskPerUnit > 0 ? Math.floor(maxLossAmount / riskPerUnit) : 0;
  const affordableLots = entryPremium > 0 ? Math.floor(deployedBudget / (entryPremium * lotSize)) : 0;
  const recommendedLots = Math.max(0, Math.min(riskLimitedLots, affordableLots));

  // Kelly Criterion: f = p - (1-p)/b  — may only REDUCE the size, never grow it.
  const p = winRate || probProfit;
  const b = entryPremium > 0 ? (entryPremium - stopLossPremium) / stopLossPremium : 1;
  const kellyFraction = p - (1 - p) / b;
  const kellyLots = kellyFraction > 0
    ? Math.min(recommendedLots, Math.floor((kellyFraction * deployedBudget) / (entryPremium * lotSize)))
    : 0;

  // Confidence-scaled lots (reduce size if low confidence)
  const confidenceFactor = confidence / 100;
  const confidenceScaledLots = Math.max(0, Math.floor(recommendedLots * confidenceFactor));

  const positionValue = confidenceScaledLots * entryPremium * lotSize;
  const riskRewardRatio = stopLossPremium > 0 ? (entryPremium - stopLossPremium) / stopLossPremium : 0;

  return {
    maxLossAmount,
    riskPerUnit,
    recommendedLots,
    kellyLots,
    positionValue,
    riskRewardRatio,
    confidenceScaledLots,
  };
}
