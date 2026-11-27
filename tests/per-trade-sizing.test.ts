/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// PER-TRADE SIZING MODEL — the user's rule (2026-10-20):
//
//   "if I spend ₹10,000 I take ₹2,000 of risk and make ₹3,000"
//     → deployed  = the ₹ put into THIS trade   (≤ ₹20,000 — the per-trade cap)
//     → risk      = 20% of the amount DEPLOYED, HARD-CAPPED at ₹2,000
//                   (₹10,000 deployed ⇒ ₹2,000 risk; ₹20,000 deployed ⇒ still ₹2,000)
//     → targets   = 2R / 3R / 4R                (R:R 1:2 / 1:3 / 1:4)
//
// The OLD model was "risk = 1–2% of a ₹1L/₹2L ACCOUNT", which made every
// NIFTY lot unaffordable and printed risk budgets nobody could act on.
//
// ONE source of truth: GATE_CONFIG + positionSize() in src/lib/agent-brain-gate.ts
// (and buildOptionPlan() in src/lib/option-plan.ts for plans). No engine may
// invent its own capital / risk-percentage pair.
//
// Every engine below must satisfy the SAME two invariants:
//   (a) the ₹ committed to the trade never exceeds the ₹20,000 per-trade budget
//   (b) the ₹ at risk never exceeds min(20% of that committed amount, ₹2,000)
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test, expect } from "bun:test";
import { GATE_CONFIG, positionSize } from "@/lib/agent-brain-gate";
import { calculatePositionSize, perTradeRiskBudget } from "@/lib/risk-management";
import { buildOptionPlan } from "@/lib/option-plan";
import { analyzeBTST, type BTSTStockInput } from "@/lib/btst-engine";
import { evaluatePlaybookCheck, PLAYBOOK_MAX_RISK_PCT } from "@/lib/agents/playbook-check";
import { DEFAULT_CONFIG as JARVIS_CONFIG } from "@/lib/jarvis/orchestrator";
import { getUserPreferences, DEFAULT_USER_PREFERENCES } from "@/lib/agent-memory";
import { auditLevels } from "@/lib/audit-recorders";
import { formatAlertMessage, type TradeAlert } from "@/lib/tradeAlertEngine";

const DEPLOY_BUDGET = GATE_CONFIG.tradeBudget;      // ₹20,000
const RISK_PCT = GATE_CONFIG.riskPctOfTrade;        // 20
const RISK_BUDGET = (DEPLOY_BUDGET * RISK_PCT) / 100; // 20% of DEPLOYED — no fixed ₹ cap (user rule 2026-11-17)

describe("the per-trade model itself", () => {
  test("GATE_CONFIG carries the live numbers", () => {
    expect(DEPLOY_BUDGET).toBe(45_000);
    expect(RISK_PCT).toBe(20);
    expect(GATE_CONFIG.capital).toBe(50_000);
  });

  test("positionSize: risk = 20% of DEPLOYED, never 1% of an account", () => {
    const r = positionSize({ entry: 100, sl: 90, lotSize: 65 });
    expect(r.riskAmount).toBe(RISK_BUDGET);          // 20% of deployed — NOT 1% of ₹2L
    expect(r.lots).toBeGreaterThanOrEqual(1);
    expect(r.capitalRequired).toBeLessThanOrEqual(DEPLOY_BUDGET);
    expect(r.maxLoss).toBeLessThanOrEqual(RISK_BUDGET);
    expect(r.guidance).toMatch(/deployed/i);
  });

  test("positionSize: a legacy 'capital' argument can only SHRINK the budget", () => {
    const big = positionSize({ entry: 100, sl: 90, lotSize: 65, capital: 200_000 });
    const small = positionSize({ entry: 100, sl: 90, lotSize: 65, capital: 5_000 });
    expect(big.riskAmount).toBe(RISK_BUDGET);         // 20% of the (larger) budget — scales, no cap
    expect(small.riskAmount).toBe(1_000);             // 20% of the smaller deployment
    expect(big.lots).toBeGreaterThanOrEqual(small.lots);
  });
});

