// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL TYPE INTEGRITY — the "BHARTIARTL — PE / Strike 1875.2 / Entry
// ₹1875.20" incident.
//
// A CASH trade was registered as an OPTION: the stock price was used as an
// option premium. Downstream, `optionType` decides whether the plan is
// MIRRORED (PE → stop above the entry, targets below) or LONG (CE → stop
// below), and the tracker resolves an OPTION LTP for CE/PE — so the trade was
// monitored on the wrong side and its LTP could never be found ("LTP feed
// unavailable after 10 consecutive attempts", forever, lock held).
//
// These tests are offline (no network, no DB writes): the registration seam is
// injected so nothing reaches the live tracker.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import type { MorningSignal } from "@/lib/morningSignalGenerator";

/** Collect what WOULD be registered instead of touching the live tracker. */
function collector() {
  const trades: any[] = [];
  return {
    trades,
    register: async (t: any) => {
      trades.push(t);
    },
  };
}

function sentText() {
  const texts: string[] = [];
  return { texts, send: async (t: string) => { texts.push(t); return true; } };
}

// A cash short: stop ABOVE the entry, targets BELOW (underlying levels).
const CASH_SHORT: MorningSignal = {
  symbol: "CASHCO",
  name: "Cash Co",
  sector: "Equity Swing",
  type: "EQ",
  side: "SELL",
  direction: "SELL",
  entry: 1875.2,
  stopLoss: 1917.39,
  tp1: 1818.94,
  tp2: 1775.5,
  rr: 1.5,
  confidence: 80,
  instrument: "CASHCO (cash short)",
  reasoning: "test",
  source: "equity-swing",
};

// A real option: a premium, a strike, an expiry, a premium-priced entry.
const REAL_PE: MorningSignal = {
  symbol: "SBIN",
  name: "State Bank",
  sector: "Stock F&O",
  type: "PE",
  side: "BUY",
  direction: "BUY_PE",
  entry: 8.5,
  stopLoss: 10.2,
  tp1: 5.1,
  tp2: 3.4,
  rr: 2,
  confidence: 78,
  instrument: "SBIN 970 PE",
  reasoning: "test",
  source: "stock-fo",
  strike: 970,
  expiry: "29-Oct-2026",
  premium: 8.5,
};

// The bug: an option trade priced at the UNDERLYING price.
const UNDERLYING_PRICED_OPTION: MorningSignal = {
  ...REAL_PE,
  symbol: "BADOPT",
  name: "Bad Option",
  entry: 1875.2,
  stopLoss: 1917.39,
  tp1: 1818.94,
  strike: 1875.2,
  premium: 1875.2,
};

describe("morning signal type integrity — registration", () => {
  test("(a) a cash-equity signal is registered with a NON-option type", async () => {
    const { sendIndividualSignals } = await import("@/lib/morningSignalGenerator");
    const c = collector();
    const s = sentText();

    const sent = await sendIndividualSignals([CASH_SHORT], s.send, c.register);

    expect(sent).toBe(1);
    expect(c.trades.length).toBe(1);
    const t = c.trades[0];
    expect(t.optionType).toBe("EQ");
    expect(t.optionType).not.toBe("PE");
    expect(t.optionType).not.toBe("CE");
    // a cash SHORT is a SELL — the tracker must not mirror it as a put
    expect(t.side).toBe("SELL");
    expect(t.sl).toBeGreaterThan(t.entry);
    // no option contract → no strike
    expect(t.strike).toBe(0);
    expect(t.exchange).toBe("NSE");
  });

  test("(b) an option signal keeps CE/PE", async () => {
    const { sendIndividualSignals } = await import("@/lib/morningSignalGenerator");
    const c = collector();
    const s = sentText();

    const sent = await sendIndividualSignals([REAL_PE], s.send, c.register);

    expect(sent).toBe(1);
    expect(c.trades.length).toBe(1);
    const t = c.trades[0];
    expect(t.optionType).toBe("PE");
    expect(t.side).toBe("BUY");
    expect(t.strike).toBe(970);
    expect(t.expiry).toBe("29-Oct-2026");
    // a bought put is mirrored in premium space: stop ABOVE the entry
    expect(t.sl).toBeGreaterThan(t.entry);
    expect(t.tp1).toBeLessThan(t.entry);
  });

  test("(c) the guard rejects an option trade priced at the underlying price", async () => {
    const { sendIndividualSignals, isPlausibleOptionPremium } = await import(
      "@/lib/morningSignalGenerator"
    );
    const c = collector();
    const s = sentText();

    const sent = await sendIndividualSignals([UNDERLYING_PRICED_OPTION], s.send, c.register);

    // neither announced nor registered
    expect(sent).toBe(0);
    expect(s.texts.length).toBe(0);
    expect(c.trades.length).toBe(0);

    // the guard itself
    const g = isPlausibleOptionPremium({ entry: 1875.2, strike: 1875.2, chainPremium: 1875.2 });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/strike scale|premium/i);

    // a real premium is accepted
    const ok = isPlausibleOptionPremium({ entry: 8.5, strike: 970, chainPremium: 8.5 });
    expect(ok.ok).toBe(true);
  });
});

