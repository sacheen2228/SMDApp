/// <reference types="bun-types" />
// nseChainToSnapshot — pure mapper from raw NSE option-chain-v3 records to
// the OptionChainSnapshot the F&O engine consumes. Offline: fixture mirrors
// the exact live shape captured from nse-bse-api optionChainV3.

import { describe, it, expect } from "bun:test";
import { nseChainToSnapshot } from "@/lib/breeze-fno-data";

function leg(over: Partial<Record<string, any>> = {}) {
  return {
    lastPrice: 0,
    openInterest: 0,
    changeinOpenInterest: 0,
    totalTradedVolume: 0,
    impliedVolatility: 0,
    expiryDate: "27-10-2026",
    ...over,
  };
}

const raw = {
  records: {
    underlyingValue: 1321.7,
    expiryDates: ["27-Oct-2026", "23-Nov-2026"],
    data: [
      {
        strikePrice: 1300,
        CE: leg({ lastPrice: 45.5, openInterest: 1000, changeinOpenInterest: 120, totalTradedVolume: 500, impliedVolatility: 18.4 }),
        PE: leg({ lastPrice: 22.1, openInterest: 2000, changeinOpenInterest: -80, totalTradedVolume: 300, impliedVolatility: 16.2 }),
      },
      {
        strikePrice: 1320,
        CE: leg({ lastPrice: 30.4, openInterest: 3000, changeinOpenInterest: 200, totalTradedVolume: 700, impliedVolatility: 14.9 }),
        PE: leg({ lastPrice: 33.2, openInterest: 1500, changeinOpenInterest: 50, totalTradedVolume: 400, impliedVolatility: 15.1 }),
      },
      {
        strikePrice: 1340,
        CE: leg({ lastPrice: 18.7, openInterest: 2500, changeinOpenInterest: -30, totalTradedVolume: 250, impliedVolatility: 12.8 }),
        PE: leg({ lastPrice: 46.0, openInterest: 500, changeinOpenInterest: 10, totalTradedVolume: 100, impliedVolatility: 13.5 }),
      },
      // Stale row from the NEXT expiry must be filtered out
      {
        strikePrice: 1320,
        CE: leg({ lastPrice: 99.9, openInterest: 1, expiryDate: "23-11-2026" }),
        PE: leg({ lastPrice: 99.9, openInterest: 1, expiryDate: "23-11-2026" }),
      },
    ],
  },
};

describe("nseChainToSnapshot", () => {
  it("maps spot, expiry and ATM strike from NSE records", () => {
    const snap = nseChainToSnapshot(raw as any, 0, "ICICIBANK");
    expect(snap).not.toBeNull();
    expect(snap!.spot).toBe(1321.7);
    expect(snap!.expiry).toBe("27-Oct-2026");
    expect(snap!.atmStrike).toBe(1320);
    expect(snap!.symbol).toBe("ICICIBANK");
  });

  it("filters rows from other expiries (keeps nearest-expiry strikes only)", () => {
    const snap = nseChainToSnapshot(raw as any, 0, "ICICIBANK");
    expect(snap!.strikes.map((s) => s.strike)).toEqual([1300, 1320, 1340]);
    const atm = snap!.strikes.find((s) => s.strike === 1320)!;
    expect(atm.ce.ltp).toBe(30.4); // nearest-expiry row, not the 99.9 stale row
  });

  it("maps real OI / IV / premium metrics", () => {
    const snap = nseChainToSnapshot(raw as any, 0, "ICICIBANK")!;
    const atm = snap.strikes.find((s) => s.strike === 1320)!;
    expect(atm.ce.oi).toBe(3000);
    expect(atm.ce.oiChange).toBe(200);
    expect(atm.ce.iv).toBe(14.9);
    expect(atm.ce.volume).toBe(700);
    expect(atm.pe.oi).toBe(1500);
    expect(snap.callOiMap.get(1320)).toBe(3000);
    expect(snap.putOiMap.get(1320)).toBe(1500);
    expect(snap.callOiChangeMap.get(1320)).toBe(200);
    expect(snap.putVolumeMap.get(1300)).toBe(300);
  });

  it("computes PCR from real OI totals", () => {
    const snap = nseChainToSnapshot(raw as any, 0, "ICICIBANK")!;
    const callOi = 1000 + 3000 + 2500; // 6500
    const putOi = 2000 + 1500 + 500; // 4000
    expect(snap.pcr).toBeCloseTo(putOi / callOi, 5);
  });

  it("computes real ATM IV and IV distribution stats", () => {
    const snap = nseChainToSnapshot(raw as any, 0, "ICICIBANK")!;
    expect(snap.atmIV).toBe(15.1); // max(ce 14.9, pe 15.1) at ATM
    expect(snap.ivRank).toBeGreaterThan(0);
    expect(snap.ivRank).toBeLessThanOrEqual(100);
    expect(snap.ivPercentile).toBe(snap.ivRank);
  });

  it("computes max pain as the strike with minimum total payout", () => {
    const snap = nseChainToSnapshot(raw as any, 0, "ICICIBANK")!;
    // Payout to option buyers at expiry (min across candidate prices):
    // price 1300: puts only → (1320−1300)×1500 + (1340−1300)×500 = 50000
    // price 1320: calls (1320−1300)×1000 = 20000; puts (1340−1320)×500 = 10000 → 30000
    // price 1340: calls (1340−1300)×1000 + (1340−1320)×3000 = 40000+60000 = 100000
    expect(snap.maxPain).toBe(1320);
  });

  it("returns null when records are missing or empty", () => {
    expect(nseChainToSnapshot(null, 100, "X")).toBeNull();
    expect(nseChainToSnapshot({} as any, 100, "X")).toBeNull();
    expect(nseChainToSnapshot({ records: { data: [] } } as any, 100, "X")).toBeNull();
    expect(
      nseChainToSnapshot({ records: { data: [{ strikePrice: 100 }] } } as any, 100, "X")
    ).toBeNull();
  });

  it("honours an explicit spot override (caller's index/stock price)", () => {
    const snap = nseChainToSnapshot(raw as any, 1310, "ICICIBANK")!;
    expect(snap.spot).toBe(1310);
    expect(snap.atmStrike).toBe(1300); // nearest to 1310 (1300: 10, 1320: 10 → first wins on tie? nearest strictly smaller diff: 1300 diff 10, 1320 diff 10)
  });
});
