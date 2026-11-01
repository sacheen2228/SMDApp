import { describe, test, expect } from "bun:test";
import { assessRisk, estimateCosts } from "@/lib/quant/quant-risk-manager";
import {
  simulateEntry,
  evaluateLevels,
  applyBreakevenAfterTp1,
  applyTrail,
  statusForStopEvent,
  type QuantExecutionTrade,
} from "@/lib/quant/quant-paper-execution";
import type { QuantContractSelection, QuantPlan } from "@/lib/quant/quant-types";

// ── Fixtures ─────────────────────────────────────────────────────────

function contract(over: Partial<QuantContractSelection> = {}): QuantContractSelection {
  return {
    tradingsymbol: "NIFTY27OCT2625000CE", strike: 25000, optionType: "CE",
    expiry: "27-Oct-2026", lotSize: 65, tickSize: 0.05,
    premium: 150, bid: 149.5, ask: 150.5, spreadPct: 0.0067,
    iv: 14, delta: 0.52, theta: -8, oi: 2000,
    selectionReasons: [], ...over,
  };
}

function plan(over: Partial<QuantPlan> = {}): QuantPlan {
  return {
    entry: 150, stopLoss: 120,
    targets: { tp1: 180, tp2: 210, tp3: 240, tp4: 270 },
    trailingPolicy: { kind: "BREAKEVEN_TP1_THEN_ATR_TRAIL", atrPremium: 10, multiple: 1 },
    rewardRisk: 2, dataQualityScore: 90, lots: 1, ...over,
  };
}

function trade(over: Partial<QuantExecutionTrade> = {}): QuantExecutionTrade {
  return {
    tradeId: "QPT-TEST", direction: "BUY_CE", entryPrice: 150,
    stopLoss: 120, initialStopLoss: 120,
    targets: { tp1: 180, tp2: 210, tp3: 240, tp4: 270 },
    quantity: 130, remainingQuantity: 130,
    tp1Hit: false, tpHitLevel: null, highestSinceTp1: null,
    breakevenArmed: false, atrPremium: 10, ...over,
  };
}

const NOW = Date.parse("2026-10-26T10:00:00+05:30");

// ── Cost model ───────────────────────────────────────────────────────

describe("estimateCosts", () => {
  test("brokerage 20+20 + STT 0.1% sell + slippage 0.05%/side", () => {
    // 40 + 110*65*0.001 (7.15) + (100+110)*65*0.0005 (6.825) = 53.975 → 53.98
    expect(estimateCosts(100, 110, 1, 65)).toBeCloseTo(53.98, 2);
  });

  test("scales with lots", () => {
    const one = estimateCosts(100, 110, 1, 65);
    const two = estimateCosts(100, 110, 2, 65);
    expect(two).toBeGreaterThan(one);
    // brokerage is flat (₹40); STT+slippage double — 2dp rounding tolerance
    expect(two - one).toBeCloseTo(one - 40, 1);
  });

  test("zero/invalid inputs → 0 (never NaN)", () => {
    expect(estimateCosts(0, 100, 1, 65)).toBe(0);
    expect(estimateCosts(100, 100, 0, 65)).toBe(0);
    expect(estimateCosts(100, 100, 1, 0)).toBe(0);
  });
});

// ── Sizing math ──────────────────────────────────────────────────────

