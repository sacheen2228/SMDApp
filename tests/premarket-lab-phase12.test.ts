// Phase 12 — Automated Quant Research Operations tests (offline, no network).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate DB for these tests
const TMP_DB = path.join(os.tmpdir(), `pmlab-phase12-${process.pid}.db`);
process.env.MARKET_HISTORY_DB = TMP_DB;

import {
  getLabDb, saveShadowSession, getShadowSession, listPendingOutcomes,
  setOutcomeStatus, appendCaptureAudit, listCaptureAudit, shadowCoverageStats,
  saveOptionSim, listOptionSims, saveStudyDay,
} from "@/lib/premarket-lab/storage";
import {
  attachOutcomesForSession, attachPendingOutcomes,
} from "@/lib/premarket-lab/outcome-attach";
import {
  simulateBuyOption, summarizeOptionSims, estimateChargesInr, pickAtmStrike,
} from "@/lib/premarket-lab/option-sim";
import { buildDailyReport, formatDailyReport } from "@/lib/premarket-lab/daily-report";
import {
  withLabLock, runCollectStage, runReportStage,
} from "@/lib/premarket-lab/daily-pipeline";
import { istDateISO, isTradingDay } from "@/lib/premarket-lab/calendar";
import { preopenAgeMs } from "@/lib/premarket-lab/fetchers";
import type { ShadowSession, PreopenStudyDay } from "@/lib/premarket-lab/types";
import type { CandleBar } from "@/lib/premarket-lab/outcomes";
import type { PremiumCandle } from "@/lib/option-bhavcopy";

beforeAll(() => {
  try { fs.unlinkSync(TMP_DB); } catch { /* fresh */ }
  // storage reads env at first open — force re-open after env set
  getLabDb();
});

afterAll(() => {
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
  delete process.env.MARKET_HISTORY_DB;
});

function baseSession(over: Partial<ShadowSession> = {}): ShadowSession {
  return {
    tradeDate: "2026-11-02",
    symbol: "NIFTY",
    featureAsOf: "2026-11-02T09:09:00+05:30",
    labScore: 55,
    labBias: "BULLISH",
    predictions: [
      { model: "lab_score", featureSet: "combined", pUp: 0.55, predLabel: 1, asOf: "2026-11-02T09:09:00+05:30" },
    ],
    sdm: null,
    outcomes: null,
    research: null,
    quality: null,
    optionSimValidated: null,
    notes: [],
    outcomeStatus: "PENDING_OUTCOME",
    outcomeAttempts: 0,
    ...over,
  };
}

function bar(min: number, o: number, h: number, l: number, c: number): CandleBar {
  const base = Date.parse("2026-11-02T03:45:00Z"); // 09:15 IST
  return { time: base + min * 60_000, open: o, high: h, low: l, close: c };
}