describe("risk scales with the deployment — 20% of DEPLOYED, no fixed cap (2026-11-17)", () => {
  test("the risk budget scales with the capital actually deployed", () => {
    const full = positionSize({ entry: 100, sl: 90, lotSize: 65, capital: 25_000 });  // ₹25k budget
    const half = positionSize({ entry: 100, sl: 90, lotSize: 65, capital: 10_000 });  // ₹10k budget
    const small = positionSize({ entry: 100, sl: 90, lotSize: 65, capital: 5_000 });  // ₹5k budget
    expect(full.riskAmount).toBe(5_000);    // 20% of ₹25k — scales UP, no ₹4k ceiling
    expect(half.riskAmount).toBe(2_000);    // ₹10k deployed → ₹2k risk (the user's rule)
    expect(small.riskAmount).toBe(1_000);   // ₹5k deployed → ₹1k risk
  });

  test("perTradeRiskBudget is 20% of the amount deployed", () => {
    expect(perTradeRiskBudget(45_000)).toBe(9_000);
    expect(perTradeRiskBudget(20_000)).toBe(4_000);
    expect(perTradeRiskBudget(10_000)).toBe(2_000);
    expect(perTradeRiskBudget(4_000)).toBe(800);
  });

  test("an option plan's risk follows the explicit rupee risk, not a cap", () => {
    // ₹3,000 over 65 units = 46.15 pts — inside the 35%-of-premium stop guardrail
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 150, lotSize: 65, lots: 1, riskAmount: 3_000,
    })!;
    expect(p.lots).toBe(0);
    expect(p.tradable).toBe(false);
    expect(p.deployed).toBe(0);
    expect(p.riskAmount).toBe(0);            // nothing committed when not tradable
    expect(p.riskPoints).toBeCloseTo(3_000 / 65, 1);
  });
});

describe("risk-management.calculatePositionSize (the shared production path)", () => {
  const base = {
    capital: 100_000,          // the legacy caller passes ₹1L — it must NOT be the risk base
    riskPerTradePercent: 20,   // % of the amount DEPLOYED
    entryPremium: 150,
    stopLossPremium: 120,      // 30 pts risk/lot → 30 × 65 = ₹1,950
    lotSize: 65,
    maxPositionSize: 10,
  };

  test("risk is 20% of the deployed amount, not 20% of the account", () => {
    const r = calculatePositionSize(base);
    expect(r.positionValue).toBeLessThanOrEqual(DEPLOY_BUDGET);   // ₹ deployed
    expect(r.riskAmount).toBeLessThanOrEqual(RISK_BUDGET);         // ₹ at risk
    expect(r.riskAmount).toBeLessThanOrEqual(r.positionValue * RISK_PCT / 100);
    expect(r.lots).toBeGreaterThanOrEqual(1);
  });

  test("a ₹2L account cannot raise the rupee risk above the per-trade budget", () => {
    const small = calculatePositionSize({ ...base, capital: 100_000 });
    const huge = calculatePositionSize({ ...base, capital: 2_000_000 });
    expect(huge.riskAmount).toBeLessThanOrEqual(RISK_BUDGET);
    expect(huge.lots).toBe(small.lots);
  });

  test("an expensive lot is still 1 lot (no capital refusal)", () => {
    const r = calculatePositionSize({ ...base, entryPremium: 2_000, stopLossPremium: 1_900 });
    expect(r.lots).toBe(1);
    expect(r.positionValue).toBeGreaterThan(0);
  });
});

describe("btst-engine position sizing", () => {
  const input = (over: Partial<BTSTStockInput> = {}): BTSTStockInput => ({
    symbol: "INFY", name: "Infosys", sector: "IT", price: 1_500, changePct: 2,
    rsi: 58, macd: 10, macdSignal: 8, macdHist: 2, adx: 25, ema9: 1_480, ema21: 1_450,
    ema50: 1_400, volume: 900_000, avgVolume: 600_000, oiChangePct: 5, pcr: 1.2,
    iv: 18, sectorStrength: 30, relativeStrength: 1.5, deliveryPct: 55, breadth: 0.7,
    atr: 40, isFNO: true, ...over,
  });

  test("qty is sized by the per-trade model, not 1% of a ₹1L account", () => {
    const a = analyzeBTST(input());
    // entry = price, stop = ATR-based → recompute the deployed + risk invariants
    expect(a.positionSize.qty).toBeGreaterThan(0);
    const deployed = a.positionSize.qty * a.entry;
    expect(deployed).toBeLessThanOrEqual(DEPLOY_BUDGET);
    expect(a.positionSize.riskPerTrade).toBeLessThanOrEqual(RISK_BUDGET);
    expect(a.positionSize.riskPerTrade).toBeLessThanOrEqual(deployed * RISK_PCT / 100);
  });
});

