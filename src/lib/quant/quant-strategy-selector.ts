// quant-strategy-selector.ts — the four independent strategy evaluators for
// the quant engine. PURE: reads only the supplied features/regime/ctx.
//
// ISOLATION: never option selling — the only directions returned are
// BUY_CE / BUY_PE. "SELL" as a bare direction is reserved for future equity
// plans and is never produced by these evaluators either.
//
// Score weights (documented, deterministic, clamped 0-100, 1dp):
//   TREND_CONTINUATION  regime 25 · trend 30 (saturates |trendScore| 0.5%)
//                       ema-alignment 25 · volume 20 (saturates volExp 1.5)
//   BREAKOUT_RETEST     level 30 (prevDay 30 / session 25) · volume 30
//                       retest proximity 40 (1 − dist/tolerance)
//   MEAN_REVERSION      stretch 40 (saturates |vwapDevPct| 2%) · regime 25
//                       calm 35 (1 − |trendScore|/0.5)
//   EXPIRY_MOMENTUM     regime 30 · trend 40 (saturates |trendScore| 0.5%)
//                       volume 30 (saturates volExp 1.5)

import type { QuantStrategySignal } from "./quant-types";
import type { QuantFeatures, QuantRegimeResult } from "./quant-types";

export const STRATEGY_THRESHOLDS = {
  TS_TREND_MIN: 0.15, // |trendScore|% to confirm a trend
  VOL_NOT_CONTRACTING: 0.8, // volumeExpansion below this = contracting
  VOL_EXP_BREAKOUT: 1.5, // volumeExpansion needed for a tradable breakout
  RETEST_TOL_ATR: 0.5, // retest tolerance = 0.5 × atr14 (premium of spot ATR)
  RETEST_TOL_PCT: 0.5, // fallback tolerance = 0.5% of close when ATR unknown
  VWAP_DEV_MIN: 0.8, // |vwapDevPct|% beyond this = stretched
  TREND_AGAINST_MAX: 0.5, // |trendScore|% against reversion = veto
} as const;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function signal(
  strategy: QuantStrategySignal["strategy"],
  direction: "BUY_CE" | "BUY_PE",
  eligible: boolean,
  score: number | null,
  evidence: string[],
  rejectionReasons: string[],
): QuantStrategySignal {
  return {
    strategy,
    direction,
    eligible,
    score: eligible && score != null ? Math.round(Math.min(100, Math.max(0, score)) * 10) / 10 : null,
    evidence,
    rejectionReasons,
  };
}

// ── 1. TREND_CONTINUATION ────────────────────────────────────────────
// Eligible: regime TRENDING_UP/DOWN + trendScore same sign ≥ TS_TREND_MIN
// + volume not contracting (unknown volume passes — only contraction blocks).
function evalTrendContinuation(f: QuantFeatures, regime: string): QuantStrategySignal {
  const T = STRATEGY_THRESHOLDS;
  const ts = finite(f.trendScore) ? f.trendScore! : null;
  const volExp = finite(f.volumeExpansion) ? f.volumeExpansion! : null;
  const reasons: string[] = [];
  const up = regime === "TRENDING_UP";
  const down = regime === "TRENDING_DOWN";
  if (!up && !down) reasons.push(`regime ${regime} is not trending`);
  if (ts == null) reasons.push("trendScore unavailable");
  else if (up && ts < T.TS_TREND_MIN) reasons.push(`trendScore ${ts} < ${T.TS_TREND_MIN} for upside continuation`);
  else if (down && ts > -T.TS_TREND_MIN) reasons.push(`trendScore ${ts} > -${T.TS_TREND_MIN} for downside continuation`);
  if (volExp != null && volExp < T.VOL_NOT_CONTRACTING) reasons.push(`volume contracting (volumeExpansion ${volExp} < ${T.VOL_NOT_CONTRACTING})`);

  if (reasons.length > 0) {
    return signal("TREND_CONTINUATION", up ? "BUY_CE" : "BUY_PE", false, null, [], reasons);
  }

  const evidence = [
    `regime ${regime}`,
    `trendScore ${ts}`,
    `close ${f.close} vs ema20 ${f.ema20} vs ema50 ${f.ema50}`,
    `volumeExpansion ${volExp ?? "n/a"}`,
  ];
  const trendComp = 30 * Math.min(Math.abs(ts!) / 0.5, 1);
  const aligned = f.close != null && f.ema20 != null && (up ? f.close > f.ema20 : f.close < f.ema20);
  const emaComp = aligned ? 25 : 10;
  const volComp = volExp == null ? 10 : Math.min(20, 20 * ((volExp - T.VOL_NOT_CONTRACTING) / (T.VOL_EXP_BREAKOUT - T.VOL_NOT_CONTRACTING)));
  const score = 25 + trendComp + emaComp + volComp;
  return signal("TREND_CONTINUATION", up ? "BUY_CE" : "BUY_PE", true, score, evidence, []);
}

