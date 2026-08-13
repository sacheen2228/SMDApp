import type { Candle, EngineScore, RegimeResult } from '@/types/engine';
import { computeADX } from '@/indicators/adx';

export function evaluateMarketRegime(candles: Candle[], price: number): { regime: RegimeResult; score: EngineScore } {
  if (candles.length < 30) {
    return {
      regime: { regime: 'range', confidence: 0, adx: 0, atrExpansion: false, rangeCompression: false, hv: null },
      score: { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Insufficient data'] },
    };
  }

  const { adx, plusDI, minusDI } = computeADX(candles);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  // Range analysis
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const rangePct = recentLow > 0 ? ((recentHigh - recentLow) / recentLow) * 100 : 0;

  // Compression check
  const oldRange = Math.max(...highs.slice(-40, -20)) - Math.min(...lows.slice(-40, -20));
  const newRange = recentHigh - recentLow;
  const rangeCompression = oldRange > 0 && newRange / oldRange < 0.6;

  // Volume profile
  const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const volSpike = avgVol > 0 && lastVol > avgVol * 1.5;

  // Price position relative to range
  const rangeMid = (recentHigh + recentLow) / 2;
  const posInRange = rangePct > 0 ? (price - recentLow) / (recentHigh - recentLow) : 0.5;

  // At expansion from ATR
  const atrVal = highs.slice(-1)[0] - lows.slice(-1)[0];
  const avgAtr = candles.slice(-20).reduce((s, c) => s + (c.high - c.low), 0) / 20;
  const atrExpansion = avgAtr > 0 && atrVal / avgAtr > 1.5;

  const reasons: string[] = [];
  let regime: RegimeResult['regime'] = 'range';
  let confidence = 0;
  let bullish = 50;
  let bearish = 50;

  if (adx >= 40) {
    regime = 'strong_trend';
    confidence = Math.min(1, adx / 60);
    if (plusDI > minusDI) { bullish += 25; reasons.push('Strong uptrend'); }
    else { bearish += 25; reasons.push('Strong downtrend'); }
  } else if (adx >= 25) {
    regime = 'trending';
    confidence = 0.5;
    if (plusDI > minusDI) { bullish += 15; reasons.push('Trending up'); }
    else { bearish += 15; reasons.push('Trending down'); }
  } else if (rangeCompression) {
    regime = 'compression';
    confidence = 0.6;
    reasons.push('Range compression — breakout zone');
    bullish += 10;
    bearish += 10;
  } else if (volSpike && atrExpansion) {
    regime = 'breakout';
    confidence = 0.7;
    reasons.push('Breakout detected — volume spike + ATR expansion');
    if (price > rangeMid) bullish += 20;
    else bearish += 20;
  } else if (rangePct > 5 && posInRange > 0.8) {
    regime = 'distribution';
    confidence = 0.5;
    bearish += 10;
    reasons.push('Distribution zone');
  } else if (rangePct > 5 && posInRange < 0.2) {
    regime = 'accumulation';
    confidence = 0.5;
    bullish += 10;
    reasons.push('Accumulation zone');
  } else {
    regime = 'range';
    confidence = 0.3;
    reasons.push('Range-bound market');
  }

  // Reversal detection
  if (rangePct > 5) {
    const last3 = candles.slice(-3);
    const prev3 = candles.slice(-6, -3);
    const prevDir = prev3[0].close < prev3[1].close && prev3[1].close < prev3[2].close;
    const revDir = last3[0].close > last3[1].close && last3[1].close > last3[2].close;
    if (prevDir && revDir) {
      regime = 'reversal';
      reasons.push('Trend reversal up');
      bullish += 15;
    }
  }

  const total = bullish + bearish;
  const pctBull = total > 0 ? (bullish / total) * 100 : 50;
  const pctBear = total > 0 ? (bearish / total) * 100 : 50;

  return {
    regime: { regime, confidence, adx, atrExpansion, rangeCompression, hv: null },
    score: {
      score: Math.max(0, Math.min(100, bullish)),
      confidence,
      bullishProb: Math.round(pctBull),
      bearishProb: Math.round(pctBear),
      neutralProb: Math.round(Math.max(0, 100 - pctBull - pctBear)),
      reasons,
    },
  };
}
