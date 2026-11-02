// Phase 11 shadow recorder — records lab scores, model preds, SDM snapshot,
// research inputs, outcomes, option-sim. READ-ONLY w.r.t. production trade paths.
// Never calls sendTradeAlert / veto / risk / sizing.

import type {
  ShadowSession, ShadowPrediction, SdmShadowSnapshot, ShadowOutcomes,
  CombinedQuantScore, ResearchInputs, LabeledSample,
} from "./types";
import { getStudyDay, saveShadowSession, getShadowSession, listShadowSessions, saveOptionSim, shadowCoverageStats } from "./storage";
import { computeCombinedScore } from "./score";
import { buildFeatures } from "./features";
import { researchFeatures, collectResearchInputs, type ResearchInputOptions } from "./research-inputs";
import { computeOutcomes, type CandleBar } from "./outcomes";
import { simulateBuyOption, type OptionSimConfig } from "./option-sim";
import { fitModel, type ModelName, FEATURE_SETS, type FeatureSetId } from "./validation";

export interface ShadowRecordInput {
  tradeDate: string;
  symbol: string;
  /** ISO feature cutoff — typically pre-open capture time. */
  featureAsOf?: string;
  /** Real intraday candles (post-open). Optional — outcomes null if absent. */
  candles?: CandleBar[];
  candleIntervalMin?: number;
  prevClose?: number | null;
  /** Optional SDM snapshot — filled by caller without Telegram/alerts. */
  sdm?: SdmShadowSnapshot | null;
  /** Research inputs — collect live or inject for tests. */
  research?: ResearchInputs | null;
  researchOpts?: Omit<ResearchInputOptions, "symbol">;
  /** Historical labeled samples for model fit (chronological — prior only). */
  trainSamples?: LabeledSample[];
  /** Option sim config + optional premium candle (bhavcopy). */
  optionSim?: {
    cfg?: OptionSimConfig;
    premiumCandle?: import("@/lib/option-bhavcopy").PremiumCandle | null;
    side?: "CE" | "PE";
    /** When true and no premium candle → NOT_VALIDATED row. */
    attempt?: boolean;
  };
  /** Skip network research collection (tests). */
  skipResearch?: boolean;
  score?: CombinedQuantScore | null;
}

const MODEL_NAMES: ModelName[] = ["logistic", "forest", "gbt"];
const FEATURE_SETS_FOR_SHADOW: FeatureSetId[] = ["cm_only", "fno_only", "cm_fno", "cm_fno_options", "full"];

/**
 * Build + persist one shadow session for a study day.
 * Fail-closed: no study day → throws; missing outcomes → nulls + notes.
 */
