// Phase 11 shadow compare — CM / F&O / CM+F&O / +MOAPI / full + SDM side-by-side.
// Chronological OOS only. n < 30 → insufficient (honest).

import type { LabeledSample, ModelMetrics, ShadowSession, WilsonInterval } from "./types";
import { SHADOW_MIN_N } from "./types";
import { listShadowSessions, wilsonInterval } from "./storage";
import { compareFeatureSets, FEATURE_SETS, fitModel, chronologicalSplit, type FeatureSetId, type ModelName } from "./validation";
import { accuracyCheck, calibrationBuckets, binomialPvs, type AccuracyCheck, type CalibrationBucket } from "./significance";
import { computeMetrics } from "./models";

export type CompareTarget = "gap_continuation" | "gap_reversal" | "labelEod" | "label15m" | "label30m";

export interface SourceRow {
  featureSet: FeatureSetId;
  nTrain: number;
  nTest: number;
  metrics: ModelMetrics | null;
  accuracy: AccuracyCheck | null;
  calibration: CalibrationBucket[];
  message?: string;
}

export interface ShadowCompareResult {
  target: string;
  model: ModelName;
  sufficient: boolean;
  nLabeled: number;
  minN: number;
  sources: SourceRow[];
  sdm: {
    n: number;
    accuracy: AccuracyCheck | null;
    note: string;
  } | null;
  disclaimer: string;
}

const SOURCE_SETS: FeatureSetId[] = ["cm_only", "fno_only", "cm_fno", "cm_fno_options", "full"];

/**
 * Label samples from shadow sessions (features already include research keys).
 * Targets: gap_cont/rev from outcomes, or horizon direction labels.
 */
export function shadowSessionsToSamples(
  sessions: ShadowSession[],
  target: CompareTarget = "gap_continuation",
): LabeledSample[] {
  const out: LabeledSample[] = [];
  for (const s of sessions) {
    if (!s.outcomes) continue;
    let label: 0 | 1 | null = null;
    if (target === "gap_continuation") label = s.outcomes.gapContEod;
    else if (target === "gap_reversal") label = s.outcomes.gapRevEod;
    else if (target === "labelEod") label = s.outcomes.labelEod;
    else if (target === "label15m") label = s.outcomes.label15m;
    else if (target === "label30m") label = s.outcomes.label30m;
    if (label == null) continue;

    // Rebuild feature vector from stored predictions' session + research
    const features: Record<string, number | null> = {};
    // Prefer latest model featureSet row features — we store research + need study features.
    // Sessions don't store full feature map; reconstruct from lab bias + research numerics.
    if (s.labScore != null) features.cm_gap_pct = null; // placeholder — full rebuild needs study day
    if (s.research) {
      const r = s.research;
      features.options_pcr = r.options?.pcr ?? null;
      features.fii_net = r.fiiDii?.available ? r.fiiDii.fiiNet : null;
      features.vix_level = r.vix?.value ?? null;
      features.breadth_net =
        r.breadth && r.breadth.adv + r.breadth.dec > 0
          ? (r.breadth.adv - r.breadth.dec) / (r.breadth.adv + r.breadth.dec)
          : null;
      if (r.options?.ceOi != null && r.options?.peOi != null && r.options.ceOi + r.options.peOi > 0) {
        features.options_oi_imbalance =
          (r.options.peOi - r.options.ceOi) / (r.options.ceOi + r.options.peOi);
      }
    }
    // Attach stored lab score as a pseudo feature for combined view
    if (s.labScore != null) features.lab_score = s.labScore;
    if (s.labBias === "BULLISH") features.lab_bias = 1;
    else if (s.labBias === "BEARISH") features.lab_bias = -1;
    else if (s.labBias != null) features.lab_bias = 0;

    // Merge any feature map we can recover from study-day-like keys if present on session notes
    out.push({
      tradeDate: s.tradeDate,
      symbol: s.symbol,
      features,
      target,
      label,
    });
  }
  return out;
}

/**
 * Enrich shadow samples with full study-day features (preferred path).
 */
import { getStudyDay } from "./storage";
import { buildFeatures } from "./features";
import { researchFeatures } from "./research-inputs";

export function shadowSessionsToFullSamples(
  sessions: ShadowSession[],
  target: CompareTarget = "gap_continuation",
): LabeledSample[] {
  const out: LabeledSample[] = [];
  for (const s of sessions) {
    if (!s.outcomes) continue;
    let label: 0 | 1 | null = null;
    if (target === "gap_continuation") label = s.outcomes.gapContEod;
    else if (target === "gap_reversal") label = s.outcomes.gapRevEod;
    else if (target === "labelEod") label = s.outcomes.labelEod;
    else if (target === "label15m") label = s.outcomes.label15m;
    else if (target === "label30m") label = s.outcomes.label30m;
    if (label == null) continue;

    const day = getStudyDay(s.tradeDate, s.symbol);
    if (!day) continue;
    const fr = buildFeatures({ day, asOf: s.featureAsOf });
    const rf = researchFeatures(s.research);
    out.push({
      tradeDate: s.tradeDate,
      symbol: s.symbol,
      features: { ...fr.features, ...rf, lab_score: s.labScore },
      target,
      label,
    });
  }
  return out;
}