describe("morning signal type integrity — mapping", () => {
  test("an index futures view is FUT (never CE/PE) with the right side", async () => {
    const { mapIndexFOSignal } = await import("@/lib/morningSignalGenerator");

    const long = mapIndexFOSignal({
      symbol: "NIFTY",
      direction: "LONG",
      confidence: 80,
      entry: 24000,
      stopLoss: 23640,
      target1: 24720,
      target2: 25140,
      riskReward: 2,
      reasoning: ["x"],
      recommendedInstrument: "NIFTY Futures",
      strike: 0,
      expiry: "",
      premium: 0,
    } as any);
    expect(long?.type).toBe("FUT");
    expect(long?.side).toBe("BUY");

    const short = mapIndexFOSignal({
      symbol: "NIFTY",
      direction: "SHORT",
      confidence: 80,
      entry: 24000,
      stopLoss: 24360,
      target1: 23280,
      target2: 22860,
      riskReward: 2,
      reasoning: ["x"],
      recommendedInstrument: "NIFTY Short Futures",
      strike: 0,
      expiry: "",
      premium: 0,
    } as any);
    expect(short?.type).toBe("FUT");
    expect(short?.side).toBe("SELL");
    expect(short?.strike).toBeUndefined();
  });

  test("an index option view with a real contract is CE/PE priced from the premium", async () => {
    const { mapIndexFOSignal } = await import("@/lib/morningSignalGenerator");

    const put = mapIndexFOSignal({
      symbol: "NIFTY",
      direction: "PUT",
      confidence: 70,
      entry: 24000, // spot level from the engine — must NOT survive
      stopLoss: 24360,
      target1: 23280,
      target2: 22860,
      riskReward: 2,
      reasoning: ["x"],
      recommendedInstrument: "NIFTY 24000 PE",
      strike: 24000,
      expiry: "29-Oct-2026",
      premium: 120,
    } as any);

    expect(put?.type).toBe("PE");
    expect(put?.side).toBe("BUY");
    // the entry is the PREMIUM, not the underlying price
    expect(put?.entry).toBeCloseTo(120, 2);
    expect(put?.entry).toBeLessThan(24000);
    // a bought put is mirrored in premium space
    expect(put?.stopLoss).toBeGreaterThan(put!.entry);
    expect(put?.tp1).toBeLessThan(put!.entry);
  });

  test("a stock option view without a real contract is dropped, never a cash trade", async () => {
    const { mapStockFOSignal } = await import("@/lib/morningSignalGenerator");

    const dropped = mapStockFOSignal({
      symbol: "BHARTIARTL",
      name: "Bharatiarthl",
      direction: "BUY_PE",
      confidence: 80,
      entry: 1875.2,
      stopLoss: 1917.39,
      target1: 1818.94,
      target2: 1775.5,
      riskReward: 1.5,
      reasoning: ["x"],
      recommendedInstrument: "BHARTIARTL 1875 PE",
      strike: 1875.2,
      expiry: "",
      premium: 0,
    } as any);

    expect(dropped).toBeNull();
  });

  test("a cash swing signal maps to EQ with the side of the trade", async () => {
    const { mapEquitySwingSignal } = await import("@/lib/morningSignalGenerator");

    const short = mapEquitySwingSignal({
      symbol: "BHARTIARTL",
      name: "Bharatiarthl",
      direction: "SELL",
      confidence: 75,
      entry: 1875.2,
      stopLoss: 1917.39,
      target1: 1818.94,
      target2: 1775.5,
      riskReward: 1.5,
      reasoning: ["x"],
    } as any);
    expect(short.type).toBe("EQ");
    expect(short.side).toBe("SELL");

    const long = mapEquitySwingSignal({
      symbol: "HDFCBANK",
      name: "HDFC Bank",
      direction: "BUY",
      confidence: 75,
      entry: 1900,
      stopLoss: 1850,
      target1: 2000,
      target2: 2100,
      riskReward: 2,
      reasoning: ["x"],
    } as any);
    expect(long.type).toBe("EQ");
    expect(long.side).toBe("BUY");
  });
});

