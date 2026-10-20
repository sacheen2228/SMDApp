// ═══════════════════════════════════════════════════════════════════════════
// ALERT TRUTH TESTS — every number in a Telegram alert must be true.
//
// Built from the LIVE NSE payload captured on 20-Oct-2026 15:00 IST from
// /api/scanner?symbol=NIFTY&live=true:
//
//   TCS 2460 PE  @ ₹41.05   SL ₹49.25   T1 ₹24.65  T2 ₹16.40  T3 ₹8.20
//   ULTRACEMCO 10600 CE @ ₹164.90  SL ₹131.90  T1 ₹230.85
//
// The defects these lock down (all reproduced live):
//   1. A PE plan is MIRRORED (stop ABOVE the entry, targets BELOW). The monitor
//      treated it like a long → a FALSE "STOP LOSS HIT" the moment the trade
//      opened (at the ENTRY price) and the TP ladder never fired.
//   2. The P&L sign ignored the plan geometry → "Loss: ₹533.00" (positive!) on
//      a stop-out and "Gain: ₹-1066.00" (negative!) on a target.
//   3. No exit price on the SL alert, and the queue format showed the ENTRY as
//      the exit.
//   4. Bare "₹-" for missing values in the Hermes queue format.
//   5. Float noise (5.100000000000001) leaking into prices.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterAll } from "bun:test";
import {
  planSide, planPnlPct, planPnlRupees, detectPlanHit, stopFillPrice,
  formatSLTPHit, checkSLTP, addTrade, removeTradeForTest,
} from "@/lib/activeTradeTracker";
import { formatStockOptionAlert, isPlausibleOptionPlan } from "@/lib/sendIntradayAlerts";
import { formatEventForTelegram } from "@/lib/hermes/telegram-queue";
import { detectHitForTest, pollTradesOnce } from "@/lib/tiger-monitor";
import { __setAlertSenderForTests } from "@/lib/agents/telegram-alerts";
import { releaseTradeLock } from "@/lib/active-trade-lock";
import { getLotSize } from "@/lib/symbol-config";

// ── LIVE payloads ────────────────────────────────────────────────────
const LIVE_PE = {
  symbol: "TCS", strike: 2460, optionType: "PE" as const, premium: 41.05,
  stopLoss: 49.25, targets: [24.65, 16.4, 8.2], expiryLabel: "27-Oct-2026",
  expiry: "27-Oct-2026", chainSource: "NSE", chainAsOf: new Date().toISOString(),
  direction: "BUY", underlyingPrice: 2460.9,
};

const LIVE_CE = {
  symbol: "ULTRACEMCO", strike: 10600, optionType: "CE" as const, premium: 164.9,
  stopLoss: 131.9, targets: [230.85, 263.85, 296.8], expiryLabel: "27-Oct-2026",
  expiry: "27-Oct-2026", chainSource: "NSE", chainAsOf: new Date().toISOString(),
  direction: "BUY", underlyingPrice: 10650,
};

