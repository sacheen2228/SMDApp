/// <reference types="bun-types" />
// TDD for the REAL confirmation engine behind the SimpleMode BUY/WAIT card.
//
// The old evaluateConfirmations scored 3 fabricated proxies (spot-vs-maxPain
// "trend", OI-writing "trigger", total-chain-volume "RVOL") against 2 real
// checks, so the 3-of-5 gate was unreachable and the card sat on WATCH/40%.
//
// The new engine scores ONLY real reads:
//   • Trend     — SuperTrend dir + EMA rel (chop-suppressed) + structure, from the 15m TfRead
//   • Trigger   — real trigger hits/opposing from the 5m triggerLayer (closed-bar evidence)
//   • Volume    — real last-bar RVOL vs the 20-bar average; null when candles carry no volume
//   • OI / PCR  — real PCR (unchanged)
//   • VWAP      — real vsVwap from the 5m TfRead; "NA" (no volume) → unavailable
//
// No fabricated values: missing data marks the check UNAVAILABLE (not counted
// in the ratio), never a pass.
//
// The trade gate is the playbook rule: Trigger AND (Trend OR VWAP). A card
// shows BUY only when the gate passes; everything else stays WAIT.

import { describe, test, expect } from "bun:test";
import {
  evaluateConfirmations,
  confirmSummary,
  type TrendReadInput,
} from "@/lib/signal-persistence";

const trend = (o: Partial<TrendReadInput>): TrendReadInput => ({
  stDir: 1, emaRel: "ABOVE", emaChop: false, structureTrend: "UP", ...o,
});

describe("Trend check — real SuperTrend/EMA/structure reads only", () => {
  test("CALL with SuperTrend up + EMA above + structure UP → pass", () => {
    const c = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({}),
    });
    const t = c.find((x) => x.name === "Trend")!;
    expect(t.available).toBe(true);
    expect(t.pass).toBe(true);
    expect(t.detail).toContain("SuperTrend");
  });

  test("CALL with SuperTrend down + structure DOWN → fail (data available, not in favour)", () => {
    const t = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({ stDir: -1, emaRel: "BELOW", structureTrend: "DOWN" }),
    }).find((x) => x.name === "Trend")!;
    expect(t.available).toBe(true);
    expect(t.pass).toBe(false);
  });

  test("PUT with SuperTrend down + EMA below + structure DOWN → pass", () => {
    const t = evaluateConfirmations({
      direction: "PUT",
      trendRead: trend({ stDir: -1, emaRel: "BELOW", structureTrend: "DOWN" }),
    }).find((x) => x.name === "Trend")!;
    expect(t.pass).toBe(true);
  });

  test("EMA chop suppresses the EMA vote — structure decides", () => {
    const pass = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({ emaChop: true, structureTrend: "UP" }),
    }).find((x) => x.name === "Trend")!;
    expect(pass.pass).toBe(true);
    expect(pass.detail).toContain("chop");

    const fail = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({ emaChop: true, structureTrend: "DOWN" }),
    }).find((x) => x.name === "Trend")!;
    expect(fail.pass).toBe(false);
  });

  test("no trend read → unavailable, never a fabricated pass", () => {
    const t = evaluateConfirmations({ direction: "CALL", trendRead: null })
      .find((x) => x.name === "Trend")!;
    expect(t.available).toBe(false);
    expect(t.pass).toBe(false);
  });
});

describe("no trigger check — the confirmations are READ-ONLY context", () => {
  // The Simple tab issues no trade action, so there is no trigger check and
  // no trigger gate. A regression that reintroduces either would silently
  // re-arm a trade path on a tab that is meant to be display-only.
  test("evaluateConfirmations emits no 'Trigger' check", () => {
    const names = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({}),
      rvol: 1.4,
      pcr: 1.1,
      vsVwap: "ABOVE",
    }).map((c) => c.name);
    expect(names).not.toContain("Trigger");
    expect(names).toContain("Trend");
    expect(names).toContain("VWAP");
  });

  test("the module exports no trade gate", async () => {
    const mod = await import("@/lib/signal-persistence");
    expect((mod as Record<string, unknown>).confirmTradeGate).toBeUndefined();
  });
});

describe("Volume check — real RVOL, unavailable when candles have no volume", () => {
  test("real RVOL 1.5 → pass; 0.8 → fail", () => {
    expect(evaluateConfirmations({ direction: "CALL", rvol: 1.5 })
      .find((x) => x.name === "Volume")!.pass).toBe(true);
    expect(evaluateConfirmations({ direction: "CALL", rvol: 0.8 })
      .find((x) => x.name === "Volume")!.pass).toBe(false);
  });

  test("null RVOL (index spot candles have no volume) → unavailable, NOT the old always-5.0x pass", () => {
    const v = evaluateConfirmations({ direction: "CALL", rvol: null })
      .find((x) => x.name === "Volume")!;
    expect(v.available).toBe(false);
    expect(v.pass).toBe(false);
    expect(v.detail).not.toMatch(/RVOL/);
  });
});

describe("VWAP check — real vsVwap; NA (no volume) is unavailable", () => {
  test("CALL with price ABOVE VWAP → pass", () => {
    const v = evaluateConfirmations({ direction: "CALL", vsVwap: "ABOVE" })
      .find((x) => x.name === "VWAP")!;
    expect(v.available).toBe(true);
    expect(v.pass).toBe(true);
  });

  test("CALL with price BELOW VWAP → fail", () => {
    const v = evaluateConfirmations({ direction: "CALL", vsVwap: "BELOW" })
      .find((x) => x.name === "VWAP")!;
    expect(v.pass).toBe(false);
  });

  test("vsVwap 'NA' → unavailable, never counted", () => {
    const v = evaluateConfirmations({ direction: "CALL", vsVwap: "NA" })
      .find((x) => x.name === "VWAP")!;
    expect(v.available).toBe(false);
    expect(v.pass).toBe(false);
  });
});

