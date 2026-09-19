// MTF Signal Engine
// 15M trend filter → 5M primary signal → 3M entry confirmation → composite score
// PURE COMPUTATION — no data fetching.

import type { TimeframeIndicators } from './mtf-indicator-engine';
import { DEFAULT_MTF_CONFIG, type MTFEngineConfig, type SignalWeights } from './mtf-config';

// ─── Types ─────────────────────────────────────────────────────────

export type MTFSignalAction = "BUY_CE" | "BUY_PE" | "WAIT" | "INVALID";

export interface SignalFactor {
  name: string;
  score: number;       // -100 to +100 (negative = bearish, positive = bullish)
  weight: number;
  weightedScore: number;
  reason: string;
}

export interface MTFSignalResult {
  action: MTFSignalAction;
  compositeScore: number;  // -100 to +100
  confidence: number;      // 0 to 100
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  factors: SignalFactor[];
  entry: {
    spot: number;
    suggestedEntry: number;
    stopLoss: number;
    target1: number;
    target2: number;
    rrRatio: number;
  } | null;
  trend: {
    primary: string;
    signal: string;
    entry: string;
    trendDirection: string;
    trendAge: number;
  };
  dataQuality: {
    trendTF: number;
    signalTF: number;
    entryTF: number;
  };
  reasons: string[];
  timestamp: number;
}

// ─── 15M Trend Filter ──────────────────────────────────────────────

function scoreTrend15m(tf: TimeframeIndicators | undefined): { score: number; reason: string } {
  if (!tf) return { score: 0, reason: "15M data unavailable" };

  let bullish = 0;
  let bearish = 0;
  const reasons: string[] = [];

  if (tf.supertrend) {
    if (tf.supertrend.direction === "UP") {
      bullish += 40;
      reasons.push(`ST UP ${tf.supertrend.trendAge} bars`);
    } else {
      bearish += 40;
      reasons.push(`ST DOWN ${tf.supertrend.trendAge} bars`);
    }
  }

  if (tf.ema.slope > 0.05) { bullish += 25; reasons.push(`EMA slope +${tf.ema.slope.toFixed(2)}%`); }
  else if (tf.ema.slope < -0.05) { bearish += 25; reasons.push(`EMA slope ${tf.ema.slope.toFixed(2)}%`); }

  if (tf.structure.trend === "UPTREND") { bullish += 20; reasons.push("Structure UPTREND"); }
  else if (tf.structure.trend === "DOWNTREND") { bearish += 20; reasons.push("Structure DOWNTREND"); }

  if (tf.vwap.above) { bullish += 15; reasons.push(`Above VWAP +${tf.vwap.distancePercent.toFixed(1)}%`); }
  else { bearish += 15; reasons.push(`Below VWAP ${tf.vwap.distancePercent.toFixed(1)}%`); }

  return { score: Math.max(-100, Math.min(100, bullish - bearish)), reason: reasons.join("; ") };
}

// ─── 5M Signal Scoring ─────────────────────────────────────────────

