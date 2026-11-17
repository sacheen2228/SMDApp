/// <reference types="bun-types" />
// Canonical chain greeks — the "delta unavailable" fix (2026-11-17).
//
// The engine-path normalizer used to map only ltp/oi/oiChg/volume/iv/bid/ask
// and silently DROP delta/gamma/theta/vega that NSE publishes and Breeze
// computes from IV — so selectStrike saw no delta anywhere, labelled the plan
// "delta unavailable" and assessTargets fell back to a 0.50 estimate.
// It also emitted `oiChg` while ChainLegLike/assessTargets read `oiChange`,
// so every wall note said "flat" regardless of the real ΔOI.
//
// Contract under test: mapEngineStrikes() — the single mapper the canonical
// getOptionChain() engine path uses.

import { describe, test, expect } from "bun:test";
import { mapEngineStrikes } from "@/lib/data-layer/chains/option-chain";
import { calculateGreeks } from "@/lib/greeks";
import { selectStrike, assessTargets } from "@/lib/option-plan";

const SPOT = 25460;
const STRIKE = 25450;
const EXPIRY = "2026-11-20"; // ISO, a few days out

function providerLeg() {
  return {
    ltp: 120, oi: 500_000, oiChg: 120_000, volume: 90_000,
    iv: 14.5, delta: 0.54, gamma: 0.0012, theta: -12.5, vega: 6.1,
  };
}

function zeroGreeksLeg() {
  // What a provider that ships IV but no greeks looks like after the
  // market-data layer's `Number(x) || 0` mapping.
  return { ltp: 120, oi: 500_000, oiChg: 120_000, volume: 90_000, iv: 14.5, delta: 0, gamma: 0, theta: 0, vega: 0 };
}

function bareLeg() {
  return { ltp: 120, oi: 500_000, oiChg: 120_000, volume: 90_000, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
}

describe("mapEngineStrikes — greeks survive the canonical normalizer", () => {
  test("provider greeks pass through; oiChange AND oiChg are both emitted", () => {
    const [row] = mapEngineStrikesOrDie([{ strike: STRIKE, ce: providerLeg(), pe: null }], SPOT, EXPIRY);
    const ce: any = row.ce!;
    expect(ce.delta).toBe(0.54);
    expect(ce.gamma).toBe(0.0012);
    expect(ce.theta).toBe(-12.5);
    expect(ce.vega).toBe(6.1);
    expect(ce.deltaSource).toBe("provider");
    // both field names — OptionLeg.oiChange is the type, oiChg is what
    // legacy consumers (DailyDerivatives top-OI, providers) read.
    expect(ce.oiChange).toBe(120_000);
    expect(ce.oiChg).toBe(120_000);
  });

  test("all-zero greeks with live IV → Black-Scholes delta, labelled 'bs'", () => {
    const [row] = mapEngineStrikesOrDie([{ strike: STRIKE, ce: zeroGreeksLeg(), pe: null }], SPOT, EXPIRY);
    const ce: any = row.ce!;
    // The REAL BS delta for these inputs — computed independently here.
    const days = (Date.parse(`${EXPIRY}T15:30:00+05:30`) - Date.now()) / 86_400_000;
    const T = Math.max(days / 365, 0.002);
    const expected = calculateGreeks(SPOT, STRIKE, T, 14.5 / 100, true).delta;
    expect(ce.deltaSource).toBe("bs");
    expect(ce.delta).toBeCloseTo(expected, 6);
    expect(ce.delta).toBeGreaterThan(0.4); // near-the-money → not a degenerate 0
    expect(ce.delta).toBeLessThan(0.7);
    expect(ce.gamma).toBeGreaterThan(0);
  });

  test("no IV and no greeks → delta honestly null (never 0 pretending to be real)", () => {
    const [row] = mapEngineStrikesOrDie([{ strike: STRIKE, ce: bareLeg(), pe: null }], SPOT, EXPIRY);
    const ce: any = row.ce!;
    expect(ce.delta).toBeNull();
    expect(ce.deltaSource).toBeNull();
  });

  test("non-finite strikes are dropped, numeric strings coerced", () => {
    const rows = mapEngineStrikesOrDie(
      [{ strike: "25450", ce: providerLeg(), pe: null }, { strike: null, ce: null, pe: null }],
      SPOT, EXPIRY,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].strike).toBe(25450);
  });
});

