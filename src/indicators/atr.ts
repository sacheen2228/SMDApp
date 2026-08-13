import type { Candle } from '@/types/engine';

export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  if (trs.length === 0) return 0;
  // RMA (smoothed)
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

export function computeATRPercent(atr: number, price: number): number {
  return price > 0 ? (atr / price) * 100 : 0;
}

export function classifyATRRegime(atrPercent: number): 'low' | 'normal' | 'high' | 'extreme' {
  if (atrPercent < 0.5) return 'low';
  if (atrPercent < 1.5) return 'normal';
  if (atrPercent < 3.0) return 'high';
  return 'extreme';
}
