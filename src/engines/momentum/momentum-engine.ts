import type { Candle, EngineScore } from '@/types/engine';

export function evaluateMomentum(candles: Candle[]): EngineScore {
  if (candles.length < 14) {
    return { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Insufficient data'] };
  }

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const last = closes[closes.length - 1];

  // Rate of change (ROC)
  const roc10 = closes.length > 10 ? (last - closes[closes.length - 11]) / closes[closes.length - 11] * 100 : 0;
  const roc5 = closes.length > 5 ? (last - closes[closes.length - 6]) / closes[closes.length - 6] * 100 : 0;

  // Volume momentum
  const vol10 = volumes.slice(-10).reduce((s, v) => s + v, 0) / 10;
  const vol30 = volumes.slice(-30).reduce((s, v) => s + v, 0) / 30;
  const volRatio = vol30 > 0 ? vol10 / vol30 : 1;

  // Price acceleration
  const accel = roc5 - roc10;

  const reasons: string[] = [];
  let bullish = 50;
  let bearish = 50;

  if (roc10 > 2) {
    bullish += 15;
    reasons.push(`ROC(10): +${roc10.toFixed(1)}%`);
  } else if (roc10 < -2) {
    bearish += 15;
    reasons.push(`ROC(10): ${roc10.toFixed(1)}%`);
  }

  if (accel > 1) {
    bullish += 15;
    reasons.push('Accelerating momentum');
  } else if (accel < -1) {
    bearish += 15;
    reasons.push('Decelerating momentum');
  }

  if (volRatio > 1.3) {
    if (roc10 > 0) { bullish += 10; reasons.push('Rising volume on up move'); }
    else { bearish += 10; reasons.push('Rising volume on down move'); }
  } else if (volRatio < 0.7) {
    reasons.push('Drying volume');
  }

  const total = bullish + bearish;
  const pctBull = total > 0 ? (bullish / total) * 100 : 50;
  const pctBear = total > 0 ? (bearish / total) * 100 : 50;

  return {
    score: Math.max(0, Math.min(100, bullish)),
    confidence: Math.min(1, candles.length / 100),
    bullishProb: Math.round(pctBull),
    bearishProb: Math.round(pctBear),
    neutralProb: Math.round(Math.max(0, 100 - pctBull - pctBear)),
    reasons,
  };
}
