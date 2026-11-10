/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// ZERO LOTS IS REPRESENTABLE — the P0 sizing bug (2026-10-20)
//
// THE BUG: `lotsForBudget()` returned `Math.max(1, …)` and the plan forced
// `Math.max(1, …)` too, so "0 lots" could not exist. A contract that did not
// fit the ₹20,000 per-trade budget was traded as ONE lot anyway:
//   • RELIANCE CE ₹90 × lot 500 → 1 lot → ₹45,000 deployed (2.25× the cap)
//   • SBIN     CE ₹300 × lot 750 → 1 lot → ₹2,25,000 deployed (11× the cap)
// The master bot's `if (lots < 1) return null` was DEAD CODE, and the veto
// never looked at the ₹ deployment at all — so the over-sized plan reached
// Telegram as a trade.
//
// THE FIX:
//   • the sizing returns the HONEST FLOOR (0 lots) and the plan reports
//     `lots: 0`, `deployed: 0`, `riskAmount: 0` — nothing is committed;
//   • every caller bails on 0 lots (no trade, no alert, no tracker row);
//   • the veto blocks a candidate whose ₹ deployment does not fit the budget.
//
// OFFLINE: no network, no chain fetch, no Telegram — every assertion below is
// a pure function call.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test, expect } from "bun:test";
import {
  buildOptionPlan,
  lotsForBudget,
  sizeOptionTrade,
  PLAN_CONFIG,
} from "@/lib/option-plan";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";
import { evaluateSignalVeto } from "@/lib/signal-veto";
import { buildMasterBotPlan } from "@/lib/master-bot-engine";
import { buildIndexOptionPlan } from "@/lib/morning-scan";
import { mapStockFOSignal, mapIndexFOSignal, sendIndividualSignals } from "@/lib/morningSignalGenerator";
import { generateMonthlyOptionTrade } from "@/lib/intraday-scanner";
import type { OptionChainSnapshot } from "@/lib/auction-types";

const CAP = GATE_CONFIG.tradeBudget;          // ₹20,000 — the per-trade cap
const RISK_PCT = GATE_CONFIG.riskPctOfTrade;   // 20% of the amount DEPLOYED

// The two contracts that used to breach the cap (verified live):
const RELIANCE = { symbol: "RELIANCE", premium: 90, lot: 500, cost: 45_000 };
const SBIN = { symbol: "SBIN", premium: 300, lot: 750, cost: 225_000 };

// 2026-07-15 10:05 IST — before the 13:00 option-buy cutoff
const AT = Date.parse("2026-07-15T10:05:00+05:30");