function tradeOf(o: any, over: any = {}): any {
  return {
    id: `truth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, symbol: o.symbol, side: "BUY",
    instrument: `${o.symbol} ${o.strike} ${o.optionType}`,
    strike: o.strike, optionType: o.optionType,
    entry: o.premium, sl: o.stopLoss, tp1: o.targets[0], tp2: o.targets[1], tp3: o.targets[2],
    status: "ACTIVE", sentAt: new Date().toISOString(), source: "e2e-test", exchange: "NFO",
    ...over,
  };
}

const LOT = getLotSize("TCS");

afterAll(async () => {
  try {
    const { db } = await import("@/lib/db");
    await db.trade.deleteMany({ where: { tradeId: { startsWith: "truth-" } } });
  } catch { /* db unavailable */ }
  // The TP/SL delivery flags live in a JSON file — drop this run's entries so
  // the test never dedups against its own previous run.
  try {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(process.cwd(), "data", "tpsl-alert-flags.json");
    if (fs.existsSync(file)) {
      const flags = JSON.parse(fs.readFileSync(file, "utf8"));
      let changed = false;
      for (const k of Object.keys(flags)) {
        if (k.startsWith("truth-")) { delete flags[k]; changed = true; }
      }
      if (changed) fs.writeFileSync(file, JSON.stringify(flags, null, 2));
    }
  } catch { /* flags file optional */ }
});

// ═══════════════════════════════════════════════════════════════════════
describe("plan geometry — the mirror decides the side, not the option letter", () => {
  it("a bearish PE plan (stop above, targets below) is a SHORT plan", () => {
    expect(planSide(tradeOf(LIVE_PE))).toBe("SHORT");
  });

  it("a bullish CE plan (stop below, targets above) is a LONG plan", () => {
    expect(planSide(tradeOf(LIVE_CE))).toBe("LONG");
  });

  it("the P&L sign follows the plan: the stop is a loss, the target is a gain", () => {
    const pe = tradeOf(LIVE_PE);
    // stop hit → the premium rose 8.20 → a LOSS of 8.20 x lot (19.98% of the premium)
    expect(planPnlPct(pe, LIVE_PE.stopLoss)).toBeCloseTo(-19.98, 1);
    expect(planPnlRupees(pe, LIVE_PE.stopLoss)).toBeCloseTo(-8.2 * LOT, 5);
    // target hit → the premium fell 16.40 → a GAIN of 16.40 x lot (39.95%)
    expect(planPnlPct(pe, LIVE_PE.targets[0])).toBeCloseTo(39.95, 1);
    expect(planPnlRupees(pe, LIVE_PE.targets[0])).toBeCloseTo(16.4 * LOT, 5);
  });

  it("a CE keeps the long-side maths", () => {
    const ce = tradeOf(LIVE_CE);
    expect(planPnlPct(ce, LIVE_CE.stopLoss)).toBeCloseTo(-20.01, 1);
    expect(planPnlPct(ce, LIVE_CE.targets[0])).toBeCloseTo(39.99, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("one hit ladder for every monitor (PE aware)", () => {
  it("a PE does NOT stop out while the price is below its stop", () => {
    const pe = tradeOf(LIVE_PE);
    expect(detectPlanHit(pe, LIVE_PE.premium)).toBeNull();     // at the entry
    expect(detectPlanHit(pe, 45)).toBeNull();                  // below the stop
    expect(detectPlanHit(pe, LIVE_PE.stopLoss)).toBe("SL_HIT");
    expect(detectPlanHit(pe, LIVE_PE.stopLoss + 1)).toBe("SL_HIT");
  });

  it("a PE fires TP1 when the price FALLS to the target", () => {
    const pe = tradeOf(LIVE_PE);
    expect(detectPlanHit(pe, LIVE_PE.targets[0])).toBe("TP1_HIT");
    expect(detectPlanHit(pe, LIVE_PE.targets[0] - 1)).toBe("TP1_HIT");
  });

  it("a CE keeps the long-side ladder", () => {
    const ce = tradeOf(LIVE_CE);
    expect(detectPlanHit(ce, LIVE_CE.stopLoss - 1)).toBe("SL_HIT");
    expect(detectPlanHit(ce, LIVE_CE.targets[0])).toBe("TP1_HIT");
    expect(detectPlanHit(ce, LIVE_CE.premium)).toBeNull();
  });

  it("the tiger monitor uses the same ladder", () => {
    const pe = tradeOf(LIVE_PE);
    expect(detectHitForTest(pe, LIVE_PE.premium)).toBeNull();
    expect(detectHitForTest(pe, LIVE_PE.targets[0])).toBe("TP1_HIT");
    expect(detectHitForTest(pe, LIVE_PE.stopLoss)).toBe("SL_HIT");
  });

  it("the stop fill is the stop level, or worse when the price gaps through it", () => {
    const pe = tradeOf(LIVE_PE);
    expect(stopFillPrice(pe, LIVE_PE.stopLoss)).toBe(LIVE_PE.stopLoss);
    expect(stopFillPrice(pe, LIVE_PE.stopLoss + 2.5)).toBe(LIVE_PE.stopLoss + 2.5); // gap up
    const ce = tradeOf(LIVE_CE);
    expect(stopFillPrice(ce, LIVE_CE.stopLoss)).toBe(LIVE_CE.stopLoss);
    expect(stopFillPrice(ce, LIVE_CE.stopLoss - 3)).toBe(LIVE_CE.stopLoss - 3);    // gap down
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("checkSLTP (the 15-minute monitor) — PE side logic", () => {
  it("does not fire a false SL on a PE at the entry price", async () => {
    const t = tradeOf(LIVE_PE, { id: `truth-pe-entry-${Date.now()}`, symbol: "TRUTHPE1" });
    await addTrade(t, true);
    const res = await checkSLTP(async () => LIVE_PE.premium);
    expect(res.hitSL.length).toBe(0);
    expect(res.hitTP1.length).toBe(0);
    removeTradeForTest(t.id);
    releaseTradeLock("TRUTHPE1", "NFO");
  });

  it("fires TP1 for a PE when the price falls to the target", async () => {
    const t = tradeOf(LIVE_PE, { id: `truth-pe-tp1-${Date.now()}`, symbol: "TRUTHPE2" });
    await addTrade(t, true);
    const res = await checkSLTP(async () => LIVE_PE.targets[0]);
    expect(res.hitSL.length).toBe(0);
    expect(res.hitTP1.length).toBe(1);
    expect(res.hitTP1[0].id).toBe(t.id);
    removeTradeForTest(t.id);
    releaseTradeLock("TRUTHPE2", "NFO");
  });

  it("fires SL for a PE when the price rises to the stop", async () => {
    const t = tradeOf(LIVE_PE, { id: `truth-pe-sl-${Date.now()}`, symbol: "TRUTHPE3" });
    await addTrade(t, true);
    const res = await checkSLTP(async () => LIVE_PE.stopLoss);
    expect(res.hitSL.length).toBe(1);
    removeTradeForTest(t.id);
    releaseTradeLock("TRUTHPE3", "NFO");
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("formatSLTPHit — the whole alert on a realistic PE payload", () => {
  it("a PE stop hit is a LOSS, signed, with the stop as the exit price", () => {
    const msg = formatSLTPHit(tradeOf(LIVE_PE) as any, "SL");
    expect(msg).toContain("STOP LOSS HIT");
    // the money: −8.20 × lot, and it MUST carry a sign
    expect(msg).toContain(`Loss: ₹-${(8.2 * LOT).toFixed(2)}`);
    // the % is the per-unit move on the premium (20%), never 1300%
    expect(msg).toMatch(/\(20\.0%\)/);
    expect(msg).not.toContain("1300");
    // the exit is the STOP, never the entry
    expect(msg).toContain("Exit: ₹49.25");
    expect(msg).not.toContain("Exit: ₹41.05");
    // no float noise anywhere
    expect(msg).not.toMatch(/\d+\.\d{6,}/);
    expect(msg).not.toContain("₹- ");
  });

  it("a PE target hit is a GAIN, signed, with the target as the exit price", () => {
    const msg = formatSLTPHit(tradeOf(LIVE_PE) as any, "TP1");
    expect(msg).toContain("TARGET 1 HIT");
    expect(msg).toContain(`Gain: ₹+${(16.4 * LOT).toFixed(2)}`);
    expect(msg).toMatch(/\(40\.0%\)/);
    expect(msg).not.toMatch(/\d+\.\d{6,}/);
  });

  it("a CE stop hit is a loss and a CE target hit is a gain", () => {
    const sl = formatSLTPHit(tradeOf(LIVE_CE) as any, "SL");
    expect(sl).toContain("Loss: ₹-");
    expect(sl).toMatch(/\(20\.0%\)/);
    expect(sl).toContain("Exit: ₹131.90");
    const tp = formatSLTPHit(tradeOf(LIVE_CE) as any, "TP1");
    expect(tp).toContain("Gain: ₹+");
    expect(tp).toMatch(/\(40\.0%\)/);
  });

  it("never prints a bare ₹- and never a NaN", () => {
    for (const t of [tradeOf(LIVE_PE), tradeOf(LIVE_CE)]) {
      for (const hit of ["SL", "TP1", "TP2", "TP3"] as const) {
        const msg = formatSLTPHit(t as any, hit);
        expect(msg).not.toContain("NaN");
        expect(msg).not.toMatch(/₹-\s/);
        expect(msg).not.toContain("undefined");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("formatStockOptionAlert — the whole alert on a realistic PE payload", () => {
  const stock = {
    symbol: "TCS", totalScore: 64, currentPrice: LIVE_PE.underlyingPrice,
    reasons: ["Engine 88/100 — PREV_HIGH_SWEEP_REJECTION @ TRANSITION"],
  };
  const sources = { quotes: "nse", daily: "nse", intraday: "none", chain: "NSE (1m ago)" };

  it("R:R comes from the option's own plan (1:2.0) and every price is tick-rounded", () => {
    const msg = formatStockOptionAlert(stock, LIVE_PE, sources);
    expect(msg).toContain("R:R 1:2.0");
    expect(msg).toContain("Premium: ₹41.05");
    expect(msg).toContain("Stop Loss: ₹49.25");
    expect(msg).toContain("T1 ₹24.65 | T2 ₹16.40 | T3 ₹8.20");
    expect(msg).not.toMatch(/\d+\.\d{6,}/);   // no 24.650000000000002
    expect(msg).not.toContain("5.100000000000001");
  });

  it("the data-source line is present and truthful", () => {
    const msg = formatStockOptionAlert(stock, LIVE_PE, sources);
    expect(msg).toContain("📡 Data:");
    expect(msg).toContain("quotes nse");
    expect(msg).toContain("daily nse");
    expect(msg).toContain("chain NSE");
    expect(msg).toContain("5m UNAVAILABLE");
  });

  it("a CE plan prints the same 1:2.0 with long-side maths", () => {
    const msg = formatStockOptionAlert(
      { symbol: "ULTRACEMCO", totalScore: 62, currentPrice: LIVE_CE.underlyingPrice, reasons: ["GAP_REVERSAL"] },
      LIVE_CE, sources,
    );
    expect(msg).toContain("R:R 1:2.0");
    expect(msg).not.toMatch(/\d+\.\d{6,}/);
  });

  it("a BOUGHT PE (stop below, targets above) uses the long-side R:R", () => {
    // The SDM engine builds a long plan for a PE — the letter must not flip it.
    const msg = formatStockOptionAlert(
      { symbol: "NIFTY", totalScore: 70, currentPrice: 22888, reasons: ["MTF uptrend"] },
      { optionType: "PE", strike: 22900, premium: 150, stopLoss: 100, targets: [250, 350, 450], expiryLabel: "27-Oct-2026" },
      sources,
    );
    expect(msg).toContain("R:R 1:2.0");   // risk 50 (entry-stop), reward 100 (TP1-entry)
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("fail closed — the underlying can never be an option premium", () => {
  it("rejects a plan whose premium is the underlying's price", () => {
    // The live bug: "BHARTIARTL — PE / Strike 1875.2 / Entry ₹1875.20"
    expect(isPlausibleOptionPlan(
      { symbol: "BHARTIARTL", currentPrice: 1875.2 },
      { optionType: "PE", strike: 1875, premium: 1875.2, stopLoss: 2250.24, targets: [1125.12, 750.08, 375.04] },
    )).toBe(false);
  });

  it("rejects a plan whose stop is on the wrong side of the entry", () => {
    expect(isPlausibleOptionPlan(
      { symbol: "SBIN", currentPrice: 800 },
      { optionType: "CE", strike: 800, premium: 40, stopLoss: 45, targets: [80, 120, 160] },  // CE stop above entry
    )).toBe(false);
    expect(isPlausibleOptionPlan(
      { symbol: "SBIN", currentPrice: 800 },
      { optionType: "PE", strike: 800, premium: 40, stopLoss: 30, targets: [20, 10, 5] },    // mirrored PE stop below entry
    )).toBe(false);
  });

  it("accepts the live plans", () => {
    expect(isPlausibleOptionPlan(
      { symbol: "TCS", currentPrice: LIVE_PE.underlyingPrice }, LIVE_PE,
    )).toBe(true);
    expect(isPlausibleOptionPlan(
      { symbol: "ULTRACEMCO", currentPrice: LIVE_CE.underlyingPrice }, LIVE_CE,
    )).toBe(true);
  });

  it("rejects a plan with a missing level", () => {
    expect(isPlausibleOptionPlan(
      { symbol: "SBIN", currentPrice: 800 },
      { optionType: "PE", strike: 800, premium: 40, stopLoss: 48, targets: [] },
    )).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("Hermes queue format — SL/TP events", () => {
  const ev = (eventType: string, payload: Record<string, any>) => ({
    eventId: "truth-evt", eventType: eventType as any, symbol: "TCS", tradeId: "truth-1",
    payload, timestamp: new Date().toISOString(), delivered: false, retryCount: 0,
  });

  it("an SL hit shows the STOP as the exit — never the entry", () => {
    const text = formatEventForTelegram(ev("SL_HIT", {
      direction: "BUY_PE", entry: 41.05, sl: 49.25, exit: 41.05, tp1: 24.65, tp2: 16.4,
      pnl: -533, exitReason: "INITIAL_SL",
    }));
    expect(text).toContain("Exit: ₹49.25");
    expect(text).not.toContain("Exit: ₹41.05");
    expect(text).toContain("P&L: -₹533");
    expect(text).toContain("Net:");
  });

  it("a gapped SL shows the worse fill, not the trigger tick", () => {
    const text = formatEventForTelegram(ev("SL_HIT", {
      direction: "BUY_PE", entry: 41.05, sl: 49.25, exit: 51.75, tp1: 24.65,
      pnl: -696, exitReason: "INITIAL_SL",
    }));
    expect(text).toContain("Exit: ₹51.75");
  });

  it("a CE SL shows the stop or worse", () => {
    const text = formatEventForTelegram(ev("SL_HIT", {
      direction: "BUY_CE", entry: 164.9, sl: 131.9, exit: 129.4, tp1: 230.85,
      pnl: -2380, exitReason: "INITIAL_SL",
    }));
    expect(text).toContain("Exit: ₹129.40");
  });

  it("never prints a bare ₹- for a missing level", () => {
    const text = formatEventForTelegram(ev("TP1_HIT", { direction: "BUY_CE", entry: 100 }));
    expect(text).not.toContain("₹-");
    expect(text).toContain("Entry: ₹100");
    expect(text).toContain("Net:");
  });

  it("the P&L carries a sign and the % is the per-unit move", () => {
    const text = formatEventForTelegram(ev("TP1_HIT", {
      direction: "BUY_PE", entry: 41.05, sl: 49.25, tp1: 24.65, current: 24.65, pnl: 1066,
    }));
    expect(text).toContain("P&L: +₹1066");
    expect(text).toMatch(/40\.0%/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("tiger card — a PE stop hit is not a green profit", () => {
  it("the card shows a signed loss and the stop as the exit", async () => {
    const sent: string[] = [];
    __setAlertSenderForTests(async (text: string) => { sent.push(text); return true; });
    const t = tradeOf(LIVE_PE, { id: `truth-tiger-${Date.now()}`, symbol: "TRUTHTIG1" });
    await addTrade(t, true);
    const res = await pollTradesOnce(async (x) => (x.id === t.id ? LIVE_PE.stopLoss : 0));
    expect(res.detected).toBe(1);
    expect(sent.length).toBe(1);
    const card = sent[0];
    expect(card).toContain("SL HIT");
    expect(card).toContain("P&L: ₹-");
    expect(card).toMatch(/\(20\.0%\)/);
    expect(card).toContain("Exit: ₹49.25");
    expect(card).not.toContain("Exit: ₹41.05");
    expect(card).not.toMatch(/\d+\.\d{6,}/);
    __setAlertSenderForTests(null);
    removeTradeForTest(t.id);
    releaseTradeLock("TRUTHTIG1", "NFO");
  });

  it("a PE target hit is not a red loss", async () => {
    const sent: string[] = [];
    __setAlertSenderForTests(async (text: string) => { sent.push(text); return true; });
    const t = tradeOf(LIVE_PE, { id: `truth-tiger-tp-${Date.now()}`, symbol: "TRUTHTIG2" });
    await addTrade(t, true);
    const res = await pollTradesOnce(async (x) => (x.id === t.id ? LIVE_PE.targets[0] : 0));
    expect(res.detected).toBe(1);
    const card = sent[0];
    expect(card).toContain("TARGET 1 HIT");
    expect(card).toContain("P&L: ₹+");
    expect(card).toMatch(/\(40\.0%\)/);
    __setAlertSenderForTests(null);
    removeTradeForTest(t.id);
    releaseTradeLock("TRUTHTIG2", "NFO");
  });
});
