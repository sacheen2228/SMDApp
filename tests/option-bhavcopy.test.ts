/// <reference types="bun-types" />
// option-bhavcopy — NSE F&O bhavcopy as the REAL premium history source for
// option backtests (Breeze F&O historical returns empty — no entitlement —
// and spot-vs-premium replay was producing garbage wins). Offline tests: URL
// construction, weekend handling, CSV parsing and premium lookup on a fixture
// shaped exactly like the live 2026 SEBI CSV (34 columns, no quotes).

import { describe, it, expect } from "bun:test";
import {
  bhavcopyZipUrl,
  isWeekend,
  parseBhavcopyCsv,
  selectPremiumCandles,
  pickPremiumExpiry,
  type PremiumCandle,
} from "@/lib/option-bhavcopy";

const HEADER =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";

const FIXTURE = [
  HEADER,
  // NIFTY weekly CE (option)
  "2026-09-29,2026-09-29,FO,NSE,IDO,12345,,NIFTY,,2026-10-01,2026-10-01,22700.00,CE,NIFTY26SEP22700CE,100.00,150.50,90.25,120.75,121.00,95.00,22650.30,120.75,1000000,50000,5000,18000000.00,200,F1,75,,,,,",
  // RELIANCE stock PE (option)
  "2026-09-29,2026-09-29,FO,NSE,STO,53040,,RELIANCE,,2026-10-27,2026-10-27,1300.00,PE,RELIANCE26OCT1300PE,104.80,119.90,102.00,114.00,114.50,110.00,1060.00,114.00,1534500,49600,147,184886480.00,127,F1,500,,,,,",
  // NIFTY future (OptnTp empty) — must NOT become a premium candle
  "2026-09-29,2026-09-29,FO,NSE,IDO,11111,,NIFTY,,2026-09-25,2026-09-25,,FUT,NIFTY26SEPFUT,22600.00,22750.00,22550.00,22680.00,22680.00,22610.00,22650.30,22680.00,900000,20000,3000,67000000.00,150,F1,75,,,,,",
  // SENSEX-style row absent from NSE (BSE only) — nothing to do here
].join("\n");

describe("option-bhavcopy URL + weekend guard", () => {
  it("builds the NSE archives F&O bhavcopy zip URL", () => {
    expect(bhavcopyZipUrl("2026-09-29")).toBe(
      "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260929_F_0000.csv.zip"
    );
    expect(bhavcopyZipUrl("2026-07-17")).toBe(
      "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260717_F_0000.csv.zip"
    );
  });

  it("treats Saturdays and Sundays as non-trading days", () => {
    expect(isWeekend("2026-09-26")).toBe(true); // Saturday
    expect(isWeekend("2026-09-27")).toBe(true); // Sunday
    expect(isWeekend("2026-09-25")).toBe(false); // Friday
    expect(isWeekend("2026-09-29")).toBe(false); // Monday
  });
});

