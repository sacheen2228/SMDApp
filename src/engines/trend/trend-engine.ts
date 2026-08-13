import { computeATR, computeATRPercent, classifyATRRegime } from '@/indicators/atr';
import { computeEMAAlignment } from '@/indicators/ema';
import { computeADX, classifyTrend } from '@/indicators/adx';
import { computeVWAP } from '@/indicators/vwap';
import type { Candle, EngineScore } from '@/types/engine';

export function evaluateTrend(candles: Candle[], price: number): EngineScore {
  if (candles.length < 50) {
    return { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Insufficient data'] };
  }

  const closes = candles.map(c => c.close);
  const ema = computeEMAAlignment(closes);
  const { adx, plusDI, minusDI } = computeADX(candles);
  const vwap = computeVWAP(candles);
  const atr = computeATR(candles);
  const atrPct = computeATRPercent(atr, price);
  const atrRegime = classifyATRRegime(atrPct);
  const trendType = classifyTrend(adx);

  const reasons: string[] = [];
  let bullishScore = 0;
  let bearishScore = 0;

  // EMA alignment (max 30 points)
  if (ema.bullish) {
    bullishScore += 30 * ema.strength;
    reasons.push(`EMA alignment: bullish (${ema.strength.toFixed(2)})`);
  } else {
    bearishScore += 30 * (1 - ema.strength);
    reasons.push(`EMA alignment: bearish (${(1 - ema.strength).toFixed(2)})`);
  }

  // ADX trend strength (max 25 points)
  const trendStrength = adx / 50;
  if (plusDI > minusDI) {
    bullishScore += 25 * Math.min(trendStrength, 1);
    reasons.push(`ADX ${adx.toFixed(1)}: +DI ${plusDI.toFixed(1)} > -DI ${minusDI.toFixed(1)}`);
  } else {
    bearishScore += 25 * Math.min(trendStrength, 1);
    reasons.push(`ADX ${adx.toFixed(1)}: -DI ${minusDI.toFixed(1)} > +DI ${plusDI.toFixed(1)}`);
  }

  // VWAP position (max 25 points)
  if (price > vwap) {
    bullishScore += 25 * Math.min((price - vwap) / vwap * 10, 1);
    reasons.push(`Price above VWAP ($${vwap.toFixed(2)})`);
  } else {
    bearishScore += 25 * Math.min((vwap - price) / vwap * 10, 1);
    reasons.push(`Price below VWAP ($${vwap.toFixed(2)})`);
  }

  // Trend type bonus (max 20 points)
  if (trendType === 'strong_trend') {
    if (plusDI > minusDI) { bullishScore += 20; reasons.push('Strong bullish trend'); }
    else { bearishScore += 20; reasons.push('Strong bearish trend'); }
  } else if (trendType === 'trending') {
    if (plusDI > minusDI) { bullishScore += 10; reasons.push('Bullish trending'); }
    else { bearishScore += 10; reasons.push('Bearish trending'); }
  }

  const total = bullishScore + bearishScore;
  const bullishPct = total > 0 ? (bullishScore / total) * 100 : 50;
  const bearishPct = total > 0 ? (bearishScore / total) * 100 : 50;
  const neutralPct = Math.max(0, 100 - bullishPct - bearishPct);
  const score = Math.max(0, Math.min(100, bullishScore));
  const confidence = Math.min(1, adx / 50 + ema.strength * 0.5 + (atrRegime === 'normal' ? 0.2 : 0.1));

  return {
    score,
    confidence,
    bullishProb: Math.round(bullishPct),
    bearishProb: Math.round(bearishPct),
    neutralProb: Math.round(neutralPct),
    reasons,
  };
}
