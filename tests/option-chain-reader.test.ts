import { describe, test, expect } from "bun:test";
import {
  normalizeChain, classify, analyze, recordSnapshot, baselineSnap, fillChanges,
  layerForDirection, wallBeforeTarget, greekCheck, formatChainAnalysis,
  OPTION_CHAIN_TOOL, CHAIN_CFG,
} from "@/lib/option-chain-reader";
import type { Leg, NormChain } from "@/lib/option-chain-reader";

const leg = (over: Partial<Leg> = {}): Leg => ({ oi: 100000, oiChange: 0, ltp: 100, ltpChange: 0, volume: 5000, iv: 14, delta: 0.5, ...over });

const chain = (over: Partial<NormChain> = {}): NormChain => ({
  symbol: "NIFTY", spot: 24500, derivedChange: false,
  rows: [
    { strike: 24400, ce: leg({ oi: 40000 }), pe: leg({ oi: 300000, oiChange: 30000, ltpChange: -2 }) },
    { strike: 24500, ce: leg({ oi: 200000 }), pe: leg({ oi: 200000, oiChange: -15000, ltpChange: -3 }) },
    { strike: 24600, ce: leg({ oi: 350000, oiChange: 40000, ltpChange: -4 }), pe: leg({ oi: 50000 }) },
    { strike: 24700, ce: leg({ oi: 150000 }), pe: leg({ oi: 20000 }) },
  ],
  pcr: 1.05, maxPain: 24600, atm: 24500, vix: 13.5, asOf: new Date().toISOString(),
  ...over,
});

describe("normalizeChain", () => {
  test("accepts repo /api/option-chain payload shape", () => {
    const j = {
      data: {
        symbol: "NIFTY", spotPrice: 24500,
        strikes: [
          { strike: 24500, ce: { oi: 100, ltp: 150 }, pe: { oi: 120, ltp: 100 } },
        ],
        summary: { pcr: 1.2, maxPain: 24600, atmStrike: 24500, indiaVIX: 13.1 },
      },
    };
    const c = normalizeChain(j, "NIFTY");
    expect(c?.spot).toBe(24500);
    expect(c?.pcr).toBe(1.2);
    expect(c?.rows[0].ce.oi).toBe(100);
  });
  test("tolerates NSE-style field aliases", () => {
    const j = { data: { underlyingValue: 24500, strikes: [{ strike: 24500, ce: { openInterest: 10, changeInOI: 5, lastPrice: 20, change: 1, totalTradedVolume: 7, impliedVolatility: 12 }, pe: { openInterest: 11 } }] } };
    const c = normalizeChain(j, "NIFTY");
    expect(c?.spot).toBe(24500);
    expect(c?.rows[0].ce.oiChange).toBe(5);
    expect(c?.rows[0].ce.volume).toBe(7);
  });
  test("derives PCR when summary omits it; null on empty payload", () => {
    const c = normalizeChain({ data: { spotPrice: 100, strikes: [{ strike: 100, ce: { oi: 50 }, pe: { oi: 100 } }] } }, "NIFTY");
    expect(c?.pcr).toBe(2);
    expect(normalizeChain({ data: { strikes: [] } }, "NIFTY")).toBeNull();
  });
});

describe("classify — inference table", () => {
  const max = 200000;
  test("OI↑ premium↑ = BUYING; OI↑ premium↓ = WRITING", () => {
    expect(classify(leg({ oiChange: 20000, ltpChange: 2 }), max)).toBe("BUYING");
    expect(classify(leg({ oiChange: 20000, ltpChange: -2 }), max)).toBe("WRITING");
  });
  test("OI↓ premium↑ = SHORT_COVERING; OI↓ premium↓ = LONG_UNWINDING", () => {
    expect(classify(leg({ oiChange: -20000, ltpChange: 2 }), max)).toBe("SHORT_COVERING");
    expect(classify(leg({ oiChange: -20000, ltpChange: -2 }), max)).toBe("LONG_UNWINDING");
  });
  test("illiquid / immaterial / no-change = QUIET", () => {
    expect(classify(leg({ oi: 1000, oiChange: 200, ltpChange: 2 }), max)).toBe("QUIET"); // < 10% of max
    expect(classify(leg({ oiChange: 100, ltpChange: 2 }), max)).toBe("QUIET");           // < 5% of OI
    expect(classify(leg({ oiChange: undefined, ltpChange: undefined }), max)).toBe("QUIET");
  });
});

