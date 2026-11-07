/// <reference types="bun-types" />
// TDD for the F&O Pulse board (TheTradeCartel integration — embed into Scanner tab).
// Tests the pure row-ranking/mapping helper the panel uses to turn
// /api/scanner/fno payloads into ranked display rows.

import { describe, it, expect } from "bun:test";
import { rankPulseRows } from "@/components/dashboard/FnoPulseBoard";

describe("rankPulseRows", () => {
  const payload = {
    candidates: [
      {
        symbol: "RELIANCE",
        name: "Reliance Industries",
        sector: "Energy",
        ltp: 2850,
        changePct: 1.4,
        score: 78,
        signals: ["Long Buildup", "Unusual Volume"],
        metrics: {
          oiSignal: "Long Buildup",
          oiChange: 125000,
          pcr: 1.2,
          atmIV: 14.5,
          relVolume: 2.3,
        },
      },
      {
        symbol: "TCS",
        name: "TCS",
        sector: "IT",
        ltp: 3400,
        changePct: -0.6,
        score: 65,
        signals: ["Short Buildup"],
        metrics: {
          oiSignal: "Short Buildup",
          oiChange: -40000,
          pcr: 0.8,
          atmIV: 18.2,
          relVolume: 1.1,
        },
      },
      {
        symbol: "INFY",
        name: "Infosys",
        sector: "IT",
        ltp: 1500,
        changePct: 0.2,
        score: 55,
        signals: [],
        metrics: { oiSignal: "Neutral", oiChange: null, pcr: null, atmIV: null, relVolume: null },
      },
    ],
  };

  it("ranks rows by score descending", () => {
    const rows = rankPulseRows(payload);
    expect(rows.map((r) => r.symbol)).toEqual(["RELIANCE", "TCS", "INFY"]);
    expect(rows[0].rank).toBe(1);
    expect(rows[2].rank).toBe(3);
  });

  it("maps metrics through with nulls preserved (never fabricated)", () => {
    const rows = rankPulseRows(payload);
    expect(rows[0].oiSignal).toBe("Long Buildup");
    expect(rows[0].pcr).toBe(1.2);
    expect(rows[2].pcr).toBeNull();
    expect(rows[2].atmIV).toBeNull();
    expect(rows[2].relVolume).toBeNull();
  });

  it("drops rows without a real score or price", () => {
    const rows = rankPulseRows({
      candidates: [
        { symbol: "OK", score: 70, ltp: 100, metrics: {} },
        { symbol: "NOSCORE", score: null, ltp: 100, metrics: {} },
        { symbol: "NOPRICE", score: 70, ltp: null, metrics: {} },
        null,
      ],
    });
    expect(rows.map((r) => r.symbol)).toEqual(["OK"]);
  });

  it("re-sorts even if the API order changes", () => {
    const rows = rankPulseRows({
      candidates: [
        { symbol: "LOW", score: 40, ltp: 10, metrics: {} },
        { symbol: "HIGH", score: 90, ltp: 10, metrics: {} },
      ],
    });
    expect(rows[0].symbol).toBe("HIGH");
  });

  it("returns [] for a missing/invalid payload instead of throwing", () => {
    expect(rankPulseRows(null)).toEqual([]);
    expect(rankPulseRows(undefined)).toEqual([]);
    expect(rankPulseRows({})).toEqual([]);
    expect(rankPulseRows({ candidates: "nope" })).toEqual([]);
  });

  it("defaults signals to [] when absent", () => {
    const rows = rankPulseRows({ candidates: [{ symbol: "X", score: 60, ltp: 1, metrics: {} }] });
    expect(rows[0].signals).toEqual([]);
  });
});
