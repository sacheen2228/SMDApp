import type { EngineScore, FundingData } from '@/types/engine';

export function evaluateFunding(
  raw: {
    currentRate: number | null;
    predictedRate: number | null;
    lastPrice: number | null;
    markPrice: number | null;
    volume: number | null;
    high24h: number | null;
    low24h: number | null;
    priceChange: number | null;
  } | null = null,
): { data: FundingData; score: EngineScore } {
  if (!raw || raw.currentRate === null) {
    const data: FundingData = {
      currentRate: null,
      predictedRate: null,
      fundingTrend: null,
      fundingBias: 'neutral',
      fundingHistory: [],
      raw: { lastPrice: null, markPrice: null, volume: null, high24h: null, low24h: null, priceChange: null },
    };
    return {
      data,
      score: { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Funding data unavailable'] },
    };
  }

  const fr = raw.currentRate;
  const efr = raw.predictedRate;
  const trend = efr !== null ? efr - fr : null;
  const bias: 'long' | 'short' | 'neutral' = fr > 0.0001 ? 'long' : fr < -0.0001 ? 'short' : 'neutral';

  // Score: low/negative funding = bullish for longs (cheap to hold), high positive = bearish (expensive)
  let score = 50;
  if (fr < -0.0005) score = 75;      // shorts paying heavily = bullish
  else if (fr < -0.0001) score = 65;
  else if (fr > 0.0005) score = 25;  // longs paying heavily = bearish
  else if (fr > 0.0001) score = 35;

  const conf = Math.min(Math.abs(fr) * 2000, 0.9);   // scale confidence with rate magnitude
  const bullishProb = bias === 'short' ? 60 : bias === 'long' ? 30 : 45;
  const bearishProb = bias === 'long' ? 60 : bias === 'short' ? 30 : 45;
  const neutralProb = 100 - bullishProb - bearishProb;

  const reasons: string[] = [];
  if (fr !== null) reasons.push(`Funding: ${(fr * 100).toFixed(4)}%`);
  if (efr !== null) reasons.push(`Expected: ${(efr * 100).toFixed(4)}%`);
  reasons.push(bias === 'long' ? 'Longs paying = bearish' : bias === 'short' ? 'Shorts paying = bullish' : 'Neutral funding');

  const data: FundingData = {
    currentRate: fr,
    predictedRate: efr,
    fundingTrend: trend,
    fundingBias: bias,
    fundingHistory: [fr, efr].filter((v): v is number => v !== null),
    raw: {
      lastPrice: raw.lastPrice,
      markPrice: raw.markPrice,
      volume: raw.volume,
      high24h: raw.high24h,
      low24h: raw.low24h,
      priceChange: raw.priceChange,
    },
  };

  return { data, score: { score, confidence: conf, bullishProb, bearishProb, neutralProb, reasons } };
}
