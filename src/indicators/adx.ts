import type { Candle } from '@/types/engine';

export function computeADX(candles: Candle[], period = 14): {
  adx: number;
  plusDI: number;
  minusDI: number;
} {
  const len = candles.length;
  if (len < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const tr: number[] = [];
  const upMove: number[] = [];
  const downMove: number[] = [];

  for (let i = 1; i < len; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    upMove.push(c.high - p.high);
    downMove.push(p.low - c.low);
  }

  // Smoothed TR, +DM, -DM
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0);
  let plusDM = upMove.slice(0, period).reduce((s, v, i) => {
    const dm = v > downMove[i] && v > 0 ? v : 0;
    return s + dm;
  }, 0);
  let minusDM = downMove.slice(0, period).reduce((s, v, i) => {
    const dm = v > upMove[i] && v > 0 ? v : 0;
    return s + dm;
  }, 0);

  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    const up = upMove[i] > downMove[i] && upMove[i] > 0 ? upMove[i] : 0;
    const dn = downMove[i] > upMove[i] && downMove[i] > 0 ? downMove[i] : 0;
    plusDM = (plusDM * (period - 1) + up) / period;
    minusDM = (minusDM * (period - 1) + dn) / period;
  }

  const plusDI = atr > 0 ? (plusDM / atr) * 100 : 0;
  const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0;
  const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
  const adx = dx; // Single-period simplified

  return { adx, plusDI, minusDI };
}

export function classifyTrend(adx: number): string {
  if (adx >= 40) return 'strong_trend';
  if (adx >= 25) return 'trending';
  if (adx >= 20) return 'weak_trend';
  return 'range';
}
