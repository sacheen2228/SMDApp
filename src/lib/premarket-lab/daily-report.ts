// Phase 12 — daily research report metrics (research-only).
// Predictions vs outcomes, directional accuracy, gap cont/rev, false bull/bear,
// model comparison, coverage, Wilson CIs. Fail-closed when n < SHADOW_MIN_N.

import type { ShadowSession, WilsonInterval, OutcomeStatus } from "./types";
import { SHADOW_MIN_N } from "./types";
import { listShadowSessions, listOptionSims, coverageStats, shadowCoverageStats, wilsonInterval } from "./storage";
import { summarizeOptionSims } from "./option-sim";
import { accuracyCheck, type AccuracyCheck } from "./significance";
import { compareShadow, type CompareTarget } from "./shadow-compare";

export interface ModelDayRow {
  model: string;
  featureSet: string | null;
  n: number;
  correct: number;
  accuracy: number | null;
  ci: WilsonInterval | null;
  falseBull: number; // predicted up, actual down
  falseBear: number; // predicted down, actual up
  trueBull: number;
  trueBear: number;
  message?: string;
}

export interface HorizonAccuracy {
  horizon: "5m" | "15m" | "30m" | "eod";
  n: number;
  accuracy: AccuracyCheck | null;
}

export interface GapStatsReport {
  n: number;
  contHit: number;
  contMiss: number;
  revHit: number;
  revMiss: number;
  contRate: number | null;
  revRate: number | null;
}

export interface DailyLabReport {
  tradeDate: string;
  generatedAt: string;
  sessions: number;
  byStatus: Record<OutcomeStatus, number>;
  labeled: number;
  modelRows: ModelDayRow[];
  horizons: HorizonAccuracy[];
  gap: GapStatsReport;
  coverage: ReturnType<typeof coverageStats>;
  shadowCoverage: ReturnType<typeof shadowCoverageStats>;
  optionSim: ReturnType<typeof summarizeOptionSims>;
  oosCompare: ReturnType<typeof compareShadow> | null;
  disclaimer: string;
}

const DISCLAIMER =
  "Research report only. Not trade authorization. Not expected returns. " +
  "n < 30 → no statistical significance claim. Production SDM/veto/risk unchanged.";

function labelFromSession(s: ShadowSession, horizon: HorizonAccuracy["horizon"]): 0 | 1 | null {
  if (!s.outcomes) return null;
  if (horizon === "5m") return s.outcomes.label5m;
  if (horizon === "15m") return s.outcomes.label15m;
  if (horizon === "30m") return s.outcomes.label30m;
  return s.outcomes.labelEod;
}

/**
 * Build the daily research report for a trade date (or all dates if omitted).
 */
