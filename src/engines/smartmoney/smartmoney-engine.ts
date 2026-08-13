import type { Candle, EngineScore, SmartMoneyData } from '@/types/engine';

export function findSwingPoints(candles: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  const len = candles.length;
  if (len < 5) return { highs, lows };

  for (let i = 2; i < len - 2; i++) {
    const c = candles[i];
    // Swing high
    if (c.high > candles[i - 1].high && c.high > candles[i - 2].high &&
        c.high > candles[i + 1].high && c.high > candles[i + 2].high) {
      highs.push(c.high);
    }
    // Swing low
    if (c.low < candles[i - 1].low && c.low < candles[i - 2].low &&
        c.low < candles[i + 1].low && c.low < candles[i + 2].low) {
      lows.push(c.low);
    }
  }
  return { highs, lows };
}

export function detectFVG(candles: Candle[]): { upper: number; lower: number; type: 'bullish' | 'bearish' } | null {
  if (candles.length < 3) return null;
  const c1 = candles[candles.length - 3];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 1];

  // Bullish FVG: c1 low > c3 high (gap up)
  if (c1.low > c3.high) {
    return { upper: c1.low, lower: c3.high, type: 'bullish' };
  }
  // Bearish FVG: c3 low > c1 high (gap down)
  if (c3.low > c1.high) {
    return { upper: c3.low, lower: c1.high, type: 'bearish' };
  }
  return null;
}

export function detectOrderBlock(candles: Candle[]): { price: number; type: 'bullish' | 'bearish' } | null {
  if (candles.length < 4) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // Bullish OB: last bearish candle with big body
  if (prev.close < prev.open && (prev.open - prev.close) > (prev.high - prev.low) * 0.6 &&
      last.close > prev.high) {
    return { price: prev.high, type: 'bullish' };
  }
  // Bearish OB: last bullish candle with big body
  if (prev.close > prev.open && (prev.close - prev.open) > (prev.high - prev.low) * 0.6 &&
      last.close < prev.low) {
    return { price: prev.low, type: 'bearish' };
  }
  return null;
}