function scoreSignal5m(
  tf: TimeframeIndicators | undefined,
  direction: "BULLISH" | "BEARISH",
  weights: SignalWeights,
): { score: number; reasons: string[] } {
  if (!tf) return { score: 0, reasons: ["5M data unavailable"] };

  let score = 0;
  const reasons: string[] = [];

  // SuperTrend alignment (weight 15)
  if (tf.supertrend) {
    const aligned = (direction === "BULLISH" && tf.supertrend.direction === "UP") ||
                    (direction === "BEARISH" && tf.supertrend.direction === "DOWN");
    if (aligned) {
      const bonus = Math.min(30, 15 + tf.supertrend.trendAge * 2);
      score += bonus;
      reasons.push(`ST aligned ${tf.supertrend.direction} (+${bonus})`);
    } else {
      score -= 30;
      reasons.push(`ST counter ${tf.supertrend.direction} (-30)`);
    }
  }

  // RSI (weight 15)
  if (direction === "BULLISH" && tf.rsi < 70) {
    const rsiScore = tf.rsi < 30 ? 25 : tf.rsi < 50 ? 15 : 5;
    score += rsiScore;
    reasons.push(`RSI ${tf.rsi.toFixed(0)} (+${rsiScore})`);
  } else if (direction === "BEARISH" && tf.rsi > 30) {
    const rsiScore = tf.rsi > 70 ? 25 : tf.rsi > 50 ? 15 : 5;
    score += rsiScore;
    reasons.push(`RSI ${tf.rsi.toFixed(0)} (+${rsiScore})`);
  } else {
    score -= 10;
    reasons.push(`RSI ${tf.rsi.toFixed(0)} hostile (-10)`);
  }

  // Pivot breakout (weight 15)
  if (tf.pivots) {
    if (direction === "BULLISH" && (tf.pivots.nearest === "R1" || tf.pivots.nearest === "R2")) {
      score += 20;
      reasons.push(`Near ${tf.pivots.nearest} breakout (+20)`);
    } else if (direction === "BEARISH" && (tf.pivots.nearest === "S1" || tf.pivots.nearest === "S2")) {
      score += 20;
      reasons.push(`Near ${tf.pivots.nearest} breakdown (+20)`);
    } else {
      reasons.push(`Near ${tf.pivots.nearest} (neutral)`);
    }
  }

  // Bollinger (weight 10)
  if (direction === "BULLISH" && tf.bollinger.position < 0.2) {
    score += 15;
    reasons.push("BB near lower band bounce (+15)");
  } else if (direction === "BEARISH" && tf.bollinger.position > 0.8) {
    score += 15;
    reasons.push("BB near upper band rejection (+15)");
  } else if (tf.bollinger.bandwidth < 2) {
    reasons.push("BB squeeze — breakout imminent");
  }

  // VWAP + Volume (weight 10)
  if (direction === "BULLISH" && tf.vwap.above && tf.volume.aboveAverage) {
    score += 10;
    reasons.push("Above VWAP + high volume (+10)");
  } else if (direction === "BEARISH" && !tf.vwap.above && tf.volume.aboveAverage) {
    score += 10;
    reasons.push("Below VWAP + high volume (+10)");
  }

  // EMA cross bonus
  if ((direction === "BULLISH" && tf.ema.cross === "BULLISH_CROSS") ||
      (direction === "BEARISH" && tf.ema.cross === "BEARISH_CROSS")) {
    score += 10;
    reasons.push(`EMA ${tf.ema.cross} (+10)`);
  }

  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

// ─── 3M Entry Confirmation ─────────────────────────────────────────

function scoreEntry3m(
  tf: TimeframeIndicators | undefined,
  direction: "BULLISH" | "BEARISH",
): { score: number; reason: string } {
  if (!tf) return { score: 0, reason: "3M/5M entry TF data unavailable" };

  let score = 0;
  const reasons: string[] = [];

  // SuperTrend alignment on entry TF (strongest confirmation)
  if (tf.supertrend) {
    const aligned = (direction === "BULLISH" && tf.supertrend.direction === "UP") ||
                    (direction === "BEARISH" && tf.supertrend.direction === "DOWN");
    if (aligned) { score += 30; reasons.push(`Entry ST aligned ${tf.supertrend.direction}`); }
    else { score -= 20; reasons.push(`Entry ST counter ${tf.supertrend.direction}`); }
  }

  // RSI entry zone
  if (direction === "BULLISH" && tf.rsi >= 30 && tf.rsi <= 55) {
    score += 20;
    reasons.push("RSI in buy zone 30-55");
  } else if (direction === "BEARISH" && tf.rsi >= 45 && tf.rsi <= 70) {
    score += 20;
    reasons.push("RSI in sell zone 45-70");
  }

  // VWAP confirmation
  if (direction === "BULLISH" && tf.vwap.above) {
    score += 10;
    reasons.push("Above VWAP");
  } else if (direction === "BEARISH" && !tf.vwap.above) {
    score += 10;
    reasons.push("Below VWAP");
  }

  // Volume spike
  if (tf.volume.ratio > 1.2) {
    score += 10;
    reasons.push(`Volume ${tf.volume.ratio.toFixed(1)}x avg`);
  }

  // EMA slope on entry TF
  if (direction === "BULLISH" && tf.ema.slope > 0.02) {
    score += 5;
    reasons.push("Entry EMA sloping up");
  } else if (direction === "BEARISH" && tf.ema.slope < -0.02) {
    score += 5;
    reasons.push("Entry EMA sloping down");
  }

  return { score: Math.max(-100, Math.min(100, score)), reason: reasons.join("; ") };
}

// ─── Main Entry Point ──────────────────────────────────────────────

export function generateMTFSignal(
  indicators: Record<string, TimeframeIndicators>,
  config: Partial<MTFEngineConfig> = {},
): MTFSignalResult {
  const cfg = { ...DEFAULT_MTF_CONFIG, ...config };
  const w = cfg.weights;
  const tfTrend = cfg.timeframes.trend;
  const tfSignal = cfg.timeframes.signal;
  const tfEntry = cfg.timeframes.entry;

  const trendTF = indicators[tfTrend];
  const signalTF = indicators[tfSignal];
  const entryTF = indicators[tfEntry];

  const reasons: string[] = [];
  const factors: SignalFactor[] = [];

  // Step 1: 15M Trend Filter
  const trendResult = scoreTrend15m(trendTF);
  factors.push({
    name: "15M Trend",
    score: trendResult.score,
    weight: w.trend15m,
    weightedScore: Math.round(trendResult.score * w.trend15m / 100),
    reason: trendResult.reason,
  });

  // Reject if 15M strongly counters — but still compute for reporting
  const trendDirection: "BULLISH" | "BEARISH" | "NEUTRAL" =
    trendResult.score > 15 ? "BULLISH" : trendResult.score < -15 ? "BEARISH" : "NEUTRAL";

  if (trendDirection === "NEUTRAL") {
    reasons.push("15M trend neutral — no clear direction");
  } else if (trendDirection === "BULLISH") {
    reasons.push(`15M BULLISH (score: ${trendResult.score})`);
  } else {
    reasons.push(`15M BEARISH (score: ${trendResult.score})`);
  }

  // Step 2: 5M Signal Scoring
  if (trendDirection !== "NEUTRAL") {
    const signalResult = scoreSignal5m(signalTF, trendDirection, w);
    factors.push({
      name: "5M Signal",
      score: signalResult.score,
      weight: w.supertrend5m + w.rsi + w.pivot + w.bollinger + w.vwapVolume,
      weightedScore: Math.round(signalResult.score * (w.supertrend5m + w.rsi + w.pivot + w.bollinger + w.vwapVolume) / 100),
      reason: signalResult.reasons.join("; "),
    });

    // Step 3: 3M Entry Confirmation
    const entryResult = scoreEntry3m(entryTF, trendDirection);
    factors.push({
      name: "3M Entry",
      score: entryResult.score,
      weight: w.entry3m,
      weightedScore: Math.round(entryResult.score * w.entry3m / 100),
      reason: entryResult.reason,
    });

    // Composite score
    const compositeScore = factors.reduce((sum, f) => sum + f.weightedScore, 0);
    const confidence = Math.min(100, Math.max(0, Math.abs(compositeScore)));
    const direction = compositeScore > 0 ? "BULLISH" : compositeScore < 0 ? "BEARISH" : "NEUTRAL";

    // Action determination
    let action: MTFSignalAction = "WAIT";
    if (confidence >= cfg.minScore) {
      action = direction === "BULLISH" ? "BUY_CE" : direction === "BEARISH" ? "BUY_PE" : "WAIT";
    }

    // Entry/SL/TP using spot + ATR
    const spot = signalTF?.lastPrice || trendTF?.lastPrice || 0;
    const atr = (signalTF?.atr || trendTF?.atr || 0);
    const entry = spot;
    const sl = direction === "BULLISH" ? spot - atr : spot + atr;
    const tp1 = direction === "BULLISH" ? spot + atr * 1.5 : spot - atr * 1.5;
    const tp2 = direction === "BULLISH" ? spot + atr * 2.5 : spot - atr * 2.5;
    const rrRatio = atr > 0 ? Math.abs(tp1 - entry) / Math.abs(entry - sl) : 0;

    return {
      action,
      compositeScore: Math.round(compositeScore),
      confidence: Math.round(confidence),
      direction,
      factors,
      entry: spot > 0 && atr > 0 ? {
        spot: Math.round(spot * 100) / 100,
        suggestedEntry: Math.round(entry * 100) / 100,
        stopLoss: Math.round(sl * 100) / 100,
        target1: Math.round(tp1 * 100) / 100,
        target2: Math.round(tp2 * 100) / 100,
        rrRatio: Math.round(rrRatio * 100) / 100,
      } : null,
      trend: {
        primary: tfTrend,
        signal: tfSignal,
        entry: tfEntry,
        trendDirection: trendDirection,
        trendAge: trendTF?.supertrend?.trendAge ?? 0,
      },
      dataQuality: {
        trendTF: trendTF?.candleCount ?? 0,
        signalTF: signalTF?.candleCount ?? 0,
        entryTF: entryTF?.candleCount ?? 0,
      },
      reasons,
      timestamp: Date.now(),
    };
  }

  // Trend neutral or unavailable
  factors.push({
    name: "5M Signal",
    score: 0,
    weight: 0,
    weightedScore: 0,
    reason: "Skipped — 15M trend not available",
  });
  factors.push({
    name: "3M Entry",
    score: 0,
    weight: 0,
    weightedScore: 0,
    reason: "Skipped — 15M trend not available",
  });

  return {
    action: "WAIT",
    compositeScore: 0,
    confidence: 0,
    direction: "NEUTRAL",
    factors,
    entry: null,
    trend: {
      primary: tfTrend,
      signal: tfSignal,
      entry: tfEntry,
      trendDirection: "NEUTRAL",
      trendAge: 0,
    },
    dataQuality: {
      trendTF: trendTF?.candleCount ?? 0,
      signalTF: signalTF?.candleCount ?? 0,
      entryTF: entryTF?.candleCount ?? 0,
    },
    reasons,
    timestamp: Date.now(),
  };
}
