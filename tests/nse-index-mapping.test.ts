/// <reference types="bun-types" />
// nse-api index mapping — regression for live 2026-10-01 finding: NSE returns
// "NIFTY BANK" (all caps) while the filter expected "NIFTY Bank", so BANKNIFTY
// was silently dropped from getNSEIndices() (only NIFTY survived). SENSEX is
// BSE-only and never appears in NSE allIndices — the mapping must still accept
// it defensively.

import { describe, it, expect } from "bun:test";
import { mapNSEIndices } from "@/lib/nse-api";

const row = (index: string, last: number, previousClose: number, percentChange: number) => ({
  index,
  last,
  previousClose,
  percentChange,
});

describe("mapNSEIndices", () => {
  it("maps NIFTY 50 → NIFTY", () => {
    const out = mapNSEIndices([row("NIFTY 50", 22421.95, 22620.45, -0.88)]);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("NIFTY");
    expect(out[0].ltp).toBe(22421.95);
    expect(out[0].prevClose).toBe(22620.45);
    expect(out[0].changePct).toBe(-0.88);
  });

  it("maps NIFTY BANK (all caps, live NSE casing) → BANKNIFTY", () => {
    const out = mapNSEIndices([row("NIFTY BANK", 51000, 51400, -0.78)]);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("BANKNIFTY");
    expect(out[0].name).toBe("BANK NIFTY");
  });

  it("still accepts legacy 'NIFTY Bank' casing", () => {
    const out = mapNSEIndices([row("NIFTY Bank", 51000, 51400, -0.78)]);
    expect(out[0].key).toBe("BANKNIFTY");
  });

  it("maps SENSEX defensively if ever present", () => {
    const out = mapNSEIndices([row("SENSEX", 71909.7, 72000, -0.12)]);
    expect(out[0].key).toBe("SENSEX");
  });

  it("keeps NIFTY + BANKNIFTY together and drops unrelated rows", () => {
    const out = mapNSEIndices([
      row("NIFTY 50", 22421.95, 22620.45, -0.88),
      row("NIFTY BANK", 51000, 51400, -0.78),
      row("NIFTY NEXT 50", 60000, 59800, 0.33),
      row("NIFTY MIDCAP SELECT", 24000, 23900, 0.42),
    ]);
    expect(out.map((i) => i.key)).toEqual(["NIFTY", "BANKNIFTY"]);
  });

  it("computes change from last/previousClose when percentChange missing", () => {
    const out = mapNSEIndices([row("NIFTY 50", 100, 90, NaN)]);
    expect(out[0].change).toBe(10);
    expect(out[0].changePct).toBe(11.11);
  });

  it("returns empty for empty input", () => {
    expect(mapNSEIndices([])).toEqual([]);
    expect(mapNSEIndices(null as any)).toEqual([]);
  });
});