describe("analyze", () => {
  test("walls from highest OI near spot; strengthening put wall below, call wall above", () => {
    const a = analyze(chain());
    expect(a.atm).toBe(24500);
    expect(a.supports[0].strike).toBe(24400);
    expect(a.supports[0].trend).toBe("STRENGTHENING");
    expect(a.resistances[0].strike).toBe(24600);
    expect(a.resistances[0].trend).toBe("STRENGTHENING");
  });
  test("fresh writing zones classified on the right side of spot", () => {
    const a = analyze(chain());
    expect(a.freshPutWriting.some((z) => z.strike === 24400 && z.activity === "WRITING")).toBe(true);
    expect(a.freshCallWriting.some((z) => z.strike === 24600 && z.activity === "WRITING")).toBe(true);
  });
  test("no change-in-OI anywhere → bias UNKNOWN", () => {
    const a = analyze(chain({ rows: chain().rows.map((r) => ({ ...r, ce: { ...r.ce, oiChange: undefined }, pe: { ...r.pe, oiChange: undefined } })) }));
    expect(a.bias).toBe("UNKNOWN");
  });
  test("call writers covering + weakening call wall → bullish lean", () => {
    const c = chain({
      rows: [
        { strike: 24400, ce: leg({ oi: 40000 }), pe: leg({ oi: 300000, oiChange: 5000, ltpChange: 1 }) },
        { strike: 24500, ce: leg({ oi: 200000 }), pe: leg({ oi: 200000 }) },
        { strike: 24600, ce: leg({ oi: 350000, oiChange: -40000, ltpChange: 5, volume: 90000 }), pe: leg({ oi: 50000 }) },
      ],
    });
    const a = analyze(c);
    expect(a.bias).toBe("BULLISH_LEAN");
    expect(a.evidence.join(" ")).toMatch(/writers covering|weakening/i);
  });
});

describe("snapshots + fillChanges", () => {
  test("derives ΔOI/ΔLTP from prior snapshot when API gives none", () => {
    const sym = `TEST${Date.now() % 100000}`;
    const t0 = Date.now() - 20 * 60_000;
    const c0 = chain({ symbol: sym });
    for (const r of c0.rows) { r.ce.oiChange = undefined; r.pe.oiChange = undefined; }
    recordSnapshot(c0, t0);
    const c1 = chain({ symbol: sym });
    for (const r of c1.rows) { r.ce.oiChange = undefined; r.pe.oiChange = undefined; }
    const base = baselineSnap(sym, 20);
    expect(base).toBeTruthy();
    fillChanges(c1, base!);
    expect(c1.derivedChange).toBe(true);
    // 24600 CE grew 350k-100k? baseline was same values... chain() has same OI in both snaps → Δ0.
    // Bump the second snapshot's OI before fill:
    const c2 = chain({ symbol: sym });
    for (const r of c2.rows) { r.ce.oiChange = undefined; r.pe.oiChange = undefined; }
    if (c2.rows[2]) c2.rows[2].ce.oi = 390000; // +40k vs baseline 350k
    recordSnapshot(c2, Date.now());
    const c3 = chain({ symbol: sym });
    for (const r of c3.rows) { r.ce.oiChange = undefined; r.pe.oiChange = undefined; }
    if (c3.rows[2]) c3.rows[2].ce.oi = 390000;
    fillChanges(c3, baselineSnap(sym, 20)!);
    expect(c3.rows[2].ce.oiChange).toBe(40000);
  });
});