describe("OI / PCR check — real PCR, unchanged thresholds", () => {
  test("CALL with PCR 1.2 → pass; PCR 0.85 → fail", () => {
    expect(evaluateConfirmations({ direction: "CALL", pcr: 1.2 })
      .find((x) => x.name === "OI / PCR")!.pass).toBe(true);
    expect(evaluateConfirmations({ direction: "CALL", pcr: 0.85 })
      .find((x) => x.name === "OI / PCR")!.pass).toBe(false);
  });

  test("PUT with PCR 0.85 → pass", () => {
    expect(evaluateConfirmations({ direction: "PUT", pcr: 0.85 })
      .find((x) => x.name === "OI / PCR")!.pass).toBe(true);
  });

  test("null PCR → unavailable", () => {
    const p = evaluateConfirmations({ direction: "CALL", pcr: null })
      .find((x) => x.name === "OI / PCR")!;
    expect(p.available).toBe(false);
    expect(p.pass).toBe(false);
  });
});

describe("the context reads never gate a trade", () => {
  // The old confirmTradeGate turned these reads into a BUY/WAIT verdict.
  // It is gone: the confirmations report, they do not decide.
  test("every check is a plain read — no verdict field anywhere", () => {
    const checks = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({}),
      rvol: 1.4,
      pcr: 1.1,
      vsVwap: "ABOVE",
    });
    for (const c of checks) {
      expect(Object.keys(c).sort()).toEqual(["available", "detail", "name", "pass"]);
    }
  });
});

describe("ADX check — real trend strength + DI direction (6th check)", () => {
  test("CALL with ADX 24 and +DI > −DI → pass", () => {
    const c = evaluateConfirmations({
      direction: "CALL",
      adxRead: { adx: 24.3, pdi: 28.1, mdi: 19.2 },
    }).find((x) => x.name === "ADX")!;
    expect(c.available).toBe(true);
    expect(c.pass).toBe(true);
    expect(c.detail).toContain("24.3");
  });

  test("DI against the direction → fail even with strong ADX", () => {
    const c = evaluateConfirmations({
      direction: "CALL",
      adxRead: { adx: 30, pdi: 18, mdi: 27 },
    }).find((x) => x.name === "ADX")!;
    expect(c.pass).toBe(false);
  });

  test("ADX < 20 (chop/ranging) → fail even when DI agrees", () => {
    const c = evaluateConfirmations({
      direction: "PUT",
      adxRead: { adx: 15, pdi: 18, mdi: 27 },
    }).find((x) => x.name === "ADX")!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain("weak");
  });

  test("no ADX read → unavailable", () => {
    const c = evaluateConfirmations({ direction: "CALL", adxRead: null })
      .find((x) => x.name === "ADX")!;
    expect(c.available).toBe(false);
    expect(c.pass).toBe(false);
  });
});

describe("Delta check — real |delta| vs the gate's minAbsDelta (0.35)", () => {
  test("CALL leg with |delta| 0.52 → pass", () => {
    const c = evaluateConfirmations({
      direction: "CALL",
      greeksRead: { delta: 0.52, theta: -12, gamma: 0.004, vega: 18, iv: 11.5, premium: 188 },
    }).find((x) => x.name === "Delta")!;
    expect(c.available).toBe(true);
    expect(c.pass).toBe(true);
    expect(c.detail).toContain("0.52");
  });

  test("|delta| 0.20 = lottery ticket → fail", () => {
    const c = evaluateConfirmations({
      direction: "CALL",
      greeksRead: { delta: 0.20, theta: -5, gamma: 0.002, vega: 9, iv: 10, premium: 48 },
    }).find((x) => x.name === "Delta")!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain("lottery");
  });

  test("PUT leg uses |delta| (negative sign is fine)", () => {
    const c = evaluateConfirmations({
      direction: "PUT",
      greeksRead: { delta: -0.48, theta: -10, gamma: 0.003, vega: 15, iv: 12, premium: 260 },
    }).find((x) => x.name === "Delta")!;
    expect(c.pass).toBe(true);
  });

  test("no greeks read → unavailable", () => {
    const c = evaluateConfirmations({ direction: "CALL", greeksRead: null })
      .find((x) => x.name === "Delta")!;
    expect(c.available).toBe(false);
    expect(c.pass).toBe(false);
  });
});

describe("confirmSummary — unavailable checks never pad the ratio", () => {
  test("4 checks with 2 unavailable → pass/total counts only available", () => {
    const checks = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({}),
      rvol: null,        // no volume on index spot candles
      vsVwap: "NA",      // no volume → no VWAP side
      pcr: 1.2,
    });
    const s = confirmSummary(checks);
    expect(s.total).toBe(2);      // trend + pcr only (volume/vwap unavailable)
    expect(s.pass).toBe(2);
    expect(s.pct).toBe(100);
  });

  test("ADX counts when available", () => {
    const checks = evaluateConfirmations({
      direction: "CALL",
      trendRead: trend({}),
      pcr: 1.2,
      adxRead: { adx: 24, pdi: 28, mdi: 19 },
    });
    const s = confirmSummary(checks);
    expect(s.total).toBe(3);      // trend, pcr, adx (volume/vwap unavailable)
    expect(s.pass).toBe(3);
  });
});