describe("parseBhavcopyCsv — 2026 SEBI format", () => {
  it("parses CE/PE rows into premium candles with numeric OHLC", () => {
    const rows = parseBhavcopyCsv(FIXTURE);
    expect(rows.length).toBe(2); // future excluded

    const nifty = rows[0];
    expect(nifty.date).toBe("2026-09-29");
    expect(nifty.symbol).toBe("NIFTY");
    expect(nifty.strike).toBe(22700);
    expect(nifty.optionType).toBe("CE");
    expect(nifty.expiry).toBe("2026-10-01");
    expect(nifty.open).toBe(100);
    expect(nifty.high).toBe(150.5);
    expect(nifty.low).toBe(90.25);
    expect(nifty.close).toBe(120.75);
    expect(nifty.underlying).toBe(22650.3);
    expect(nifty.lotSize).toBe(75);

    const rel = rows[1];
    expect(rel.symbol).toBe("RELIANCE");
    expect(rel.strike).toBe(1300);
    expect(rel.optionType).toBe("PE");
    expect(rel.close).toBe(114);
    expect(rel.lotSize).toBe(500);
  });

  it("tolerates a trailing newline / empty lines", () => {
    const rows = parseBhavcopyCsv(FIXTURE + "\n\n");
    expect(rows.length).toBe(2);
  });

  it("returns empty for header-only input", () => {
    expect(parseBhavcopyCsv(HEADER).length).toBe(0);
  });

  it("normalizes zero/0-0 OHLC rows to close-only (illiquid settlement rows)", () => {
    const csv = [
      HEADER,
      // O/H/L all zero, only close — a zero low must never trigger SL logic
      "2026-09-25,2026-09-25,FO,NSE,IDO,999,NSE-TEST,NIFTY,,2026-10-19,2026-10-19,22700.00,CE,NIFTY26SEP22700CE,0,0,0,765.55,765.55,760.00,22650.30,765.55,1000,50,10,999.00,5,F1,75,,,,,",
    ].join("\n");
    const rows = parseBhavcopyCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0].low).toBe(765.55);
    expect(rows[0].high).toBe(765.55);
    expect(rows[0].open).toBe(765.55);
    expect(rows[0].close).toBe(765.55);
  });
});

describe("selectPremiumCandles — strike/type/expiry lookup", () => {
  const rows = parseBhavcopyCsv(FIXTURE);

  it("matches symbol + strike + option type (numeric strike)", () => {
    const hits = selectPremiumCandles(rows, {
      symbol: "NIFTY",
      strike: 22700,
      optionType: "CE",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].close).toBe(120.75);
  });

  it("filters by expiry when provided", () => {
    const hit = selectPremiumCandles(rows, {
      symbol: "NIFTY",
      strike: 22700,
      optionType: "CE",
      expiry: "2026-10-01",
    });
    expect(hit.length).toBe(1);
    const miss = selectPremiumCandles(rows, {
      symbol: "NIFTY",
      strike: 22700,
      optionType: "CE",
      expiry: "2026-10-06",
    });
    expect(miss.length).toBe(0);
  });

  it("does not match the wrong side (CE query never returns PE rows)", () => {
    const hits = selectPremiumCandles(rows, {
      symbol: "RELIANCE",
      strike: 1300,
      optionType: "CE",
    });
    expect(hits.length).toBe(0);
  });

  it("returns empty for symbols NSE does not publish (SENSEX)", () => {
    expect(
      selectPremiumCandles(rows, { symbol: "SENSEX", strike: 77000, optionType: "CE" }).length
    ).toBe(0);
  });
});

describe("pickPremiumExpiry — sidecar records have expiry=null, match via real ranges", () => {
  const c = (
    expiry: string,
    low: number,
    high: number,
    close: number
  ): PremiumCandle => ({
    date: "2026-07-17",
    symbol: "NIFTY",
    strike: 22700,
    optionType: "CE",
    expiry,
    open: close,
    high,
    low,
    close,
    underlying: 22650,
    lotSize: 75,
    volume: 1000,
    oi: 10000,
  });

  it("single candidate containing the entry → picked with match 'range'", () => {
    const res = pickPremiumExpiry([c("2026-07-17", 90, 150, 120)], 100);
    expect(res).toEqual({ expiry: "2026-07-17", match: "range" });
  });

  it("multiple expiries → the one whose intraday range contains entry wins", () => {
    const res = pickPremiumExpiry(
      [
        c("2026-07-31", 200, 260, 230), // monthly, way above entry
        c("2026-07-17", 95, 140, 118), // weekly contains 100
      ],
      100
    );
    expect(res).toEqual({ expiry: "2026-07-17", match: "range" });
  });

  it("no range match and closest close is >30% away → refuse (honest NO_DATA)", () => {
    const res = pickPremiumExpiry(
      [
        c("2026-07-31", 200, 260, 230),
        c("2026-07-17", 140, 160, 145), // does not contain 100, but 145 vs 100 = 45%? → null
      ],
      100
    );
    // 45% diff > 30% → refuse (honest NO_DATA beats a wrong premium series)
    expect(res).toBeNull();
  });

  it("closest close within 30% → accepted", () => {
    const res = pickPremiumExpiry([c("2026-07-17", 130, 150, 140)], 120);
    expect(res).toEqual({ expiry: "2026-07-17", match: "closest" }); // diff 16.7%
  });

  it("rejects empty rows / zero entry", () => {
    expect(pickPremiumExpiry([], 100)).toBeNull();
    expect(pickPremiumExpiry([c("2026-07-17", 90, 150, 120)], 0)).toBeNull();
  });
});

