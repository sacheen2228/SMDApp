/// <reference types="bun-types" />
// TDD for the NSE most-active contracts feed.
//
// THE BUGS THIS LOCKS DOWN (verified live 2026-11-25):
//   1. The fetcher requested `calls-index`, `puts-index`, `calls-stocks` and
//      `puts-stocks` — NSE answers `{}` for all four. The Calls/Puts tabs and
//      the P/C sentiment badge were permanently empty (a fabricated
//      "Neutral P/C 1.00"). The index names NSE actually serves are `calls`
//      and `puts`.
//   2. The page has TWO rankings ("Sort By Volume" / "Sort By Value"); the
//      normalizer kept only the volume rows, so the value ranking was lost.
//
// The EOD artifact (the skill's 19:05 job) must keep BOTH rankings too.

import { describe, test, expect } from "bun:test";
import {
  normalizeContracts,
  splitByInstrumentType,
  emptyCategory,
} from "@/lib/nse-most-active";
import { readNseEodMostActive } from "@/lib/orchestrator/eod-artifacts";

const NSE_PAYLOAD = {
  volume: {
    timestamp: "25-Nov-2026 15:40:00",
    data: [
      {
        instrumentType: "OPTIDX", instrument: "Index Options", underlying: "NIFTY",
        expiryDate: "01-Dec-2026", optionType: "Call", strikePrice: 26000,
        lastPrice: 142.9, pChange: 12.5, numberOfContractsTraded: 3058958,
        totalTurnover: 324494.26, openInterest: 133776, underlyingValue: 25819.25,
      },
    ],
  },
  value: {
    timestamp: "25-Nov-2026 15:40:00",
    data: [
      {
        instrumentType: "OPTIDX", instrument: "Index Options", underlying: "NIFTY",
        expiryDate: "01-Dec-2026", optionType: "Call", strikePrice: 25800,
        lastPrice: 230.9, pChange: 9.1, numberOfContractsTraded: 2557428,
        totalTurnover: 399939.54, openInterest: 77091, underlyingValue: 25819.25,
      },
    ],
  },
};

describe("normalizeContracts — both NSE rankings are kept", () => {
  test("byVolume, byValue and the backward-compatible data field", () => {
    const cat = normalizeContracts(NSE_PAYLOAD);
    expect(cat.byVolume).toHaveLength(1);
    expect(cat.byValue).toHaveLength(1);
    expect(cat.data).toEqual(cat.byVolume);       // `data` stays the volume list
    expect(cat.byVolume[0].strikePrice).toBe(26000);
    expect(cat.byValue[0].strikePrice).toBe(25800);
    expect(cat.timestamp).toBe("25-Nov-2026 15:40:00");
  });

  test("a payload with only one sort still yields a category", () => {
    const cat = normalizeContracts({ volume: NSE_PAYLOAD.volume });
    expect(cat.byVolume).toHaveLength(1);
    expect(cat.byValue).toHaveLength(0);
  });

  test("a failed request → an empty category, never a crash", () => {
    const cat = normalizeContracts(null);
    expect(cat.data).toEqual([]);
    expect(cat.byVolume).toEqual([]);
    expect(cat.byValue).toEqual([]);
    expect(cat.timestamp).toBe("");
    expect(emptyCategory().data).toEqual([]);
  });
});

describe("splitByInstrumentType — index vs stock rows", () => {
  test("index options land in the index bucket, stock options in the stock one", () => {
    const cat = normalizeContracts({
      volume: {
        timestamp: "25-Nov-2026 15:40:00",
        data: [
          { instrumentType: "OPTIDX", instrument: "Index Options", underlying: "NIFTY", strikePrice: 26000, optionType: "Call" },
          { instrumentType: "OPTSTK", instrument: "Stock Options", underlying: "RELIANCE", strikePrice: 1400, optionType: "Call" },
        ],
      },
      value: {
        timestamp: "25-Nov-2026 15:40:00",
        data: [
          { instrumentType: "OPTIDX", instrument: "Index Options", underlying: "NIFTY", strikePrice: 25900, optionType: "Put" },
        ],
      },
    });
    const { index, stocks } = splitByInstrumentType(cat);
    expect(index.data).toHaveLength(1);
    expect(index.data[0].underlying).toBe("NIFTY");
    expect(index.byValue).toHaveLength(1);
    expect(stocks.data).toHaveLength(1);
    expect(stocks.data[0].underlying).toBe("RELIANCE");
    expect(stocks.byValue).toHaveLength(0);
  });
});

describe("readNseEodMostActive — the daily capture", () => {
  test("reads both rankings from the artifact", async () => {
    const eod = await readNseEodMostActive("2026-11-25");
    expect(eod).not.toBeNull();
    expect(eod!.byVolume.data.length).toBeGreaterThan(0);
    expect(eod!.byValue.data.length).toBeGreaterThan(0);
    const row = eod!.byVolume.data[0];
    expect(row.strikePrice).toBeGreaterThan(0);
    expect(row.expiryDate).toBeTruthy();
    expect(row.underlying).toBeTruthy();
  });

  test("a missing session → null (never a fabricated list)", async () => {
    expect(await readNseEodMostActive("2020-01-01")).toBeNull();
    expect(await readNseEodMostActive("../etc")).toBeNull();
  });
});
