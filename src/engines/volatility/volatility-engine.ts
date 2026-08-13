import type { Candle, EngineScore, VolatilityData } from '@/types/engine';
import { computeATR, computeATRPercent, classifyATRRegime } from '@/indicators/atr';

export function evaluateVolatility(candles: Candle[], price: number): { data: VolatilityData; score: EngineScore } {
  if (candles.length < 14) {
    return {
      data: { atr: 0, atrPercent: 0, atrRegime: 'normal', hv: null, realizedVol: null, volatilityExpansion: false, rangeCompression: false },
      score: { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Insufficient candles'] },
    };
  }

  const atr = computeATR(candles);
  const atrPercent = computeATRPercent(atr, price);
  const atrRegime = classifyATRRegime(atrPercent);

  // Realized volatility from log returns (approximate HV)
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
  }
  const meanRet = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const variance = returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length || 1);
  const realizedVol = Math.sqrt(variance * 365) * 100; // Annualized %

  // Historical volatility (20-period)
  const recentReturns = returns.slice(-20);
  const rMean = recentReturns.reduce((s, r) => s + r, 0) / (recentReturns.length || 1);
  const rVar = recentReturns.reduce((s, r) => s + (r - rMean) ** 2, 0) / (recentReturns.length || 1);
  const hv = Math.sqrt(rVar * 365) * 100;

  // Range compression: check if recent range is shrinking
  const recentRanges = candles.slice(-10).map(c => c.high - c.low);
  const olderRanges = candles.slice(-20, -10).map(c => c.high - c.low);
  const avgRecent = recentRanges.reduce((s, r) => s + r, 0) / (recentRanges.length || 1);
  const avgOlder = olderRanges.reduce((s, r) => s + r, 0) / (olderRanges.length || 1);
  const rangeCompression = avgOlder > 0 && avgRecent / avgOlder < 0.7;
  const volatilityExpansion = avgOlder > 0 && avgRecent / avgOlder > 1.3;

  const reasons: string[] = [];
  let bullish = 50;
  let bearish = 50;

  if (rangeCompression) {
    reasons.push('Range compression — breakout imminent');
    bullish += 5;
    bearish += 5;
  }
  if (volatilityExpansion) {
    reasons.push(`Volatility expansion (ATR: $${atr.toFixed(2)})`);
    if (candles[candles.length - 1].close > candles[candles.length - 2].close) bullish += 10;
    else bearish += 10;
  }

  if (atrRegime === 'low') reasons.push('Low volatility regime');
  if (atrRegime === 'high' || atrRegime === 'extreme') reasons.push(`High volatility: ATR ${atrPercent.toFixed(1)}%`);

  const total = bullish + bearish;
  const pctBull = total > 0 ? (bullish / total) * 100 : 50;
  const pctBear = total > 0 ? (bearish / total) * 100 : 50;

  return {
    data: { atr, atrPercent, atrRegime, hv, realizedVol, volatilityExpansion, rangeCompression },
    score: {
      score: Math.max(0, Math.min(100, bullish)),
      confidence: Math.min(1, candles.length / 100),
      bullishProb: Math.round(pctBull),
      bearishProb: Math.round(pctBear),
      neutralProb: Math.round(Math.max(0, 100 - pctBull - pctBear)),
      reasons,
    },
  };
}
