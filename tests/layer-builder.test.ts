import { describe, test, expect } from "bun:test";
import { buildFlowLayer, buildGreeksVixLayer, buildLevelsLayer, buildStructureLayer, buildTriggerLayer, oiWallBeforeTarget } from "@/lib/layer-builder";

describe("layer builder — real layers, honest unknowns", () => {
  test("flow layer is unknown without a source, and never invents agreement", () => {
    const l = buildFlowLayer({});
    expect(l.state).toBe("unknown");
    expect(l.evidence).toMatch(/no FII/i);
  });

  test("flow layer reads the FII bias and the chain lean", () => {
    const l = buildFlowLayer({ flow: { fiiDii: { bias: "bullish", value: 1234 }, chainLean: "BULLISH_LEAN" } });
    expect(l.state).toBe("agree");
    expect(l.evidence).toMatch(/FII\/DII bullish/);
    expect(l.evidence).toMatch(/next-day bias only/);
  });

  test("greeks/VIX layer scores the VIX band, delta band and expiry", () => {
    const l = buildGreeksVixLayer({ vix: 14, delta: 0.52, daysToExpiry: 6, iv: 18 });
    expect(l.state).toBe("agree");
    expect(l.evidence).toMatch(/VIX 14.0 \(NORMAL\)/);
    expect(l.evidence).toMatch(/\|delta\| 0.52/);
    expect(l.evidence).toMatch(/6d to expiry/);
  });

  test("greeks/VIX layer is against when VIX is extreme or delta is a lottery", () => {
    expect(buildGreeksVixLayer({ vix: 34, delta: 0.2 }).state).toBe("against");
    expect(buildGreeksVixLayer({ vix: 14, delta: 0.2 }).state).toBe("against");
    // a plain tie is neutral, never agreement
    expect(buildGreeksVixLayer({ vix: 25, delta: 0.52 }).state).toBe("neutral");
  });

  test("structure/trigger layers are unknown without a candle read", () => {
    expect(buildStructureLayer({}).state).toBe("unknown");
    expect(buildTriggerLayer({}).state).toBe("unknown");
  });

  test("levels layer is unknown without a chain analysis", () => {
    expect(buildLevelsLayer({}).state).toBe("unknown");
  });

  test("oi wall before target needs a chain and a target", () => {
    expect(oiWallBeforeTarget({}, 100)).toBe(false);
  });
});