// ── 2. BREAKOUT_RETEST ───────────────────────────────────────────────
// Eligible: close beyond sessionHigh/prevDayHigh (or below lows) with
// volumeExpansion ≥ VOL_EXP_BREAKOUT AND close within retest tolerance of
// the broken level (confirmed but not extended = retest zone).
function evalBreakoutRetest(f: QuantFeatures, regime: string): QuantStrategySignal {
  const T = STRATEGY_THRESHOLDS;
  const close = finite(f.close) ? f.close! : null;
  const volExp = finite(f.volumeExpansion) ? f.volumeExpansion! : null;
  const reasons: string[] = [];
  if (close == null) reasons.push("close unavailable");
  if (volExp == null || volExp < T.VOL_EXP_BREAKOUT) reasons.push(`volumeExpansion ${volExp ?? "n/a"} < ${T.VOL_EXP_BREAKOUT}`);

  const tolerance = f.atr14 != null && f.atr14 > 0 ? T.RETEST_TOL_ATR * f.atr14 : close != null ? (T.RETEST_TOL_PCT / 100) * close : null;
  if (tolerance == null) reasons.push("retest tolerance not computable (no ATR, no close)");

  let brokenLevel: number | null = null;
  let direction: "BUY_CE" | "BUY_PE" | null = null;
  let levelStrength = 0;
  if (close != null && finite(f.prevDayHigh) && close > f.prevDayHigh!) {
    brokenLevel = f.prevDayHigh!;
    direction = "BUY_CE";
    levelStrength = 30;
  } else if (close != null && finite(f.sessionHigh) && close > f.sessionHigh!) {
    brokenLevel = f.sessionHigh!;
    direction = "BUY_CE";
    levelStrength = 25;
  } else if (close != null && finite(f.prevDayLow) && close < f.prevDayLow!) {
    brokenLevel = f.prevDayLow!;
    direction = "BUY_PE";
    levelStrength = 30;
  } else if (close != null && finite(f.sessionLow) && close < f.sessionLow!) {
    brokenLevel = f.sessionLow!;
    direction = "BUY_PE";
    levelStrength = 25;
  }
  if (brokenLevel == null || direction == null) reasons.push("no breakout beyond session/prev-day extremes");
  const dist = brokenLevel != null && close != null ? Math.abs(close - brokenLevel) : null;
  if (brokenLevel != null && dist != null && tolerance != null && dist > tolerance) {
    reasons.push(`close ${close} extended ${dist.toFixed(2)} beyond broken level ${brokenLevel} (tolerance ${tolerance.toFixed(2)}) — no retest zone`);
  }

  if (reasons.length > 0) {
    return signal("BREAKOUT_RETEST", direction ?? "BUY_CE", false, null, [], reasons);
  }

  const evidence = [
    `broke ${direction === "BUY_CE" ? "upside" : "downside"} level ${brokenLevel} (close ${close})`,
    `volumeExpansion ${volExp}`,
    `distance to level ${dist?.toFixed(2)} within tolerance ${tolerance?.toFixed(2)}`,
    `regime ${regime}`,
  ];
  const volComp = 30 * Math.min((volExp! - T.VOL_EXP_BREAKOUT) / 1.0, 1);
  const retestComp = 40 * (1 - Math.min(dist! / tolerance!, 1));
  const score = levelStrength + volComp + retestComp;
  return signal("BREAKOUT_RETEST", direction!, true, score, evidence, []);
}