describe("morning signal type integrity — the tracker only gets priceable trades", () => {
  test("a futures/underlying signal is announced but NOT registered (no LTP source)", async () => {
    const { sendIndividualSignals, mapIndexFOSignal } = await import("@/lib/morningSignalGenerator");
    const c = collector();
    const s = sentText();

    const fut = mapIndexFOSignal({
      symbol: "BANKNIFTY",
      direction: "SHORT",
      confidence: 80,
      entry: 52000,
      stopLoss: 52780,
      target1: 50440,
      target2: 49560,
      riskReward: 2,
      reasoning: ["x"],
      recommendedInstrument: "BANKNIFTY Short Futures",
      strike: 0,
      expiry: "",
      premium: 0,
    } as any)!;

    const sent = await sendIndividualSignals([fut], s.send, c.register);

    expect(sent).toBe(1);
    expect(s.texts.length).toBe(1);
    expect(c.trades.length).toBe(0); // nothing the monitor could ever price
  });
});

describe("morning signal type integrity — the registered trade is monitored sanely", () => {
  test("a registered cash short is NOT stopped out the moment it opens", async () => {
    const { sendIndividualSignals } = await import("@/lib/morningSignalGenerator");
    const { detectHitForTest } = await import("@/lib/tiger-monitor");
    const c = collector();
    const s = sentText();

    // A fresh symbol — the signal dedup is per symbol+type+direction per day.
    await sendIndividualSignals([{ ...CASH_SHORT, symbol: "CASHMON" }], s.send, c.register);
    const trade = c.trades[0];
    expect(trade).toBeTruthy();

    // The price at the entry is NOT a stop (the stop is above the entry for a
    // cash short) and NOT a target.
    expect(detectHitForTest(trade, trade.entry)).toBeNull();
    // the stop is hit when the price rises to it
    expect(detectHitForTest(trade, trade.sl)).toBe("SL_HIT");
    // the target is hit when the price falls to it
    expect(detectHitForTest(trade, trade.tp1)).toBe("TP1_HIT");
  });

  test("a registered option buy is monitored on the option-premium feed", async () => {
    const { sendIndividualSignals } = await import("@/lib/morningSignalGenerator");
    const { detectHitForTest } = await import("@/lib/tiger-monitor");
    const c = collector();
    const s = sentText();

    await sendIndividualSignals([{ ...REAL_PE, symbol: "SBINPE" }], s.send, c.register);
    const trade = c.trades[0];
    expect(trade.optionType).toBe("PE");
    expect(trade.strike).toBe(970);
    // the tracker resolves an OPTION premium for a PE (strike > 0 + CE/PE)
    expect(trade.strike > 0 && (trade.optionType === "CE" || trade.optionType === "PE")).toBe(true);
    // a bought put: the stop is above the entry, the target below
    expect(detectHitForTest(trade, trade.sl)).toBe("SL_HIT");
    expect(detectHitForTest(trade, trade.tp1)).toBe("TP1_HIT");
  });
});