describe("normalizeExpiry — sidecar stores '29-Sep-2026', bhavcopy uses ISO", () => {
  it("normalizes NSE DD-Mon-YYYY to ISO", async () => {
    const { normalizeExpiry } = await import("@/lib/option-bhavcopy");
    expect(normalizeExpiry("29-Sep-2026")).toBe("2026-09-29");
    expect(normalizeExpiry("01-Oct-2026")).toBe("2026-10-01");
    expect(normalizeExpiry("29-DEC-2026")).toBe("2026-12-29");
  });

  it("passes ISO through, rejects garbage", async () => {
    const { normalizeExpiry } = await import("@/lib/option-bhavcopy");
    expect(normalizeExpiry("2026-10-01")).toBe("2026-10-01");
    expect(normalizeExpiry("")).toBeNull();
    expect(normalizeExpiry("banana")).toBeNull();
    expect(normalizeExpiry(null as any)).toBeNull();
  });
});

// ── BSE fallback (SENSEX/BANKEX are BSE-only, absent from the NSE file) ──

describe("BSE bhavcopy URL + SENSEX parsing + symbol merge", () => {
  it("builds the BSE derivative UDiFF URL (Derivative, singular, plain CSV)", async () => {
    const { bseBhavcopyUrl } = await import("@/lib/option-bhavcopy");
    expect(bseBhavcopyUrl("2026-09-29")).toBe(
      "https://www.bseindia.com/download/BhavCopy/Derivative/BhavCopy_BSE_FO_0_0_0_20260929_F_0000.CSV"
    );
    expect(bseBhavcopyUrl("2026-07-13")).toBe(
      "https://www.bseindia.com/download/BhavCopy/Derivative/BhavCopy_BSE_FO_0_0_0_20260713_F_0000.CSV"
    );
  });

  it("parses BSE UDiFF SENSEX rows with the same header-driven parser", async () => {
    const { parseBhavcopyCsv, selectPremiumCandles } = await import("@/lib/option-bhavcopy");
    // Real header + row shape captured from the live 2026-09-29 BSE file
    // (Sgmt=BSE, SctySrs empty, ISIN empty for index options).
    const bse = [
      HEADER,
      "2026-09-29,2026-09-29,FO,BSE,IDO,1128539,,SENSEX,,2026-10-01,2026-10-01,68100.00,PE,SENSEX26O0168100PE,9.70,19.95,2.35,3.25,2.35,12.40,72529.07,3.25,14560,7360,244340,6641746664.00,4735,F1,20,,,,,",
      "2026-09-29,2026-09-29,FO,BSE,IDO,889401,,SENSEX,,2026-10-08,2026-10-08,75100.00,CE,SENSEX26O0875100CE,60.00,80.35,52.00,60.30,63.05,102.85,72529.07,60.30,5680,2360,7240,544201933.00,139,F1,20,,,,,",
      // futures row (OptnTp=FUT) must be skipped
      "2026-09-29,2026-09-29,FO,BSE,IVS,111111,,SENSEX,,2026-10-01,2026-10-01,,FUT,SENSEX26OCTFUT,72500.00,72600.00,72400.00,72529.07,72529.07,72400.00,72529.07,72529.07,5000,100,50,0,10,F1,20,,,,,",
    ].join("\n");
    const rows = parseBhavcopyCsv(bse);
    expect(rows.length).toBe(2);
    expect(rows[0].symbol).toBe("SENSEX");
    expect(rows[0].optionType).toBe("PE");
    expect(rows[0].strike).toBe(68100);
    expect(rows[0].close).toBe(3.25);
    expect(rows[0].high).toBe(19.95);
    expect(rows[0].expiry).toBe("2026-10-01");
    expect(rows[0].underlying).toBe(72529.07);
    expect(rows[0].lotSize).toBe(20);
    const hit = selectPremiumCandles(rows, {
      symbol: "SENSEX",
      strike: 75100,
      optionType: "CE",
      expiry: "2026-10-08",
    });
    expect(hit.length).toBe(1);
    expect(hit[0].close).toBe(60.3);
  });

  it("mergeForSymbol keeps NSE rows for NSE symbols, appends BSE for SENSEX", async () => {
    const { parseBhavcopyCsv, mergeForSymbol } = await import("@/lib/option-bhavcopy");
    const nse = parseBhavcopyCsv(FIXTURE); // NIFTY + RELIANCE + future-filtered
    const bse = parseBhavcopyCsv(
      [HEADER, "2026-09-29,2026-09-29,FO,BSE,IDO,1128539,,SENSEX,,2026-10-01,2026-10-01,68100.00,PE,SENSEX26O0168100PE,9.70,19.95,2.35,3.25,3.25,12.40,72529.07,3.25,14560,7360,244340,6641746664.00,4735,F1,20,,,,,"].join("\n")
    );
    // NIFTY found in NSE → BSE rows NOT appended (avoids duplicate work)
    expect(mergeForSymbol(nse, bse, "NIFTY")).toBe(nse);
    // SENSEX absent from NSE → merged in
    const merged = mergeForSymbol(nse, bse, "SENSEX");
    expect(merged.length).toBe(nse.length + bse.length);
    expect(merged.some((r) => r.symbol === "SENSEX")).toBe(true);
    // BSE empty → NSE rows unchanged (never lose data)
    expect(mergeForSymbol(nse, [], "SENSEX")).toBe(nse);
  });
});

