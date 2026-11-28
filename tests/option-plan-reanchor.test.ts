// Regression guards for the frozen trade-plan ladder.
//
// The ladder is anchored to the STRIKE, not to the price. When the live
// premium drifts materially from the frozen entry (routine on a 0DTE), the
// card must RE-ANCHOR: entry / SL / TP / lots / rupee risk all have to follow
// the market, otherwise the card prints an entry 10% away from the live
// price, a risk that is not the real risk, and a lot count that deploys over
// the budget when filled at the live premium.

import { describe, expect, test } from "bun:test";
import {
  describeStrike,
  shouldReanchorPlan,
  selectStrike,
  PLAN_CONFIG,
} from "@/lib/option-plan";

describe("shouldReanchorPlan", () => {
  test("no live premium for the frozen strike — keep the ladder, never invent", () => {
    const r = shouldReanchorPlan({
      frozenEntry: 201.65,
      livePremium: null,
      lots: 11,
      lotSize: 20,
    });
    expect(r.reanchor).toBe(false);
    expect(r.reason).toContain("no live premium");
  });

  test("live premium inside the drift band — keep the ladder (no jitter)", () => {
    const r = shouldReanchorPlan({
      frozenEntry: 200,
      livePremium: 204, // 2% — inside the 5% band
      lots: 11,
      lotSize: 20,
    });
    expect(r.reanchor).toBe(false);
  });

  test("live premium materially away — re-anchor the ladder", () => {
    const r = shouldReanchorPlan({
      frozenEntry: 201.65,
      livePremium: 224.35, // +11.3% — the SENSEX 0DTE case
      lots: 11,
      lotSize: 20,
    });
    expect(r.reanchor).toBe(true);
    expect(r.reason).toContain("%");
  });

  test("the band is the configured one", () => {
    expect(PLAN_CONFIG.reanchorPremiumDriftPct).toBe(0.05);
    const just = shouldReanchorPlan({
      frozenEntry: 100,
      livePremium: 104.9,
      lots: 1,
      lotSize: 1,
    });
    const over = shouldReanchorPlan({
      frozenEntry: 100,
      livePremium: 105.1,
      lots: 1,
      lotSize: 1,
    });
    expect(just.reanchor).toBe(false);
    expect(over.reanchor).toBe(true);
  });

  test("a DOWN move re-anchors too — the PE side is the same contract", () => {
    const r = shouldReanchorPlan({
      frozenEntry: 204.3,
      livePremium: 177.5, // -13%
      lots: 11,
      lotSize: 20,
    });
    expect(r.reanchor).toBe(true);
  });

  test("garbage inputs never re-anchor", () => {
    expect(
      shouldReanchorPlan({ frozenEntry: 0, livePremium: 100, lots: 1, lotSize: 20 }).reanchor,
    ).toBe(false);
    expect(
      shouldReanchorPlan({ frozenEntry: 100, livePremium: 0, lots: 1, lotSize: 20 }).reanchor,
    ).toBe(false);
    expect(
      shouldReanchorPlan({ frozenEntry: 100, livePremium: NaN, lots: 1, lotSize: 20 }).reanchor,
    ).toBe(false);
    expect(
      shouldReanchorPlan({ frozenEntry: 100, livePremium: 100, lots: 1, lotSize: 0 }).reanchor,
    ).toBe(false);
  });
});

describe("describeStrike", () => {
  test("ATM line carries delta, source and the live 1-lot cost", () => {
    const s = describeStrike({
      entry: 201.65,
      delta: 0.47,
      deltaSource: "bs",
      otmSteps: 0,
      lotSize: 20,
    });
    expect(s).toContain("ATM");
    expect(s).toContain("|delta| 0.47");
    expect(s).toContain("(BS)");
    expect(s).toContain("4,033"); // 201.65 × 20
  });

  test("OTM line names the step count", () => {
    const s = describeStrike({
      entry: 100,
      delta: 0.3,
      deltaSource: "provider",
      otmSteps: 2,
      lotSize: 50,
    });
    expect(s).toContain("2 steps OTM");
    expect(s).not.toContain("(BS)");
  });

  test("no delta — the honest reason, never a fabricated number", () => {
    const s = describeStrike({
      entry: 100,
      delta: null,
      deltaSource: null,
      otmSteps: 0,
      lotSize: 50,
    });
    expect(s).toContain("delta unavailable");
    expect(s).not.toContain("|delta|");
  });

  test("selectStrike's reason matches describeStrike (one format, no drift)", () => {
    const chain = [
      {
        strike: 84000,
        ce: { ltp: 200, oi: 100, iv: 12, delta: 0.5, deltaSource: "bs" },
        pe: { ltp: 100, oi: 100, iv: 12, delta: -0.5, deltaSource: "bs" },
      },
    ];
    const sel = selectStrike({ chain: chain as any, direction: "CALL", spot: 84000, lotSize: 20 });
    expect(sel).toBeTruthy();
    expect(sel!.reason).toBe(
      describeStrike({
        entry: sel!.entry,
        delta: sel!.delta,
        deltaSource: sel!.deltaSource,
        otmSteps: sel!.otmSteps,
        lotSize: 20,
      }),
    );
  });
});
