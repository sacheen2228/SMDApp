// Liquidity Engine - Identifies liquidity levels, sweeps, failed breakouts
// Extended with HTF (Higher Time Frame) liquidity lines and ERL/IRL classification

import { Candle, LiquidityLevel, LiquidityEvent, SwingPoint } from './auction-types';

// ─── HTF Liquidity Types ──────────────────────────────────────────

export interface HTFLiquidityLevel {
  price: number;
  timeframe: '1H' | '4H' | '1D' | '1W';
  type: 'BSL' | 'SSL'; // Buy-Side Liquidity / Sell-Side Liquidity
  classification: 'ERL' | 'IRL'; // External Range / Internal Range Liquidity
  strength: number;
  touches: number;
  swept: boolean;
  sweepTime?: number;
  originTime: number;
}

export interface HTFLiquidityResult {
  htfLevels: HTFLiquidityLevel[];
  erlLevels: HTFLiquidityLevel[];
  irlLevels: HTFLiquidityLevel[];
  nearestBSL: HTFLiquidityLevel | null;
  nearestSSL: HTFLiquidityLevel | null;
  currentBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface LiquidityConfig {
  equalHighLowThreshold: number; // price tolerance for equal highs/lows
  sweepVolumeMultiplier: number;
  lookbackSwings: number;
}

const DEFAULT_LIQ_CONFIG: LiquidityConfig = {
  equalHighLowThreshold: 0.001, // 0.1%
  sweepVolumeMultiplier: 1.5,
  lookbackSwings: 20,
};

export function identifyLiquidityLevels(
  candles: Candle[],
  swings: SwingPoint[],
  prevDayHigh: number,
  prevDayLow: number,
  prevWeekHigh: number,
  prevWeekLow: number,
  config: Partial<LiquidityConfig> = {}
): LiquidityLevel[] {
  const cfg = { ...DEFAULT_LIQ_CONFIG, ...config };
  const levels: LiquidityLevel[] = [];

  // Previous Day High/Low
  if (prevDayHigh > 0) levels.push(createLevel(prevDayHigh, 'PDH', candles));
  if (prevDayLow > 0) levels.push(createLevel(prevDayLow, 'PDL', candles));

  // Previous Week High/Low
  if (prevWeekHigh > 0) levels.push(createLevel(prevWeekHigh, 'PWH', candles));
  if (prevWeekLow > 0) levels.push(createLevel(prevWeekLow, 'PWL', candles));

  // Session High/Low
  const sessionHigh = Math.max(...candles.map(c => c.high));
  const sessionLow = Math.min(...candles.map(c => c.low));
  levels.push(createLevel(sessionHigh, 'SESSION_HIGH', candles));
  levels.push(createLevel(sessionLow, 'SESSION_LOW', candles));

  // Swing Highs/Lows
  const recentSwings = swings.slice(-cfg.lookbackSwings);
  for (const swing of recentSwings) {
    const type = swing.type === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    levels.push(createLevel(swing.price, type as any, candles));
  }

  // Equal Highs/Lows detection
  const equalLevels = findEqualHighsLows(swings, cfg.equalHighLowThreshold);
  for (const eq of equalLevels) {
    levels.push(createLevel(eq.price, eq.type === 'HIGH' ? 'EQUAL_HIGH' : 'EQUAL_LOW', candles));
    levels[levels.length - 1].touches = eq.count;
  }

  return levels.filter(l => l.price > 0);

  function createLevel(price: number, type: LiquidityLevel['type'], candles: Candle[]): LiquidityLevel {
    const touches = candles.filter(c =>
      Math.abs(c.high - price) / price < cfg.equalHighLowThreshold ||
      Math.abs(c.low - price) / price < cfg.equalHighLowThreshold
    ).length;

    return {
      price,
      type,
      strength: 1,
      touches,
      lastTouch: candles[candles.length - 1]?.time || Date.now(),
      swept: false,
    };
  }
}

function findEqualHighsLows(swings: SwingPoint[], threshold: number): Array<{ price: number; type: 'HIGH' | 'LOW'; count: number }> {
  const groups: Map<string, { price: number; type: 'HIGH' | 'LOW'; count: number }> = new Map();

  for (const s of swings) {
    const key = `${s.type}_${Math.round(s.price / (s.price * threshold))}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.price = (existing.price * (existing.count - 1) + s.price) / existing.count;
    } else {
      groups.set(key, { price: s.price, type: s.type, count: 1 });
    }
  }

  return Array.from(groups.values()).filter(g => g.count >= 2);
}

export function detectLiquiditySweeps(
  candles: Candle[],
  levels: LiquidityLevel[],
  config: Partial<LiquidityConfig> = {}
): { events: LiquidityEvent[]; sweptLevels: LiquidityLevel[] } {
  const cfg = { ...DEFAULT_LIQ_CONFIG, ...config };
  const events: LiquidityEvent[] = [];
  const sweptLevels: LiquidityLevel[] = [];
  const avgVolume = candles.reduce((s, c) => s + c.volume, 0) / candles.length;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];

    for (const level of levels) {
      if (level.swept) continue;

      // Check if price pierced the level
      const piercedHigh = c.high >= level.price && prevC.high < level.price;
      const piercedLow = c.low <= level.price && prevC.low > level.price;

      if (piercedHigh) {
        // Check if it closed back below (sweep)
        if (c.close < level.price) {
          level.swept = true;
          level.sweepTime = c.time;
          sweptLevels.push(level);

          if (level.type.includes('HIGH')) {
            events.push('LIQUIDITY_SWEEP_HIGH');
          } else {
            events.push('LIQUIDITY_SWEEP_LOW');
          }
        }
      } else if (piercedLow) {
        if (c.close > level.price) {
          level.swept = true;
          level.sweepTime = c.time;
          sweptLevels.push(level);

          if (level.type.includes('HIGH')) {
            events.push('LIQUIDITY_SWEEP_HIGH');
          } else {
            events.push('LIQUIDITY_SWEEP_LOW');
          }
        }
      }
    }
  }

  return { events, sweptLevels };
}

export function detectFailedBreakouts(
  candles: Candle[],
  levels: LiquidityLevel[]
): { events: LiquidityEvent[]; levels: LiquidityLevel[] } {
  const events: LiquidityEvent[] = [];
  const failedLevels: LiquidityLevel[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];

    for (const level of levels) {
      if (level.type.includes('HIGH') && !level.swept) {
        // Price broke above but closed back below
        if (prevC.close < level.price && c.high > level.price && c.close < level.price) {
          events.push('FAILED_BREAKOUT');
          failedLevels.push(level);
        }
      } else if (level.type.includes('LOW') && !level.swept) {
        if (prevC.close > level.price && c.low < level.price && c.close > level.price) {
          events.push('FAILED_BREAKDOWN');
          failedLevels.push(level);
        }
      }
    }
  }

  return { events, levels: failedLevels };
}

export function analyzeLiquidity(
  candles: Candle[],
  swings: SwingPoint[],
  prevDayHigh: number,
  prevDayLow: number,
  prevWeekHigh: number,
  prevWeekLow: number
): {
  levels: LiquidityLevel[];
  sweeps: LiquidityEvent[];
  failedBreakouts: LiquidityEvent[];
  failedBreakdowns: LiquidityEvent[];
  keyLevels: LiquidityLevel[];
} {
  const levels = identifyLiquidityLevels(candles, swings, prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);
  const { events: sweepEvents, sweptLevels } = detectLiquiditySweeps(candles, levels);
  const { events: fbEvents } = detectFailedBreakouts(candles, levels);

  const sweeps = sweepEvents.filter(e => e.includes('SWEEP'));
  const failedBreakouts = fbEvents.filter(e => e === 'FAILED_BREAKOUT');
  const failedBreakdowns = fbEvents.filter(e => e === 'FAILED_BREAKDOWN');

  // Key levels: unswept PDH/PDL, equal highs/lows, session H/L
  const keyLevels = levels.filter(l =>
    !l.swept && (
      l.type === 'PDH' || l.type === 'PDL' ||
      l.type === 'PWH' || l.type === 'PWL' ||
      l.type === 'EQUAL_HIGH' || l.type === 'EQUAL_LOW' ||
      l.type === 'SESSION_HIGH' || l.type === 'SESSION_LOW'
    )
  );

  return {
    levels,
    sweeps,
    failedBreakouts,
    failedBreakdowns,
    keyLevels,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTF (Higher Time Frame) Liquidity Lines
// Aggregates daily/weekly/monthly candle data to identify institutional
// liquidity levels that project onto intraday timeframes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Aggregate lower-timeframe candles into higher-timeframe candles.
 * e.g., 5m candles → 1H candles, 1H candles → 1D candles
 */
export function aggregateToHTF(
  candles: Candle[],
  targetTF: '1H' | '4H' | '1D' | '1W'
): Candle[] {
  if (candles.length === 0) return [];

  const tfMs: Record<string, number> = {
    '1H': 3600000,
    '4H': 14400000,
    '1D': 86400000,
    '1W': 604800000,
  };

  const interval = tfMs[targetTF] || tfMs['1D'];
  const htfCandles: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart = Math.floor(candles[0].time / interval) * interval;

  for (const c of candles) {
    const candleBucket = Math.floor(c.time / interval) * interval;
    if (candleBucket !== bucketStart) {
      if (bucket.length > 0) {
        htfCandles.push(mergeHTFCandle(bucket, bucketStart));
      }
      bucket = [c];
      bucketStart = candleBucket;
    } else {
      bucket.push(c);
    }
  }

  if (bucket.length > 0) {
    htfCandles.push(mergeHTFCandle(bucket, bucketStart));
  }

  return htfCandles;
}

function mergeHTFCandle(candles: Candle[], time: number): Candle {
  return {
    time,
    open: candles[0].open,
    high: Math.max(...candles.map(c => c.high)),
    low: Math.min(...candles.map(c => c.low)),
    close: candles[candles.length - 1].close,
    volume: candles.reduce((s, c) => s + c.volume, 0),
  };
}

/**
 * Detect swing points from HTF candles (uses fractal method with larger lookback).
 */
export function detectHTFSwings(candles: Candle[], lookback: number = 3): SwingPoint[] {
  if (candles.length < lookback * 2 + 1) return [];

  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];

    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (c.high <= candles[i - j].high || c.high <= candles[i + j].high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swings.push({ time: c.time, price: c.high, type: 'HIGH', strength: 1, volume: c.volume });
    }

    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (c.low >= candles[i - j].low || c.low >= candles[i + j].low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swings.push({ time: c.time, price: c.low, type: 'LOW', strength: 1, volume: c.volume });
    }
  }

  return swings;
}

/**
 * Identify HTF liquidity levels from swing points on higher timeframe candles.
 * BSL (Buy-Side Liquidity) = resting above swing highs (buy stops)
 * SSL (Sell-Side Liquidity) = resting below swing lows (sell stops)
 */
export function identifyHTFLiquidity(
  htfCandles: Candle[],
  htfSwings: SwingPoint[],
  timeframe: '1H' | '4H' | '1D' | '1W'
): HTFLiquidityLevel[] {
  const levels: HTFLiquidityLevel[] = [];

  for (const swing of htfSwings) {
    const type = swing.type === 'HIGH' ? 'BSL' : 'SSL';
    levels.push({
      price: swing.price,
      timeframe,
      type,
      classification: 'ERL', // default, will be reclassified
      strength: swing.volume > 0 ? Math.min(100, Math.round(swing.volume / 10000)) : 50,
      touches: 1,
      swept: false,
      originTime: swing.time,
    });
  }

  // Add range highs/lows if we have enough data
  if (htfCandles.length >= 5) {
    const recentHigh = Math.max(...htfCandles.slice(-5).map(c => c.high));
    const recentLow = Math.min(...htfCandles.slice(-5).map(c => c.low));

    levels.push({
      price: recentHigh,
      timeframe,
      type: 'BSL',
      classification: 'ERL',
      strength: 70,
      touches: htfCandles.filter(c => Math.abs(c.high - recentHigh) / recentHigh < 0.001).length,
      swept: false,
      originTime: htfCandles[htfCandles.length - 1].time,
    });

    levels.push({
      price: recentLow,
      timeframe,
      type: 'SSL',
      classification: 'ERL',
      strength: 70,
      touches: htfCandles.filter(c => Math.abs(c.low - recentLow) / recentLow < 0.001).length,
      swept: false,
      originTime: htfCandles[htfCandles.length - 1].time,
    });
  }

  return levels;
}

/**
 * Classify HTF levels as ERL (External Range Liquidity) or IRL (Internal Range Liquidity).
 *
 * ERL = levels at the extremes of the range (swing highs/lows, range boundaries)
 *       These are where stops rest and are targeted for sweeps.
 * IRL = levels within the range (midpoints, FVGs, order blocks)
 *       These are where price trades to find equilibrium.
 *
 * The classification depends on the current price position:
 * - If price is between two HTF levels, the outer ones are ERL, inner ones are IRL
 */
export function classifyERLIRL(
  levels: HTFLiquidityLevel[],
  currentPrice: number
): { erlLevels: HTFLiquidityLevel[]; irlLevels: HTFLiquidityLevel[] } {
  if (levels.length === 0) return { erlLevels: [], irlLevels: [] };

  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const highestPrice = sorted[sorted.length - 1].price;
  const lowestPrice = sorted[0].price;
  const rangeSize = highestPrice - lowestPrice;

  if (rangeSize <= 0) return { erlLevels: levels, irlLevels: [] };

  const erlLevels: HTFLiquidityLevel[] = [];
  const irlLevels: HTFLiquidityLevel[] = [];

  for (const level of levels) {
    const distFromHigh = (highestPrice - level.price) / rangeSize;
    const distFromLow = (level.price - lowestPrice) / rangeSize;
    const distFromMid = Math.abs(level.price - (highestPrice + lowestPrice) / 2) / rangeSize;

    // ERL: levels at extremes (within 20% of range boundary)
    // IRL: levels near the midpoint (within 30% of midpoint)
    if (distFromHigh < 0.2 || distFromLow < 0.2) {
      erlLevels.push({ ...level, classification: 'ERL' });
    } else if (distFromMid < 0.3) {
      irlLevels.push({ ...level, classification: 'IRL' });
    } else {
      // Between ERL and IRL — classify based on which is closer
      const minDist = Math.min(distFromHigh, distFromLow, distFromMid);
      if (minDist === distFromMid) {
        irlLevels.push({ ...level, classification: 'IRL' });
      } else {
        erlLevels.push({ ...level, classification: 'ERL' });
      }
    }
  }

  return { erlLevels, irlLevels };
}

/**
 * Detect sweeps on HTF liquidity levels using intraday candles.
 */
export function detectHTFSweeps(
  intradayCandles: Candle[],
  htfLevels: HTFLiquidityLevel[],
  threshold: number = 0.001
): HTFLiquidityLevel[] {
  for (let i = 1; i < intradayCandles.length; i++) {
    const c = intradayCandles[i];
    const prev = intradayCandles[i - 1];

    for (const level of htfLevels) {
      if (level.swept) continue;

      if (level.type === 'BSL') {
        // Sweep above: wick above level but close below
        const sweepLevel = level.price * (1 + threshold);
        if (c.high >= sweepLevel && c.close < level.price) {
          level.swept = true;
          level.sweepTime = c.time;
        }
      } else {
        // Sweep below: wick below level but close above
        const sweepLevel = level.price * (1 - threshold);
        if (c.low <= sweepLevel && c.close > level.price) {
          level.swept = true;
          level.sweepTime = c.time;
        }
      }
    }
  }

  return htfLevels;
}

/**
 * Full HTF liquidity analysis — combines aggregation, swing detection,
 * level identification, ERL/IRL classification, and sweep detection.
 */
export function analyzeHTFLiquidity(
  intradayCandles: Candle[],
  htf1h?: Candle[],
  htf4h?: Candle[],
  htf1d?: Candle[],
  htf1w?: Candle[]
): HTFLiquidityResult {
  const allLevels: HTFLiquidityLevel[] = [];

  // Process each timeframe
  const timeframes: Array<{ tf: '1H' | '4H' | '1D' | '1W'; data?: Candle[] }> = [
    { tf: '1H', data: htf1h },
    { tf: '4H', data: htf4h },
    { tf: '1D', data: htf1d },
    { tf: '1W', data: htf1w },
  ];

  for (const { tf, data } of timeframes) {
    if (!data || data.length < 5) continue;
    const htfSwings = detectHTFSwings(data);
    const levels = identifyHTFLiquidity(data, htfSwings, tf);
    allLevels.push(...levels);
  }

  // If no HTF data provided, aggregate from intraday
  if (allLevels.length === 0 && intradayCandles.length > 20) {
    const h1Candles = aggregateToHTF(intradayCandles, '1H');
    const d1Candles = aggregateToHTF(intradayCandles, '1D');

    if (h1Candles.length >= 5) {
      const h1Swings = detectHTFSwings(h1Candles);
      allLevels.push(...identifyHTFLiquidity(h1Candles, h1Swings, '1H'));
    }
    if (d1Candles.length >= 5) {
      const d1Swings = detectHTFSwings(d1Candles);
      allLevels.push(...identifyHTFLiquidity(d1Candles, d1Swings, '1D'));
    }
  }

  // Classify ERL/IRL
  const currentPrice = intradayCandles[intradayCandles.length - 1]?.close || 0;
  const { erlLevels, irlLevels } = classifyERLIRL(allLevels, currentPrice);

  // Detect sweeps
  detectHTFSweeps(intradayCandles, allLevels);

  // Find nearest BSL and SSL
  const unsweptBSL = allLevels.filter(l => l.type === 'BSL' && !l.swept && l.price > currentPrice);
  const unsweptSSL = allLevels.filter(l => l.type === 'SSL' && !l.swept && l.price < currentPrice);

  const nearestBSL = unsweptBSL.length > 0
    ? unsweptBSL.reduce((nearest, l) => l.price < nearest.price ? l : nearest)
    : null;
  const nearestSSL = unsweptSSL.length > 0
    ? unsweptSSL.reduce((nearest, l) => l.price > nearest.price ? l : nearest)
    : null;

  // Bias: if nearest BSL is closer than SSL → bullish (price targeting buy stops)
  // If nearest SSL is closer → bearish (price targeting sell stops)
  let currentBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (nearestBSL && nearestSSL) {
    const distToBSL = (nearestBSL.price - currentPrice) / currentPrice;
    const distToSSL = (currentPrice - nearestSSL.price) / currentPrice;
    if (distToBSL < distToSSL * 0.8) currentBias = 'BULLISH';
    else if (distToSSL < distToBSL * 0.8) currentBias = 'BEARISH';
  } else if (nearestBSL) {
    currentBias = 'BULLISH';
  } else if (nearestSSL) {
    currentBias = 'BEARISH';
  }

  return {
    htfLevels: allLevels,
    erlLevels,
    irlLevels,
    nearestBSL,
    nearestSSL,
    currentBias,
  };
}

/**
 * Score HTF liquidity alignment for trade intelligence.
 * Returns 0-100 score indicating how well HTF levels support a directional trade.
 */
export function htfLiquidityScore(
  htfResult: HTFLiquidityResult,
  direction: 'BULLISH' | 'BEARISH'
): number {
  if (htfResult.htfLevels.length === 0) return 50;

  let score = 50;

  // Aligned bias
  if (htfResult.currentBias === direction) score += 25;
  else if (htfResult.currentBias !== 'NEUTRAL') score -= 15;

  // ERL proximity (near ERL = strong S/R)
  const erlCount = htfResult.erlLevels.filter(l => !l.swept).length;
  if (erlCount >= 4) score += 15;
  else if (erlCount >= 2) score += 10;

  // Sweep opportunities (unswept SSL for bullish, unswept BSL for bearish)
  if (direction === 'BULLISH' && htfResult.nearestSSL) {
    const dist = Math.abs(htfResult.nearestSSL.price - (htfResult.nearestSSL.price * 0)) / htfResult.nearestSSL.price;
    if (htfResult.nearestSSL.strength > 60) score += 10;
  }
  if (direction === 'BEARISH' && htfResult.nearestBSL) {
    if (htfResult.nearestBSL.strength > 60) score += 10;
  }

  return Math.max(0, Math.min(100, score));
}