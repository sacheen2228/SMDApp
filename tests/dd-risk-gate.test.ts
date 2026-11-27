/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// THE DAILY DERIVATIVES RISK GATE
//
// The Daily Derivatives dashboard needs ONE risk verdict for a candidate
// trade. This file pins that gate: it reuses the EXISTING SDMApp risk
// configuration and invents no new numbers.
//
//   1. per-trade risk      → GATE_CONFIG.riskPctOfTrade + RISK_LIMITS.perTradeBudget
//   2. daily/weekly/monthly loss caps → RISK_LIMITS.* via evaluateSignalRiskLimits
//   3. loss streak         → GATE_CONFIG.maxConsecutiveLosses
//   4. concurrency         → RISK_LIMITS.maxConcurrentTrades (warn | block policy)
//   5. late option buy     → BRAIN_FLAGS.noOptionBuysAfter13 + the CONFIGURED
//                             cutoff (market-session) — never a hardcoded 13:00
//   6. expiry day          → GATE_CONFIG.allowExpiryDay
//   7. market closed       → the shared session module
//
// Every FAIL and every WARNING carries a human-readable reason, so a refusal
// can always become a WAIT / NO TRADE line on a card (never a silent pass).
//
// OFFLINE: pure functions only — no DB, no network, no clock (the IST minute
// is pinned by the test).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test, expect, afterEach } from "bun:test";
import {
  RISK_LIMITS,
  evaluateDailyDerivativesRisk,
  type DailyDerivativesRiskInput,
} from "@/lib/risk-management";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";
import { BRAIN_FLAGS } from "@/lib/brain-flags";
import {
  LATE_OPTION_BUY_CUTOFF_IST_MINUTES,
  LATE_OPTION_BUY_CONFIG,
  setLateOptionBuyCutoff,
} from "@/lib/market-session";

// The behavioural switch lives in the BRAIN_FLAGS config object. brain-flags.ts
// exposes no setter for it (only setSimpleEngine), so the test drives the
// config object directly — the same runtime-mutation mechanism setSimpleEngine
// uses inside brain-flags.ts. The gate reads the flag AT CALL TIME, so the
// mutation is visible to it.
const flags = BRAIN_FLAGS as { noOptionBuysAfter13: boolean };
const cutoffConfig = LATE_OPTION_BUY_CONFIG as { cutoffIstMinutes: number };

const AT_PRIMARY = 10 * 60 + 45;   // 10:45 IST — primary window, new buys allowed
const AT_AFTERNOON = 13 * 60 + 30; // 13:30 IST — after the configured 13:00 cutoff
const AT_LATE = 14 * 60 + 20;      // 14:20 IST — afternoon
const AT_CLOSED = 16 * 60;         // 16:00 IST — market closed

/** A clean, risk-valid candidate (₹13,000 deployed, ₹2,600 at risk = 20%). */
function candidate(over: Partial<DailyDerivativesRiskInput> = {}): DailyDerivativesRiskInput {
  return {
    direction: "CALL",
    deployedAmount: 13_000,
    riskAmount: 2_600,
    istMinutes: AT_PRIMARY,
    state: {
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
      consecutiveLosses: 0,
      openDeployed: 0,
      openRisk: 0,
      openPositions: 0,
    },
    ...over,
  };
}

afterEach(() => {
  flags.noOptionBuysAfter13 = false;
  setLateOptionBuyCutoff();
  delete process.env.SMD_ALLOW_LATE_OPTION_BUYS;
});

describe("the daily derivatives risk gate — a clean candidate passes", () => {
  test("a risk-valid candidate returns ok and NO fail reasons", () => {
    const r = evaluateDailyDerivativesRisk(candidate());
    expect(r.ok).toBe(true);
    expect(r.reasons.length).toBe(0);
    expect(r.warnings.length).toBe(0);
  });

  test("the exposure is priced with the CONFIGURED risk percentage", () => {
    const r = evaluateDailyDerivativesRisk(candidate());
    expect(r.exposure.deployed).toBe(13_000);
    expect(r.exposure.risk).toBe(2_600);
    expect(r.exposure.riskBudget).toBeCloseTo((13_000 * GATE_CONFIG.riskPctOfTrade) / 100, 2);
    expect(r.exposure.perTradeBudget).toBe(RISK_LIMITS.perTradeBudget);
    expect(r.exposure.withinPerTradeRisk).toBe(true);
  });

  test("the session's allowedActions are surfaced for the caller", () => {
    const r = evaluateDailyDerivativesRisk(candidate());
    expect(r.policy.session.allowedActions).toContain("BUY_CALL");
    expect(r.policy.session.requiredAction).toBe("BUY_CALL");
    expect(r.policy.session.isMarketOpen).toBe(true);
  });
});