/**
 * Compare feature sets + SDM on shadow labels.
 * Uses full study features when available.
 */
export function compareShadow(
  opts: {
    target?: CompareTarget;
    model?: ModelName;
    sessions?: ShadowSession[];
    from?: string;
    to?: string;
    symbol?: string;
  } = {},
): ShadowCompareResult {
  const target = opts.target || "gap_continuation";
  const model = opts.model || "logistic";
  const sessions =
    opts.sessions ||
    listShadowSessions({ from: opts.from, to: opts.to, symbol: opts.symbol, limit: 5000 });

  const samples = shadowSessionsToFullSamples(sessions, target);
  const nLabeled = samples.length;
  const sufficient = nLabeled >= SHADOW_MIN_N;

  const disclaimer =
    "Shadow validation research only. Not trade authorization. Not a claim of profitability. " +
    "Production SDM/veto/risk unchanged.";

  if (!sufficient) {
    return {
      target,
      model,
      sufficient: false,
      nLabeled,
      minN: SHADOW_MIN_N,
      sources: SOURCE_SETS.map((fs) => ({
        featureSet: fs,
        nTrain: 0,
        nTest: 0,
        metrics: null,
        accuracy: null,
        calibration: [],
        message: `insufficient n=${nLabeled} < ${SHADOW_MIN_N}`,
      })),
      sdm: sdmAccuracy(sessions, target),
      disclaimer,
    };
  }

  // Filter to samples that have enough non-null keys per set
  const sources: SourceRow[] = SOURCE_SETS.map((fs) => {
    const keys = FEATURE_SETS[fs];
    const usable = samples.filter((s) =>
      keys.some((k) => s.features[k] != null && Number.isFinite(s.features[k] as number)),
    );
    // Require at least 1 known key; models may skip nulls internally
    const { train, test } = chronologicalSplit(usable, 0.7);
    if (train.length < 10 || test.length < 5) {
      return {
        featureSet: fs,
        nTrain: train.length,
        nTest: test.length,
        metrics: null,
        accuracy: null,
        calibration: [],
        message: "insufficient train/test after chronological split",
      };
    }
    const fitted = fitModel(model, train, keys);
    if (!fitted) {
      return {
        featureSet: fs,
        nTrain: train.length,
        nTest: test.length,
        metrics: null,
        accuracy: null,
        calibration: [],
        message: "fit_failed",
      };
    }
    const yTrue: number[] = [];
    const yProb: number[] = [];
    const yPred: number[] = [];
    for (const s of test) {
      const p = fitted.predict(s.features);
      if (p == null) continue;
      yTrue.push(s.label);
      yProb.push(p);
      yPred.push(p >= 0.5 ? 1 : 0);
    }
    const metrics = yTrue.length ? computeMetrics(yTrue, yProb) : null;
    const acc = yTrue.length ? accuracyCheck(yTrue, yPred) : null;
    const cal = yTrue.length ? calibrationBuckets(yTrue, yProb) : [];
    return {
      featureSet: fs,
      nTrain: train.length,
      nTest: test.length,
      metrics,
      accuracy: acc,
      calibration: cal,
    };
  });

  return {
    target,
    model,
    sufficient: true,
    nLabeled,
    minN: SHADOW_MIN_N,
    sources,
    sdm: sdmAccuracy(sessions, target),
    disclaimer,
  };
}

function sdmAccuracy(sessions: ShadowSession[], target: CompareTarget): ShadowCompareResult["sdm"] {
  const yTrue: number[] = [];
  const yPred: number[] = [];
  let n = 0;
  for (const s of sessions) {
    if (!s.sdm || s.sdm.signal === "NO_DATA") continue;
    if (!s.outcomes) continue;
    let label: 0 | 1 | null = null;
    if (target === "gap_continuation") label = s.outcomes.gapContEod;
    else if (target === "gap_reversal") label = s.outcomes.gapRevEod;
    else if (target === "labelEod") label = s.outcomes.labelEod;
    else if (target === "label15m") label = s.outcomes.label15m;
    else if (target === "label30m") label = s.outcomes.label30m;
    if (label == null) continue;
    if (s.sdm.signal === "WAIT") continue; // no directional call — excluded from hit-rate
    const pred = s.sdm.signal === "BUY_CALL" ? 1 : 0;
    yTrue.push(label);
    yPred.push(pred);
    n++;
  }
  const acc = n ? accuracyCheck(yTrue, yPred) : null;
  return {
    n,
    accuracy: acc,
    note:
      n === 0
        ? "no SDM shadow snapshots with labels"
        : n < SHADOW_MIN_N
          ? `SDM n=${n} < ${SHADOW_MIN_N} — no significance claim`
          : acc?.message || "",
  };
}

/** Wilson CI helper re-export for API. */
export function shadowWilson(successes: number, n: number): WilsonInterval {
  return wilsonInterval(successes, n);
}

export { binomialPvs };