export function buildDailyReport(opts: {
  tradeDate?: string;
  sessions?: ShadowSession[];
  includeOos?: boolean;
} = {}): DailyLabReport {
  const all =
    opts.sessions ||
    listShadowSessions({
      from: opts.tradeDate,
      to: opts.tradeDate,
      limit: 5000,
    });

  const byStatus: Record<OutcomeStatus, number> = {
    PENDING_OUTCOME: 0,
    OUTCOME_RECORDED: 0,
    OUTCOME_UNAVAILABLE: 0,
  };
  for (const s of all) {
    const st = s.outcomeStatus || "PENDING_OUTCOME";
    byStatus[st] = (byStatus[st] || 0) + 1;
  }

  const labeled = all.filter(
    (s) => s.outcomeStatus === "OUTCOME_RECORDED" && s.outcomes && s.outcomes.labelEod != null,
  );

  // Model × feature-set accuracy on EOD direction
  const modelMap = new Map<string, ModelDayRow>();
  for (const s of labeled) {
    for (const p of s.predictions) {
      if (p.predLabel == null || p.pUp == null) continue;
      const label = s.outcomes!.labelEod;
      if (label == null) continue;
      const key = `${p.model}::${p.featureSet || "-"}`;
      let row = modelMap.get(key);
      if (!row) {
        row = {
          model: p.model,
          featureSet: p.featureSet ?? null,
          n: 0, correct: 0, accuracy: null, ci: null,
          falseBull: 0, falseBear: 0, trueBull: 0, trueBear: 0,
        };
        modelMap.set(key, row);
      }
      row.n++;
      const pred = p.predLabel;
      if (pred === label) row.correct++;
      if (pred === 1 && label === 0) row.falseBull++;
      if (pred === 0 && label === 1) row.falseBear++;
      if (pred === 1 && label === 1) row.trueBull++;
      if (pred === 0 && label === 0) row.trueBear++;
    }
  }
  const modelRows = [...modelMap.values()].map((r) => {
    const ci = r.n > 0 ? wilsonInterval(r.correct, r.n) : null;
    return {
      ...r,
      accuracy: r.n > 0 ? r.correct / r.n : null,
      ci,
      message:
        r.n < SHADOW_MIN_N
          ? `insufficient n=${r.n} < ${SHADOW_MIN_N}`
          : ci && ci.lower != null && ci.lower > 0.5
            ? "CI lower > 0.5"
            : "not distinguishable from 50% at 0.05",
    };
  }).sort((a, b) => b.n - a.n);

  // Horizon accuracy (lab_score as default predictor when present; else skip)
  const horizons: HorizonAccuracy[] = (["5m", "15m", "30m", "eod"] as const).map((h) => {
    const yTrue: number[] = [];
    const yPred: number[] = [];
    for (const s of labeled) {
      const lab = labelFromSession(s, h);
      if (lab == null) continue;
      const pred = s.predictions.find((p) => p.model === "lab_score" && p.predLabel != null)
        || s.predictions.find((p) => p.model === "sdm" && p.predLabel != null);
      if (!pred || pred.predLabel == null) continue;
      yTrue.push(lab);
      yPred.push(pred.predLabel);
    }
    return {
      horizon: h,
      n: yTrue.length,
      accuracy: yTrue.length ? accuracyCheck(yTrue, yPred) : null,
    };
  });

  // Gap cont / rev from labeled sessions
  let contHit = 0, contMiss = 0, revHit = 0, revMiss = 0;
  for (const s of labeled) {
    const o = s.outcomes!;
    // continuation measured vs lab bias direction on gap day
    if (o.gapContEod != null && s.labBias) {
      const predCont = s.labBias === "BULLISH" ? 1 : s.labBias === "BEARISH" ? 0 : null;
      if (predCont != null) {
        if (predCont === o.gapContEod) contHit++;
        else contMiss++;
      }
    }
    if (o.gapRevEod != null && s.labBias) {
      // reversal is opposite of gap direction continuation for simplicity
      const predRev = s.labBias === "BULLISH" ? 0 : s.labBias === "BEARISH" ? 1 : null;
      if (predRev != null) {
        if (predRev === o.gapRevEod) revHit++;
        else revMiss++;
      }
    }
  }
  const gapN = contHit + contMiss;
  const revN = revHit + revMiss;
  const gap: GapStatsReport = {
    n: gapN,
    contHit, contMiss, revHit, revMiss,
    contRate: gapN > 0 ? contHit / gapN : null,
    revRate: revN > 0 ? revHit / revN : null,
  };

  const sims = listOptionSims({ from: opts.tradeDate, to: opts.tradeDate, limit: 500 });
  const optionSim = summarizeOptionSims(sims);

  let oosCompare: DailyLabReport["oosCompare"] = null;
  if (opts.includeOos !== false && labeled.length >= SHADOW_MIN_N) {
    oosCompare = compareShadow({
      target: "labelEod",
      model: "logistic",
      sessions: all,
    });
  }

  return {
    tradeDate: opts.tradeDate || new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    sessions: all.length,
    byStatus,
    labeled: labeled.length,
    modelRows,
    horizons,
    gap,
    coverage: coverageStats(),
    shadowCoverage: shadowCoverageStats(),
    optionSim,
    oosCompare,
    disclaimer: DISCLAIMER,
  };
}