describe("assessRisk — rupee risk sizing", () => {
  test("lots bounded by both the risk budget and the 35% deployment cap", () => {
    // riskPerLot = (150-120)*65 = 1950; riskBudget = 100000*2% = 2000 → 1 lot by risk
    // capital cap: 100000*0.35 / (150*65) = 3.58 → 3 lots — min(1, 3) = 1
    const r = assessRisk({
      symbol: "NIFTY", contract: contract(), plan: plan(),
      account: { capital: 100000 }, openPositions: [], todayRealizedPnl: 0, todayTradeCount: 0,
    });
    expect(r.passesAll).toBe(true);
    expect(r.lots).toBe(1);
    expect(r.quantity).toBe(65);
    expect(r.riskBudget).toBe(2000);
    expect(r.riskAmount).toBe(1950);
    expect(r.maxLoss).toBeGreaterThan(r.riskAmount!); // includes costs
  });

  test("capital cap binds when the risk budget would allow more", () => {
    // riskPerLot = (110-80)*65=1950 → budget 10000*2%… use bigger capital, tiny stop distance
    const r = assessRisk({
      symbol: "NIFTY",
      contract: contract({ lotSize: 25 }),
      plan: plan({ entry: 100, stopLoss: 95, lots: undefined }),
      account: { capital: 50000 }, // riskBudget 1000; riskPerLot=125 → 8 lots by risk
      openPositions: [], todayRealizedPnl: 0, todayTradeCount: 0,
    });
    // capital cap: 50000*0.35/(100*25)=7 → min(8, 7) = 7
    expect(r.lots).toBe(7);
    expect(r.riskAmount).toBe(875);
  });

  test("0 lots (1 lot exceeds the budget) → rejected, never rounded up", () => {
    // riskPerLot = 1950; capital 20000 → budget 400 → floor(0.2) = 0
    const r = assessRisk({
      symbol: "NIFTY", contract: contract(), plan: plan(),
      account: { capital: 20000 }, openPositions: [], todayRealizedPnl: null, todayTradeCount: 0,
    });
    expect(r.passesAll).toBe(false);
    expect(r.lots).toBe(0);
    expect(r.reasons.join(" ")).toContain("1 lot exceeds risk budget/capital");
  });

  test("capital null → DATA blocked, never sized", () => {
    const r = assessRisk({
      symbol: "NIFTY", contract: contract(), plan: plan(),
      account: { capital: null }, openPositions: [], todayRealizedPnl: null, todayTradeCount: 0,
    });
    expect(r.passesAll).toBe(false);
    expect(r.reasons).toContain("capital not configured");
    expect(r.lots).toBe(0);
  });

  test("stop not below entry → invalid geometry blocked", () => {
    const r = assessRisk({
      symbol: "NIFTY", contract: contract(), plan: plan({ stopLoss: 160 }),
      account: { capital: 100000 }, openPositions: [], todayRealizedPnl: null, todayTradeCount: 0,
    });
    expect(r.passesAll).toBe(false);
    expect(r.reasons.join(" ")).toContain("stop not below entry");
  });
});

// ── Portfolio guards ─────────────────────────────────────────────────