describe("P12 outcome attach status machine", () => {
  test("records when real candles present (idempotent)", () => {
    saveShadowSession(baseSession({ tradeDate: "2026-11-02", symbol: "NIFTY" }));
    const candles = [
      bar(0, 100, 102, 99, 101),
      bar(30, 102, 105, 101, 104),
      bar(78, 104, 106, 103, 105), // ~15:45 area not required for label
    ];
    const r1 = attachOutcomesForSession({
      tradeDate: "2026-11-02",
      symbol: "NIFTY",
      candles,
      prevClose: 98,
      now: new Date("2026-11-02T10:30:00+05:30"),
    });
    expect(r1.status).toBe("OUTCOME_RECORDED");
    expect(r1.outcomes?.labelEod).toBe(1);

    const r2 = attachOutcomesForSession({
      tradeDate: "2026-11-02",
      symbol: "NIFTY",
      candles, // idempotent — already recorded
      now: new Date("2026-11-02T11:00:00+05:30"),
    });
    expect(r2.status).toBe("OUTCOME_RECORDED");
    expect(r2.message).toBe("already_recorded");

    const s = getShadowSession("2026-11-02", "NIFTY");
    expect(s?.outcomeStatus).toBe("OUTCOME_RECORDED");
    expect(s?.outcomes?.labelEod).toBe(1);
  });

  test("no candles same day → stays PENDING; past day → UNAVAILABLE", () => {
    saveShadowSession(baseSession({ tradeDate: "2026-11-03", symbol: "BANKNIFTY" }));
    const mid = attachOutcomesForSession({
      tradeDate: "2026-11-03",
      symbol: "BANKNIFTY",
      now: new Date("2026-11-03T10:05:00+05:30"),
    });
    expect(mid.status).toBe("PENDING_OUTCOME");
    expect(mid.outcomes).toBeNull();

    const eod = attachOutcomesForSession({
      tradeDate: "2026-11-03",
      symbol: "BANKNIFTY",
      now: new Date("2026-11-04T09:00:00+05:30"), // next day
      forceUnavailable: true,
    });
    expect(eod.status).toBe("OUTCOME_UNAVAILABLE");
    const s = getShadowSession("2026-11-03", "BANKNIFTY");
    expect(s?.outcomeStatus).toBe("OUTCOME_UNAVAILABLE");
  });

  test("forceUnavailable does not discard available candles", () => {
    saveShadowSession(baseSession({ tradeDate: "2026-11-02", symbol: "FINNIFTY" }));
    const candles = [bar(0, 50, 52, 49, 51), bar(60, 51, 55, 50, 54)];
    const r = attachOutcomesForSession({
      tradeDate: "2026-11-02",
      symbol: "FINNIFTY",
      candles,
      forceUnavailable: true,
      now: new Date("2026-11-02T16:00:00+05:30"),
    });
    expect(r.status).toBe("OUTCOME_RECORDED");
    expect(r.outcomes?.labelEod).toBe(1);
  });

  test("listPendingOutcomes filters by status", () => {
    const pending = listPendingOutcomes({ limit: 500 });
    expect(pending.every((s) => (s.outcomeStatus || "PENDING_OUTCOME") === "PENDING_OUTCOME")).toBe(true);
    expect(pending.some((s) => s.symbol === "BANKNIFTY")).toBe(false); // unavailable
    expect(pending.some((s) => s.symbol === "NIFTY")).toBe(false); // recorded
  });

  test("setOutcomeStatus increments attempts and keeps notes appendable", () => {
    saveShadowSession(baseSession({ tradeDate: "2026-11-02", symbol: "SENSEX" }));
    setOutcomeStatus("2026-11-02", "SENSEX", "PENDING_OUTCOME", { attempts: 2, note: "awaiting_candles" });
    const s = getShadowSession("2026-11-02", "SENSEX");
    expect(s?.outcomeAttempts).toBe(2);
    expect(s?.outcomeStatus).toBe("PENDING_OUTCOME");
    expect(s?.notes.join(" ")).toContain("awaiting_candles");
  });
});