export async function recordShadowSession(input: ShadowRecordInput): Promise<ShadowSession> {
  const day = getStudyDay(input.tradeDate, input.symbol);
  if (!day) {
    throw new Error(`no_study_day:${input.tradeDate}:${input.symbol}`);
  }

  const featureAsOf =
    input.featureAsOf ||
    day.provenance?.fetchedAt ||
    `${input.tradeDate}T09:10:00+05:30`;

  const notes: string[] = [];

  // Research inputs (optional network)
  // Phase 12 honesty: asOf = actual fetch time (never claim pre-open for a later pull).
  let research: ResearchInputs | null = input.research ?? null;
  const researchFetchedAt = new Date().toISOString();
  if (!research && !input.skipResearch) {
    try {
      research = await collectResearchInputs({
        symbol: input.symbol,
        asOf: researchFetchedAt,
        ...(input.researchOpts || {}),
      });
      if (research.missing.length) notes.push(`research_missing:${research.missing.join(",")}`);
    } catch (e: any) {
      notes.push(`research_error:${e?.message || "fail"}`);
      research = null;
    }
  }

  // Lab score
  let score = input.score ?? null;
  if (!score) {
    try {
      score = computeCombinedScore({ day, quality: day.quality });
    } catch {
      score = null;
      notes.push("score_error");
    }
  }

  // Feature row + model predictions (train only on provided prior samples)
  const fr = buildFeatures({ day, asOf: featureAsOf });
  const rf = researchFeatures(research);
  const features = { ...fr.features, ...rf };

  const predictions: ShadowPrediction[] = [];

  // Lab score → direction probability proxy (not a calibrated probability of profit)
  if (score && score.score != null) {
    const pUp = score.score / 100;
    predictions.push({
      model: "lab_score",
      featureSet: "combined",
      pUp,
      predLabel: score.score >= 50 ? 1 : score.score < 50 ? 0 : null,
      asOf: featureAsOf,
      notes: "score/100 — research score, not P(profit)",
    });
  }

  // SDM snapshot (caller-provided — no engine side effects here)
  if (input.sdm) {
    const pUp =
      input.sdm.signal === "BUY_CALL" ? 0.7 :
      input.sdm.signal === "BUY_PUT" ? 0.3 :
      input.sdm.confidence != null ? input.sdm.confidence / 100 : null;
    predictions.push({
      model: "sdm",
      featureSet: "production_sdm_readonly",
      pUp,
      predLabel: input.sdm.signal === "BUY_CALL" ? 1 : input.sdm.signal === "BUY_PUT" ? 0 : null,
      asOf: input.sdm.asOf,
      notes: input.sdm.signal,
    });
  }

  // Models — fit on prior labeled samples only
  if (input.trainSamples?.length) {
    for (const fs of FEATURE_SETS_FOR_SHADOW) {
      const keys = FEATURE_SETS[fs];
      const usable = input.trainSamples.filter((s) =>
        keys.every((k) => features[k] != null || s.features[k] != null),
      );
      // Rebuild usable with merged research features on train rows when needed
      const train: LabeledSample[] = usable.map((s) => ({
        ...s,
        features: { ...s.features },
      }));
      if (train.length < 10) continue;
      for (const m of MODEL_NAMES) {
        const fitted = fitModel(m as ModelName, train, keys);
        if (!fitted) continue;
        const p = fitted.predict(features);
        if (p == null) continue;
        predictions.push({
          model: m as ShadowPrediction["model"],
          featureSet: fs,
          pUp: p,
          predLabel: p >= 0.5 ? 1 : 0,
          asOf: featureAsOf,
        });
      }
    }
  }

  // Outcomes from real candles (Phase 12: two-phase — without candles stay PENDING).
  let outcomes: ShadowOutcomes | null = null;
  if (input.candles?.length) {
    outcomes = computeOutcomes({
      candles: input.candles,
      intervalMin: input.candleIntervalMin ?? 5,
      prevClose: input.prevClose ?? day.cm?.previousClose ?? null,
      sessionOpen: undefined,
    });
    if (outcomes.notes.length) notes.push(...outcomes.notes);
  } else {
    notes.push("no_outcomes_candles");
  }

  // Preserve prior outcome lifecycle when re-recording without new candles.
  const existing = getShadowSession(input.tradeDate, input.symbol);
  const outcomeStatus =
    outcomes != null
      ? ("OUTCOME_RECORDED" as const)
      : existing?.outcomeStatus === "OUTCOME_UNAVAILABLE"
        ? ("OUTCOME_UNAVAILABLE" as const)
        : outcomes == null && existing?.outcomes
          ? ("OUTCOME_RECORDED" as const) // keep already-attached outcomes
          : ("PENDING_OUTCOME" as const);

  // Option sim (bhavcopy) — NOT_VALIDATED without premium OHLC
  let optionSimValidated: boolean | null = null;
  if (input.optionSim?.attempt !== false && input.optionSim) {
    const side = input.optionSim.side || (score?.bias === "BEARISH" ? "PE" : "CE");
    const spot =
      day.futures?.finalPrice ?? day.cm?.finalPrice ?? day.cm?.iep ?? null;
    let candle = input.optionSim.premiumCandle ?? null;
    if (!candle && spot != null) {
      // leave null → NOT_VALIDATED (caller may pass bhavcopy rows)
      candle = null;
    }
    const sim = simulateBuyOption(input.tradeDate, input.symbol, side, candle, input.optionSim.cfg);
    saveOptionSim(sim);
    optionSimValidated = sim.validated;
    if (!sim.validated) notes.push(`option_sim:${sim.outcome}:${sim.reason || "no_premium"}`);
  }

  const session: ShadowSession = {
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    featureAsOf,
    labScore: score?.score ?? null,
    labBias: score?.bias ?? null,
    predictions,
    sdm: input.sdm ?? null,
    outcomes: outcomes ?? existing?.outcomes ?? null,
    research,
    quality: day.quality,
    optionSimValidated,
    notes,
    createdAt: new Date().toISOString(),
    outcomeStatus,
    outcomeAttempts: existing?.outcomeAttempts ?? 0,
    outcomeAttachedAt: existing?.outcomeAttachedAt ?? null,
    recordedAt: new Date().toISOString(),
    researchAsOf: research?.asOf ?? existing?.researchAsOf ?? null,
  };

  saveShadowSession(session);
  return { ...session, id: getShadowSession(input.tradeDate, input.symbol)?.id };
}

