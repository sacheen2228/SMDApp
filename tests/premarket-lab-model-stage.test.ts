// The features → model → score loop must actually produce data.
//
// The three tables (premarket_features / premarket_model_runs /
// premarket_scores) were all EMPTY in production: the features were never
// persisted, no model run was ever recorded and the combined score was never
// saved. The stage below closes the loop — and it must never fabricate: a
// day with no session prints produces no features, no labels and no model.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP_DB = path.join(os.tmpdir(), `pmlab-model-${process.pid}.db`);
process.env.MARKET_HISTORY_DB = TMP_DB;

import {
  getLabDb, saveStudyDay, listStudyDays,
} from "@/lib/premarket-lab/storage";
import { runModelStage } from "@/lib/premarket-lab/daily-pipeline";
import { buildFeatureDataset } from "@/lib/premarket-lab/dataset";
import type { PreopenStudyDay } from "@/lib/premarket-lab/types";

beforeAll(() => {
  // Re-assert here: another test file's afterAll may have deleted the env
  // var between our module load and our first DB access.
  process.env.MARKET_HISTORY_DB = TMP_DB;
  try { fs.unlinkSync(TMP_DB); } catch { /* fresh */ }
  getLabDb();
});

afterAll(() => {
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
  if (process.env.MARKET_HISTORY_DB === TMP_DB) delete process.env.MARKET_HISTORY_DB;
});

function studyDay(tradeDate: string, symbol: string, open?: { spotOpen: number }): PreopenStudyDay {
  return {
    tradeDate,
    symbol,
    provenance: { source: "NSE_CM_PREOPEN", fetchedAt: `${tradeDate}T03:40:00Z` } as any,
    quality: {
      overall: "OK",
      score: 100,
      perSource: {
        NSE_CM_PREOPEN: { quality: "OK", ageMs: 1000 },
        NSE_FNO_PREOPEN: { quality: "OK", ageMs: 1000 },
      },
    } as any,
    cm: {
      previousClose: 100, iep: 102, finalPrice: 103, pChange: 3,
      finalQuantity: 1000, totalTurnover: 100000, imbalanceQty: 10,
      bestBid: 102.9, bestAsk: 103.1,
    },
    futures: {
      instrumentType: "FUTSTK", expiryDate: "28-Nov-2026",
      previousClose: 100, iep: 102.2, finalPrice: 103.2, pChange: 3.2,
      finalQuantity: 900, totalTurnover: 90000, imbalanceQty: 20,
      basis: 0.2, basisPct: 0.2,
    },
    open: open
      ? { spotOpen: open.spotOpen, futuresOpen: null, dayHigh: 105, dayLow: 101, dayClose: 104, volume: 5000 }
      : null,
    fiiNet: 100, diiNet: 50, vix: 14.2,
    research: null,
  } as any;
}

describe("premarket-lab — the features → model → score loop", () => {
  test("a study day WITHOUT a session produces no features and no samples", () => {
    saveStudyDay(studyDay("2026-11-02", "NIFTY"));
    const ds = buildFeatureDataset({ requireOpen: true, persist: false });
    expect(ds.features.length).toBe(0);
    expect(ds.samples.length).toBe(0);
    expect(ds.skippedNoOpen).toBeGreaterThan(0);
  });

  test("a study day WITH a session produces a labeled feature row", () => {
    saveStudyDay(studyDay("2026-11-03", "NIFTY", { spotOpen: 102.5 }));
    const ds = buildFeatureDataset({ requireOpen: true, persist: false });
    expect(ds.features.length).toBe(1);
    expect(ds.samples.length).toBeGreaterThan(0);
    expect(ds.samples[0].tradeDate).toBe("2026-11-03");
    expect(ds.samples[0].label === 0 || ds.samples[0].label === 1).toBe(true);
  });

  test("persisting the features is IDEMPOTENT — no duplicate rows per day", () => {
    const before = buildFeatureDataset({ requireOpen: true, persist: true });
    const after = buildFeatureDataset({ requireOpen: true, persist: true });
    expect(after.samples.length).toBe(before.samples.length);
    const rows = getLabDb()
      .prepare("SELECT COUNT(*) n FROM premarket_features")
      .get() as any;
    const labeled = getLabDb()
      .prepare("SELECT COUNT(*) n FROM premarket_features WHERE target IS NOT NULL")
      .get() as any;
    // One row per (day, symbol, target) — never a second copy of the same day.
    expect(rows.n).toBe(labeled.n);
  });

  test("the model stage never invents a model run from too little data", async () => {
    const r = await runModelStage({ tradeDate: "2026-11-04", persist: true, skipOpen: true });
    expect(r.ok).toBe(true);
    // Two labeled days is not a dataset — the stage must refuse to fit.
    expect(r.data?.modelRuns ?? 0).toBe(0);
    const runs = getLabDb().prepare("SELECT COUNT(*) n FROM premarket_model_runs").get() as any;
    expect(runs.n).toBe(0);
  });

  test("the model stage scores the day's study days when the quality gate passes", async () => {
    saveStudyDay(studyDay("2026-11-04", "RELIANCE", { spotOpen: 102.5 }));
    const r = await runModelStage({ tradeDate: "2026-11-04", persist: true, skipOpen: true });
    expect(r.ok).toBe(true);
    const scores = getLabDb().prepare("SELECT COUNT(*) n FROM premarket_scores").get() as any;
    expect(scores.n).toBeGreaterThan(0);
  });

  test("the study days keep their session block after the stage", () => {
    const days = listStudyDays({ from: "2026-11-03", to: "2026-11-03" });
    expect(days.length).toBe(1);
    expect(days[0].open?.spotOpen).toBe(102.5);
  });
});
