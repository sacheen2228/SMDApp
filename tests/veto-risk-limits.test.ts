/// <reference types="bun-types" />
// THE ACCOUNT RISK FRAME, enforced in the SIGNAL VETO (2026-10-20).
//
// THE DEFECT: the loss caps lived only in the agent's trade gate, so the
// scanner / Zero-Hero / SDMBot / master-bot Telegram paths were NOT day-loss
// limited at all, and NOTHING summed the exposure of the open trades:
// 3 concurrent ₹20,000 deployments = ₹60,000 committed and ₹12,000 (48% of the
// ₹25,000 account) at risk at the same time.
//
// WHAT IS PINNED HERE (offline — no DB, no network):
//   • the caps are derived from GATE_CONFIG and are all ≤ the ₹25,000 account
//   • a day-loss breach blocks the next candidate
//   • the consecutive-loss rule is the binding one
//   • the concurrent-exposure check blocks a trade that would exceed the cap
//   • an unknown exposure fails closed
//   • the paper account mirrors the real ₹25,000 account
//   • the veto's EXISTING gates (R:R, stop side, delta, OTM, expiry, session,
//     deployment/lot) still behave exactly as before
//
// The risk state is injected (the loader seam) so nothing here touches the
// journal: the same seam the production funnel uses.

import { describe, test, expect } from "bun:test";
import {
  evaluateSignalVeto,
  evaluateSignalVetoWithRisk,
  type VetoInput,
} from "@/lib/signal-veto";
import {
  RISK_LIMITS,
  evaluateConcurrentExposure,
  evaluateLossCaps,
  evaluateSignalRiskLimits,
  type RiskStateSnapshot,
} from "@/lib/risk-management";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";
import { DEFAULT_PAPER_CONFIG } from "@/lib/hermes/paper-engine";
import { DEFAULT_PAPER_WORKER_CONFIG } from "@/lib/hermes/paper-worker";

// 2026-07-15 10:05 IST — before the 13:00 option-buy cutoff
const AT = Date.parse("2026-07-15T10:05:00+05:30");

const base: VetoInput = {
  nowMs: AT,
  symbol: "NIFTY",
  action: "BUY CE",
  optionType: "CE",
  strike: 25200,
  entry: 150,
  stopLoss: 120,
  tp1: 210,
  confidence: 75, // 75 stated → 68 calibrated (×0.9 haircut) → above the 65 floor
};

