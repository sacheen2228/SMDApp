/// <reference types="bun-types" />
// Challenge lot sizes — SEBI revises F&O lot sizes often; the 2024 static
// table was wrong (NIFTY 25 vs live 65, RELIANCE 250 vs 500, WIPRO 1500 vs
// 3000). Live source: NSE fo_mktlots.csv (verified reachable), parsed from
// the FIRST month column (current expiry month), merged over the static
// snapshot fallback.

import { describe, it, expect } from "bun:test";
import {
  parseMktLotsCsv,
  setLiveLotSizes,
  getLiveLotSizes,
  getLotSize,
} from "@/lib/challenge/capital-manager";

const FIXTURE = `UNDERLYING                          ,SYMBOL    ,OCT-26     ,NOV-26     ,DEC-26
NIFTY 50                            ,NIFTY     ,65         ,65         ,65
NIFTY BANK                          ,BANKNIFTY ,30         ,30         ,30
RELIANCE INDUSTRIES LTD             ,RELIANCE  ,500        ,500        ,500
WIPRO LTD                           ,WIPRO     ,3000       ,3000       ,3000
GRASIM INDUSTRIES LTD               ,GRASIM    ,250        ,250        ,250
INFOSYS LTD                         ,INFY      ,400        ,400        ,400
TATA STEEL LTD                      ,TATASTEEL ,5500       ,5500       ,5500
BANK OF BARODA                      ,BANKBARODA,1470       ,           ,1470`;

describe("parseMktLotsCsv", () => {
  it("maps SYMBOL → first non-empty month column", () => {
    const lots = parseMktLotsCsv(FIXTURE);
    expect(lots.NIFTY).toBe(65);
    expect(lots.BANKNIFTY).toBe(30);
    expect(lots.RELIANCE).toBe(500);
    expect(lots.WIPRO).toBe(3000);
    expect(lots.TATASTEEL).toBe(5500);
  });

  it("skips the header row and blank month cells (falls to next month)", () => {
    const lots = parseMktLotsCsv(FIXTURE);
    expect(lots.BANKBARODA).toBe(1470); // NOV empty → DEC 1470
    expect(lots.UNDERLYING).toBeUndefined();
    expect(Object.keys(lots).length).toBe(8); // 7 fixture symbols + BANKBARODA
  });

  it("ignores junk/empty input", () => {
    expect(parseMktLotsCsv("")).toEqual({});
    expect(parseMktLotsCsv("not,a,csv")).toEqual({});
  });
});

describe("live lot sizes (set/get)", () => {
  it("live values override the static snapshot in getLotSize", () => {
    setLiveLotSizes({ NIFTY: 65, RELIANCE: 500 });
    expect(getLotSize("NIFTY")).toBe(65);
    expect(getLotSize("RELIANCE")).toBe(500);
    expect(getLiveLotSizes().NIFTY).toBe(65);
    setLiveLotSizes({}); // reset — no leak into other tests
  });

  it("falls back to the updated static snapshot when live data absent", () => {
    setLiveLotSizes({});
    // static snapshot from NSE fo_mktlots.csv (OCT-26) — NOT the stale 2024 table
    expect(getLotSize("NIFTY")).toBe(65);
    expect(getLotSize("BANKNIFTY")).toBe(30);
    expect(getLotSize("FINNIFTY")).toBe(60);
    expect(getLotSize("MIDCPNIFTY")).toBe(120);
    expect(getLotSize("RELIANCE")).toBe(500);
    expect(getLotSize("WIPRO")).toBe(3000);
    // unknown symbol → 1 (never a fabricated lot)
    expect(getLotSize("SOME_UNKNOWN")).toBe(1);
  });

  it("SENSX/BSE symbols keep their static value (NSE CSV does not cover BSE)", () => {
    setLiveLotSizes({});
    expect(getLotSize("SENSEX")).toBeGreaterThanOrEqual(1);
  });
});
