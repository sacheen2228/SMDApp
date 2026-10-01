/*
 * Liquidity Zones — Stock-specific liquidity-sweep detection.
 *
 * NEW module. Does NOT touch frozen `src/lib/jarvis/strategy.ts`.
 * The index's S3 (liquidity-sweep reversal) stays as-is in jarvis/strategy.ts —
 * this module is what the STOCK strategy set calls for LIQUID_STOCK instruments.
 *
 * Pattern: stop-loss clusters form at equal highs/lows, PDH/PDL,
 * opening-range extremes, and round numbers. A wick through the level
 * that closes back inside with opposite-side confirmation = reversal.
 * A close-and-hold beyond it = breakout.
 *
 * Status: NEW strategy — does NOT inherit index S3's validated status.
 * Own 30-trade expectancy bar required before being trusted.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface LiquidityPool {
  level: number;
  source:
    | "pdh"
    | "pdl"
    | "or_high"
    | "or_low"
    | "equal_highs"
    | "equal_lows"
    | "round_number"
    | "week_high"
    | "week_low";
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SweepEvent {
  pool: LiquidityPool;
  sweepPrice: number;           // the wick extreme
  closeBackInside: boolean;     // true = reversal candidate, false = breakout candidate
  oppositeOiConfirmation: boolean; // OI added on opposite side at the extreme
  volumeSpike: boolean;
  candlesToReclose: number;     // how many bars it took to close back inside
}

export interface SweepOptions {
  /** Average volume over recent bars — used to detect volume spike */
  avgVolume: number;
  /**
   * OI change near the swept level (from option chain).
   * Positive = OI added on opposite side (confirmation).
   * Pass `null` if OI data unavailable (e.g. non-optionable instrument).
   */
  oppositeOiChange: number | null;
  /**
   * Threshold for volume spike: volume > avgVolume * volumeSpikeMultiplier.
   * Default 1.5x.
   */
  volumeSpikeMultiplier?: number;
}

// ─── Round-number step ──────────────────────────────────────────────

/**
 * Derive round-number step from price magnitude.
 * NOT a fixed constant — scales with the instrument's price.
 *
 * Examples:
 *   ₹150 stock  → step 10
 *   ₹450 stock  → step 10
 *   ₹850 stock  → step 20
 *   ₹2,200 stock → step 50
 *   ₹3,500 stock → step 100
 *   ₹24,000 NIFTY → step 100
 *   ₹1,500 stock → step 50
 */
export function roundNumberStep(price: number): number {
  const abs = Math.abs(price);

  if (abs <= 0) return 1;
  if (abs < 100) return 5;
  if (abs < 500) return 10;
  if (abs < 1000) return 20;
  if (abs < 2000) return 50;
  if (abs < 5000) return 100;
  if (abs < 10000) return 100;
  if (abs < 50000) return 100;
  return 500; // for very high-priced instruments
}

// ─── Liquidity pool detection ───────────────────────────────────────

export function detectLiquidityPools(
  ohlc: {
    pdh?: number;
    pdl?: number;
    orHigh?: number;
    orLow?: number;
    weekHigh?: number;
    weekLow?: number;
    /** Current spot price — used to derive round-number step */
    spot?: number;
  },
  roundStep?: number
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];

  // PDH/PDL
  if (ohlc.pdh != null && ohlc.pdh > 0) {
    pools.push({ level: ohlc.pdh, source: "pdh" });
  }
  if (ohlc.pdl != null && ohlc.pdl > 0) {
    pools.push({ level: ohlc.pdl, source: "pdl" });
  }

  // Opening range extremes
  if (ohlc.orHigh != null && ohlc.orHigh > 0) {
    pools.push({ level: ohlc.orHigh, source: "or_high" });
  }
  if (ohlc.orLow != null && ohlc.orLow > 0) {
    pools.push({ level: ohlc.orLow, source: "or_low" });
  }

  // Week high/low
  if (ohlc.weekHigh != null && ohlc.weekHigh > 0) {
    pools.push({ level: ohlc.weekHigh, source: "week_high" });
  }
  if (ohlc.weekLow != null && ohlc.weekLow > 0) {
    pools.push({ level: ohlc.weekLow, source: "week_low" });
  }

  // Round numbers — step derived from price magnitude
  const spot = ohlc.spot ?? 0;
  const step = roundStep ?? roundNumberStep(spot);
  if (spot > 0 && step > 0) {
    const nearestAbove = Math.ceil(spot / step) * step;
    const nearestBelow = Math.floor(spot / step) * step;
    // Only add if distinct from spot
    if (nearestAbove !== spot) {
      pools.push({ level: nearestAbove, source: "round_number" });
    }
    if (nearestBelow !== spot && nearestBelow > 0) {
      pools.push({ level: nearestBelow, source: "round_number" });
    }
  }

  return pools;
}

// ─── Equal highs / equal lows detection ─────────────────────────────

/**
 * Detect equal highs/lows from a candle series — clusters where multiple
 * bars print the same high (or low) within a small tolerance.
 */
