import { describe, test, expect } from "bun:test";
import { parseFuturesOiCsv, pickFrontMonth } from "@/lib/futures-oi";

const csv = [
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4",
  "2026-11-06,2026-11-06,FO,NSE,IDF,123,,NIFTY,,2026-11-23,2026-11-23,, ,NIFTY FUT,25000,25100,24900,25032,25032,24536,25030.35,25030,12088505,-553085,100000,2500000000,50000,F1,75,,,,,",
  "2026-11-06,2026-11-06,FO,NSE,IDF,124,,NIFTY,,2026-12-29,2026-12-29,, ,NIFTY FUT,25100,25200,25050,25159,25159,24536,25030.35,25030,1481090,74035,40000,1000000000,20000,F1,75,,,,,",
  "2026-11-06,2026-11-06,FO,NSE,IDF,125,,NIFTY,,2027-01-25,2027-01-25,, ,NIFTY FUT,25200,25300,25150,25267,25267,24536,25030.35,25030,366730,55770,10000,500000000,5000,F1,75,,,,,",
  // options must be ignored
  "2026-11-06,2026-11-06,FO,NSE,IDO,999,,NIFTY,,2026-11-23,2026-11-23,25000.00,CE,NIFTY26NOV25000CE,100,110,90,105,105,100,25030.35,25030,500000,-1000,90000,9000000,70000,F1,75,,,,,",
  // a different symbol's futures must be ignored
  "2026-11-06,2026-11-06,FO,NSE,IDF,555,,BANKNIFTY,,2026-11-23,2026-11-23,, ,BANKNIFTY FUT,57000,57500,56800,57100,57100,56500,57000,57000,900000,-20000,5000,100000000,4000,F1,35,,,,,",
].join("\n");

describe("parseFuturesOiCsv", () => {
  test("extracts only index-futures rows for the requested symbol", () => {
    const rows = parseFuturesOiCsv(csv, "NIFTY");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.symbol === "NIFTY")).toBe(true);
    expect(rows.map((r) => r.expiry)).toEqual(["2026-11-23", "2026-12-29", "2027-01-25"]);
  });
  test("reads OI, OI change and close — converted to CONTRACTS (÷ lot 65)", () => {
    const rows = parseFuturesOiCsv(csv, "NIFTY");
    const front = rows.find((r) => r.expiry === "2026-11-23")!;
    // bhavcopy OpnIntrst/ChngInOpnIntrst are in UNDERLYING UNITS:
    // 12,088,505 ÷ 65 = 185,977 contracts; -553,085 ÷ 65 = -8,509.
    expect(front.oi).toBe(185977);
    expect(front.oiChg).toBe(-8509);
    expect(front.close).toBe(25032);
    expect(front.date).toBe("2026-11-06");
  });
  test("uses the symbol's own lot (BANKNIFTY ÷ 30, not NIFTY's 65)", () => {
    const rows = parseFuturesOiCsv(csv, "BANKNIFTY");
    expect(rows).toHaveLength(1);
    expect(rows[0].oi).toBe(30000); // 900,000 ÷ 30
    expect(rows[0].oiChg).toBe(-667); // -20,000 ÷ 30, rounded
  });
  test("returns [] for unknown schema / empty input", () => {
    expect(parseFuturesOiCsv("", "NIFTY")).toEqual([]);
    expect(parseFuturesOiCsv("foo,bar\n1,2", "NIFTY")).toEqual([]);
  });
  test("tolerates missing numeric fields without throwing", () => {
    const header = csv.split("\n")[0];
    const bad = [header, "2026-11-06,2026-11-06,FO,NSE,IDF,1,,NIFTY,,2026-11-23,2026-11-23,, ,NIFTY FUT,,,,,,25030,25030,,,,, ,F1,75,,,,,"].join("\n");
    const rows = parseFuturesOiCsv(bad, "NIFTY");
    expect(rows).toHaveLength(1);
    expect(Number.isFinite(rows[0].oi)).toBe(true);
  });
});

describe("pickFrontMonth", () => {
  const rows = [
    { date: "2026-11-06", symbol: "NIFTY", expiry: "2026-11-23", oi: 12088505, oiChg: -553085, close: 25032 },
    { date: "2026-11-06", symbol: "NIFTY", expiry: "2026-12-29", oi: 1481090, oiChg: 74035, close: 25159 },
    { date: "2026-11-05", symbol: "NIFTY", expiry: "2026-11-23", oi: 12641590, oiChg: 30000, close: 24900 },
    { date: "2026-11-05", symbol: "NIFTY", expiry: "2026-12-29", oi: 1407055, oiChg: -1000, close: 25010 },
  ];
  test("keeps only the nearest (front) expiry per day", () => {
    const front = pickFrontMonth(rows);
    expect(front).toHaveLength(2);
    expect(front.map((r) => r.date)).toEqual(["2026-11-05", "2026-11-06"]);
    expect(front.find((r) => r.date === "2026-11-06")!.expiry).toBe("2026-11-23");
    expect(front.find((r) => r.date === "2026-11-06")!.oi).toBe(12088505);
  });
  test("sorts ascending by date", () => {
    const front = pickFrontMonth([...rows].reverse());
    expect(front.map((r) => r.date)).toEqual(["2026-11-05", "2026-11-06"]);
  });
  test("empty input → []", () => {
    expect(pickFrontMonth([])).toEqual([]);
  });
});