describe("selectStrike — honest delta labels", () => {
  const spot = 100;
  const lot = 65;

  test("provider delta → plain |delta| label", () => {
    const sel = selectStrike({
      chain: [{ strike: 100, ce: { ltp: 2.5, delta: 0.55, deltaSource: "provider", oi: 1000, oiChange: 100, iv: 14 } }],
      direction: "CALL", spot, lotSize: lot,
    })!;
    expect(sel).not.toBeNull();
    expect(sel.delta).toBe(0.55);
    expect(sel.reason).toMatch(/\|delta\| 0\.55/);
    expect(sel.reason).not.toMatch(/BS/);
    expect(sel.reason).not.toMatch(/unavailable/);
  });

  test("BS-derived delta → labelled '(BS)', never 'delta unavailable'", () => {
    const sel = selectStrike({
      chain: [{ strike: 100, ce: { ltp: 2.5, delta: 0.48, deltaSource: "bs", oi: 1000, oiChange: 100, iv: 14 } }],
      direction: "CALL", spot, lotSize: lot,
    })!;
    expect(sel).not.toBeNull();
    expect(sel.delta).toBe(0.48);
    expect(sel.reason).toMatch(/\|delta\| 0\.48 \(BS\)/);
    expect(sel.reason).not.toMatch(/unavailable/);
  });

  test("no delta anywhere → the honest 'delta unavailable' fallback stays", () => {
    const sel = selectStrike({
      chain: [{ strike: 100, ce: { ltp: 2.5, delta: null, deltaSource: null, oi: 1000, oiChange: 100, iv: 0 } }],
      direction: "CALL", spot, lotSize: lot,
    })!;
    expect(sel).not.toBeNull();
    expect(sel.delta).toBeNull();
    expect(sel.reason).toMatch(/delta unavailable/);
  });
});

describe("assessTargets — wall flow uses the real ΔOI (oiChange), not 'flat'", () => {
  test("a defended wall in the TP path shows writing, not 'flat'", () => {
    // A realistic ladder (several strikes) so the median-based wall floor
    // isn't defined by a 2-element sample.
    const chain = [
      { strike: 100, ce: { ltp: 2.5, delta: 0.5, oi: 1000, oiChange: 100, iv: 14 }, pe: { ltp: 2.4, delta: -0.5, oi: 900, oiChange: -50, iv: 14 } },
      { strike: 101, ce: { ltp: 2.0, delta: 0.42, oi: 2000, oiChange: 300, iv: 14 }, pe: null },
      { strike: 105, ce: { ltp: 1.2, delta: 0.28, oi: 3000, oiChange: -400, iv: 15 }, pe: null },
      // call wall ABOVE spot (the CE must rise past it) — freshly written
      { strike: 110, ce: { ltp: 0.8, delta: 0.15, oi: 50_000, oiChange: 800_000, iv: 15 }, pe: { ltp: 9, delta: -0.9, oi: 100, oiChange: 0, iv: 13 } },
      { strike: 115, ce: { ltp: 0.4, delta: 0.08, oi: 4000, oiChange: 100, iv: 16 }, pe: null },
    ];
    const reach = assessTargets({
      optionType: "CE", spot: 100, entry: 2.5,
      targets: [4.5, 6.5, 8.5], // 2R/3R/4R of a 1-pt risk → needs spot 104/108/112
      delta: 0.5, deltaEstimated: false, chain,
    });
    expect(reach.length).toBe(3);
    // TPs 1 and 2 end BEFORE the wall → achievable
    expect(reach[0].achievable).toBe(true);
    expect(reach[1].achievable).toBe(true);
    // TP3 needs spot 112 → must trade through the 110 wall
    const wallHit = reach[2];
    expect(wallHit.wall?.strike).toBe(110);
    expect(wallHit.achievable).toBe(false);
    expect(wallHit.note).toMatch(/\+8\.0L writing/i); // real flow, not "flat"
    expect(wallHit.note).not.toMatch(/flat/i);
  });
});

// mapEngineStrikesOrDie — tiny helper so a null result fails loudly at the
// call site instead of inside every assertion.
function mapEngineStrikesOrDie(raw: any[], spot: number, expiry: string | null) {
  const rows = mapEngineStrikes(raw, spot, expiry);
  if (!Array.isArray(rows)) throw new Error("mapEngineStrikes returned non-array");
  return rows;
}
