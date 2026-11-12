/// <reference types="bun-types" />
// TDD for selectStrike (option-plan.ts) — deterministic strike selection for
// the SimpleMode BUY card.
//
// The card used to hardcode the ATM strike and never validate the contract:
// a lottery-ticket |delta| 0.20 CE or a contract whose one lot costs more
// than the per-trade budget would still be displayed as a BUY plan.
//
// The selector applies the REAL gate rules only (agent-brain-gate
// GATE_CONFIG — nothing invented):
//   • OTM ≤ maxOtmSteps (3) strikes from ATM, ATM or OTM side only
//   • |delta| ≥ minAbsDelta (0.35) when the provider publishes delta
//   • 1 lot must fit the ₹45,000 per-trade budget (else the contract is NOT
//     tradable — 0 lots is a real outcome, never sized up to 1)
//   • ltp > 0 required — no fabricated premium
//   • no delta anywhere → nearest tradable ATM..OTM leg, honestly labelled

import { describe, test, expect } from "bun:test";
import { selectStrike } from "@/lib/option-plan";

const LOT = 75; // NIFTY lot
const SPOT = 25200; // exactly on a strike → ATM unambiguous

function row(strike: number, ce?: { ltp?: number; delta?: number; oi?: number }, pe?: { ltp?: number; delta?: number; oi?: number }) {
  return {
    strike,
    ce: ce ? { ltp: ce.ltp ?? 0, delta: ce.delta ?? null, oi: ce.oi ?? 0 } : null,
    pe: pe ? { ltp: pe.ltp ?? 0, delta: pe.delta ?? null, oi: pe.oi ?? 0 } : null,
  };
}

const CHAIN = [
  row(24900, undefined, { ltp: 420, delta: -0.15 }),
  row(25000, undefined, { ltp: 350, delta: -0.25 }),
  row(25100, { ltp: 320, delta: 0.25 }, { ltp: 290, delta: -0.45 }),
  row(25200, { ltp: 300, delta: 0.20 }, { ltp: 260, delta: -0.40 }), // ATM
  row(25300, { ltp: 210, delta: 0.38 }, { ltp: 188, delta: -0.55 }),
  row(25400, { ltp: 140, delta: 0.30 }, { ltp: 130, delta: -0.65 }),
  row(25500, { ltp: 85, delta: 0.18 }, { ltp: 92, delta: -0.72 }),
  row(25600, { ltp: 48, delta: 0.10 }, { ltp: 60, delta: -0.78 }),
];

describe("selectStrike — CALL direction", () => {
  test("skips the ATM call below the delta band → first passing OTM strike", () => {
    const s = selectStrike({ chain: CHAIN, direction: "CALL", spot: SPOT, lotSize: LOT });
    expect(s).not.toBeNull();
    expect(s!.optionType).toBe("CE");
    expect(s!.strike).toBe(25300);       // ATM CE delta 0.20 < 0.35 → skipped; 25300 |delta| 0.38 passes
    expect(s!.entry).toBe(210);
    expect(s!.delta).toBeCloseTo(0.38);
  });

  test("never returns a strike beyond maxOtmSteps (3)", () => {
    const chain = [
      row(25200, { ltp: 300, delta: 0.10 }),
      row(25300, { ltp: 210, delta: 0.12 }),
      row(25400, { ltp: 140, delta: 0.14 }),
      row(25500, { ltp: 85, delta: 0.16 }),
      row(25600, { ltp: 48, delta: 0.36 }),  // would pass delta but 4 steps away
    ];
    const s = selectStrike({ chain, direction: "CALL", spot: SPOT, lotSize: LOT });
    expect(s).toBeNull();                 // all in-window strikes are lottery tickets
  });
});

