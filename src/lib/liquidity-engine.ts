// Liquidity Engine - Identifies liquidity levels, sweeps, failed breakouts

import { Candle, LiquidityLevel, LiquidityEvent, SwingPoint } from './auction-types';

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