// ═══════════════════════════════════════════════════════════════════════════
// MSS (Market Structure Shift) — Sweep-Gated BOS/CHoCH Engine
// Ported from TradingView "SD Ultimate SMC Indicator v10.6"
//
// Key innovation: BOS/CHoCH only CONFIRMS after price sweeps a recent swing
// point. This prevents false breakouts and provides institutional-grade
// entry signals. The sweep acts as a "liquidity grab before the real move."
//
// Signal flow:
//   1. Detect swing points (fractal method)
//   2. Detect raw BOS/CHoCH (break of structure)
//   3. Check if a sweep occurred BEFORE the break (sweep-gating)
//   4. MSS confirms only when: sweep → then break in opposite direction
//   5. Returns sweep-gated signals with confidence scoring
// ═══════════════════════════════════════════════════════════════════════════

export interface MSSCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: "HIGH" | "LOW";
}

export interface SweepEvent {
  time: number;
  swingPrice: number;
  sweepHigh: number;
  sweepLow: number;
  direction: "BULLISH" | "BEARISH"; // direction of the sweep (where stops were taken)
  candleIndex: number;
}

export interface MSSSignal {
  time: number;
  type: "BOS" | "CHoCH";
  direction: "BULLISH" | "BEARISH";
  sweepGated: boolean;
  sweepPrice: number | null;
  breakPrice: number;
  structurePrice: number;
  confidence: number;
  displacement: boolean;
  reasoning: string[];
}

export interface MSSResult {
  signals: MSSSignal[];
  swings: SwingPoint[];
  sweeps: SweepEvent[];
  currentBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  biasStrength: number; // 0-100
  lastSignal: MSSSignal | null;
  structureIntact: boolean;
}

export interface MSSConfig {
  swingLookback: number;
  sweepThreshold: number;    // % beyond swing to count as sweep
  sweepConfirmBars: number;  // max bars between sweep and break
  displacementMultiplier: number; // ATR multiplier for displacement
}

const DEFAULT_CONFIG: MSSConfig = {
  swingLookback: 3,
  sweepThreshold: 0.001,   // 0.1% beyond swing
  sweepConfirmBars: 5,     // sweep must happen within 5 bars of break
  displacementMultiplier: 1.5,
};

// ─── Swing Point Detection ────────────────────────────────────────

export function detectSwings(candles: MSSCandle[], lookback: number = 3): SwingPoint[] {
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
      swings.push({ index: i, time: c.time, price: c.high, type: "HIGH" });
    }

    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (c.low >= candles[i - j].low || c.low >= candles[i + j].low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swings.push({ index: i, time: c.time, price: c.low, type: "LOW" });
    }
  }

  swings.sort((a, b) => a.index - b.index);
  return swings;
}

// ─── Sweep Detection ──────────────────────────────────────────────
// A sweep occurs when price wicks beyond a swing point but closes back
// inside — indicating liquidity was taken (stop hunt) before the real move.

export function detectSweeps(
  candles: MSSCandle[],
  swings: SwingPoint[],
  threshold: number = 0.001
): SweepEvent[] {
  const sweeps: SweepEvent[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    for (const swing of swings) {
      if (swing.index >= i) continue; // only check swings before this candle

      if (swing.type === "HIGH") {
        // Price pierced above swing high but closed below it
        const sweepLevel = swing.price * (1 + threshold);
        if (c.high >= sweepLevel && c.close < swing.price) {
          sweeps.push({
            time: c.time,
            swingPrice: swing.price,
            sweepHigh: c.high,
            sweepLow: c.low,
            direction: "BEARISH", // took buy-side liquidity → bearish
            candleIndex: i,
          });
        }
      } else {
        // Price pierced below swing low but closed above it
        const sweepLevel = swing.price * (1 - threshold);
        if (c.low <= sweepLevel && c.close > swing.price) {
          sweeps.push({
            time: c.time,
            swingPrice: swing.price,
            sweepHigh: c.high,
            sweepLow: c.low,
            direction: "BULLISH", // took sell-side liquidity → bullish
            candleIndex: i,
          });
        }
      }
    }
  }

  return sweeps;
}

// ─── Displacement Detection ───────────────────────────────────────
// A large-range, high-volume candle that closes near its extreme.
// Indicates institutional conviction.

