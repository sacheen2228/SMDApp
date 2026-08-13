import type { Candle } from '@/types/engine';

export function computeVWAP(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  let volSum = 0;
  let pvSum = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    volSum += c.volume;
    pvSum += tp * c.volume;
  }
  return volSum > 0 ? pvSum / volSum : 0;
}

export function computeVWAPBands(candles: Candle[]): { vwap: number; upper: number; lower: number } {
  const vwap = computeVWAP(candles);
  if (candles.length === 0) return { vwap: 0, upper: 0, lower: 0 };

  let sqSum = 0;
  let volSum = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    volSum += c.volume;
    sqSum += c.volume * (tp - vwap) ** 2;
  }
  const std = volSum > 0 ? Math.sqrt(sqSum / volSum) : 0;
  return { vwap, upper: vwap + std * 2, lower: vwap - std * 2 };
}
