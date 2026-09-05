// ═══════════════════════════════════════════════════════════════════════════
// SuperTrend Engine
// ATR-based trend filter — standard indicator ported from TradingView.
// Used as a trend confirmation filter across all trade modes.
//
// SuperTrend = ATR-based envelope that flips direction based on volatility.
// When price is above SuperTrend → bullish. Below → bearish.
// ═══════════════════════════════════════════════════════════════════════════

export interface SuperTrendCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SuperTrendBar {
  time: number;
  value: number;
  direction: "UP" | "DOWN";
}

export interface SuperTrendResult {
  bars: SuperTrendBar[];
  currentDirection: "UP" | "DOWN";
  currentValue: number;
  trendAge: number; // bars since last flip
  flips: number;    // total flip count
}

export interface SuperTrendConfig {
  period: number;    // ATR period (default 10)
  multiplier: number; // ATR multiplier (default 3.0)
}

const DEFAULT_ST_CONFIG: SuperTrendConfig = {
  period: 10,
  multiplier: 3.0,
};

// ─── ATR Calculation ──────────────────────────────────────────────

function computeATR(candles: SuperTrendCandle[], period: number): number[] {
  if (candles.length < 2) return candles.map(() => 0);

  const tr: number[] = [candles[0].high - candles[0].low];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const hl = c.high - c.low;
    const hc = Math.abs(c.high - prev.close);
    const lc = Math.abs(c.low - prev.close);
    tr.push(Math.max(hl, hc, lc));
  }

  // Wilder's smoothed ATR
  const atr: number[] = [];
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period) {
      sum += tr[i];
      atr.push(sum / (i + 1));
    } else {
      atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
  }

  return atr;
}

// ─── SuperTrend Computation ───────────────────────────────────────

export function computeSuperTrend(
  candles: SuperTrendCandle[],
  config: Partial<SuperTrendConfig> = {}
): SuperTrendResult {
  const cfg = { ...DEFAULT_ST_CONFIG, ...config };
  const atr = computeATR(candles, cfg.period);
  const bars: SuperTrendBar[] = [];
  let flips = 0;

  if (candles.length < cfg.period + 1) {
    return {
      bars: [],
      currentDirection: "UP",
      currentValue: 0,
      trendAge: 0,
      flips: 0,
    };
  }

  let prevUpperBand = 0;
  let prevLowerBand = 0;
  let prevDirection: "UP" | "DOWN" = "UP";
  let trendAge = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;

    let upperBand = hl2 + cfg.multiplier * atr[i];
    let lowerBand = hl2 - cfg.multiplier * atr[i];

    // Keep bands from moving against the trend
    if (i > 0) {
      if (lowerBand < prevLowerBand || candles[i - 1].close < prevLowerBand) {
        lowerBand = prevLowerBand;
      } else {
        lowerBand = lowerBand;
      }
      if (upperBand > prevUpperBand || candles[i - 1].close > prevUpperBand) {
        upperBand = prevUpperBand;
      } else {
        upperBand = upperBand;
      }
    }

    let direction: "UP" | "DOWN";

    if (i === 0) {
      direction = "UP";
    } else if (prevDirection === "UP") {
      direction = c.close < lowerBand ? "DOWN" : "UP";
    } else {
      direction = c.close > upperBand ? "UP" : "DOWN";
    }

    if (direction !== prevDirection) {
      flips++;
      trendAge = 0;
    } else {
      trendAge++;
    }

    const value = direction === "UP" ? lowerBand : upperBand;
    bars.push({ time: c.time, value: Math.round(value * 100) / 100, direction });

    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
    prevDirection = direction;
  }

  const last = bars[bars.length - 1];

  return {
    bars,
    currentDirection: last.direction,
    currentValue: last.value,
    trendAge,
    flips,
  };
}

// ─── Convenience: Score factor for trade intelligence ──────────────

export function supertrendToScore(
  result: SuperTrendResult,
  direction: "BULLISH" | "BEARISH",
  candles: SuperTrendCandle[]
): number {
  if (result.bars.length === 0) return 50;

  const aligned = (direction === "BULLISH" && result.currentDirection === "UP") ||
                  (direction === "BEARISH" && result.currentDirection === "DOWN");

  const lastCandle = candles[candles.length - 1];
  const distFromST = Math.abs(lastCandle.close - result.currentValue) / result.currentValue;

  if (aligned && distFromST > 0.01) return 90;  // strong trend, far from ST
  if (aligned && distFromST > 0.003) return 80; // trend intact
  if (aligned) return 70;                        // near ST but aligned
  if (!aligned && distFromST < 0.002) return 40; // close to flip
  if (!aligned) return 20;                       // counter-trend

  return 50;
}

// ─── Convenience: Boolean filter ──────────────────────────────────

export function supertrendFilter(
  result: SuperTrendResult,
  direction: "BULLISH" | "BEARISH"
): { passes: boolean; reason: string } {
  if (result.bars.length === 0) {
    return { passes: true, reason: "No SuperTrend data — filter bypassed" };
  }

  const aligned = (direction === "BULLISH" && result.currentDirection === "UP") ||
                  (direction === "BEARISH" && result.currentDirection === "DOWN");

  if (aligned) {
    return { passes: true, reason: `SuperTrend ${result.currentDirection} — aligned with ${direction}` };
  }

  // Counter-trend: only allow if very recent flip (potential reversal)
  if (result.trendAge <= 2) {
    return { passes: true, reason: `SuperTrend just flipped ${result.currentDirection} — possible reversal entry` };
  }

  return {
    passes: false,
    reason: `SuperTrend ${result.currentDirection} for ${result.trendAge} bars — counter-trend ${direction} rejected`,
  };
}
