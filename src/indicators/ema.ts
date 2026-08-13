export function computeEMA(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  // Start with SMA
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function computeEMALast(values: number[], period: number): number {
  const emas = computeEMA(values, period);
  return emas.length > 0 ? emas[emas.length - 1] : 0;
}

export interface EMAAlignment {
  bullish: boolean;
  strength: number; // 0-1
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
}

export function computeEMAAlignment(closes: number[]): EMAAlignment {
  const ema9 = computeEMALast(closes, 9);
  const ema21 = computeEMALast(closes, 21);
  const ema50 = computeEMALast(closes, 50);
  const ema200 = computeEMALast(closes, 200);
  const last = closes[closes.length - 1] || 0;

  // Count alignments
  let count = 0;
  if (ema9 > ema21) count++;
  if (ema21 > ema50) count++;
  if (ema50 > ema200) count++;
  if (last > ema9) count++;

  return {
    bullish: count >= 2,
    strength: count / 4,
    ema9,
    ema21,
    ema50,
    ema200,
  };
}
