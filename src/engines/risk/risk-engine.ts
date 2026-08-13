import type { EngineScore } from '@/types/engine';

export interface RiskResult {
  maxPosition: number;
  riskPercent: number;
  maxRiskPercent: number;
  liqPercent: number;
  marginUsage: number;
  expectedRR: number;
  expectedWinRate: number;
  kellyPercent: number;
  positionSize: number;
  leverage: number;
  liquidationPrice: number;
}

export function evaluateRisk(
  atr: number,
  atrPercent: number,
  price: number,
  confidence: number,
  side: 'long' | 'short' | 'wait',
  accountBalance: number = 10000,
): { result: RiskResult; score: EngineScore } {
  const maxRiskPercent = 2; // Max 2% risk per trade
  const riskAmount = accountBalance * (maxRiskPercent / 100);

  // Position sizing based on ATR
  const stopDistance = side === 'wait' ? atr * 2 : atr * 1.5;
  const maxPosition = stopDistance > 0 ? riskAmount / stopDistance : 0;
  const positionSize = maxPosition;

  // Leverage based on ATR
  const leverage = atrPercent > 0 ? Math.min(10, Math.max(1, Math.floor(3 / atrPercent))) : 1;

  // Liquidation price
  const liqPrice = side === 'long'
    ? price - stopDistance * (1 + 1 / leverage)
    : price + stopDistance * (1 + 1 / leverage);

  // Expected risk/reward
  const tpDistance = atr * 2;
  const expectedRR = stopDistance > 0 ? tpDistance / stopDistance : 0;

  // Kelly criterion
  const winRate = confidence;
  const kellyPercent = expectedRR > 0 ? ((winRate * (expectedRR + 1) - 1) / expectedRR) * 100 : 0;

  const liqPercent = price > 0 ? Math.abs(price - liqPrice) / price * 100 : 0;

  const reasons: string[] = [];
  reasons.push(`ATR: $${atr.toFixed(2)} (${atrPercent.toFixed(1)}%)`);
  reasons.push(`Max risk: ${maxRiskPercent}% ($${riskAmount.toFixed(0)})`);
  if (leverage > 5) reasons.push(`High leverage: ${leverage}x`);
  if (atrPercent > 3) reasons.push('Wide stops recommended');
  if (kellyPercent > 20) reasons.push('High conviction — size accordingly');

  const riskScore = Math.max(0, 100 - atrPercent * 15);
  const isLowRisk = atrPercent < 1 && confidence > 0.6;
  const isHighRisk = atrPercent > 3 || leverage > 8;

  return {
    result: {
      maxPosition, riskPercent: atrPercent, maxRiskPercent,
      liqPercent, marginUsage: Math.round((1 / leverage) * 100),
      expectedRR, expectedWinRate: Math.round(confidence * 100),
      kellyPercent: Math.max(0, Math.min(kellyPercent, 50)),
      positionSize, leverage, liquidationPrice: liqPrice,
    },
    score: {
      score: Math.round(riskScore),
      confidence: isLowRisk ? 0.8 : isHighRisk ? 0.3 : 0.5,
      bullishProb: side === 'long' ? 60 : 33,
      bearishProb: side === 'short' ? 60 : 33,
      neutralProb: side === 'wait' ? 60 : 34,
      reasons,
    },
  };
}
