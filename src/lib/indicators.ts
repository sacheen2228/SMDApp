// Technical indicator calculations for chart overlays (SMA/EMA/Bollinger/RSI/VWAP).

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function sma(bars: Bar[], period: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

export function ema(bars: Bar[], period: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      prev = bars[i].close;
    } else {
      prev = bars[i].close * k + prev * (1 - k);
    }
    if (i >= period - 1) out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

export function bollinger(bars: Bar[], period: number, mult = 2): {
  upper: Array<{ time: number; value: number }>;
  middle: Array<{ time: number; value: number }>;
  lower: Array<{ time: number; value: number }>;
} {
  const middle: Array<{ time: number; value: number }> = [];
  const upper: Array<{ time: number; value: number }> = [];
  const lower: Array<{ time: number; value: number }> = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (bars[j].close - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    const t = bars[i].time;
    middle.push({ time: t, value: mean });
    upper.push({ time: t, value: mean + mult * sd });
    lower.push({ time: t, value: mean - mult * sd });
  }
  return { upper, middle, lower };
}

export function rsi(bars: Bar[], period = 14): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].close - bars[i - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out.push({ time: bars[i].time, value: 100 - 100 / (1 + avgGain / (avgLoss || 1e-9)) });
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out.push({ time: bars[i].time, value: 100 - 100 / (1 + avgGain / (avgLoss || 1e-9)) });
    }
  }
  return out;
}

export function vwap(bars: Bar[]): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 0;
    cumPV += tp * v;
    cumV += v;
    if (cumV > 0) out.push({ time: b.time, value: cumPV / cumV });
  }
  return out;
}