describe("parseBhavcopyCsv — corrupt close==underlying rows (BSE 2026-07-16)", () => {
  // The 2026-07-16 BSE file stamps UndrlygPric into ClsPric for 230 SENSEX
  // option rows (close 77186.87 on a 76900PE would be nonsense). Real close
  // must fall back to LastPric, then PrvsClsgPric — never the index value.
  const row = (cls: string, last: string, prev: string, und: string) =>
    [
      "2026-07-16", "2026-07-16", "FO", "BSE", "IDO", "823754", "", "SENSEX", "",
      "2026-07-16", "2026-07-16", "76900.00", "PE", "SENSEX2671676900PE",
      "139.85", "139.90", "0.05", cls, last, prev, und, und, "1489040", "826800",
      "243426740", "18723397595074.00", "1586750", "F1", "20", "", "", "", "", "",
    ].join(",");

  it("replaces close==underlying with LastPric", () => {
    const rows = parseBhavcopyCsv(HEADER + "\n" + row("77186.87", "0.05", "159.15", "77186.87"));
    expect(rows.length).toBe(1);
    expect(rows[0].close).toBe(0.05);
    expect(rows[0].underlying).toBe(77186.87); // underlying kept for context
  });

  it("falls back to PrvsClsgPric when LastPric is zero", () => {
    const rows = parseBhavcopyCsv(HEADER + "\n" + row("77186.87", "0", "159.15", "77186.87"));
    expect(rows[0].close).toBe(159.15);
  });

  it("keeps a genuine close that differs from underlying", () => {
    const rows = parseBhavcopyCsv(HEADER + "\n" + row("140.25", "140.25", "159.15", "77186.87"));
    expect(rows[0].close).toBe(140.25);
  });
});