// ───────────────────────────────────────────────────────────────────────────
describe("the sizing floor — 0 lots is a REAL outcome", () => {
  test("the cap and the risk rule are the live ones", () => {
    expect(CAP).toBe(20_000);
    expect(RISK_PCT).toBe(20);
    expect(PLAN_CONFIG.maxDeployedAmount).toBe(CAP);
  });

  test("RELIANCE CE ₹90 × lot 500 → 0 lots (₹45,000 per lot)", () => {
    expect(RELIANCE.cost).toBeGreaterThan(CAP);
    expect(lotsForBudget(RELIANCE.premium, RELIANCE.lot, CAP)).toBe(0);
    const s = sizeOptionTrade({ entryPremium: RELIANCE.premium, lotSize: RELIANCE.lot });
    expect(s.lots).toBe(0);
    expect(s.tradable).toBe(false);
    expect(s.deployed).toBe(0);
    expect(s.riskAmount).toBe(0);
    expect(s.costPerLot).toBe(45_000);
    expect(s.reason).toMatch(/per-trade budget/);
  });

  test("SBIN CE ₹300 × lot 750 → 0 lots (₹2,25,000 per lot)", () => {
    expect(SBIN.cost).toBeGreaterThan(CAP);
    expect(lotsForBudget(SBIN.premium, SBIN.lot, CAP)).toBe(0);
    const s = sizeOptionTrade({ entryPremium: SBIN.premium, lotSize: SBIN.lot });
    expect(s.lots).toBe(0);
    expect(s.deployed).toBe(0);
    expect(s.costPerLot).toBe(225_000);
  });

  test("an affordable contract still gets its lots", () => {
    expect(lotsForBudget(150, 65, CAP)).toBe(2);   // ₹9,750 per lot
    expect(lotsForBudget(30, 500, CAP)).toBe(1);    // ₹15,000 per lot
    expect(lotsForBudget(300, 65, CAP)).toBe(1);   // ₹19,500 per lot
    const s = sizeOptionTrade({ entryPremium: 150, lotSize: 65 });
    expect(s.lots).toBe(2);
    expect(s.units).toBe(130);
    expect(s.deployed).toBe(19_500);
    expect(s.tradable).toBe(true);
  });

  test("the minimum-1-lot rule is a RECORDING convention, not a sizing rule", () => {
    // The recording minimum exists so a candidate stays visible in the ledger —
    // it must never size a trade. The sizing floor is 0, always.
    expect(PLAN_CONFIG.recordingMinimumLots).toBe(1);
    expect(lotsForBudget(RELIANCE.premium, RELIANCE.lot, CAP)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("buildOptionPlan — 0 lots, ₹0 deployed, ₹0 at risk", () => {
  test("an unaffordable contract returns a 0-lot plan (nothing is committed)", () => {
    const p = buildOptionPlan({
      symbol: RELIANCE.symbol, optionType: "CE",
      entryPremium: RELIANCE.premium, lotSize: RELIANCE.lot,
    })!;
    expect(p).not.toBeNull();
    expect(p.lots).toBe(0);
    expect(p.units).toBe(0);
    expect(p.deployed).toBe(0);
    expect(p.riskAmount).toBe(0);
    expect(p.tradable).toBe(false);
    expect(p.rupee.tp1).toBe(0);
    expect(p.lotCost).toBe(45_000);
    expect(p.notes.join(" ")).toMatch(/0 lots/);
  });

  test("SBIN CE ₹300 × lot 750 → 0 lots, ₹0 deployed", () => {
    const p = buildOptionPlan({
      symbol: SBIN.symbol, optionType: "CE",
      entryPremium: SBIN.premium, lotSize: SBIN.lot,
    })!;
    expect(p.lots).toBe(0);
    expect(p.deployed).toBe(0);
    expect(p.riskAmount).toBe(0);
    expect(p.tradable).toBe(false);
  });

  test("an explicit 0 lots is honoured (the state is representable)", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 150, lotSize: 65, lots: 0,
    })!;
    expect(p.lots).toBe(0);
    expect(p.deployed).toBe(0);
    expect(p.riskAmount).toBe(0);
    expect(p.tradable).toBe(false);
  });

  test("the deployment NEVER exceeds the cap — whatever the premium", () => {
    for (const premium of [5, 10, 50, 90, 100, 150, 200, 300, 400, 500, 900]) {
      for (const lotSize of [65, 225, 500, 750]) {
        const p = buildOptionPlan({
          symbol: "TEST", optionType: "CE", entryPremium: premium, lotSize,
        });
        if (!p) continue;
        expect(p.deployed).toBeLessThanOrEqual(CAP);
        expect(p.riskAmount).toBeLessThanOrEqual(p.deployed * (RISK_PCT / 100) + 1);
        if (p.lots === 0) {
          expect(p.deployed).toBe(0);
          expect(p.riskAmount).toBe(0);
        }
      }
    }
  });

  test("even an explicit lot count cannot push the deployment over the cap", () => {
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 400, lotSize: 65, lots: 1,
    })!;
    expect(p.lots).toBe(0);      // 1 lot = ₹26,000 → over the ₹20,000 cap
    expect(p.deployed).toBe(0);
    expect(p.tradable).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the 1-lot case — NO REGRESSION in the plan maths", () => {
  test("the user's example: spend ₹10,000 → risk ₹2,000, targets at 2R/3R/4R", () => {
    // 1 NIFTY lot (65) at ₹153.85 → deployed ₹10,000
    const p = buildOptionPlan({
      symbol: "NIFTY", optionType: "CE", entryPremium: 153.85, lotSize: 65, lots: 1,
      deployedAmount: 10_000, riskAmount: 2_000,
    })!;
    expect(p.lots).toBe(1);
    expect(p.units).toBe(65);
    expect(p.tradable).toBe(true);
    expect(p.deployed).toBeCloseTo(10_000, 0);
    expect(p.riskAmount).toBeCloseTo(2_000, 0);
    expect(p.riskPoints).toBeCloseTo(2000 / 65, 5);
    // levels are rounded to the ₹0.05 tick grid
    expect(Math.abs(p.stopLoss - (153.85 - 2000 / 65))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[0] - (153.85 + 2 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[1] - (153.85 + 3 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.targets[2] - (153.85 + 4 * (2000 / 65)))).toBeLessThanOrEqual(0.05);
    expect(p.rr).toBeCloseTo(2, 1);
    // ₹ at the targets: 2R = ₹4,000, 3R = ₹6,000, 4R = ₹8,000
    expect(p.rupee.tp1).toBeCloseTo(4_000, -1);
    expect(p.rupee.tp2).toBeCloseTo(6_000, -1);
    expect(p.rupee.tp3).toBeCloseTo(8_000, -1);
    expect(p.lotCost).toBeCloseTo(153.85 * 65, 5);
  });

  test("the default sizing still takes 2 NIFTY lots and caps the rupee risk at ₹2,000", () => {
    const p = buildOptionPlan({ symbol: "NIFTY", optionType: "CE", entryPremium: 150, lotSize: 65 })!;
    expect(p.lots).toBe(2);
    expect(p.units).toBe(130);
    expect(p.deployed).toBe(19_500);
    expect(p.riskAmount).toBeCloseTo(2_000, 0);   // FIXED cap (20% would be ₹3,900)
    // ₹2,000 over 130 units = 15.38 pts of premium → stop and 2R/3R/4R ladder
    expect(p.stopLoss).toBeCloseTo(150 - 2_000 / 130, 1);
    expect(p.targets[0]).toBeCloseTo(150 + 2 * 2_000 / 130, 1);
    expect(p.targets[1]).toBeCloseTo(150 + 3 * 2_000 / 130, 1);
    expect(p.targets[2]).toBeCloseTo(150 + 4 * 2_000 / 130, 1);
  });

  test("the guardrails still hold (35% premium cap + 8-tick floor)", () => {
    const capped = buildOptionPlan({
      // 10 units so the ₹2,000 risk cap allows a stop past the 35% premium cap
      symbol: "NIFTY", optionType: "CE", entryPremium: 100, lotSize: 10, lots: 1,
      deployedAmount: 10_000, riskAmount: 6_000,
    })!;
    expect(capped.stopLoss).toBeCloseTo(100 * 0.65, 1);
    expect(capped.riskAmount).toBeLessThan(6_000);
    expect(capped.notes.join(" ")).toMatch(/capped/);

    const floored = buildOptionPlan({
      symbol: "NTPC", optionType: "CE", entryPremium: 4.2, lotSize: 500, lots: 1,
      deployedAmount: 2_100, riskAmount: 50,
    })!;
    expect(floored.riskPoints).toBeCloseTo(8 * 0.05, 5);
    expect(floored.notes.join(" ")).toMatch(/noise floor/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the veto — DEPLOYMENT / LOT check (fail closed, no network)", () => {
  const base = {
    nowMs: AT,
    symbol: "NIFTY",
    action: "BUY CE",
    optionType: "CE" as const,
    strike: 25200,
    entry: 150,
    stopLoss: 120,
    tp1: 210,
    confidence: 75,
  };

  test("an affordable option still PASSES", () => {
    const r = evaluateSignalVeto(base);          // 1 NIFTY lot = ₹9,750
    expect(r.verdict).toBe("PASS");
    expect(r.fails).toHaveLength(0);
  });

  test("RELIANCE CE ₹90 (lot 500 → ₹45,000) is BLOCKED", () => {
    const r = evaluateSignalVeto({
      ...base, symbol: "RELIANCE", entry: 90, stopLoss: 72, tp1: 126,
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.suppress).toBe(true);
    expect(r.sizeFactor).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/45,000|20,000/);
    expect(r.reasons.join(" ")).toMatch(/budget/);
  });

  test("SBIN CE ₹300 (lot 750 → ₹2,25,000) is BLOCKED", () => {
    const r = evaluateSignalVeto({
      ...base, symbol: "SBIN", entry: 300, stopLoss: 240, tp1: 420,
    });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/2,25,000|20,000/);
  });

  test("0 lots is BLOCKED (the state a 0-lot plan would carry)", () => {
    const r = evaluateSignalVeto({ ...base, lots: 0 });
    expect(r.verdict).toBe("BLOCK");
    expect(r.hardFail).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/0 lots/);
  });

  test("a stated deployment over the cap is BLOCKED", () => {
    const r = evaluateSignalVeto({ ...base, deployedAmount: 45_000 });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons.join(" ")).toMatch(/45,000/);
  });

  test("a stated lot size is honoured (no symbol lookup needed)", () => {
    const r = evaluateSignalVeto({
      ...base, symbol: "UNKNOWNCO", lotSize: 500, entry: 90, stopLoss: 72, tp1: 126,
    });
    expect(r.verdict).toBe("BLOCK");
    const ok = evaluateSignalVeto({
      ...base, symbol: "UNKNOWNCO", lotSize: 500, entry: 30, stopLoss: 24, tp1: 42,
    });
    expect(ok.verdict).toBe("PASS");
  });

  test("the check is options-only — a cash equity signal is not sized", () => {
    const r = evaluateSignalVeto({
      ...base, symbol: "RELIANCE", optionType: undefined,
      entry: 2800, stopLoss: 2750, tp1: 2900,
    });
    expect(r.verdict).toBe("PASS");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the callers bail on 0 lots (no trade, no alert, no tracker row)", () => {
  test("master bot: an unaffordable contract yields NO plan", () => {
    expect(
      buildMasterBotPlan({
        symbol: RELIANCE.symbol, direction: "CALL",
        entryPremium: RELIANCE.premium, lotSize: RELIANCE.lot,
      })
    ).toBeNull();
    expect(
      buildMasterBotPlan({
        symbol: SBIN.symbol, direction: "CALL",
        entryPremium: SBIN.premium, lotSize: SBIN.lot,
      })
    ).toBeNull();
  });

  test("master bot: an affordable contract still yields a plan inside the cap", () => {
    const p = buildMasterBotPlan({
      symbol: "RELIANCE", direction: "CALL", entryPremium: 30, lotSize: 500,
    })!;
    expect(p).not.toBeNull();
    expect(p.lots).toBe(1);
    expect(p.totalPremium).toBeLessThanOrEqual(CAP);
    expect(p.totalPremium).toBe(15_000);
    expect(p.maxRisk).toBeCloseTo(2_000, 0);   // FIXED ₹2,000 risk cap (20% would be ₹3,000)
  });

  test("morning scan: an unaffordable contract is skipped", () => {
    expect(
      buildIndexOptionPlan(RELIANCE.symbol, "CE", RELIANCE.premium, 2500)
    ).toBeNull();
    expect(buildIndexOptionPlan(RELIANCE.symbol, "CE", 30, 2500)).not.toBeNull();
  });

  test("morning signals: an unaffordable contract never becomes a signal", () => {
    const stock = {
      symbol: RELIANCE.symbol, name: "Reliance", sector: "Energy",
      direction: "BUY_CE" as const, confidence: 80, score: 80, reasoning: ["test"],
      factors: {
        oiSignal: 70, ivPercentile: 40, premiumVelocity: 50, volumeConfirmation: 60,
        technicalAlignment: 70, sectorStrength: 55, institutionalFlow: 50, futuresPositioning: 50,
      },
      entry: RELIANCE.premium, stopLoss: 72, target1: 126, target2: 144, riskReward: 2,
      holdingPeriod: "1D", recommendedInstrument: `${RELIANCE.symbol} 2500 CE`,
      strike: 2500, expiry: "2026-10-22", premium: RELIANCE.premium,
      maxRisk: "₹18,000", invalidation: "spot below 2450", setupType: "TREND",
    };
    expect(mapStockFOSignal(stock)).toBeNull();

    const index = {
      symbol: "NIFTY", direction: "CALL" as const, confidence: 80, score: 80,
      reasoning: ["test"],
      factors: {
        priceStructure: 70, futuresPositioning: 50, oiAnalysis: 60, ivState: 50,
        volumeConfirmation: 60, breadthConfirmation: 60, institutionalFlow: 50,
        regimeAlignment: 60, newsAlignment: 50, technicalAlignment: 70,
      },
      entry: 300, stopLoss: 240, target1: 420, target2: 480, riskReward: 2,
      holdingPeriod: "1D", recommendedInstrument: "NIFTY 25200 CE",
      strike: 25200, expiry: "2026-10-22", premium: 300,
      maxRisk: "₹3,900", invalidation: "spot below 25000",
    };
    // 1 NIFTY lot (65) at ₹300 = ₹19,500 → affordable
    expect(mapIndexFOSignal(index)).not.toBeNull();
    // ₹400 → 1 lot = ₹26,000 → over the cap → dropped
    expect(
      mapIndexFOSignal({ ...index, premium: 400, entry: 400 })
    ).toBeNull();
  });

  test("morning signals: a 0-lot contract is never sent nor registered", async () => {
    const stock = {
      symbol: RELIANCE.symbol, name: "Reliance", sector: "Energy",
      direction: "BUY_CE" as const, confidence: 80, score: 80, reasoning: ["test"],
      factors: {
        oiSignal: 70, ivPercentile: 40, premiumVelocity: 50, volumeConfirmation: 60,
        technicalAlignment: 70, sectorStrength: 55, institutionalFlow: 50, futuresPositioning: 50,
      },
      entry: RELIANCE.premium, stopLoss: 72, target1: 126, target2: 144, riskReward: 2,
      holdingPeriod: "1D", recommendedInstrument: `${RELIANCE.symbol} 2500 CE`,
      strike: 2500, expiry: "2026-10-22", premium: RELIANCE.premium,
      maxRisk: "₹18,000", invalidation: "spot below 2450", setupType: "TREND",
    };
    const signals = [mapStockFOSignal(stock)].filter(Boolean) as any[];
    const sent: string[] = [];
    const registered: any[] = [];
    const count = await sendIndividualSignals(
      signals,
      async (text) => { sent.push(text); return true; },
      (trade) => { registered.push(trade); },
    );
    expect(signals).toHaveLength(0);
    expect(count).toBe(0);
    expect(sent).toHaveLength(0);        // no Telegram
    expect(registered).toHaveLength(0);  // no tracker row
  });

  test("intraday scanner: an unaffordable contract yields NO monthly option trade", () => {
    const chain = (premium: number): OptionChainSnapshot => ({
      symbol: RELIANCE.symbol,
      spot: 2500,
      source: "NSE",
      asOf: new Date().toISOString(),
      atmStrike: 2500,
      expiry: "2026-10-22",
      strikes: [{
        strike: 2500,
        expiry: "2026-10-22",
        ce: { ltp: premium, volume: 1000, oi: 5000, oiChange: 100, iv: 14, bid: premium, ask: premium, bidQty: 1, askQty: 1, delta: 0.5, gamma: 0, theta: 0, vega: 0, spread: 0, spreadPct: 0 } as any,
        pe: { ltp: premium, volume: 1000, oi: 5000, oiChange: 100, iv: 14, bid: premium, ask: premium, bidQty: 1, askQty: 1, delta: -0.5, gamma: 0, theta: 0, vega: 0, spread: 0, spreadPct: 0 } as any,
      }],
      callOiMap: new Map([[2500, 5000]]),
      putOiMap: new Map([[2500, 5000]]),
      callOiChangeMap: new Map(),
      putOiChangeMap: new Map(),
      callVolumeMap: new Map(),
      putVolumeMap: new Map(),
      maxPain: 2500,
      pcr: 1,
      ivRank: 50,
      ivPercentile: 50,
      atmIV: 14,
      ivSkew: 0,
    });

    // ₹90 × lot 500 = ₹45,000 → 0 lots → no monthly option trade at all
    expect(generateMonthlyOptionTrade(RELIANCE.symbol, 2500, "BULLISH", chain(90))).toBeUndefined();
    // ₹30 × lot 500 = ₹15,000 → affordable → a real trade
    const ok = generateMonthlyOptionTrade(RELIANCE.symbol, 2500, "BULLISH", chain(30));
    expect(ok).toBeDefined();
    expect(ok!.premium).toBe(30);
  });
});