describe("gate integration", () => {
  test("layerForDirection: bullish lean + call = agree; pressed against strengthening wall = against", () => {
    const bull = analyze(chain({
      rows: [
    { strike: 24400, ce: leg({ oi: 40000 }), pe: leg({ oi: 300000, oiChange: 30000, ltpChange: -2 }) },
        { strike: 24500, ce: leg({ oi: 200000 }), pe: leg({ oi: 200000 }) },
        { strike: 24600, ce: leg({ oi: 350000, oiChange: -50000, ltpChange: 6, volume: 90000 }), pe: leg({ oi: 50000 }) },
      ],
    }));
    expect(layerForDirection(bull, "call").state).toBe("agree");

    const pressed = chain({ spot: 24595, rows: chain().rows });
    // 24600 call wall is 0.02% above spot and strengthening → pressed → against for calls
    const a = analyze(pressed);
    const layer = layerForDirection(a, "call");
    expect(layer.state).toBe("against");
    expect(layer.evidence).toMatch(/pressed against/i);
  });
  test("wallBeforeTarget finds a major non-weakening wall between spot and target", () => {
    const a = analyze(chain());
    // call target 24650: 24600 wall (share 350/350=100%, strengthening) sits before it
    expect(wallBeforeTarget(a, "call", 24650)?.strike).toBe(24600);
    // call target 24550: no wall between 24500 and 24550
    expect(wallBeforeTarget(a, "call", 24550)).toBeUndefined();
  });
});

describe("greekCheck + format + tool def", () => {
  test("flags lottery delta, sweet spot, expiry-day", () => {
    expect(greekCheck(leg({ delta: 0.2 }), 5).join(" ")).toMatch(/lottery/);
    expect(greekCheck(leg({ delta: 0.55 }), 5).join(" ")).toMatch(/sweet spot|✓/);
    expect(greekCheck(leg({ delta: 0.55 }), 0).join(" ")).toMatch(/expiry day/);
  });
  test("formatChainAnalysis includes walls, honest limits, no-signal reminder", () => {
    const text = formatChainAnalysis(analyze(chain()), 5);
    expect(text).toMatch(/SUPPORT/);
    expect(text).toMatch(/RESISTANCE/);
    expect(text).toMatch(/HONEST LIMITS/);
    expect(text).toMatch(/evaluate_trade_gate/);
    expect(text).not.toMatch(/🎯/);
  });
  test("tool definition is well-formed", () => {
    expect(OPTION_CHAIN_TOOL.function.name).toBe("read_option_chain");
    expect(OPTION_CHAIN_TOOL.function.parameters.properties.symbol).toBeTruthy();
    expect(CHAIN_CFG.windowPct).toBe(5);
  });
});

describe("derived ΔOI from a baseline snapshot", () => {
  test("fillChanges derives oiChange/ltpChange when the API has none", () => {
    const chain = {
      symbol: "NIFTY", spot: 22600, derivedChange: false,
      rows: [{ strike: 22600, ce: { oi: 1200, ltp: 100 }, pe: { oi: 900, ltp: 90 } }],
    } as any;
    const base = {
      at: Date.now(),
      m: new Map([[22600, { ceOi: 1000, peOi: 1000, ceLtp: 95, peLtp: 88 }]]),
    } as any;
    fillChanges(chain, base);
    expect(chain.derivedChange).toBe(true);
    expect(chain.rows[0].ce.oiChange).toBe(200);
    expect(chain.rows[0].pe.oiChange).toBe(-100);
    expect(chain.rows[0].ce.ltpChange).toBe(5);
    expect(chain.rows[0].pe.ltpChange).toBe(2);
  });

  test("API-provided changes are never overwritten", () => {
    const chain = {
      symbol: "NIFTY", spot: 22600, derivedChange: false,
      rows: [{ strike: 22600, ce: { oi: 1200, oiChange: 999, ltp: 100 }, pe: { oi: 900 } }],
    } as any;
    fillChanges(chain, { at: Date.now(), m: new Map([[22600, { ceOi: 1000, peOi: 1000, ceLtp: 95, peLtp: 88 }]]) } as any);
    expect(chain.rows[0].ce.oiChange).toBe(999);
    expect(chain.derivedChange).toBe(false);
  });
});