describe("assessRisk — portfolio guards", () => {
  const base = {
    symbol: "NIFTY", contract: contract(), plan: plan(),
    account: { capital: 100000 }, openPositions: [] as Array<{ symbol: string; direction: string }>,
    todayRealizedPnl: 0, todayTradeCount: 0, nowMs: NOW,
  };

  test("daily loss cap blocks at −6% of capital", () => {
    expect(assessRisk({ ...base, todayRealizedPnl: -6000 }).passesAll).toBe(false);
    expect(assessRisk({ ...base, todayRealizedPnl: -6000 }).reasons.join(" ")).toContain("daily loss cap");
    expect(assessRisk({ ...base, todayRealizedPnl: -5999 }).passesAll).toBe(true);
  });

  test("no trade-count / concurrency cap by default (unlimited — quality gates only)", () => {
    const open = [
      { symbol: "BANKNIFTY", direction: "BUY_CE" },
      { symbol: "SENSEX", direction: "BUY_PE" },
      { symbol: "RELIANCE", direction: "BUY" },
      { symbol: "ICICIBANK", direction: "BUY_CE" },
      { symbol: "HCLTECH", direction: "BUY_PE" },
    ];
    expect(assessRisk({ ...base, openPositions: open }).passesAll).toBe(true);
    expect(assessRisk({ ...base, todayTradeCount: 25 }).passesAll).toBe(true);
  });

  test("a configured cap still blocks (overrides are honoured when set)", () => {
    const open = [
      { symbol: "BANKNIFTY", direction: "BUY_CE" },
      { symbol: "SENSEX", direction: "BUY_PE" },
      { symbol: "RELIANCE", direction: "BUY" },
    ];
    const capped = { maxConcurrentPositions: 3, maxTradesPerDay: 6 };
    expect(assessRisk({ ...base, openPositions: open, overrides: capped }).passesAll).toBe(false);
    expect(assessRisk({ ...base, openPositions: open.slice(0, 2), overrides: capped }).passesAll).toBe(true);
    expect(assessRisk({ ...base, todayTradeCount: 6, overrides: capped }).passesAll).toBe(false);
    expect(assessRisk({ ...base, todayTradeCount: 5, overrides: capped }).passesAll).toBe(true);
  });

  test("cooldown after loss (30 min)", () => {
    expect(assessRisk({ ...base, lastLossAt: NOW - 10 * 60_000 }).passesAll).toBe(false);
    expect(assessRisk({ ...base, lastLossAt: NOW - 10 * 60_000 }).reasons.join(" ")).toContain("cooldown");
    expect(assessRisk({ ...base, lastLossAt: NOW - 31 * 60_000 }).passesAll).toBe(true);
    // no nowMs → cooldown cannot be evaluated → not blocked
    expect(assessRisk({ ...base, lastLossAt: NOW - 10 * 60_000, nowMs: null }).passesAll).toBe(true);
  });

  test("duplicate exposure (same symbol+direction) blocked", () => {
    const r = assessRisk({ ...base, openPositions: [{ symbol: "NIFTY", direction: "BUY_CE" }] });
    expect(r.passesAll).toBe(false);
    expect(r.reasons.join(" ")).toContain("duplicate exposure");
    // different direction on the same symbol is a different exposure
    expect(assessRisk({ ...base, openPositions: [{ symbol: "NIFTY", direction: "BUY_PE" }] }).passesAll).toBe(true);
  });

  test("all guards combined → every reason reported", () => {
    const r = assessRisk({
      ...base,
      openPositions: [{ symbol: "NIFTY", direction: "BUY_CE" }, { symbol: "X", direction: "BUY" }, { symbol: "Y", direction: "BUY" }],
      todayRealizedPnl: -6000, todayTradeCount: 6, lastLossAt: NOW - 60_000,
      overrides: { maxConcurrentPositions: 3, maxTradesPerDay: 6 },
    });
    expect(r.passesAll).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Entry simulation ─────────────────────────────────────────────────

describe("simulateEntry", () => {
  test("fill = roundToTick(ask + 1 tick), quantity = lots × lotSize", () => {
    const r = simulateEntry(contract({ ask: 150.5, lotSize: 65, tickSize: 0.05 }), plan({ lots: 2 }), NOW);
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.fillPrice).toBe(150.55);
      expect(r.slippage).toBe(0.05);
      expect(r.quantity).toBe(130);
      expect(r.ts).toBe(NOW);
    }
  });

  test("ask missing → rejected (never filled from ltp)", () => {
    const r = simulateEntry(contract({ ask: null }), plan({ lots: 1 }), NOW);
    expect(r.rejected).toBe(true);
    if (r.rejected) expect(r.reason).toContain("ask missing");
  });

  test("lots 0/absent → rejected (risk sizing must approve first)", () => {
    expect(simulateEntry(contract(), plan({ lots: 0 }), NOW).rejected).toBe(true);
    expect(simulateEntry(contract(), plan({ lots: null }), NOW).rejected).toBe(true);
  });
});

// ── Level evaluation ─────────────────────────────────────────────────

describe("evaluateLevels — ordering + fills", () => {
  test("SL evaluated BEFORE TP on the same observation (conservative)", () => {
    // high 185 would cross TP1 180, but low 110 also crosses SL 120 → stop wins
    const events = evaluateLevels({
      trade: trade(),
      observation: { ltp: 185, high: 185, low: 110, ts: NOW },
    });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("SL_HIT");
    expect(events[0].fillPrice).toBe(120);
    expect(events[0].quantityExited).toBe(130);
    expect(events[0].remainingQuantity).toBe(0);
  });

  test("TP1 partial exit (50%), then TP2 exits the remainder on the same observation", () => {
    const events = evaluateLevels({
      trade: trade(),
      observation: { ltp: 220, high: 220, low: 175, ts: NOW },
    });
    expect(events.map((e) => e.type)).toEqual(["TP1_HIT", "TP2_HIT"]);
    expect(events[0].fillPrice).toBe(180);
    expect(events[0].quantityExited).toBe(65); // half of 130
    expect(events[0].remainingQuantity).toBe(65);
    expect(events[0].partial).toBe(true);
    expect(events[1].fillPrice).toBe(210);
    expect(events[1].quantityExited).toBe(65);
    expect(events[1].remainingQuantity).toBe(0);
  });

  test("touch without crossing = no fill", () => {
    // TP1 180: high 179.9 (below) → no TP; SL 120: low 120.1 (above) → no SL
    const events = evaluateLevels({
      trade: trade(),
      observation: { ltp: 150, high: 179.9, low: 120.1, ts: NOW },
    });
    expect(events).toEqual([]);
  });

  test("gap through SL fills at the worst realistic price min(ltp, stop)", () => {
    const events = evaluateLevels({
      trade: trade(),
      observation: { ltp: 100, high: 130, low: 100, ts: NOW },
    });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("GAP_THROUGH_SL");
    expect(events[0].fillPrice).toBe(100); // min(100, 120)
    expect(events[0].ambiguity).toContain("gap");
  });

  test("breakeven stop → BREAKEVEN_SL_HIT; trailed stop → TRAILING_SL_HIT", () => {
    const be = evaluateLevels({
      trade: trade({ tp1Hit: true, breakevenArmed: true, stopLoss: 150 }),
      observation: { ltp: 150, high: 160, low: 149.9, ts: NOW }, // touched 150, closed at the stop → no gap
    });
    expect(be[0].type).toBe("BREAKEVEN_SL_HIT");
    expect(be[0].fillPrice).toBe(150);

    const trail = evaluateLevels({
      trade: trade({ tp1Hit: true, breakevenArmed: false, stopLoss: 140 }),
      observation: { ltp: 140, high: 160, low: 139.9, ts: NOW },
    });
    expect(trail[0].type).toBe("TRAILING_SL_HIT");
  });

  test("event ids are deterministic (dedupe-safe across ticks)", () => {
    const obs = { ltp: 185, high: 185, low: 175, ts: NOW };
    const a = evaluateLevels({ trade: trade(), observation: obs });
    const b = evaluateLevels({ trade: trade(), observation: obs });
    expect(a.map((e) => e.eventId)).toEqual(b.map((e) => e.eventId));
    expect(a[0].eventId).toContain("QPT-TEST");
  });

  test("already-hit TPs are never re-fired (tpHitLevel guard)", () => {
    const events = evaluateLevels({
      trade: trade({ tp1Hit: true, tpHitLevel: "TP1", remainingQuantity: 65 }),
      observation: { ltp: 185, high: 185, low: 175, ts: NOW },
    });
    expect(events).toEqual([]); // TP1 taken; TP2 210 not crossed
  });

  test("no remaining quantity → no events", () => {
    const events = evaluateLevels({
      trade: trade({ remainingQuantity: 0 }),
      observation: { ltp: 300, high: 300, low: 100, ts: NOW },
    });
    expect(events).toEqual([]);
  });
});

// ── Breakeven + trailing ─────────────────────────────────────────────

describe("breakeven/trailing policies", () => {
  test("applyBreakevenAfterTp1 moves the stop to entry only after TP1", () => {
    const t = trade();
    expect(applyBreakevenAfterTp1(t).stopLoss).toBe(120); // not tp1Hit → unchanged
    const after = applyBreakevenAfterTp1({ ...t, tp1Hit: true });
    expect(after.stopLoss).toBe(150); // entry
    expect(after.breakevenArmed).toBe(true);
    // never loosens an already-tighter stop
    expect(applyBreakevenAfterTp1({ ...t, tp1Hit: true, stopLoss: 160 }).stopLoss).toBe(160);
  });

  test("applyTrail trails at highestSinceTp1 − 1×atrPremium, only after TP1", () => {
    const t = trade({ tp1Hit: true, highestSinceTp1: 200, stopLoss: 150, atrPremium: 10 });
    const trailed = applyTrail(t, { ltp: 210, ts: NOW });
    expect(trailed.highestSinceTp1).toBe(210);
    expect(trailed.stopLoss).toBe(200); // 210 − 10
    // never loosens
    expect(applyTrail(trailed, { ltp: 180, ts: NOW }).stopLoss).toBe(200);
    // high water ratchets, never falls
    expect(applyTrail(trailed, { ltp: 180, ts: NOW }).highestSinceTp1).toBe(210);
    // before TP1 → unchanged
    const pre = applyTrail(trade(), { ltp: 210, ts: NOW });
    expect(pre.stopLoss).toBe(120);
    expect(pre.highestSinceTp1).toBeNull();
  });

  test("statusForStopEvent maps event types to close statuses", () => {
    expect(statusForStopEvent("SL_HIT")).toBe("CLOSED_SL");
    expect(statusForStopEvent("GAP_THROUGH_SL")).toBe("CLOSED_SL");
    expect(statusForStopEvent("TRAILING_SL_HIT")).toBe("CLOSED_TRAILING_SL");
    expect(statusForStopEvent("BREAKEVEN_SL_HIT")).toBe("CLOSED_BREAKEVEN");
  });
});