/**
 * Try a READ-ONLY SDM snapshot via generateTradeRecommendation.
 * Never sends Telegram. On any failure → NO_DATA (fail-closed).
 * Network/chain dependent — optional path for the API, not unit tests.
 */
export async function trySdmShadowSnapshot(symbol: string): Promise<SdmShadowSnapshot> {
  const asOf = new Date().toISOString();
  try {
    const { generateTradeRecommendation } = await import("@/lib/sdm-recommendation");
    const { getNSEOptionChain } = await import("@/lib/nse-api");
    const chain = await getNSEOptionChain(symbol);
    if (!chain?.data?.length) {
      return { signal: "NO_DATA", confidence: null, asOf, source: "sdm_shadow", notes: "no_chain" };
    }
    // Map NSE chain → SDMOptionStrike-ish shape used by generateTradeRecommendation
    const strikes = chain.data.map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? {
        ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChange: row.ce.oiChg || 0,
        volume: row.ce.volume || 0, iv: row.ce.iv || 0, change: row.ce.chg || 0,
        bid: row.ce.bid || 0, ask: row.ce.ask || 0,
      } : null,
      pe: row.pe ? {
        ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChange: row.pe.oiChg || 0,
        volume: row.pe.volume || 0, iv: row.pe.iv || 0, change: row.pe.chg || 0,
        bid: row.pe.bid || 0, ask: row.pe.ask || 0,
      } : null,
    }));
    // Same call shape as /api/sdm-signal (read-only — no Telegram in this module).
    const selectedExpiry =
      (chain.expiries || []).map((e: any) => (typeof e === "string" ? e : e.date))[0] || "";
    const rec = await (generateTradeRecommendation as any)(
      strikes,
      chain.spotPrice,
      symbol,
      selectedExpiry,
      {},
      null,
      "nse-api",
      new Date().toISOString(),
    );
    const direction = (rec as any)?.direction;
    const confRaw =
      typeof (rec as any)?.confidence === "object"
        ? (rec as any)?.confidence?.total
        : (rec as any)?.confidence;
    const confidence = typeof confRaw === "number" && Number.isFinite(confRaw) ? confRaw : null;
    const action = (rec as any)?.action || (rec as any)?.tradeAction;
    const signal =
      action === "BUY_CALL" || direction === "CALL"
        ? "BUY_CALL"
        : action === "BUY_PUT" || direction === "PUT"
          ? "BUY_PUT"
          : "WAIT";
    return { signal, confidence, asOf, source: "sdm_recommendation_readonly", notes: "no_alerts_sent" };
  } catch (e: any) {
    return {
      signal: "NO_DATA",
      confidence: null,
      asOf,
      source: "sdm_shadow",
      notes: e?.message || "sdm_failed",
    };
  }
}

export function getShadow(tradeDate: string, symbol: string) {
  return getShadowSession(tradeDate, symbol);
}

export function listShadows(opts: Parameters<typeof listShadowSessions>[0] = {}) {
  return listShadowSessions(opts);
}

export function shadowCoverage() {
  return shadowCoverageStats();
}