// ── 3. MEAN_REVERSION ────────────────────────────────────────────────
// Eligible only when regime RANGE_BOUND or LOW_VOLATILITY and |vwapDevPct|
// ≥ VWAP_DEV_MIN and no strong trendScore against the reversion direction.
function evalMeanReversion(f: QuantFeatures, regime: string): QuantStrategySignal {
  const T = STRATEGY_THRESHOLDS;
  const dev = finite(f.vwapDevPct) ? f.vwapDevPct! : null;
  const ts = finite(f.trendScore) ? f.trendScore! : null;
  const reasons: string[] = [];
  if (regime !== "RANGE_BOUND" && regime !== "LOW_VOLATILITY") reasons.push(`regime ${regime} is neither RANGE_BOUND nor LOW_VOLATILITY`);
  if (dev == null) reasons.push("vwapDevPct unavailable");
  else if (Math.abs(dev) < T.VWAP_DEV_MIN) reasons.push(`|vwapDevPct| ${Math.abs(dev)} < ${T.VWAP_DEV_MIN} — not stretched`);

  // dev > 0 = price stretched ABOVE vwap → reversion is down → BUY_PE.
  const direction: "BUY_CE" | "BUY_PE" = dev != null && dev > 0 ? "BUY_PE" : "BUY_CE";
  if (ts != null && Math.abs(ts) >= T.TREND_AGAINST_MAX) {
    const against = (direction === "BUY_PE" && ts > 0) || (direction === "BUY_CE" && ts < 0);
    if (against) reasons.push(`strong trend ${ts} against reversion direction ${direction}`);
  }

  if (reasons.length > 0) {
    return signal("MEAN_REVERSION", direction, false, null, [], reasons);
  }

  const evidence = [
    `regime ${regime}`,
    `vwapDevPct ${dev} beyond ±${T.VWAP_DEV_MIN}`,
    `trendScore ${ts ?? "n/a"} not against`,
    `vwap ${f.vwap}`,
  ];
  const stretchComp = 40 * Math.min(Math.abs(dev!) / 2.0, 1);
  const calmComp = 35 * (1 - Math.min(Math.abs(ts ?? 0) / T.TREND_AGAINST_MAX, 1));
  const score = stretchComp + 25 + calmComp;
  return signal("MEAN_REVERSION", direction, true, score, evidence, []);
}

// ── 4. EXPIRY_MOMENTUM ───────────────────────────────────────────────
// Eligible ONLY when ctx.isExpiryDay is true and regime is TRENDING_* or
// EXPIRY_VOLATILE. Direction follows the trend. Time-decay risk is always
// noted in evidence (expiry-day theta).
function evalExpiryMomentum(f: QuantFeatures, regime: string, isExpiryDay: boolean): QuantStrategySignal {
  const T = STRATEGY_THRESHOLDS;
  const ts = finite(f.trendScore) ? f.trendScore! : null;
  const dev = finite(f.vwapDevPct) ? f.vwapDevPct! : null;
  const volExp = finite(f.volumeExpansion) ? f.volumeExpansion! : null;
  const reasons: string[] = [];
  if (!isExpiryDay) reasons.push("not an expiry day for this symbol");
  if (!["TRENDING_UP", "TRENDING_DOWN", "EXPIRY_VOLATILE"].includes(regime)) reasons.push(`regime ${regime} not momentum-compatible on expiry`);

  let direction: "BUY_CE" | "BUY_PE" | null = null;
  if (regime === "TRENDING_UP") direction = "BUY_CE";
  else if (regime === "TRENDING_DOWN") direction = "BUY_PE";
  else if (regime === "EXPIRY_VOLATILE") {
    if (ts != null && Math.abs(ts) >= T.TS_TREND_MIN) direction = ts > 0 ? "BUY_CE" : "BUY_PE";
    else if (dev != null && Math.abs(dev) >= T.VWAP_DEV_MIN) direction = dev > 0 ? "BUY_CE" : "BUY_PE";
    else reasons.push("EXPIRY_VOLATILE without directional evidence (trendScore/vwapDevPct)");
  }

  if (reasons.length > 0 || direction == null) {
    return signal("EXPIRY_MOMENTUM", direction ?? "BUY_CE", false, null, [], reasons);
  }

  const evidence = [
    `expiry day momentum with regime ${regime}`,
    `trendScore ${ts ?? "n/a"}, vwapDevPct ${dev ?? "n/a"}`,
    `volumeExpansion ${volExp ?? "n/a"}`,
    "time-decay risk: expiry-day theta — premium decays fast, avoid holding into close",
  ];
  const trendComp = 40 * Math.min(Math.abs(ts ?? 0) / 0.5, 1);
  const volComp = volExp == null ? 10 : Math.min(30, 30 * Math.max(0, (volExp - 0.8) / 0.7));
  const score = 30 + trendComp + volComp;
  return signal("EXPIRY_MOMENTUM", direction, true, score, evidence, []);
}

// ── Orchestrator ─────────────────────────────────────────────────────

export interface StrategyCtx {
  isExpiryDay: boolean;
  symbol: string;
}

export function evaluateStrategies(
  features: QuantFeatures,
  regime: QuantRegimeResult,
  ctx: StrategyCtx,
): QuantStrategySignal[] {
  const r = regime.regime;
  return [
    evalTrendContinuation(features, r),
    evalBreakoutRetest(features, r),
    evalMeanReversion(features, r),
    evalExpiryMomentum(features, r, ctx.isExpiryDay === true),
  ];
}