describe("the per-trade risk limit", () => {
  test("a candidate whose risk exceeds the configured per-trade risk FAILS", () => {
    // ₹10,000 deployed → the configured risk limit is 20% = ₹2,000; the
    // candidate risks ₹2,500.
    const r = evaluateDailyDerivativesRisk(candidate({ deployedAmount: 10_000, riskAmount: 2_500 }));
    expect(r.ok).toBe(false);
    const why = r.reasons.join(" ");
    expect(why).toMatch(/per-trade risk/i);
    expect(why).toContain("₹2,000");          // the limit is named
    expect(why).toContain("₹2,500");          // so is the breach
    expect(why).toContain(String(GATE_CONFIG.riskPctOfTrade));
  });

  test("a deployment above the configured per-trade budget FAILS", () => {
    const over = RISK_LIMITS.perTradeBudget + 1;
    const r = evaluateDailyDerivativesRisk(candidate({
      deployedAmount: over,
      riskAmount: (over * GATE_CONFIG.riskPctOfTrade) / 100,
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/per-trade budget/i);
  });

  test("risk exactly at the configured limit passes (the limit is inclusive)", () => {
    const r = evaluateDailyDerivativesRisk(candidate({ deployedAmount: 10_000, riskAmount: 2_000 }));
    expect(r.ok).toBe(true);
  });
});

describe("the loss streak (cumulative daily / weekly / monthly caps removed)", () => {
  test("a loss streak AT maxConsecutiveLosses FAILS", () => {
    const below = evaluateDailyDerivativesRisk(candidate({
      state: { consecutiveLosses: GATE_CONFIG.maxConsecutiveLosses - 1 },
    }));
    expect(below.ok).toBe(true);

    const at = evaluateDailyDerivativesRisk(candidate({
      state: { consecutiveLosses: GATE_CONFIG.maxConsecutiveLosses },
    }));
    expect(at.ok).toBe(false);
    expect(at.reasons.join(" ")).toMatch(/consecutive losses/i);
    expect(at.reasons.join(" ")).toContain(String(GATE_CONFIG.maxConsecutiveLosses));
  });
});

describe("concurrency — surfaced with the configured policy", () => {
  test("at the configured maximum the book is surfaced as a WARNING by default", () => {
    const r = evaluateDailyDerivativesRisk(candidate({
      state: { openPositions: RISK_LIMITS.maxConcurrentTrades },
    }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/concurrent/i);
    expect(r.warnings.join(" ")).toContain(String(RISK_LIMITS.maxConcurrentTrades));
    expect(r.policy.concurrency.policy).toBe("warn");
    expect(r.policy.concurrency.maxConcurrentTrades).toBe(RISK_LIMITS.maxConcurrentTrades);
    expect(r.policy.concurrency.openPositions).toBe(RISK_LIMITS.maxConcurrentTrades);
    expect(r.policy.concurrency.atLimit).toBe(true);
  });

  test("over the maximum is surfaced too", () => {
    const r = evaluateDailyDerivativesRisk(candidate({
      state: { openPositions: RISK_LIMITS.maxConcurrentTrades + 1 },
    }));
    expect(r.policy.concurrency.atLimit).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/concurrent/i);
  });

  test("the 'block' policy refuses instead of warning", () => {
    const r = evaluateDailyDerivativesRisk(candidate({
      state: { openPositions: RISK_LIMITS.maxConcurrentTrades },
      concurrencyPolicy: "block",
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/concurrent/i);
    expect(r.policy.concurrency.policy).toBe("block");
  });

  test("under the maximum nothing is surfaced", () => {
    const r = evaluateDailyDerivativesRisk(candidate({
      state: { openPositions: RISK_LIMITS.maxConcurrentTrades - 1 },
    }));
    expect(r.policy.concurrency.atLimit).toBe(false);
    expect(r.warnings.length).toBe(0);
  });
});

describe("the configured late option-buy rule", () => {
  test("the configured cutoff is the one the app already uses (13:00 IST)", () => {
    expect(LATE_OPTION_BUY_CUTOFF_IST_MINUTES).toBe(780);
    expect(LATE_OPTION_BUY_CONFIG.cutoffIstMinutes).toBe(LATE_OPTION_BUY_CUTOFF_IST_MINUTES);
  });

  test("WITH the flag ENABLED a BUY after the configured cutoff FAILS", () => {
    flags.noOptionBuysAfter13 = true;
    const r = evaluateDailyDerivativesRisk(candidate({ istMinutes: AT_AFTERNOON }));
    expect(r.ok).toBe(false);
    const why = r.reasons.join(" ");
    expect(why).toMatch(/late option-buy rule/i);
    expect(why).toMatch(/13:00/);
    expect(r.policy.session.lateOptionBuy.enabled).toBe(true);
    expect(r.policy.session.lateOptionBuy.sessionRuleFired).toBe(true);
    expect(r.policy.session.lateOptionBuy.enforced).toBe(true);
    expect(r.policy.session.lateOptionBuy.cutoffIstMinutes).toBe(LATE_OPTION_BUY_CUTOFF_IST_MINUTES);
  });

  test("WITH the flag DISABLED the same candidate PASSES (the policy is reported)", () => {
    flags.noOptionBuysAfter13 = false;
    const r = evaluateDailyDerivativesRisk(candidate({ istMinutes: AT_AFTERNOON }));
    expect(r.ok).toBe(true);
    expect(r.reasons.length).toBe(0);
    expect(r.policy.session.lateOptionBuy.enabled).toBe(false);
    expect(r.policy.session.lateOptionBuy.sessionRuleFired).toBe(true);
    expect(r.policy.session.lateOptionBuy.enforced).toBe(false);
  });

  test("the cutoff is NOT hardcoded — moving the configured minutes moves the outcome", () => {
    flags.noOptionBuysAfter13 = true;
    setLateOptionBuyCutoff(14 * 60); // the configured cutoff moves to 14:00 IST
    expect(cutoffConfig.cutoffIstMinutes).toBe(14 * 60);

    const before = evaluateDailyDerivativesRisk(candidate({ istMinutes: AT_AFTERNOON })); // 13:30
    expect(before.ok).toBe(true);
    expect(before.policy.session.lateOptionBuy.cutoffIstMinutes).toBe(14 * 60);

    const after = evaluateDailyDerivativesRisk(candidate({ istMinutes: AT_LATE })); // 14:20
    expect(after.ok).toBe(false);
    expect(after.reasons.join(" ")).toMatch(/late option-buy rule/i);
    expect(after.reasons.join(" ")).toMatch(/14:00/);
  });

  test("the configured cutoff is restored to the app default", () => {
    setLateOptionBuyCutoff(9 * 60);
    setLateOptionBuyCutoff();
    expect(LATE_OPTION_BUY_CONFIG.cutoffIstMinutes).toBe(LATE_OPTION_BUY_CUTOFF_IST_MINUTES);
  });

  test("a BUY before the configured cutoff is never blocked by the rule", () => {
    flags.noOptionBuysAfter13 = true;
    const r = evaluateDailyDerivativesRisk(candidate({ istMinutes: AT_PRIMARY }));
    expect(r.ok).toBe(true);
    expect(r.policy.session.lateOptionBuy.sessionRuleFired).toBe(false);
  });
});

describe("the expiry-day rule", () => {
  test("an option expiring today is REFUSED when allowExpiryDay is false", () => {
    expect(GATE_CONFIG.allowExpiryDay).toBe(false);
    const r = evaluateDailyDerivativesRisk(candidate({ isExpiryDay: true }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/expiry/i);
  });

  test("daysToExpiry 0 is the expiry day too", () => {
    const r = evaluateDailyDerivativesRisk(candidate({ daysToExpiry: 0 }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/expiry/i);
  });

  test("a regular day is not blocked by the expiry rule", () => {
    const r = evaluateDailyDerivativesRisk(candidate({ daysToExpiry: 3 }));
    expect(r.ok).toBe(true);
  });
});

describe("a closed market", () => {
  test("a closed session is REFUSED", () => {
    const r = evaluateDailyDerivativesRisk(candidate({ istMinutes: AT_CLOSED }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/market closed/i);
    expect(r.policy.session.isMarketOpen).toBe(false);
    expect(r.policy.session.allowedActions).toEqual(["WAIT"]);
  });

  test("an explicit closed verdict from the caller is REFUSED", () => {
    const r = evaluateDailyDerivativesRisk(candidate({ marketOpen: false }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/market closed/i);
  });
});
