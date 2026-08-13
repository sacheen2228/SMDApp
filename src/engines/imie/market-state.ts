import type { Candle } from '@/types/engine';
import type { MarketStateResult, MarketStateType } from './types';

export function determineMarketState(candles: Candle[], price: number): MarketStateResult {
  const len = candles.length;
  if (len < 14) {
    return { state: 'BALANCED', confidence: 0.3, reasons: ['Insufficient data'] };
  }

  const reasons: string[] = [];
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const vols = candles.map(c => c.volume);

  const totalRange = Math.max(...highs) - Math.min(...lows);
  const recentRange = Math.max(...highs.slice(-7)) - Math.min(...lows.slice(-7));
  const fullRange = Math.max(...highs) - Math.min(...lows);

  // Trend strength via EMA alignment
  const ema9 = closes.slice(-9).reduce((s, v) => s + v, 0) / Math.min(9, closes.length);
  const ema21 = closes.slice(-21).reduce((s, v) => s + v, 0) / Math.min(21, closes.length);
  const ema50 = closes.slice(-50).reduce((s, v) => s + v, 0) / Math.min(50, closes.length);

  const trendUp = ema9 > ema21 && ema21 > ema50 && price > ema9;
  const trendDown = ema9 < ema21 && ema21 < ema50 && price < ema9;
  const trendStrength = trendUp || trendDown ? Math.abs(ema9 - ema21) / price * 100 : 0;

  // Compression check
  const rangeRatio = fullRange > 0 ? recentRange / fullRange : 0;
  const rangeCompression = rangeRatio < 0.25;
  const rangeExpansion = rangeRatio > 0.8;

  // Volume profile — detect accumulation/distribution
  const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
  const recentAvgVol = vols.slice(-10).reduce((s, v) => s + v, 0) / 10;
  const volumeRising = recentAvgVol > avgVol * 1.2;

  // Price in upper/lower half of range
  const pricePosition = fullRange > 0 ? (price - Math.min(...lows)) / fullRange : 0.5;
  const inUpperHalf = pricePosition > 0.6;
  const inLowerHalf = pricePosition < 0.4;

  // Scoring for each state
  const scores: Record<MarketStateType, number> = {
    TRENDING: 0, BALANCED: 0, ACCUMULATION: 0, DISTRIBUTION: 0,
    EXPANSION: 0, COMPRESSION: 0,
  };

  // TRENDING
  if (trendUp && trendStrength > 0.5) {
    scores.TRENDING += 60;
    reasons.push(`Price above all EMAs (9/21/50), trend strength ${trendStrength.toFixed(2)}%`);
  }
  if (trendDown && trendStrength > 0.5) {
    scores.TRENDING += 60;
    reasons.push(`Price below all EMAs (9/21/50), trend strength ${trendStrength.toFixed(2)}%`);
  }
  if (volumeRising && (trendUp || trendDown)) {
    scores.TRENDING += 20;
    reasons.push('Volume confirming trend direction');
  }

  // COMPRESSION
  if (rangeCompression) {
    scores.COMPRESSION += 60;
    reasons.push(`Range compression: recent range ${(recentRange / fullRange * 100).toFixed(0)}% of total`);
  }
  if (Math.abs(ema9 - ema21) / price < 0.003) {
    scores.COMPRESSION += 20;
    reasons.push('EMAs tightly coiled');
  }
  if (avgVol > 0 && recentAvgVol < avgVol * 0.7) {
    scores.COMPRESSION += 10;
    reasons.push('Volume declining — coiling');
  }

  // EXPANSION
  if (rangeExpansion) {
    scores.EXPANSION += 50;
    reasons.push(`Range expansion: recent range ${(recentRange / fullRange * 100).toFixed(0)}% of total`);
  }
  if (volumeRising && (trendUp || trendDown)) {
    scores.EXPANSION += 30;
    reasons.push('Volume expanding with price');
  }

  // ACCUMULATION
  if (inLowerHalf && volumeRising && !trendDown) {
    scores.ACCUMULATION += 50;
    reasons.push('Price in lower range with rising volume — potential accumulation');
  }
  if (inLowerHalf && candles.slice(-3).filter(c => c.close > c.open).length >= 2) {
    scores.ACCUMULATION += 20;
    reasons.push('Buying absorption in discount');
  }

  // DISTRIBUTION
  if (inUpperHalf && volumeRising && !trendUp) {
    scores.DISTRIBUTION += 50;
    reasons.push('Price in upper range with rising volume — potential distribution');
  }
  if (inUpperHalf && candles.slice(-3).filter(c => c.close < c.open).length >= 2) {
    scores.DISTRIBUTION += 20;
    reasons.push('Selling pressure in premium');
  }

  // BALANCED
  if (!trendUp && !trendDown && !rangeCompression && !rangeExpansion && scores.ACCUMULATION < 30 && scores.DISTRIBUTION < 30) {
    scores.BALANCED += 40;
    reasons.push('No clear directional bias');
  }
  if (pricePosition > 0.35 && pricePosition < 0.65) {
    scores.BALANCED += 20;
    reasons.push('Price centered within range');
  }
  // Balance default
  scores.BALANCED += 10;

  // Select best state
  const entries = Object.entries(scores) as [MarketStateType, number][];
  entries.sort((a, b) => b[1] - a[1]);

  const bestState = entries[0][0];
  const bestScore = entries[0][1];
  const secondScore = entries[1][1];

  // Confidence from score separation
  const confidence = Math.min(0.95, Math.max(0.3, (bestScore - secondScore) / 100 + 0.3));

  return {
    state: bestState,
    confidence: parseFloat(confidence.toFixed(2)),
    reasons: reasons.slice(0, 4),
  };
}
