// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Position Size Calculator
// Kelly Criterion + Risk-based sizing

export interface PositionSizeInput {
  capital: number;           // Total trading capital
  riskPercent: number;       // Max risk per trade (e.g. 2 = 2%)
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

  const maxLossAmount = (capital * riskPercent) / 100;
  const riskPerUnit = Math.max(0.01, entryPremium - stopLossPremium) * lotSize;

  const recommendedLots = riskPerUnit > 0 ? Math.floor(maxLossAmount / riskPerUnit) : 0;

  // Kelly Criterion: f = p - (1-p)/b
  const p = winRate || probProfit;
  const b = entryPremium > 0 ? (entryPremium - stopLossPremium) / stopLossPremium : 1;
  const kellyFraction = p - (1 - p) / b;
  const kellyLots = kellyFraction > 0 ? Math.floor((kellyFraction * capital) / (entryPremium * lotSize)) : 0;

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
