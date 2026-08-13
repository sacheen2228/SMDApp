import type { Candle, EngineScore } from '@/types/engine';

export function evaluateVolume(candles: Candle[]): EngineScore {
  if (candles.length < 20) {
    return { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Insufficient data'] };
  }

  const volumes = candles.map(c => c.volume);
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const lastVol = volumes[volumes.length - 1];

  // Average volume
  const avg20 = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const avg50 = volumes.slice(-50).reduce((s, v) => s + v, 0) / 50;
  const relVol = avg20 > 0 ? lastVol / avg20 : 0;

  // Volume trend
  const volUp = volumes.slice(-5).reduce((s, v) => s + v, 0);
  const volPrev = volumes.slice(-10, -5).reduce((s, v) => s + v, 0);
  const volTrend = volPrev > 0 ? volUp / volPrev : 1;

  // Climax detection
  const volStd = Math.sqrt(volumes.slice(-50).reduce((s, v) => s + (v - avg50) ** 2, 0) / 50);
  const isClimax = volStd > 0 && lastVol > avg50 + volStd * 2;

  // Volume confirmation of price
  const lastDir = last > closes[closes.length - 2] ? 1 : -1;
  const confirmed = (lastDir > 0 && relVol > 1) || (lastDir < 0 && relVol > 1);

  const reasons: string[] = [];
  let bullish = 50;
  let bearish = 50;

  if (relVol > 1.5) {
    if (lastDir > 0) { bullish += 20; reasons.push('Volume spike on up move'); }
    else { bearish += 20; reasons.push('Volume spike on down move'); }
  } else if (relVol < 0.5) {
    reasons.push(`Low volume (${(relVol * 100).toFixed(0)}% of avg)`);
  }

  if (isClimax) {
    reasons.push('Climax volume — potential reversal');
    if (lastDir > 0) bearish += 10;
    else bullish += 10;
  }

  if (volTrend > 1.2) reasons.push('Volume trending up');
  else if (volTrend < 0.8) reasons.push('Volume declining');

  if (confirmed) {
    if (lastDir > 0) reasons.push('Volume confirms bullish move');
    else reasons.push('Volume confirms bearish move');
  }

  const total = bullish + bearish;
  const pctBull = total > 0 ? (bullish / total) * 100 : 50;
  const pctBear = total > 0 ? (bearish / total) * 100 : 50;

  return {
    score: Math.max(0, Math.min(100, bullish)),
    confidence: Math.min(1, relVol / 3),
    bullishProb: Math.round(pctBull),
    bearishProb: Math.round(pctBear),
    neutralProb: Math.round(Math.max(0, 100 - pctBull - pctBear)),
    reasons,
  };
}
