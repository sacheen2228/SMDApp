#!/usr/bin/env bun
// scripts/premarket-lab-report.ts
// Historical validation summary: coverage, gap stats, CM vs F&O vs combined.
// Usage: bun scripts/premarket-lab-report.ts [YYYY-MM-DD]

import {
  coverageStats, listStudyDays, loadFeatures, listModelRuns, shadowCoverageStats, listShadowSessions, listOptionSims,
} from "../src/lib/premarket-lab/storage";
import { computeGapHistory, gapPct } from "../src/lib/premarket-lab/analytics";
import { compareFeatureSets, walkForwardAverage } from "../src/lib/premarket-lab/validation";
import { compareShadow } from "../src/lib/premarket-lab/shadow-compare";
import { summarizeOptionSims } from "../src/lib/premarket-lab/option-sim";
import type { LabeledSample } from "../src/lib/premarket-lab/types";

const date = process.argv[2] || new Date().toISOString().slice(0, 10);

console.log("=== Pre-Market Data Science Lab Report ===");
console.log(`as of ${date}\n`);

const cov = coverageStats();
console.log("Coverage:");
console.log(`  CM days: ${cov.cmDays} (${cov.cmRange?.join(" → ") || "none"})`);
console.log(`  F&O days: ${cov.fnoDays} (${cov.fnoRange?.join(" → ") || "none"})`);
console.log(`  Study days: ${cov.studyDays}`);
console.log(`  Feature rows: ${cov.featureRows}`);
console.log(`  Model runs: ${cov.modelRuns}`);
console.log(`  Score rows: ${cov.scoreRows}`);

const days = listStudyDays({ limit: 1000 });
const niftyGaps = days
  .filter((d) => d.symbol === "NIFTY" && d.cm)
  .map((d) => gapPct(d.cm!.iep ?? d.cm!.finalPrice, d.cm!.previousClose))
  .filter((g): g is number => g != null);

console.log("\nNIFTY CM gap history:");
const stats = computeGapHistory(niftyGaps);
console.log(`  n=${stats.n} mean=${stats.meanGap?.toFixed(3)}% std=${stats.stdGap?.toFixed(3)}%`);
console.log(`  gap-up freq=${stats.gapUpFreq != null ? (stats.gapUpFreq * 100).toFixed(1) : "—"}%`);
console.log(`  gap-down freq=${stats.gapDownFreq != null ? (stats.gapDownFreq * 100).toFixed(1) : "—"}%`);

for (const target of ["gap_continuation", "gap_reversal", "opening_breakout"]) {
  const rows = loadFeatures({ target });
  const samples: LabeledSample[] = rows
    .filter((r) => r.label === 0 || r.label === 1)
    .map((r) => ({
      tradeDate: r.tradeDate,
      symbol: r.symbol,
      features: r.features,
      target: r.target || target,
      label: r.label as 0 | 1,
    }));
  console.log(`\nTarget ${target}: n=${samples.length}`);
  if (samples.length >= 30) {
    const cmp = compareFeatureSets(samples, target, "logistic", 0.7);
    for (const c of cmp) {
      const m = c.metrics;
      console.log(
        `  ${c.featureSet.padEnd(12)} nTest=${String(c.nTest).padStart(3)} ` +
        `F1=${m?.f1?.toFixed(3) ?? "—"} AUC=${m?.rocAuc?.toFixed(3) ?? "—"} Brier=${m?.brier?.toFixed(3) ?? "—"}`,
      );
    }
    const wf = walkForwardAverage(samples, target, "logistic", "cm_fno", 3);
    if (wf.mean) {
      console.log(`  walk-forward CM+F&O mean F1=${wf.mean.f1?.toFixed(3) ?? "—"} AUC=${wf.mean.rocAuc?.toFixed(3) ?? "—"} folds=${wf.folds.length}`);
    }
  } else {
    console.log("  (insufficient for OOS comparison — continue daily collection)");
  }
}

const runs = listModelRuns(10);
if (runs.length) {
  console.log("\nRecent model runs:");
  for (const r of runs.slice(0, 5)) {
    console.log(`  ${r.model_name} / ${r.target} / ${r.feature_set} @ ${r.created_at}`);
  }
}

// Phase 11 — Shadow validation
const scov = shadowCoverageStats();
console.log("\nShadow validation coverage:");
console.log(`  sessions: ${scov.sessions} (${scov.dateRange?.join(" → ") || "none"})`);
console.log(`  with outcomes: ${scov.withOutcomes} · with SDM: ${scov.withSdm} · with research: ${scov.withResearch}`);
console.log(`  option sim validated: ${scov.optionSimValidated} · NOT_VALIDATED: ${scov.optionSimNotValidated}`);

const shadowSessions = listShadowSessions({ limit: 5000 });
const shadowCmp = compareShadow({ target: "gap_continuation", model: "logistic", sessions: shadowSessions });
console.log(`\nShadow OOS compare (gap_continuation, logistic): n=${shadowCmp.nLabeled} sufficient=${shadowCmp.sufficient}`);
if (shadowCmp.sufficient) {
  for (const s of shadowCmp.sources) {
    console.log(
      `  ${s.featureSet.padEnd(16)} nTest=${String(s.nTest).padStart(3)} ` +
      `acc=${s.accuracy?.accuracy != null ? (s.accuracy.accuracy * 100).toFixed(1) + "%" : "—"} ` +
      `CI=${s.accuracy?.ci?.lower != null && s.accuracy?.ci?.upper != null ? `${(s.accuracy.ci.lower * 100).toFixed(1)}-${(s.accuracy.ci.upper * 100).toFixed(1)}%` : "—"}` +
      ` sig=${s.accuracy?.significantAt05 ? "Y" : "N"}`,
    );
  }
  if (shadowCmp.sdm) {
    console.log(
      `  SDM              n=${shadowCmp.sdm.n} acc=${shadowCmp.sdm.accuracy?.accuracy != null ? (shadowCmp.sdm.accuracy.accuracy * 100).toFixed(1) + "%" : "—"}` +
      ` ${shadowCmp.sdm.note}`,
    );
  }
} else {
  console.log(`  (insufficient — continue daily shadow collection; min N=${shadowCmp.minN})`);
}

const sims = listOptionSims({ limit: 500 });
const simSum = summarizeOptionSims(sims);
console.log(`\nOption sim: ${simSum.message}`);
if (simSum.n) {
  console.log(`  validated=${simSum.validated} winRate=${simSum.winRate != null ? (simSum.winRate * 100).toFixed(1) + "%" : "—"} avgR=${simSum.avgR?.toFixed(3) ?? "—"}`);
}

// Phase 12 — daily report (pred vs outcome, horizons, gap cont/rev, status machine)
try {
  const { buildDailyReport, formatDailyReport } = await import("../src/lib/premarket-lab/daily-report");
  const daily = buildDailyReport({ includeOos: true });
  console.log("\n" + formatDailyReport(daily));
} catch (e: any) {
  console.log(`\nDaily report failed: ${e?.message || e}`);
}

console.log("\nDisclaimer: research metrics only — not profitability claims, not trade authorization.");