export function detectBreakerBlock(candles: Candle[]): { price: number; type: 'bullish' | 'bearish' } | null {
  if (candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // Breaker: failed breakout past a level
  if (prev.close > prev.open && last.close < prev.open) {
    return { price: prev.low, type: 'bearish' };
  }
  if (prev.close < prev.open && last.close > prev.open) {
    return { price: prev.high, type: 'bullish' };
  }
  return null;
}

export function detectMitigationBlock(candles: Candle[], swingHighs: number[], swingLows: number[]): { price: number; type: 'bullish' | 'bearish' } | null {
  if (candles.length < 3) return null;
  const last = candles[candles.length - 1];

  // Price retracing to a swing level
  for (const sh of swingHighs.slice(-3)) {
    if (Math.abs(last.close - sh) / sh < 0.005) {
      return { price: sh, type: 'bearish' };
    }
  }
  for (const sl of swingLows.slice(-3)) {
    if (Math.abs(last.close - sl) / sl < 0.005) {
      return { price: sl, type: 'bullish' };
    }
  }
  return null;
}

export function detectBOS(candles: Candle[], swingHighs: number[], swingLows: number[]): { bos: 'bullish' | 'bearish' | null; external: boolean; internal: boolean } {
  const last = candles[candles.length - 1];
  if (swingHighs.length < 1 || swingLows.length < 1) return { bos: null, external: false, internal: false };

  const recentHigh = swingHighs[swingHighs.length - 1];
  const recentLow = swingLows[swingLows.length - 1];
  const prevHigh = swingHighs.length > 1 ? swingHighs[swingHighs.length - 2] : 0;
  const prevLow = swingLows.length > 1 ? swingLows[swingLows.length - 2] : 0;

  // External BOS: breaking previous structure
  if (last.close > recentHigh && recentHigh > prevHigh) return { bos: 'bullish', external: true, internal: false };
  if (last.close < recentLow && recentLow < prevLow) return { bos: 'bearish', external: true, internal: false };

  // Internal BOS: micro structure break
  if (last.close > recentHigh && prevHigh > 0) return { bos: 'bullish', external: false, internal: true };
  if (last.close < recentLow && prevLow > 0) return { bos: 'bearish', external: false, internal: true };

  return { bos: null, external: false, internal: false };
}

export function detectCHoCH(candles: Candle[]): { choch: 'bullish' | 'bearish' | null } {
  if (candles.length < 6) return { choch: null };
  const c = candles;
  const last3 = c.slice(-3);
  const prev3 = c.slice(-6, -3);

  const prevTrendDown = prev3[0].close > prev3[1].close && prev3[1].close > prev3[2].close;
  const prevTrendUp = prev3[0].close < prev3[1].close && prev3[1].close < prev3[2].close;
  const lastUp = last3[0].close < last3[1].close && last3[1].close < last3[2].close;
  const lastDown = last3[0].close > last3[1].close && last3[1].close > last3[2].close;

  if (prevTrendDown && lastUp) return { choch: 'bullish' };
  if (prevTrendUp && lastDown) return { choch: 'bearish' };
  return { choch: null };
}

export function detectEqualLevels(swingHighs: number[], swingLows: number[]): { equalHigh: boolean; equalLow: boolean } {
  const eqHigh = swingHighs.length >= 2 &&
    Math.abs(swingHighs[swingHighs.length - 1] - swingHighs[swingHighs.length - 2]) /
    (swingHighs[swingHighs.length - 1] || 1) < 0.002;

  const eqLow = swingLows.length >= 2 &&
    Math.abs(swingLows[swingLows.length - 1] - swingLows[swingLows.length - 2]) /
    (swingLows[swingLows.length - 1] || 1) < 0.002;

  return { equalHigh: eqHigh, equalLow: eqLow };
}

export function evaluateSmartMoney(candles: Candle[], price: number): { data: SmartMoneyData; score: EngineScore } {
  if (candles.length < 10) {
    return {
      data: {
        bos: null, externalBos: false, internalBos: false,
        choch: null, liquiditySweep: false, equalHigh: false, equalLow: false,
        orderBlock: null, mitigationBlock: null, breakerBlock: null,
        fvg: null, premiumZone: null, discountZone: null, ote: null,
        swingHigh: [], swingLow: [],
      },
      score: { score: 50, confidence: 0, bullishProb: 33, bearishProb: 33, neutralProb: 34, reasons: ['Insufficient data'] },
    };
  }

  const { highs, lows } = findSwingPoints(candles);
  const { bos, external, internal } = detectBOS(candles, highs, lows);
  const { choch } = detectCHoCH(candles);
  const fvg = detectFVG(candles);
  const orderBlock = detectOrderBlock(candles);
  const breakerBlock = detectBreakerBlock(candles);
  const mitigationBlock = detectMitigationBlock(candles, highs, lows);
  const { equalHigh, equalLow } = detectEqualLevels(highs, lows);

  // Premium/Discount zones from long-term structure
  const highestClose = Math.max(...candles.slice(-100).map(c => c.close));
  const lowestClose = Math.min(...candles.slice(-100).map(c => c.close));
  const range = highestClose - lowestClose;
  const premiumZone = { upper: highestClose, lower: highestClose - range * 0.236 };
  const discountZone = { upper: lowestClose + range * 0.236, lower: lowestClose };

  // OTE (Optimal Trade Entry): 61.8-78.6% retracement
  const mid = (highestClose + lowestClose) / 2;
  const oteUp = lowestClose + range * 0.618;
  const oteDown = highestClose - range * 0.618;
  const ote = price >= oteDown && price <= oteUp
    ? { entry: price, stop: price * 0.99, tp: price * 1.02 } as const
    : null;

  const reasons: string[] = [];
  let bullish = 50;
  let bearish = 50;

  if (bos === 'bullish') {
    bullish += 20;
    reasons.push(`BOS ${external ? 'external' : 'internal'} bullish`);
  } else if (bos === 'bearish') {
    bearish += 20;
    reasons.push(`BOS ${external ? 'external' : 'internal'} bearish`);
  }

  if (choch === 'bullish') { bullish += 15; reasons.push('CHoCH bullish'); }
  else if (choch === 'bearish') { bearish += 15; reasons.push('CHoCH bearish'); }

  if (fvg) {
    if (fvg.type === 'bullish') { bullish += 10; reasons.push('Bullish FVG'); }
    else { bearish += 10; reasons.push('Bearish FVG'); }
  }

  if (orderBlock) {
    if (orderBlock.type === 'bullish') { bullish += 10; reasons.push('Bullish OB'); }
    else { bearish += 10; reasons.push('Bearish OB'); }
  }

  if (price <= discountZone.upper) { bullish += 10; reasons.push('Price in discount zone'); }
  if (price >= premiumZone.lower) { bearish += 10; reasons.push('Price in premium zone'); }
  if (equalHigh) { bearish += 10; reasons.push('Equal highs (resistance)'); }
  if (equalLow) { bullish += 10; reasons.push('Equal lows (support)'); }
  if (ote) { reasons.push('OTE zone'); }

  const total = bullish + bearish;
  const pctBull = total > 0 ? (bullish / total) * 100 : 50;
  const pctBear = total > 0 ? (bearish / total) * 100 : 50;
  const confidence = Math.min(1, highs.length / 10);

  return {
    data: {
      bos, externalBos: external, internalBos: internal, choch,
      liquiditySweep: false, equalHigh, equalLow,
      orderBlock, mitigationBlock, breakerBlock, fvg,
      premiumZone, discountZone, ote,
      swingHigh: highs, swingLow: lows,
    },
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
