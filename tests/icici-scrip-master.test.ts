/// <reference types="bun-types" />
// TDD for the ICICI scrip-code resolver.
//
// Breeze getHistoricalDatav2 needs ICICI's OWN scrip codes: RELIANCE returns
// 0 rows as "RELIANCE" and 40 rows as "RELIND"; NIFTYBEES as "NIFBEE";
// SBIN as "STABAN". Plain tickers only work when the ICICI code happens to
// equal the NSE symbol (ITC). The exchange symbol lives at column 60 and the
// ICICI code at column 1 of NSEScripMaster.txt (inside SecurityMaster.zip).

import { describe, test, expect } from "bun:test";
import { parseNseScripMaster, lookupScrip, INDEX_BREEZE_CODES } from "@/lib/icici-scrip-master";

/** A real-shaped master row: 61 fields, quoted text, bare numerics. */
function masterRow(overrides: {
  token?: string;
  short?: string;
  series?: string;
  company?: string;
  symbol?: string;
  fields?: number;
}): string {
  const f: string[] = new Array(overrides.fields ?? 61).fill('""');
  f[0] = `"${overrides.token ?? "0"}"`;
  f[1] = `"${overrides.short ?? "X"}"`;
  f[2] = `"${overrides.series ?? "EQ"}"`;
  f[3] = `"${overrides.company ?? "COMPANY"}"`;
  f[60] = `"${overrides.symbol ?? "X"}"`;
  return f.join(",");
}

const HEADER = '"Token", "ShortName", "Series", "CompanyName", "Symbol"';

const REAL_SHAPES = [
  masterRow({ token: "2885", short: "RELIND", company: "RELIANCE INDUSTRIES", symbol: "RELIANCE" }),
  masterRow({ token: "3045", short: "STABAN", company: "STATE BANK OF INDIA", symbol: "SBIN" }),
  masterRow({ token: "10576", short: "NIFBEE", company: "NIPPON INDIA ETF NIFTY 50 BEES", symbol: "NIFTYBEES" }),
  masterRow({ token: "1660", short: "ITC", company: "ITC LIMITED", symbol: "ITC" }),
  // A company name containing a comma would shift a naive split(",") —
  // column 60 must stay aligned through quote-aware parsing.
  masterRow({ token: "999", short: "COMMACO", company: 'COMMA, "QUOTED" LTD', symbol: "COMMACO" }),
  // Non-EQ series must not shadow the EQ row for the same symbol.
  masterRow({ token: "1", short: "BEOLD", series: "BE", symbol: "COMMACO" }),
  // Short rows (partial files) are skipped, not misaligned.
  '"5","TRUNC","EQ","TRUNCATED"',
].join("\n");

describe("parseNseScripMaster", () => {
  test("maps exchange symbol → ICICI scrip code (idx60 → idx1)", () => {
    const map = parseNseScripMaster(HEADER + "\n" + REAL_SHAPES);
    expect(map.get("RELIANCE")).toBe("RELIND");
    expect(map.get("SBIN")).toBe("STABAN");
    expect(map.get("NIFTYBEES")).toBe("NIFBEE");
    expect(map.get("ITC")).toBe("ITC");
  });

  test("quote-aware parsing survives commas and quotes inside a field", () => {
    const map = parseNseScripMaster(HEADER + "\n" + REAL_SHAPES);
    expect(map.get("COMMACO")).toBe("COMMACO");
  });

  test("EQ wins over another series for the same symbol", () => {
    const map = parseNseScripMaster(HEADER + "\n" + REAL_SHAPES);
    expect(map.get("COMMACO")).toBe("COMMACO");
  });

  test("skips short/invalid rows and the header", () => {
    const map = parseNseScripMaster(HEADER + "\n" + REAL_SHAPES);
    expect(map.has("TRUNC")).toBe(false);
    expect(map.has("TOKEN")).toBe(false);
    expect(map.size).toBe(5);
  });
});

describe("lookupScrip", () => {
  test("index symbols map to Breeze's index codes (not the NSE master)", () => {
    expect(INDEX_BREEZE_CODES["NIFTY"]).toBe("NIFTY");
    expect(INDEX_BREEZE_CODES["BANKNIFTY"]).toBe("CNXBAN");
    expect(INDEX_BREEZE_CODES["FINNIFTY"]).toBe("NIFFIN");
    expect(INDEX_BREEZE_CODES["MIDCPNIFTY"]).toBe("NIFMID");
    expect(INDEX_BREEZE_CODES["SENSEX"]).toBe("BSESEN");
    const empty = new Map<string, string>();
    expect(lookupScrip(empty, "NIFTY")).toBe("NIFTY");
    expect(lookupScrip(empty, "BANKNIFTY")).toBe("CNXBAN");
  });

  test("resolves through the master, case-insensitively", () => {
    const map = new Map([["RELIANCE", "RELIND"]]);
    expect(lookupScrip(map, "reliance")).toBe("RELIND");
    expect(lookupScrip(map, "RELIANCE")).toBe("RELIND");
  });

  test("unknown symbols fall back to the raw ticker (ITC-style equality)", () => {
    const map = new Map([["RELIANCE", "RELIND"]]);
    expect(lookupScrip(map, "ITC")).toBe("ITC");
    expect(lookupScrip(map, "TCS")).toBe("TCS");
  });

  test("no master available → raw ticker, never a throw", () => {
    expect(lookupScrip(null, "RELIANCE")).toBe("RELIANCE");
  });
});