/** Render report as plain text (console / log file). */
export function formatDailyReport(r: DailyLabReport): string {
  const lines: string[] = [];
  lines.push(`=== Pre-Market Lab Daily Report — ${r.tradeDate} ===`);
  lines.push(`generated ${r.generatedAt}`);
  lines.push("");
  lines.push(`Sessions: ${r.sessions}`);
  lines.push(
    `  PENDING_OUTCOME=${r.byStatus.PENDING_OUTCOME} ` +
    `OUTCOME_RECORDED=${r.byStatus.OUTCOME_RECORDED} ` +
    `OUTCOME_UNAVAILABLE=${r.byStatus.OUTCOME_UNAVAILABLE}`,
  );
  lines.push(`Labeled (EOD): ${r.labeled}`);
  if (r.labeled > 0 && r.labeled < SHADOW_MIN_N) {
    lines.push(`  (insufficient for significance — n < ${SHADOW_MIN_N})`);
  }

  lines.push("\nPredictions vs actual (EOD direction):");
  if (!r.modelRows.length) {
    lines.push("  (no labeled predictions yet)");
  }
  for (const m of r.modelRows.slice(0, 20)) {
    lines.push(
      `  ${m.model.padEnd(12)} ${String(m.featureSet || "-").padEnd(16)} ` +
      `n=${String(m.n).padStart(3)} acc=${m.accuracy != null ? (m.accuracy * 100).toFixed(1) + "%" : "—"} ` +
      `CI=${m.ci?.lower != null && m.ci.upper != null ? `${(m.ci.lower * 100).toFixed(1)}-${(m.ci.upper * 100).toFixed(1)}%` : "—"} ` +
      `FB=${m.falseBull} FBea=${m.falseBear} | ${m.message}`,
    );
  }

  lines.push("\nDirectional accuracy by horizon (lab_score/sdm):");
  for (const h of r.horizons) {
    const a = h.accuracy;
    lines.push(
      `  ${h.horizon.padEnd(4)} n=${String(h.n).padStart(3)} ` +
      `acc=${a?.accuracy != null ? (a.accuracy * 100).toFixed(1) + "%" : "—"} ` +
      `CI=${a?.ci?.lower != null && a.ci.upper != null ? `${(a.ci.lower * 100).toFixed(1)}-${(a.ci.upper * 100).toFixed(1)}%` : "—"} ` +
      `${a ? a.message : "no data"}`,
    );
  }

  lines.push("\nGap continuation / reversal (vs lab bias):");
  lines.push(
    `  cont: ${r.gap.contHit}/${r.gap.n || 0}` +
    (r.gap.contRate != null ? ` (${(r.gap.contRate * 100).toFixed(1)}%)` : "") +
    ` | rev: ${r.gap.revHit}/${r.gap.revHit + r.gap.revMiss}` +
    (r.gap.revRate != null ? ` (${(r.gap.revRate * 100).toFixed(1)}%)` : ""),
  );

  lines.push("\nOption simulation:");
  lines.push(`  ${r.optionSim.message}`);
  if (r.optionSim.winRate != null) {
    lines.push(
      `  winRate=${(r.optionSim.winRate * 100).toFixed(1)}% avgR=${r.optionSim.avgR?.toFixed(3) ?? "—"}`,
    );
  }

  lines.push("\nCoverage:");
  lines.push(
    `  CM=${r.coverage.cmDays} F&O=${r.coverage.fnoDays} study=${r.coverage.studyDays} ` +
    `features=${r.coverage.featureRows} scores=${r.coverage.scoreRows}`,
  );
  lines.push(
    `  shadow=${r.shadowCoverage.sessions} pending=${r.shadowCoverage.pendingOutcomes} ` +
    `recorded=${r.shadowCoverage.recordedOutcomes} unavailable=${r.shadowCoverage.unavailableOutcomes}`,
  );

  if (r.oosCompare) {
    lines.push(`\nOOS compare (labelEod): n=${r.oosCompare.nLabeled} sufficient=${r.oosCompare.sufficient}`);
    for (const s of r.oosCompare.sources) {
      lines.push(
        `  ${s.featureSet.padEnd(16)} nTest=${s.nTest} ` +
        `acc=${s.accuracy?.accuracy != null ? (s.accuracy.accuracy * 100).toFixed(1) + "%" : "—"}`,
      );
    }
  } else {
    lines.push(`\nOOS compare: insufficient n (need ≥ ${SHADOW_MIN_N} labeled sessions)`);
  }

  lines.push(`\nDisclaimer: ${r.disclaimer}`);
  return lines.join("\n");
}
