/// <reference types="bun-types" />
// The OI-WALL GEOMETRY — the wall's integrity decides whether a target is
// reachable.
//
// The 26-Nov-2026 SENSEX chain (spot 84,328):
//   call wall 84,500  OI 2.29 L  ΔOI +1,65,000  → being WRITTEN (defended)
//   put  wall 84,200  OI 2.47 L  ΔOI +2,37,000  → being WRITTEN (defended)
// The market was pinned inside a 300-point range with BOTH walls defended, so
// every target that needed a break through a wall was a trap.
//
// The rule: a wall whose OI is UNWINDING is being taken out — the break is
// live and the target IS reachable through it. A wall that is being WRITTEN
// is defended and blocks the target.

import { describe, expect, test } from "bun:test";
import { assessTargets } from "@/lib/option-plan";

// spot 100 — a thin call ladder above and a thin put ladder below, so the
// heavy row IS the wall (the wall floor is 2.5× the ladder's median OI).
const ladder = [
  { strike: 102, ce: { oi: 30_000, oiChange: 0 }, pe: null },
  { strike: 104, ce: { oi: 40_000, oiChange: 0 }, pe: null },
  { strike: 106, ce: { oi: 50_000, oiChange: 0 }, pe: null },
  { strike: 108, ce: { oi: 60_000, oiChange: 0 }, pe: null },
  { strike: 96, ce: null, pe: { oi: 30_000, oiChange: 0 } },
  { strike: 94, ce: null, pe: { oi: 40_000, oiChange: 0 } },
  { strike: 92, ce: null, pe: { oi: 50_000, oiChange: 0 } },
  { strike: 90, ce: null, pe: { oi: 60_000, oiChange: 0 } },
];

describe("assessTargets — wall integrity (OI walls are levels, ΔOI is the signal)", () => {
  test("a WRITTEN wall blocks the target (defended)", () => {
    const r = assessTargets({
      optionType: "CE",
      spot: 100,
      entry: 10,
      targets: [30], // needs spot 100 + 30/0.5 = 160 → through the 110 wall
      delta: 0.5,
      chain: [...ladder, { strike: 110, ce: { oi: 400_000, oiChange: 180_000 }, pe: null }],
    });
    expect(r[0].achievable).toBe(false);
    expect(r[0].wall?.oiChange).toBe(180_000);
    expect(r[0].note).toMatch(/defended/i);
  });

  test("an UNWINDING wall is being taken out — the break is live, the target is reachable", () => {
    const r = assessTargets({
      optionType: "CE",
      spot: 100,
      entry: 10,
      targets: [30],
      delta: 0.5,
      chain: [...ladder, { strike: 110, ce: { oi: 400_000, oiChange: -180_000 }, pe: null }],
    });
    expect(r[0].achievable).toBe(true);
    expect(r[0].wall?.oiChange).toBe(-180_000);
    expect(r[0].note).toMatch(/being taken out/i);
  });

  test("a FLAT wall is treated as defended (conservative — never assume it moves)", () => {
    const r = assessTargets({
      optionType: "CE",
      spot: 100,
      entry: 10,
      targets: [30],
      delta: 0.5,
      chain: [...ladder, { strike: 110, ce: { oi: 400_000, oiChange: 0 }, pe: null }],
    });
    expect(r[0].achievable).toBe(false);
    expect(r[0].note).toMatch(/defended/i);
  });

  test("a PE below spot is judged on the PUT ladder (mirror side)", () => {
    const r = assessTargets({
      optionType: "PE",
      spot: 100,
      entry: 10,
      targets: [30], // needs spot 100 - 30/0.5 = 40 → through the 90 wall
      delta: 0.5,
      chain: [...ladder, { strike: 88, ce: null, pe: { oi: 400_000, oiChange: -120_000 } }],
    });
    expect(r[0].wall?.side).toBe("put");
    expect(r[0].achievable).toBe(true);
  });

  test("no wall in the path → the target is reachable", () => {
    const r = assessTargets({
      optionType: "CE",
      spot: 100,
      entry: 10,
      targets: [6], // needs spot 112 → no heavy wall there
      delta: 0.5,
      chain: ladder,
    });
    expect(r[0].achievable).toBe(true);
    expect(r[0].note).toMatch(/no opposing OI wall/i);
  });
});
