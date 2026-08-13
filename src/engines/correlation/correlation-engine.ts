import type { EngineScore, CorrelationData } from '@/types/engine';

export function evaluateCorrelation(
  returns: number[],
  btcReturns: number[],
): { data: CorrelationData; score: EngineScore } {
  const minLen = Math.min(returns.length, btcReturns.length, 20);
  if (minLen < 20) {
    return {
      data: { btcCorrelation: null, ethCorrelation: null, marketCorrelation: null, sectorCorrelation: null },
      score: { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Insufficient data for correlation'] },
    };
  }

  const r = returns.slice(-minLen);
  const b = btcReturns.slice(-minLen);

  // Pearson correlation
  const meanR = r.reduce((s, v) => s + v, 0) / minLen;
  const meanB = b.reduce((s, v) => s + v, 0) / minLen;
  let num = 0, denR = 0, denB = 0;
  for (let i = 0; i < minLen; i++) {
    const dr = r[i] - meanR;
    const db = b[i] - meanB;
    num += dr * db;
    denR += dr * dr;
    denB += db * db;
  }
  const btcCorrelation = denR > 0 && denB > 0 ? num / Math.sqrt(denR * denB) : null;

  const strong = btcCorrelation !== null && Math.abs(btcCorrelation) > 0.7;
  const moderate = btcCorrelation !== null && Math.abs(btcCorrelation) > 0.4;

  const reasons: string[] = [];
  let bullish = 50;
  let bearish = 50;

  if (btcCorrelation !== null) {
    reasons.push(`BTC correlation: ${btcCorrelation.toFixed(2)}`);
    if (strong) {
      if (btcCorrelation > 0) bullish += 10;
      else bearish += 10;
    }
    if (moderate) {
      if (btcCorrelation > 0) bullish += 5;
      else bearish += 5;
    }
  }

  const total = bullish + bearish;
  const pctBull = total > 0 ? (bullish / total) * 100 : 50;
  const pctBear = total > 0 ? (bearish / total) * 100 : 50;

  return {
    data: { btcCorrelation, ethCorrelation: null, marketCorrelation: null, sectorCorrelation: null },
    score: {
      score: Math.max(0, Math.min(100, bullish)),
      confidence: strong ? 0.7 : moderate ? 0.4 : 0.2,
      bullishProb: Math.round(pctBull),
      bearishProb: Math.round(pctBear),
      neutralProb: Math.round(Math.max(0, 100 - pctBull - pctBear)),
      reasons,
    },
  };
}
