import type { EngineScore } from '@/types/engine';

export interface ProbabilityResult {
  bullishProb: number;
  bearishProb: number;
  rangeProb: number;
  breakoutProb: number;
  fakeBreakoutProb: number;
  expectedMove: number;
  expectedATRMove: number;
  confidence: number;
}

export function computeProbabilities(
  engines: Record<string, EngineScore>,
  atrPercent: number,
  price: number,
): ProbabilityResult {
  const engineKeys = Object.keys(engines);
  if (engineKeys.length === 0) {
    return { bullishProb: 33, bearishProb: 33, rangeProb: 34, breakoutProb: 0, fakeBreakoutProb: 0, expectedMove: 0, expectedATRMove: 0, confidence: 0 };
  }

  let totalBull = 0;
  let totalBear = 0;
  let totalConf = 0;
  let totalScore = 0;

  for (const key of engineKeys) {
    const e = engines[key];
    totalBull += e.bullishProb * e.confidence;
    totalBear += e.bearishProb * e.confidence;
    totalConf += e.confidence;
    totalScore += e.score * e.confidence;
  }

  const avgConf = totalConf > 0 ? totalConf / engineKeys.length : 0;
  const avgScore = totalConf > 0 ? totalScore / totalConf : 50;

  const rawBull = totalConf > 0 ? totalBull / totalConf : 33;
  const rawBear = totalConf > 0 ? totalBear / totalConf : 33;

  // Normalize to 100%
  const rawTotal = rawBull + rawBear;
  const bullishProb = rawTotal > 0 ? Math.round((rawBull / rawTotal) * 100) : 33;
  const bearishProb = rawTotal > 0 ? Math.round((rawBear / rawTotal) * 100) : 33;
  const rangeProb = Math.max(0, 100 - bullishProb - bearishProb);

  // Breakout probability: high confidence + regime alignment
  const breakoutProb = Math.round(Math.min(40, avgScore * avgConf * 0.4));

  // Fake breakout probability
  const fakeBreakoutProb = Math.round(Math.min(30, (100 - avgConf) * 0.3));

  // Expected move based on ATR and confidence
  const expectedATRMove = atrPercent;
  const expectedMove = (atrPercent / 100) * price;

  return {
    bullishProb,
    bearishProb,
    rangeProb,
    breakoutProb: Math.max(0, breakoutProb),
    fakeBreakoutProb: Math.max(0, fakeBreakoutProb),
    expectedMove,
    expectedATRMove,
    confidence: avgConf,
  };
}
