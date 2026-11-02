// Combined experimental 0–100 quantitative score — transparent contributions.
// NOT trade authorization. Correlation de-dup via grouped weights.

import type {
  CombinedQuantScore, BiasLabel, FeatureContribution, PreopenStudyDay, QualityReport, SourceId,
} from "./types";
import { SCORE_DISCLAIMER } from "./types";
import {
  gapPct, computeImbalance, basisPct, spotFuturesDivergence, computeBreadth,
  futuresOpeningStrength, idxStkFuturesConfirmation, expectedMovePct,
} from "./analytics";
import { canProduceResearchScore } from "./quality";

function clamp(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

function tanhScale(x: number, scale: number): number {
  return Math.tanh(x / scale);
}

export interface ScoreInput {
  day: PreopenStudyDay;
  quality: QualityReport;
  breadthRows?: Array<{ symbol: string; pChange: number | null; weightPct?: number }>;
  optionsConfirmPct?: number | null; // MOAPI-derived directional confirmation −1..1
  vix?: number | null;
  /** Optional stock-futures avg strength for IDX/STK confirmation. */
  stockFutStrengthPct?: number | null;
}

/**
 * Build transparent score. Weights grouped to avoid double-counting:
 * - CM group (gap + imbalance) weight 0.30
 * - F&O group (gap + strength + basis) weight 0.30
 * - Cross (spot/fut divergence, confirmation) weight 0.15
 * - Options (external MOAPI) weight 0.15
 * - Volatility regime weight 0.10
 */
export function computeCombinedScore(input: ScoreInput): CombinedQuantScore {
  const { day, quality } = input;
  const contributions: FeatureContribution[] = [];
  const now = new Date().toISOString();

  const sourceScores = {
    cm: null as number | null,
    fno: null as number | null,
    options: null as number | null,
    volatility: null as number | null,
    breadth: null as number | null,
    flow: null as number | null,
  };

  const push = (
    key: string, label: string, raw: number | null, normalized: number,
    weight: number, source: SourceId, q: "OK" | "DEGRADED" | "MISSING" | "STALE",
  ) => {
    contributions.push({
      key, label, raw, normalized: clamp(normalized), weight,
      weighted: clamp(normalized) * weight, source, quality: q,
    });
  };

  // ── CM group ───────────────────────────────────────────────────────
  let cmSum = 0;
  let cmN = 0;
  const cmGap = day.cm ? gapPct(day.cm.iep ?? day.cm.finalPrice, day.cm.previousClose) : null;
  if (cmGap != null) {
    const n = tanhScale(cmGap, 0.4); // 0.4% ~ neutral scaling
    push("cm_gap_pct", "CM pre-open gap %", cmGap, n, 0.18, "NSE_CM_PREOPEN", "OK");
    cmSum += n; cmN++;
  }
  if (day.cm) {
    const imb = computeImbalance(day.cm);
    if (imb.normalized != null) {
      push("normalized_imbalance", "Order imbalance", imb.raw, imb.normalized, 0.12, "NSE_CM_PREOPEN", "OK");
      cmSum += imb.normalized; cmN++;
    }
  }
  sourceScores.cm = cmN > 0 ? Math.round(((cmSum / cmN) + 1) * 50) : null;

  // ── F&O group ──────────────────────────────────────────────────────
  let fnoSum = 0;
  let fnoN = 0;
  const fnoGap = day.futures ? gapPct(day.futures.iep ?? day.futures.finalPrice, day.futures.previousClose) : null;
  if (fnoGap != null) {
    const n = tanhScale(fnoGap, 0.4);
    push("fno_gap_pct", "Futures pre-open gap %", fnoGap, n, 0.12, "NSE_FNO_PREOPEN", "OK");
    fnoSum += n; fnoN++;
  }
  if (day.futures) {
    const strength = futuresOpeningStrength({
      iep: day.futures.iep, previousClose: day.futures.previousClose, pChange: day.futures.pChange,
    });
    if (strength != null) {
      const n = tanhScale(strength, 0.5);
      push("futures_opening_strength", "Futures opening strength %", strength, n, 0.10, "NSE_FNO_PREOPEN", "OK");
      fnoSum += n; fnoN++;
    }
    const bp = day.futures.basisPct ?? basisPct(day.futures.iep ?? day.futures.finalPrice, day.cm?.iep ?? day.cm?.finalPrice);
    if (bp != null) {
      // mild bullish tilt for contango, bearish for deep backwardation — small weight
      const n = tanhScale(bp, 0.3) * 0.5;
      push("basis_pct", "Futures basis %", bp, n, 0.08, "NSE_FNO_PREOPEN", "OK");
      fnoSum += n; fnoN++;
    }
  }
  sourceScores.fno = fnoN > 0 ? Math.round(((fnoSum / fnoN) + 1) * 50) : null;

  // ── Cross: divergence + confirmation ───────────────────────────────
  const div = spotFuturesDivergence(day.cm?.pChange ?? null, day.futures?.pChange ?? null);
  if (div != null) {
    // divergence > 0 means futures stronger — mild positive for trend continuation risk
    push("spot_futures_divergence", "Spot/futures divergence (pp)", div, tanhScale(div, 0.5) * 0.3, 0.08, "NSE_FNO_PREOPEN", "OK");
  }
  const conf = idxStkFuturesConfirmation(
    day.futures && day.futures.instrumentType === "FUTIDX" ? day.futures.pChange : null,
    input.stockFutStrengthPct ?? null,
  );
  if (conf.confirmed != null && conf.agreement != null) {
    const n = conf.confirmed ? conf.agreement : -conf.agreement * 0.5;
    push("idx_stk_confirmation", "IDX↔STK futures confirmation", conf.agreement, n, 0.07, "NSE_FNO_PREOPEN", "OK");
  }

  // ── Options (MOAPI — external) ─────────────────────────────────────
  if (input.optionsConfirmPct != null && Number.isFinite(input.optionsConfirmPct)) {
    const n = clamp(input.optionsConfirmPct);
    push("options_confirmation", "Options chain confirmation (MOAPI)", input.optionsConfirmPct, n, 0.15, "MOAPI_OPTION_CHAIN", "OK");
    sourceScores.options = Math.round((n + 1) * 50);
  } else {
    sourceScores.options = null;
  }

  // ── Breadth (from CM constituents when provided) ───────────────────
  if (input.breadthRows && input.breadthRows.length > 0) {
    const b = computeBreadth(input.breadthRows);
    if (b.indexWeighted != null) {
      push("index_weighted_breadth", "Index-weighted breadth %", b.indexWeighted, tanhScale(b.indexWeighted, 0.6), 0.07, "NSE_CM_PREOPEN", "OK");
      sourceScores.breadth = Math.round((clamp(tanhScale(b.indexWeighted, 0.6)) + 1) * 50);
    }
  }

  // ── Volatility regime ──────────────────────────────────────────────
  const vix = input.vix ?? day.vix;
  if (vix != null && vix > 0) {
    // high VIX → more caution (negative contribution to "clean" score direction)
    const em = expectedMovePct(vix);
    const n = -tanhScale((vix - 13) / 5, 1) * 0.5; // above ~18 starts dampening
    push("vix_regime", "VIX regime dampener", vix, n, 0.10, "INDIA_VIX", "OK");
    sourceScores.volatility = Math.round((clamp(n) + 1) * 50);
    void em;
  }

  // ── Flow ───────────────────────────────────────────────────────────
  if (day.fiiNet != null) {
    const n = tanhScale(day.fiiNet, 2000); // ₹ Cr scale
    push("fii_net", "FII net flow", day.fiiNet, n, 0.05, "FII_DII", "OK");
    sourceScores.flow = Math.round((n + 1) * 50);
  }

  // Weighted sum → 0..100
  const weightSum = contributions.reduce((a, c) => a + c.weight, 0);
  const weighted = contributions.reduce((a, c) => a + c.weighted, 0);
  const norm = weightSum > 0 ? weighted / weightSum : 0; // −1..1
  const score = Math.round(clamp(norm, -1, 1) * 50 + 50);

  const bias: BiasLabel = resolveBias(score, contributions, quality);

  return {
    score,
    bias,
    contributions,
    sourceScores,
    quality,
    disclaimer: SCORE_DISCLAIMER,
    calculatedAt: now,
  };
}

function resolveBias(score: number, contributions: FeatureContribution[], quality: QualityReport): BiasLabel {
  if (!canProduceResearchScore(quality, ["NSE_CM_PREOPEN"])) return "WAIT";
  const agree = contributions.filter((c) => Math.abs(c.normalized) > 0.2);
  const bulls = agree.filter((c) => c.normalized > 0).length;
  const bears = agree.filter((c) => c.normalized < 0).length;
  const hasCm = contributions.some((c) => c.key === "cm_gap_pct" || c.key === "normalized_imbalance");
  const hasFno = contributions.some((c) => c.key === "fno_gap_pct" || c.key === "futures_opening_strength");

  // Large gap without confirmation → WAIT (spec rule)
  const cmGap = contributions.find((c) => c.key === "cm_gap_pct");
  const fnoGap = contributions.find((c) => c.key === "fno_gap_pct");
  if (cmGap && Math.abs(cmGap.raw ?? 0) >= 0.8) {
    const fnoAgrees = fnoGap && Math.sign(fnoGap.raw ?? 0) === Math.sign(cmGap.raw ?? 0);
    if (!fnoAgrees && (!hasFno || Math.abs(fnoGap?.normalized ?? 0) < 0.15)) return "WAIT";
  }

  // Spot/futures disagreement
  const div = contributions.find((c) => c.key === "spot_futures_divergence");
  if (div && Math.abs(div.raw ?? 0) > 0.4 && cmGap && fnoGap) {
    if (Math.sign(cmGap.raw ?? 0) !== Math.sign(fnoGap.raw ?? 0)) return "MIXED";
  }

  if (bulls > 0 && bears > 0 && Math.abs(bulls - bears) <= 1 && score >= 35 && score <= 65) {
    return "MIXED";
  }
  if (score >= 60 && bulls >= 2 && bulls > bears) return "BULLISH";
  if (score <= 40 && bears >= 2 && bears > bulls) return "BEARISH";
  if (score >= 55 && hasCm && hasFno) return "BULLISH";
  if (score <= 45 && hasCm && hasFno) return "BEARISH";
  if (!hasCm) return "WAIT";
  return "NEUTRAL";
}

/** Contextual options setup hint for BUY CE / BUY PE only — never auto-trade. */
export function optionsSetupHint(score: CombinedQuantScore): {
  side: "BUY_CE" | "BUY_PE" | "NONE";
  reason: string;
} {
  if (score.bias === "WAIT" || score.bias === "MIXED") {
    return { side: "NONE", reason: "Spot/futures disagreement or insufficient confirmation — WAIT" };
  }
  if (score.bias === "BULLISH") {
    return { side: "BUY_CE", reason: "Bullish research bias with CM+F&O context — options remain subject to full SDM gates" };
  }
  if (score.bias === "BEARISH") {
    return { side: "BUY_PE", reason: "Bearish research bias with CM+F&O context — options remain subject to full SDM gates" };
  }
  return { side: "NONE", reason: "Neutral bias — no directional options setup" };
}