describe("P12 capture audit", () => {
  test("append-only history never overwrites prior rows", () => {
    const d = "2026-10-30"; // unique date so prior runs / shared DB can't collide
    appendCaptureAudit({
      tradeDate: d,
      capturedAt: "2026-10-30T09:02:00+05:30",
      cmRows: 100, fnoRows: 50,
      qualityOverall: "OK", qualityScore: 100,
      researchAsOf: "2026-10-30T09:02:01+05:30",
      notes: "first",
    });
    appendCaptureAudit({
      tradeDate: d,
      capturedAt: "2026-10-30T09:08:00+05:30",
      cmRows: 2411, fnoRows: 224,
      qualityOverall: "OK", qualityScore: 100,
      notes: "retry",
    });
    const rows = listCaptureAudit(d, 10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // newest first
    expect(rows[0].cm_rows).toBe(2411);
    expect(rows[0].notes).toBe("retry");
    expect(rows.some((r: any) => r.cm_rows === 100 && r.notes === "first")).toBe(true);
    // both retained — append-only
    expect(rows.length).toBeGreaterThanOrEqual(rows.filter((r: any) => r.notes === "first" || r.notes === "retry").length);
  });
});

describe("P12 lot-aware option sim", () => {
  function prem(over: Partial<PremiumCandle> = {}): PremiumCandle {
    return {
      date: "2026-11-02",
      symbol: "NIFTY",
      strike: 23200,
      optionType: "CE",
      expiry: "2026-11-06",
      open: 100,
      high: 120,
      low: 80,
      close: 110,
      underlying: 23250,
      lotSize: 75,
      volume: 1000,
      oi: 5000,
      ...over,
    };
  }

  test("known lot → pnlInr and lot-scaled charges", () => {
    const r = simulateBuyOption("2026-11-02", "NIFTY", "CE", prem(), { asOf: "2026-11-02T18:00:00Z" });
    expect(r.validated).toBe(true);
    expect(r.lotSize).toBe(75);
    expect(r.pnlInr).not.toBeNull();
    expect(r.charges).not.toBeNull();
    // WIN path (high 120 hits target 140? entry 100 stop 80 target 140 — high 120 < 140, low 80 <= 80 → LOSS SL-first)
    // low=80, stop=80 → hitStop true → LOSS
    expect(r.outcome).toBe("LOSS");
    // netPts negative → pnlInr negative after charges
    expect(r.pnlInr!).toBeLessThan(0);
  });

  test("unknown lot → flat charges, null pnlInr (never pretend lot=1)", () => {
    const r = simulateBuyOption("2026-11-02", "RELIANCE", "CE", prem({ lotSize: 0 }), {
      asOf: "2026-11-02T18:00:00Z",
      lotSize: null,
    });
    expect(r.lotSize).toBeNull();
    expect(r.pnlInr).toBeNull();
    expect(r.charges).toBe(40); // flat default
  });

  test("estimateChargesInr scales with turnover when lot known", () => {
    const flat = estimateChargesInr(100, null);
    const lot75 = estimateChargesInr(100, 75);
    expect(flat).toBe(40);
    expect(lot75).toBeGreaterThan(flat);
  });

  test("no premium candle → NOT_VALIDATED / NO_DATA, never underlying substitute", () => {
    const r = simulateBuyOption("2026-11-02", "NIFTY", "PE", null);
    expect(r.validated).toBe(false);
    expect(r.outcome).toBe("NO_DATA");
    expect(r.pnlR).toBeNull();
    const sum = summarizeOptionSims([r]);
    expect(sum.validated).toBe(0);
    expect(sum.message).toContain("NOT_VALIDATED");
  });

  test("save/list option sim persists lot + pnlInr columns", () => {
    const r = simulateBuyOption("2026-11-02", "MIDCPNIFTY", "CE", prem({ lotSize: 125 }), {
      asOf: "2026-11-02T18:30:00Z",
    });
    saveOptionSim(r);
    const rows = listOptionSims({ from: "2026-11-02", to: "2026-11-02", symbol: "MIDCPNIFTY" });
    expect(rows.length).toBe(1);
    expect(rows[0].lotSize).toBe(125);
    expect(rows[0].pnlInr).not.toBeNull();
  });
});

describe("P12 daily report", () => {
  test("builds honest report with status counts and insufficient-n messaging", () => {
    // Seed a labeled recorded session
    const outcomes = {
      open: 100, dayHigh: 110, dayLow: 99, eodClose: 105,
      label5m: 1, label15m: 1, label30m: 1, labelEod: 1,
      gapContEod: 1, gapRevEod: 0,
      notes: [],
    };
    saveShadowSession(baseSession({
      tradeDate: "2026-11-02",
      symbol: "NIFTY",
      outcomes: outcomes as any,
      outcomeStatus: "OUTCOME_RECORDED",
    }));
    const report = buildDailyReport({ tradeDate: "2026-11-02", includeOos: true });
    expect(report.sessions).toBeGreaterThan(0);
    expect(report.byStatus.OUTCOME_RECORDED).toBeGreaterThanOrEqual(1);
    expect(report.labeled).toBeGreaterThanOrEqual(1);
    expect(report.disclaimer).toContain("Not trade authorization");
    // n << 30 → model rows carry insufficient message when present
    for (const m of report.modelRows) {
      if (m.n < 30) expect(m.message).toContain("insufficient");
    }
    const text = formatDailyReport(report);
    expect(text).toContain("Pre-Market Lab Daily Report");
    expect(text).toContain("PENDING_OUTCOME");
    expect(text).toContain("Disclaimer");
  });
});

describe("P12 daily pipeline locks + trading-day gate", () => {
  test("withLabLock rejects non-trading day", async () => {
    const sunday = "2026-11-01"; // Sat Nov 1 2026 is Saturday; Nov 1 2026 = Sunday
    // Verify calendar: 2026-11-01 is Sunday
    expect(isTradingDay(sunday)).toBe(false);
    const r = await withLabLock("collect", sunday, async () => ({ x: 1 }));
    expect(r.ran).toBe(false);
    if (!r.ran) expect(r.reason).toBe("not_trading_day");
  });

  test("withLabLock is exclusive (second concurrent call skipped)", async () => {
    const tradeDate = "2026-11-03"; // Monday
    expect(isTradingDay(tradeDate)).toBe(true);
    let released = false;
    const first = withLabLock("report", tradeDate, async () => {
      await new Promise((r) => setTimeout(r, 50));
      released = true;
      return "first";
    });
    // give first a moment to acquire
    await new Promise((r) => setTimeout(r, 10));
    const second = await withLabLock("report", tradeDate, async () => "second");
    expect(second.ran).toBe(false);
    if (!second.ran) expect(second.reason).toBe("locked");
    const firstRes = await first;
    expect(firstRes.ran).toBe(true);
    expect(released).toBe(true);
  });

  test("collect stage skips non-trading day without network", async () => {
    const r = await runCollectStage({ tradeDate: "2026-11-01", skipResearch: true });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe("not_trading_day");
  });

  test("report stage runs on trading day (offline DB)", async () => {
    const r = await runReportStage({ tradeDate: "2026-11-03", writeLog: false });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe("report");
  });
});

describe("P12 fetch freshness", () => {
  test("preopenAgeMs parses NSE timestamp", () => {
    const now = Date.parse("2026-11-02T03:40:00Z"); // 09:10 IST
    const age = preopenAgeMs("02-Nov-2026 09:09:31", now);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(120_000);
    expect(preopenAgeMs(null)).toBeNull();
    expect(preopenAgeMs("not-a-date")).toBeNull();
  });
});

describe("P12 isolation — no production trade path imports", async () => {
  test("lab modules do not import sendTradeAlert / evaluateSignalVeto / telegram", async () => {
    const files = [
      "src/lib/premarket-lab/daily-pipeline.ts",
      "src/lib/premarket-lab/outcome-attach.ts",
      "src/lib/premarket-lab/daily-report.ts",
      "src/lib/premarket-lab/shadow-recorder.ts",
    ];
    const root = process.cwd();
    // Match real imports/usages, not prose comments like "Never calls sendTradeAlert"
    const badImport = /from\s+["'][^"']*telegram[^"']*["']|import\s*\{[^}]*sendTradeAlert|import\s*\{[^}]*evaluateSignalVeto|require\([^)]*telegram/;
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(badImport.test(src)).toBe(false);
      // No dynamic import of veto/alert modules
      expect(src).not.toMatch(/import\(\s*["'][^"']*(signal-veto|telegram)[^"']*["']\s*\)/);
    }
  });
});