describe("playbook-check risk budget", () => {
  const agent = (id: string) => ({
    agentId: id, bias: "NEUTRAL", confidence: 50, riskFlags: [], evidence: [],
    dataFreshness: "FRESH", recommendationContext: "RESEARCH_ONLY",
  } as any);
  const ALL = ["FII_DII", "CAS", "MTF_CONFIRMATION", "MARKET_STRUCTURE",
    "SUPPORT_RESISTANCE", "OI_CLASSIFICATION", "BREAKOUT", "MOMENTUM", "EVENT_RISK"].map(agent);
  const candidate = (over: Record<string, unknown> = {}) => ({
    symbol: "NIFTY", exchange: "NFO", instrument: "CALL", optionType: "CE",
    strike: 22400, entry: 100, stopLoss: 90, target1: 130, target2: 140,
    direction: "BUY_CE", strategy: "AGENT_SYSTEM", score: 70,
    spot: 22400, premium: 100, maxLoss: 650, daysToExpiry: 5, ...over,
  } as any);

  test("the risk threshold is the model's 20%, not a hardcoded 1%", () => {
    expect(PLAYBOOK_MAX_RISK_PCT).toBe(RISK_PCT);
  });

  test("a maxLoss inside the risk budget passes (1% of ₹1L would have failed)", () => {
    const r = evaluatePlaybookCheck(candidate({ maxLoss: 1_500 }), ALL, { capital: 100_000 } as any);
    expect(r.failedItems).not.toContain(7);
  });

  test("a maxLoss above the 20%-of-deployed reference is SHOWN, never a veto", () => {
    const r = evaluatePlaybookCheck(candidate({ maxLoss: 9_500 }), ALL, { capital: 100_000 } as any);
    expect(r.failedItems).not.toContain(7);
    expect(r.items.find(i => i.item === 7)!.note).toMatch(/deployed/i);
  });
});

describe("the ₹2,00,000 / ₹1,00,000 account assumptions", () => {
  test("jarvis does not assume a ₹2L account with 1% risk", () => {
    expect(JARVIS_CONFIG.capital).toBe(GATE_CONFIG.capital);
    expect(JARVIS_CONFIG.riskPctPerTrade).toBeCloseTo(RISK_PCT / 100, 5);
  });

  test("agent-memory preferences default to the live capital + the per-trade rule", () => {
    expect(DEFAULT_USER_PREFERENCES.defaultCapital).toBe(GATE_CONFIG.capital);
    expect(DEFAULT_USER_PREFERENCES.riskPerTradePct).toBe(RISK_PCT);
    // A stored file that still holds the pre-model auto-written defaults is
    // migrated, never served as-is.
    const prefs = getUserPreferences();
    expect(prefs.defaultCapital).not.toBe(100_000);
    expect(prefs.riskPerTradePct).not.toBe(2);
  });
});

describe("audit-recorders — the recorded plan must be the R ladder", () => {
  test("a candidate without levels records 1R stop and 2R/3R/4R targets", () => {
    const l = auditLevels({ strike: 22400, type: "CE", entry: 100, conf: 70 });
    expect(l.sl).toBeCloseTo(80, 5);     // 1R = 20% of the premium
    expect(l.tp1).toBeCloseTo(140, 5);   // 2R
    expect(l.tp2).toBeCloseTo(160, 5);   // 3R
    expect(l.tp3).toBeCloseTo(180, 5);   // 4R
    expect((l.tp1 - 100) / (100 - l.sl)).toBeCloseTo(2, 5);
  });

  test("a PE records a stop ABOVE the entry and targets BELOW it", () => {
    const l = auditLevels({ strike: 22400, type: "PE", entry: 100, conf: 70 });
    expect(l.sl).toBeCloseTo(120, 5);
    expect(l.tp1).toBeCloseTo(60, 5);
    expect((100 - l.tp1) / (l.sl - 100)).toBeCloseTo(2, 5);
  });

  test("caller-supplied levels are never overwritten", () => {
    const l = auditLevels({ strike: 22400, type: "CE", entry: 100, sl: 90, tp1: 130, conf: 70 });
    expect(l.sl).toBe(90);
    expect(l.tp1).toBe(130);
  });
});

describe("the risk-budget TEXT the user reads", () => {  const alert: TradeAlert = {
    id: "a1", kind: "option", symbol: "NIFTY", side: "BUY", instrument: "NIFTY 22400 CE",
    optionType: "CE", entry: 100, sl: 90, tp1: 120, tp2: 130, rr: 2,
    confidence: 70, rationale: "PCR 1.3 · OI building", generatedAt: new Date().toISOString(),
  } as any;

  test("the Telegram/dashboard message states the per-trade rule, not '2% of your capital'", () => {
    const msg = formatAlertMessage(alert);
    expect(msg).not.toMatch(/2% of your capital/i);
    expect(msg).toMatch(/20% of the amount you deploy/i);
    expect(msg).toMatch(/45,000|₹45,000/);
  });
});