describe("selectStrike — PUT direction", () => {
  test("picks the ATM put with |delta| in band", () => {
    const s = selectStrike({ chain: CHAIN, direction: "PUT", spot: SPOT, lotSize: LOT });
    expect(s!.optionType).toBe("PE");
    expect(s!.strike).toBe(25200);        // ATM PE |delta| 0.40 ≥ 0.35
    expect(s!.entry).toBe(260);
  });

  test("walks DOWN the OTM side for puts (strike below ATM)", () => {
    const chain = [
      row(24900, undefined, { ltp: 400, delta: -0.30 }),  // lottery
      row(25000, undefined, { ltp: 350, delta: -0.45 }),  // passes, 1 listed row below ATM
      row(25200, undefined, { ltp: 260, delta: -0.20 }),  // ATM, lottery
      row(25300, undefined, { ltp: 188, delta: -0.55 }),  // ITM side — never walked
    ];
    const s = selectStrike({ chain, direction: "PUT", spot: SPOT, lotSize: LOT });
    expect(s!.strike).toBe(25000);
    expect(s!.otmSteps).toBe(1);
  });
});

describe("selectStrike — budget gate (0 lots is a real outcome)", () => {
  test("a contract whose 1 lot exceeds the budget is skipped, never sized up", () => {
    const chain = [
      row(25200, { ltp: 650, delta: 0.45 }),              // 650×75 = ₹48.75k — OVER the ₹45k cap
      row(25300, { ltp: 210, delta: 0.38 }),              // 210×75 = ₹15.75k — fits
    ];
    const s = selectStrike({ chain, direction: "CALL", spot: SPOT, lotSize: LOT });
    expect(s!.strike).toBe(25300);        // expensive ATM skipped, affordable OTM taken
  });

  test("every tradable-looking leg over budget → null with the reason", () => {
    const chain = [row(25200, { ltp: 900, delta: 0.50 })];  // 900×75 = ₹67.5k
    const s = selectStrike({ chain, direction: "CALL", spot: SPOT, lotSize: LOT });
    expect(s).toBeNull();
  });
});

describe("selectStrike — no fabricated contracts", () => {
  test("zero/missing premium legs are skipped", () => {
    const chain = [
      row(25200, { ltp: 0, delta: 0.50 }),          // no real premium
      row(25300, { ltp: 210, delta: 0.38 }),
    ];
    const s = selectStrike({ chain, direction: "CALL", spot: SPOT, lotSize: LOT });
    expect(s!.strike).toBe(25300);
  });

  test("no delta anywhere → nearest tradable ATM leg, honestly labelled", () => {
    const chain = [
      row(25200, { ltp: 300 }),
      row(25300, { ltp: 210 }),
      row(25400, { ltp: 140 }),
    ];
    const s = selectStrike({ chain, direction: "CALL", spot: SPOT, lotSize: LOT });
    expect(s!.strike).toBe(25200);
    expect(s!.delta).toBeNull();
    expect(s!.reason.toLowerCase()).toContain("delta unavailable");
  });

  test("empty chain / no spot → null", () => {
    expect(selectStrike({ chain: [], direction: "CALL", spot: SPOT, lotSize: LOT })).toBeNull();
    expect(selectStrike({ chain: CHAIN, direction: "CALL", spot: 0, lotSize: LOT })).toBeNull();
    expect(selectStrike({ chain: CHAIN, direction: "CALL", spot: SPOT, lotSize: 0 })).toBeNull();
  });
});

describe("selectStrike — otmSteps reporting", () => {
  test("ATM reports 0 steps; OTM reports the step count", () => {
    const s1 = selectStrike({
      chain: [row(25200, { ltp: 300, delta: 0.40 }), row(25300, { ltp: 210, delta: 0.38 })],
      direction: "CALL", spot: SPOT, lotSize: LOT,
    });
    expect(s1!.otmSteps).toBe(0);
    expect(s1!.isAtm).toBe(true);

    const s2 = selectStrike({
      chain: [row(25200, { ltp: 300, delta: 0.10 }), row(25300, { ltp: 210, delta: 0.45 })],
      direction: "CALL", spot: SPOT, lotSize: LOT,
    });
    expect(s2!.otmSteps).toBe(1);
    expect(s2!.isAtm).toBe(false);
  });
});