/** A clean book: nothing realised, nothing open. */
const cleanBook: RiskStateSnapshot = {
  dailyPnl: 0,
  weeklyPnl: 0,
  monthlyPnl: 0,
  consecutiveLosses: 0,
  openDeployed: 0,
  openRisk: 0,
  openPositions: 0,
  unpricedOpenPositions: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
describe("the caps are derived from GATE_CONFIG and fit the ₹25,000 account", () => {
  test("the raw numbers live in GATE_CONFIG", () => {
    expect(GATE_CONFIG.capital).toBe(25_000);
    expect(GATE_CONFIG.tradeBudget).toBe(20_000);
    expect(GATE_CONFIG.riskPctOfTrade).toBe(20);
    expect(GATE_CONFIG.maxConsecutiveLosses).toBe(2);
    expect(GATE_CONFIG.maxDailyLossPct).toBe(40);
  });

  test("one stop is the fixed ₹2,000 cap (≈ 8% of the account)", () => {
    expect(RISK_LIMITS.maxRiskPerTrade).toBe(2_000);
    expect(RISK_LIMITS.maxRiskPerTrade / RISK_LIMITS.capital).toBeCloseTo(0.08, 4);
  });

  test("the daily / weekly / monthly caps are all ≤ the account", () => {
    expect(RISK_LIMITS.maxDailyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxWeeklyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    // the monthly cap used to be ₹50,000 — 2× the whole account
    expect(RISK_LIMITS.maxMonthlyLoss).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxMonthlyLoss).toBe(16_000);
  });

  test("the caps are monotone (a bigger bucket allows a bigger loss)", () => {
    expect(RISK_LIMITS.maxDailyLoss).toBeLessThan(RISK_LIMITS.maxWeeklyLoss);
    expect(RISK_LIMITS.maxWeeklyLoss).toBeLessThanOrEqual(RISK_LIMITS.maxMonthlyLoss);
  });

  test("the streak rule is the BINDING one — it stops the day before the 40% cap", () => {
    // two stops = ₹4,000 = 16% of the account; the 40% daily cap (₹10,000)
    // can never be reached first.
    expect(RISK_LIMITS.maxDailyLoss).toBe(RISK_LIMITS.maxRiskPerTrade * GATE_CONFIG.maxConsecutiveLosses);
    expect(RISK_LIMITS.maxDailyLoss).toBeLessThan((RISK_LIMITS.capital * GATE_CONFIG.maxDailyLossPct) / 100);
  });

  test("the exposure budgets live inside the account too", () => {
    expect(RISK_LIMITS.maxOpenDeployed).toBe(20_000);
    expect(RISK_LIMITS.maxOpenDeployed).toBeLessThanOrEqual(RISK_LIMITS.capital);
    expect(RISK_LIMITS.maxOpenRisk).toBeLessThanOrEqual(RISK_LIMITS.capital);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the veto blocks the next candidate once the day is lost", () => {
  test("a clean book passes", () => {
    const r = evaluateSignalVeto({ ...base, riskState: cleanBook });
    expect(r.verdict).toBe("PASS");
    expect(r.fails).toHaveLength(0);
  });

  test("a day-loss breach blocks the next candidate", () => {
    const r = evaluateSignalVeto({
      ...base,
      riskState: { ...cleanBook, dailyPnl: -RISK_LIMITS.maxDailyLoss, weeklyPnl: -RISK_LIMITS.maxDailyLoss, monthlyPnl: -RISK_LIMITS.maxDailyLoss },
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.suppress).toBe(true);
    expect(r.hardFail).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/daily loss/);
  });

  test("one rupee below the cap still trades", () => {
    const r = evaluateSignalVeto({
      ...base,
      riskState: { ...cleanBook, dailyPnl: -(RISK_LIMITS.maxDailyLoss - 1) },
    });
    expect(r.verdict).toBe("PASS");
  });

  test("the weekly and monthly caps block on their own", () => {
    expect(evaluateSignalVeto({ ...base, riskState: { ...cleanBook, weeklyPnl: -RISK_LIMITS.maxWeeklyLoss } }).verdict).toBe("BLOCK");
    expect(evaluateSignalVeto({ ...base, riskState: { ...cleanBook, monthlyPnl: -RISK_LIMITS.maxMonthlyLoss } }).verdict).toBe("BLOCK");
  });

  test("the consecutive-loss rule is the binding one", () => {
    // one loss is fine, two losses end the session even with a flat P&L
    expect(evaluateSignalVeto({ ...base, riskState: { ...cleanBook, consecutiveLosses: 1 } }).verdict).toBe("PASS");
    const r = evaluateSignalVeto({ ...base, riskState: { ...cleanBook, consecutiveLosses: 2 } });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/consecutive losses/);
  });

  test("an unreadable risk state FAILS CLOSED", () => {
    const r = evaluateSignalVeto({ ...base, riskUnavailable: true });
    expect(r.verdict).toBe("BLOCK");
    expect(r.suppress).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/cannot verify today's loss/i);
  });

  test("the BTST path keeps its own option gates but NOT the account rule", () => {
    const btst: VetoInput = {
      nowMs: AT,
      symbol: "RELIANCE",
      action: "BUY",
      source: "BTST",
      entry: 2800,
      stopLoss: 2750,
      tp1: 2810, // R:R 0.2 — the BTST path is exempt from the R:R gate
      confidence: 40,
    };
    expect(evaluateSignalVeto(btst).verdict).toBe("PASS");
    const blown = evaluateSignalVeto({
      ...btst,
      riskState: { ...cleanBook, dailyPnl: -9_000, weeklyPnl: -9_000, monthlyPnl: -9_000 },
    });
    expect(blown.verdict).toBe("BLOCK");
    expect(blown.reasons.join(" ")).toMatch(/daily loss/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the veto enforces the CONCURRENT EXPOSURE", () => {
  test("one full-size trade fits the open-deployment budget", () => {
    const r = evaluateSignalVeto({
      ...base,
      deployedAmount: 20_000,
      riskAmount: 2_000,
      riskState: cleanBook,
    });
    expect(r.verdict).toBe("PASS");
  });

  test("a second trade that would exceed the cap is blocked", () => {
    const r = evaluateSignalVeto({
      ...base,
      deployedAmount: 6_500,
      riskAmount: 1_300,
      riskState: { ...cleanBook, openDeployed: 20_000, openRisk: 4_000, openPositions: 1 },
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/deployed/i);
  });

  test("remaining headroom: a partial open book does NOT permanent-block a smaller new trade", () => {
    // Open ₹4,000 + a candidate sized into the remaining ₹16,000 must PASS
    // the exposure check (the old code sized the candidate against the FULL
    // ₹20k budget → open+new always exceeded the cap → every alert blocked).
    const r = evaluateSignalVeto({
      ...base,
      deployedAmount: 8_000, // fits in the ₹16,000 headroom
      riskAmount: 1_600,
      riskState: { ...cleanBook, openDeployed: 4_000, openRisk: 800, openPositions: 1 },
    });
    expect(r.verdict).toBe("PASS");
    expect(r.reasons.join(" ")).not.toMatch(/headroom|exceeds the/i);
  });

  test("remaining headroom 0 → explicit block (the book is full)", () => {
    const r = evaluateSignalVeto({
      ...base,
      riskState: { ...cleanBook, openDeployed: 20_000, openRisk: 4_000, openPositions: 1 },
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/headroom|deployed/i);
  });

  test("3 × ₹20,000 concurrent deployments are impossible (the account is ₹25,000)", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 40_000,
      openRisk: 8_000,
      newDeployed: 20_000,
      newRisk: 2_000,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/deployed/i);
  });

  test("the Σ risk of the open trades may not exceed the risk budget", () => {
    const v = evaluateConcurrentExposure({
      openDeployed: 10_000,
      openRisk: RISK_LIMITS.maxOpenRisk,
      newDeployed: 1_000,
      newRisk: 100,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/risk budget/i);
  });

  test("an UNKNOWN open exposure fails closed (it is not a zero exposure)", () => {
    const r = evaluateSignalVeto({
      ...base,
      riskState: { ...cleanBook, unpricedOpenPositions: 1 },
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.suppress).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/cannot be verified|fail closed/i);
  });

  test("the whole verdict is one call (loss caps AND exposure)", () => {
    const v = evaluateSignalRiskLimits({
      state: { ...cleanBook, dailyPnl: -9_000, openDeployed: 20_000, openRisk: 4_000 },
      newDeployed: 6_500,
      newRisk: 1_300,
    });
    expect(v.blocked).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/daily loss/);
    expect(v.reasons.join(" ")).toMatch(/deployed/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the funnel entry point — evaluateSignalVetoWithRisk", () => {
  test("a clean book passes", async () => {
    const r = await evaluateSignalVetoWithRisk(base, async () => ({ ok: true, state: cleanBook }));
    expect(r.verdict).toBe("PASS");
  });

  test("a blown day blocks", async () => {
    const r = await evaluateSignalVetoWithRisk(base, async () => ({
      ok: true,
      state: { ...cleanBook, dailyPnl: -9_000, weeklyPnl: -9_000, monthlyPnl: -9_000 },
    }));
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/daily loss/);
  });

  test("a loader that fails FAILS CLOSED — 'cannot verify today's loss'", async () => {
    const r = await evaluateSignalVetoWithRisk(base, async () => ({ ok: false, reason: "journal down" }));
    expect(r.verdict).toBe("BLOCK");
    expect(r.suppress).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/cannot verify today's loss/i);
  });

  test("a loader that throws FAILS CLOSED too", async () => {
    const r = await evaluateSignalVetoWithRisk(base, async () => {
      throw new Error("boom");
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/cannot verify today's loss/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the paper account mirrors the REAL account", () => {
  test("the paper engine starts with the real capital (₹25,000, not ₹1,00,000)", () => {
    expect(DEFAULT_PAPER_CONFIG.startingCapital).toBe(GATE_CONFIG.capital);
    expect(DEFAULT_PAPER_CONFIG.startingCapital).toBe(25_000);
  });

  test("the paper worker starts with the real capital", () => {
    expect(DEFAULT_PAPER_WORKER_CONFIG.startingCapital).toBe(GATE_CONFIG.capital);
    expect(DEFAULT_PAPER_WORKER_CONFIG.startingCapital).toBe(25_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the EXISTING veto gates still behave (no regression)", () => {
  test("a sound option signal passes", () => {
    const r = evaluateSignalVeto(base);
    expect(r.verdict).toBe("PASS");
    expect(r.sizeFactor).toBe(1);
    expect(r.reasons).toHaveLength(0);
  });

  test("R:R below 1.5 still blocks", () => {
    const r = evaluateSignalVeto({ ...base, tp1: 180 }); // (180-150)/30 = 1.0
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/R:R/);
  });

  test("a stop on the wrong side of the entry still blocks", () => {
    const r = evaluateSignalVeto({ ...base, stopLoss: 150 });
    expect(r.verdict).toBe("BLOCK");
  });

  test("a missing stop / target still fails closed", () => {
    expect(evaluateSignalVeto({ ...base, stopLoss: undefined }).verdict).toBe("BLOCK");
    expect(evaluateSignalVeto({ ...base, tp1: undefined }).verdict).toBe("BLOCK");
  });

  test("the expiry-day index option still blocks (ISO)", () => {
    const r = evaluateSignalVeto({ ...base, expiry: "2026-07-15" });
    expect(r.verdict).toBe("BLOCK");
  });

  test("the expiry-day index option still blocks (Breeze DD-MMM-YYYY)", () => {
    const r = evaluateSignalVeto({ ...base, expiry: "15-Jul-2026" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/expiry-day/);
  });

  test("the deep-OTM delta lottery ticket still blocks", () => {
    const r = evaluateSignalVeto({
      ...base,
      spot: 25150,
      expiry: "2026-12-03",
      entry: 1,
      strike: 25600,
      stopLoss: 0.5,
      tp1: 3,
      confidence: 90,
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/delta/);
  });

  test("more than 3 steps OTM still blocks", () => {
    const r = evaluateSignalVeto({ ...base, strike: 25400, spot: 25150 });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/steps/);
  });

  test("0 lots and an over-budget deployment still block", () => {
    expect(evaluateSignalVeto({ ...base, lots: 0 }).verdict).toBe("BLOCK");
    expect(evaluateSignalVeto({ ...base, deployedAmount: 45_000 }).verdict).toBe("BLOCK");
  });

  test("the 13:00 option-buy cutoff still blocks", () => {
    const afterOne = Date.parse("2026-07-15T13:30:00+05:30");
    const r = evaluateSignalVeto({ ...base, nowMs: afterOne });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/13:00/);
  });

  test("a low-confidence candidate still WARNS (it is not blocked)", () => {
    const r = evaluateSignalVeto({ ...base, confidence: 40 });
    expect(r.verdict).toBe("WARN");
    expect(r.sizeFactor).toBe(0.5);
    expect(r.reasons.join(" ")).toMatch(/confidence/);
  });

  test("an equity signal still passes the option-free path", () => {
    const r = evaluateSignalVeto({
      ...base,
      symbol: "RELIANCE",
      optionType: undefined,
      strike: undefined,
      tp1: 2900,
      entry: 2800,
      stopLoss: 2750,
      expiry: undefined,
    });
    expect(r.verdict).toBe("PASS");
  });

  test("without a risk state the pure veto is unchanged (no state, no block)", () => {
    const r = evaluateSignalVeto(base);
    expect(r.fails).toHaveLength(0);
    expect(r.hardFail).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the loss caps are the same rules the agent gate uses", () => {
  test("evaluateLossCaps agrees with the veto on the daily cap", () => {
    const atCap = evaluateLossCaps({ dailyPnl: -RISK_LIMITS.maxDailyLoss });
    expect(atCap.blocked).toBe(true);
    const justUnder = evaluateLossCaps({ dailyPnl: -(RISK_LIMITS.maxDailyLoss - 1) });
    expect(justUnder.blocked).toBe(false);
  });

  test("the caps the veto reads are the caps the agent gate reads", () => {
    expect(RISK_LIMITS.capital).toBe(GATE_CONFIG.capital);
    expect(RISK_LIMITS.perTradeBudget).toBe(GATE_CONFIG.tradeBudget);
    expect(RISK_LIMITS.riskPctOfTrade).toBe(GATE_CONFIG.riskPctOfTrade);
    expect(RISK_LIMITS.maxConsecutiveLosses).toBe(GATE_CONFIG.maxConsecutiveLosses);
  });
});