export function detectDisplacement(
  candles: MSSCandle[],
  multiplier: number = 1.5
): boolean[] {
  if (candles.length < 14) return candles.map(() => false);

  const ranges = candles.map(c => c.high - c.low);
  const avgRange = ranges.slice(0, -1).reduce((s, r) => s + r, 0) / (candles.length - 1);
  const volumes = candles.map(c => c.volume);
  const avgVolume = volumes.slice(0, -1).reduce((s, v) => s + v, 0) / (candles.length - 1);

  return candles.map((c, i) => {
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const isLargeRange = range > avgRange * multiplier;
    const isHighVolume = c.volume > avgVolume * 1.2;
    const closeAtExtreme = (c.close - c.low) / (range || 1) > 0.75 ||
                           (c.high - c.close) / (range || 1) > 0.75;
    return isLargeRange && isHighVolume && closeAtExtreme;
  });
}

// ─── Raw BOS/CHoCH Detection ──────────────────────────────────────
// Pre-sweep-gate detection. These are raw structure breaks that may or
// may not be sweep-gated later.

export interface RawStructureBreak {
  index: number;
  time: number;
  type: "BOS" | "CHoCH";
  direction: "BULLISH" | "BEARISH";
  breakPrice: number;
  structurePrice: number;
  trendAtBreak: "BULLISH" | "BEARISH";
}

export function detectRawBreaks(
  candles: MSSCandle[],
  swings: SwingPoint[]
): RawStructureBreak[] {
  const breaks: RawStructureBreak[] = [];
  if (swings.length < 2) return breaks;

  // Determine trend from swing sequence
  const highs = swings.filter(s => s.type === "HIGH");
  const lows = swings.filter(s => s.type === "LOW");

  let trend: "BULLISH" | "BEARISH" = "BULLISH";
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) trend = "BULLISH";
    else if (lh && ll) trend = "BEARISH";
  }

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const recentHighs = swings.filter(s => s.type === "HIGH" && s.index < i);
    const recentLows = swings.filter(s => s.type === "LOW" && s.index < i);

    if (recentHighs.length === 0 || recentLows.length === 0) continue;

    const lastHigh = recentHighs[recentHighs.length - 1];
    const lastLow = recentLows[recentLows.length - 1];

    // BOS bullish: close above swing high in uptrend
    if (c.close > lastHigh.price && trend === "BULLISH") {
      breaks.push({
        index: i, time: c.time, type: "BOS", direction: "BULLISH",
        breakPrice: c.close, structurePrice: lastHigh.price, trendAtBreak: trend,
      });
    }
    // BOS bearish: close below swing low in downtrend
    else if (c.close < lastLow.price && trend === "BEARISH") {
      breaks.push({
        index: i, time: c.time, type: "BOS", direction: "BEARISH",
        breakPrice: c.close, structurePrice: lastLow.price, trendAtBreak: trend,
      });
    }
    // CHoCH bullish: close above swing high in downtrend
    else if (c.close > lastHigh.price && trend === "BEARISH") {
      breaks.push({
        index: i, time: c.time, type: "CHoCH", direction: "BULLISH",
        breakPrice: c.close, structurePrice: lastHigh.price, trendAtBreak: trend,
      });
      trend = "BULLISH"; // trend flips after CHoCH
    }
    // CHoCH bearish: close below swing low in uptrend
    else if (c.close < lastLow.price && trend === "BULLISH") {
      breaks.push({
        index: i, time: c.time, type: "CHoCH", direction: "BEARISH",
        breakPrice: c.close, structurePrice: lastLow.price, trendAtBreak: trend,
      });
      trend = "BEARISH"; // trend flips after CHoCH
    }
  }

  return breaks;
}

// ─── Sweep-Gated MSS Signal ───────────────────────────────────────
// The core logic: a BOS/CHoCH is only confirmed as MSS if a sweep
// occurred within `sweepConfirmBars` bars BEFORE the break.
// The sweep direction must be OPPOSITE to the break direction.

