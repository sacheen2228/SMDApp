import { describe, test, expect } from "bun:test";
import { assessTargets, type ChainRowLike } from "@/lib/option-plan";

// CE ladder above spot 25000 — call OI flat ~1L with one 10L wall at 25050.
function ceChain(): ChainRowLike[] {
  const rows: ChainRowLike[] = [];
  for (let k = 24900; k <= 25200; k += 50) {
    rows.push({
      strike: k,
      ce: { ltp: 100, oi: k === 25050 ? 1_000_000 : 100_000, oiChange: k === 25050 ? 210_000 : 5_000 },
      pe: { ltp: 100, oi: 120_000, oiChange: 1_000 },
    });
  }
  return rows;
}

// PE ladder below spot 25000 — put support 9L at 24950, rest ~80k.
function peChain(): ChainRowLike[] {
  const rows: ChainRowLike[] = [];
  for (let k = 24800; k <= 25100; k += 50) {
    rows.push({
      strike: k,
      pe: { ltp: 100, oi: k === 24950 ? 900_000 : 80_000, oiChange: k === 24950 ? -50_000 : 2_000 },
      ce: { ltp: 100, oi: 100_000, oiChange: 1_000 },
    });
  }
  return rows;
}

describe("TP achievability vs OI (assessTargets)", () => {
  test("CE: a call wall in the path blocks only the TPs that need spot past it", () => {
    const reach = assessTargets({
      optionType: "CE", spot: 25000, entry: 100,
      targets: [110, 120, 130], delta: 0.5,
      chain: ceChain(),
    });
    expect(reach).toHaveLength(3);
    // delta 0.5 → +10 premium needs +20 spot, +20 → +40, +30 → +60
    expect(reach[0].requiredSpot).toBeCloseTo(25020, 5);
    expect(reach[1].requiredSpot).toBeCloseTo(25040, 5);
    expect(reach[2].requiredSpot).toBeCloseTo(25060, 5);
    expect(reach[0].achievable).toBe(true);    // 25020 stops short of the wall
    expect(reach[1].achievable).toBe(true);    // 25040 still short
    expect(reach[2].achievable).toBe(false);   // 25060 must break 25050
    expect(reach[2].wall?.strike).toBe(25050);
    expect(reach[2].note).toMatch(/call wall 25050/);
  });

  test("PE: put support in the path blocks only the TPs that need spot past it", () => {
    const reach = assessTargets({
      optionType: "PE", spot: 25000, entry: 100,
      targets: [110, 120, 130], delta: -0.5,
      chain: peChain(),
    });
    expect(reach[0].requiredSpot).toBeCloseTo(24980, 5);
    expect(reach[1].requiredSpot).toBeCloseTo(24960, 5);
    expect(reach[2].requiredSpot).toBeCloseTo(24940, 5);
    expect(reach[0].achievable).toBe(true);    // support at 24950 not yet needed
    expect(reach[1].achievable).toBe(true);
    expect(reach[2].achievable).toBe(false);   // 24940 must break the 24950 wall
    expect(reach[2].wall?.strike).toBe(24950);
    expect(reach[2].note).toMatch(/put wall 24950/);
  });

  test("no wall in the path → every TP is achievable", () => {
    const rows: ChainRowLike[] = [];
    for (let k = 24900; k <= 25200; k += 50) {
      rows.push({ strike: k, ce: { ltp: 100, oi: 100_000, oiChange: 0 } });
    }
    const reach = assessTargets({
      optionType: "CE", spot: 25000, entry: 100,
      targets: [110, 120], delta: 0.5, chain: rows,
    });
    expect(reach[0].achievable).toBe(true);
    expect(reach[1].achievable).toBe(true);
    expect(reach[0].wall).toBeUndefined();
  });

  test("fresh writing at the wall is called out (and unwinding too)", () => {
    const withWriting = assessTargets({
      optionType: "CE", spot: 25000, entry: 100,
      targets: [130], delta: 0.5, chain: ceChain(),
    });
    expect(withWriting[0].note).toMatch(/writing/);

    const withUnwind = assessTargets({
      optionType: "PE", spot: 25000, entry: 100,
      targets: [130], delta: -0.5, chain: peChain(),
    });
    expect(withUnwind[0].note).toMatch(/unwinding/);
  });

  test("delta null → labelled 0.50 estimate, still returns finite checks", () => {
    const reach = assessTargets({
      optionType: "CE", spot: 25000, entry: 100,
      targets: [110], delta: null, chain: ceChain(),
    });
    expect(reach).toHaveLength(1);
    expect(reach[0].requiredSpot).toBeCloseTo(25020, 5); // 10 / 0.50
    expect(reach[0].note ?? "").toMatch(/est/);
  });

  test("deltaEstimated flag labels an ATM-derived delta", () => {
    const reach = assessTargets({
      optionType: "CE", spot: 25000, entry: 100,
      targets: [110], delta: 0.44, deltaEstimated: true, chain: ceChain(),
    });
    expect(reach[0].note ?? "").toMatch(/est/);
    expect(reach[0].requiredSpot).toBeCloseTo(25000 + 10 / 0.44, 2); // rounded to tick grid
  });
});