export function detectEqualLevels(
  candles: Candle[],
  tolerancePct: number = 0.2
): LiquidityPool[] {
  if (candles.length < 3) return [];

  const pools: LiquidityPool[] = [];
  const tolerance = tolerancePct / 100;

  // Equal highs: group highs that are within tolerance of each other
  const highs = candles.map((c) => c.high).sort((a, b) => a - b);
  const lows = candles.map((c) => c.low).sort((a, b) => a - b);

  const findClusters = (
    values: number[],
    source: "equal_highs" | "equal_lows"
  ): void => {
    let clusterStart = 0;
    for (let i = 1; i <= values.length; i++) {
      const withinCluster =
        i < values.length &&
        Math.abs(values[i] - values[clusterStart]) / values[clusterStart] <=
          tolerance;

      if (!withinCluster) {
        const clusterSize = i - clusterStart;
        if (clusterSize >= 3) {
          // 3+ touches = significant level
          const level =
            values
              .slice(clusterStart, i)
              .reduce((s, v) => s + v, 0) / clusterSize;
          pools.push({ level, source });
        }
        clusterStart = i;
      }
    }
  };

  findClusters(highs, "equal_highs");
  findClusters(lows, "equal_lows");

  return pools;
}

// ─── Sweep detection ────────────────────────────────────────────────

/**
 * Detect sweep events from a candle series against known liquidity pools.
 *
 * A sweep occurs when a candle's wick pierces a pool level but the close
 * returns inside (reversal candidate) or holds beyond (breakout candidate).
 *
 * The crux: reversal = wick through + close back inside within `maxBarsToReturn`.
 * Breakout = close and hold beyond the level (no return inside within window).
 */
export function detectSweep(
  candles: Candle[],
  pools: LiquidityPool[],
  options: SweepOptions,
  maxBarsToReturn: number = 2
): SweepEvent[] {
  if (candles.length === 0 || pools.length === 0) return [];

  const events: SweepEvent[] = [];
  const volMult = options.volumeSpikeMultiplier ?? 1.5;

  for (const pool of pools) {
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];

      // Determine sweep direction from the candle's OPEN (approach side):
      // - Open below level → price approached from below → only high can sweep up through
      // - Open above level → price approached from above → only low can sweep down through
      // This prevents false positives when a candle's entire range is on one side.
      const approachFromBelow = candle.open < pool.level;
      const approachFromAbove = candle.open > pool.level;

      let direction: "upside" | "downside" | null = null;

      if (approachFromBelow && candle.high > pool.level) {
        direction = "upside";
      } else if (approachFromAbove && candle.low < pool.level) {
        direction = "downside";
      } else if (!approachFromBelow && !approachFromAbove && candle.open === pool.level) {
        // Open exactly at level — check which wick pierced
        if (candle.high > pool.level) direction = "upside";
        else if (candle.low < pool.level) direction = "downside";
      }

      if (!direction) continue;

      let closeBackInside = false;
      let candlesToReclose = 0;
      let sweepPrice = 0;

      if (direction === "upside") {
        sweepPrice = candle.high;
        if (candle.close <= pool.level) {
          closeBackInside = true;
          candlesToReclose = 0;
        } else {
          for (let j = i + 1; j < Math.min(i + 1 + maxBarsToReturn, candles.length); j++) {
            if (candles[j].close <= pool.level) {
              closeBackInside = true;
              candlesToReclose = j - i;
              break;
            }
          }
        }
      } else {
        // downside
        sweepPrice = candle.low;
        if (candle.close >= pool.level) {
          closeBackInside = true;
          candlesToReclose = 0;
        } else {
          for (let j = i + 1; j < Math.min(i + 1 + maxBarsToReturn, candles.length); j++) {
            if (candles[j].close >= pool.level) {
              closeBackInside = true;
              candlesToReclose = j - i;
              break;
            }
          }
        }
      }

      // Volume spike check
      const volumeSpike = candle.volume > options.avgVolume * volMult;

      // Opposite OI confirmation
      const oppositeOiConfirmation =
        options.oppositeOiChange != null && options.oppositeOiChange > 0;

      events.push({
        pool,
        sweepPrice,
        closeBackInside,
        oppositeOiConfirmation,
        volumeSpike,
        candlesToReclose,
      });

      // Only first sweep per pool per candle sequence
      break;
    }
  }

  return events;
}

// ─── Sweep quality assessment ───────────────────────────────────────

export interface SweepQuality {
  /** Reversal candidate (close back inside) vs breakout candidate (hold beyond) */
  type: "REVERSAL" | "BREAKOUT" | "NONE";
  /** Whether there's enough confluence: at least one of OI confirmation or volume spike */
  hasConfluence: boolean;
  reasons: string[];
}

/**
 * Assess the quality of a sweep event.
 * A sweep with NO opposite-OI confirmation and NO volume spike is weak evidence.
 * Require at least one of the two — same confluence discipline as the index playbook.
 */
export function assessSweepQuality(event: SweepEvent): SweepQuality {
  const reasons: string[] = [];
  const hasConfluence =
    event.oppositeOiConfirmation || event.volumeSpike;

  if (event.closeBackInside) {
    reasons.push("Close back inside within window → reversal candidate");
    if (event.candlesToReclose <= 1) {
      reasons.push("Fast reclose (≤1 bar) — stronger reversal signal");
    }
  } else {
    reasons.push("Close and hold beyond → breakout candidate");
  }

  if (event.oppositeOiConfirmation) {
    reasons.push("Opposite-side OI added at extreme — confirms positioning");
  }
  if (event.volumeSpike) {
    reasons.push("Volume spike at sweep — confirms participation");
  }
  if (!hasConfluence) {
    reasons.push(
      "WARNING: No OI confirmation AND no volume spike — weak evidence, insufficient for signal"
    );
  }

  return {
    type: event.closeBackInside ? "REVERSAL" : "BREAKOUT",
    hasConfluence,
    reasons,
  };
}