export function gateBreaksWithSweeps(
  breaks: RawStructureBreak[],
  sweeps: SweepEvent[],
  confirmBars: number = 5
): MSSSignal[] {
  const signals: MSSSignal[] = [];

  for (const brk of breaks) {
    // Find sweeps that happened before this break, within confirmBars
    const relevantSweeps = sweeps.filter(s => {
      const barsBetween = brk.index - s.candleIndex;
      return barsBetween > 0 && barsBetween <= confirmBars &&
             s.direction !== brk.direction; // sweep must be opposite to break
    });

    const sweepGated = relevantSweeps.length > 0;
    const sweep = sweepGated ? relevantSweeps[relevantSweeps.length - 1] : null;

    const reasoning: string[] = [];
    if (sweepGated) {
      reasoning.push(`Sweep at ${sweep!.swingPrice.toFixed(0)} (${sweep!.direction}) confirmed ${brk.type}`);
      reasoning.push(`Break at ${brk.breakPrice.toFixed(0)} after ${brk.index - sweep!.candleIndex} bars`);
    } else {
      reasoning.push(`${brk.type} without sweep confirmation — lower confidence`);
    }

    // Confidence: sweep-gated breaks get higher confidence
    let confidence = 50;
    if (sweepGated) confidence += 30;
    if (brk.type === "CHoCH") confidence += 10; // CHoCH is stronger signal
    confidence = Math.min(100, confidence);

    signals.push({
      time: brk.time,
      type: brk.type,
      direction: brk.direction,
      sweepGated,
      sweepPrice: sweep?.swingPrice ?? null,
      breakPrice: brk.breakPrice,
      structurePrice: brk.structurePrice,
      confidence,
      displacement: false, // will be set later
      reasoning,
    });
  }

  return signals;
}

// ─── Main Entry Point ─────────────────────────────────────────────

export function analyzeMSS(
  candles: MSSCandle[],
  config: Partial<MSSConfig> = {}
): MSSResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const swings = detectSwings(candles, cfg.swingLookback);
  const sweeps = detectSweeps(candles, swings, cfg.sweepThreshold);
  const displacement = detectDisplacement(candles, cfg.displacementMultiplier);
  const rawBreaks = detectRawBreaks(candles, swings);
  let signals = gateBreaksWithSweeps(rawBreaks, sweeps, cfg.sweepConfirmBars);

  // Mark displacement on signals
  signals = signals.map(s => ({
    ...s,
    displacement: displacement[s.index] ?? false,
  }));

  // Boost confidence for displacement-confirmed signals
  signals = signals.map(s => ({
    ...s,
    confidence: s.displacement ? Math.min(100, s.confidence + 15) : s.confidence,
    reasoning: s.displacement
      ? [...s.reasoning, "Displacement candle confirms institutional conviction"]
      : s.reasoning,
  }));

  // Determine current bias from most recent signal
  const lastSignal = signals.length > 0 ? signals[signals.length - 1] : null;

  let currentBias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  let biasStrength = 0;

  if (lastSignal) {
    currentBias = lastSignal.direction;
    biasStrength = lastSignal.confidence;
    // Decay strength with distance
    const barsSince = candles.length - 1 - (lastSignal as any).index;
    if (barsSince > 10) biasStrength = Math.max(30, biasStrength - barsSince * 2);
  }

  // Structure is intact if the most recent signal aligns with price action
  const lastCandle = candles[candles.length - 1];
  let structureIntact = true;
  if (lastSignal) {
    if (lastSignal.direction === "BULLISH" && lastCandle.close < lastCandle.open) {
      structureIntact = false;
    }
    if (lastSignal.direction === "BEARISH" && lastCandle.close > lastCandle.open) {
      structureIntact = false;
    }
  }

  return {
    signals,
    swings,
    sweeps,
    currentBias,
    biasStrength,
    lastSignal,
    structureIntact,
  };
}

// ─── Convenience: Score factor for SMC engine ─────────────────────

export function mssToScore(mss: MSSResult, direction: "BULLISH" | "BEARISH"): number {
  if (!mss.lastSignal) return 50;

  const aligned = mss.lastSignal.direction === direction;
  const sweepGated = mss.lastSignal.sweepGated;
  const displacement = mss.lastSignal.displacement;

  if (aligned && sweepGated && displacement) return 95;
  if (aligned && sweepGated) return 85;
  if (aligned && displacement) return 75;
  if (aligned) return 65;
  if (!aligned && sweepGated) return 25; // counter-trend sweep = reversal risk
  return 40;
}
