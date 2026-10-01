import { describe, test, expect } from "bun:test";
import { mapNSEChain } from "@/lib/market/capture";

// Real NSE option-chain v3 shape (verified live 2026-09-27):
//  - spot comes from records.underlyingValue
//  - legs carry impliedVolatility but NO greeks field anywhere
//  - per-leg expiryDate is DD-MM-YYYY ("29-09-2026") — new Date() can't parse it
const nseFixture = {
  records: {
    underlyingValue: 23140.5,
    expiryDates: ["29-Sep-2026"],
    data: [
      {
        strikePrice: 23000,
        CE: {
          lastPrice: 210.4,
          openInterest: 1500000,
          changeinOpenInterest: 12000,
          impliedVolatility: 12.1,
          totalTradedVolume: 45000,
          expiryDate: "29-09-2026",
        },
        PE: {
          lastPrice: 42.3,
          openInterest: 2400000,
          changeinOpenInterest: -8000,
          impliedVolatility: 9.9,
          totalTradedVolume: 61000,
          expiryDate: "29-09-2026",
        },
      },
      {
        strikePrice: 23150,
        CE: {
          lastPrice: 119.25,
          openInterest: 560870,
          changeinOpenInterest: 10050,
          impliedVolatility: 11.5,
          totalTradedVolume: 39000,
          expiryDate: "29-09-2026",
        },
        PE: {
          lastPrice: 76.75,
          openInterest: 610400,
          changeinOpenInterest: -5020,
          impliedVolatility: 8.74,
          totalTradedVolume: 44000,
          expiryDate: "29-09-2026",
        },
      },
      {
        strikePrice: 25500,
        CE: {
          lastPrice: 0.05,
          openInterest: 10,
          changeinOpenInterest: 0,
          impliedVolatility: 0,
          totalTradedVolume: 0,
          expiryDate: "29-09-2026",
        },
        PE: {
          lastPrice: 2390,
          openInterest: 5,
          changeinOpenInterest: 0,
          impliedVolatility: 0,
          totalTradedVolume: 0,
          expiryDate: "29-09-2026",
        },
      },
    ],
  },
};

describe("mapNSEChain — Black-Scholes greeks from IV (NSE v3 ships no greeks field)", () => {
  const legs = mapNSEChain(nseFixture);
  const ce = legs.find((l) => l.strike === 23150 && l.type === "CE");
  const pe = legs.find((l) => l.strike === 23150 && l.type === "PE");

  test("ATM CE leg: delta in (0,1), negative theta, positive gamma", () => {
    expect(ce).toBeDefined();
    expect(ce!.greeks.delta).toBeGreaterThan(0);
    expect(ce!.greeks.delta).toBeLessThan(1);
    expect(ce!.greeks.theta).toBeLessThan(0);
    expect(ce!.greeks.gamma).toBeGreaterThan(0);
  });

  test("ATM PE leg: delta in (-1,0)", () => {
    expect(pe).toBeDefined();
    expect(pe!.greeks.delta).toBeLessThan(0);
    expect(pe!.greeks.delta).toBeGreaterThan(-1);
  });

  test("computed greeks are finite — DD-MM-YYYY expiry must parse (new Date yields NaN)", () => {
    expect(Number.isFinite(ce!.greeks.delta)).toBe(true);
    expect(Number.isFinite(ce!.greeks.theta)).toBe(true);
    expect(Number.isFinite(pe!.greeks.delta)).toBe(true);
    expect(Number.isFinite(pe!.greeks.gamma)).toBe(true);
  });

  test("IV=0 leg stays zero-greeks with null iv (never fabricate BS from iv=0)", () => {
    const far = legs.find((l) => l.strike === 25500 && l.type === "CE");
    expect(far).toBeDefined();
    expect(far!.iv).toBeNull();
    expect(far!.greeks.delta).toBe(0);
    expect(far!.greeks.theta).toBe(0);
    expect(far!.greeks.gamma).toBe(0);
  });

  test("field mapping: ltp/oi/oiChg/volume/iv come from the NSE keys", () => {
    expect(ce!.ltp).toBe(119.25);
    expect(ce!.oi).toBe(560870);
    expect(ce!.oiChg).toBe(10050);
    expect(ce!.volume).toBe(39000);
    expect(ce!.iv).toBe(11.5);
    expect(pe!.iv).toBe(8.74);
    expect(pe!.ltp).toBe(76.75);
    expect(pe!.oi).toBe(610400);
  });

  test("spot from records.underlyingValue: ITM CE delta > near-ATM CE delta", () => {
    const itmCe = legs.find((l) => l.strike === 23000 && l.type === "CE");
    expect(itmCe).toBeDefined();
    expect(itmCe!.greeks.delta).toBeGreaterThan(ce!.greeks.delta);
  });
});
