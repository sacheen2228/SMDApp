import { describe, test, expect } from "bun:test";
import {
  deriveStrikeRange,
  sliceStrikesAroundATM,
  aggregateStrikes,
  windowOiChange,
  formatLakhCrore,
  toggleExpiry,
  MAX_AGGREGATE_EXPIRIES,
  type OiStrikeRow,
  type ChainSnapshot,
} from "@/lib/oi-panel";

const row = (strike: number, ceOi = 0, ceChg = 0, peOi = 0, peChg = 0): OiStrikeRow => ({
  strike,
  ce: { oi: ceOi, oiChg: ceChg },
  pe: { oi: peOi, oiChg: peChg },
});

describe("deriveStrikeRange", () => {
  test("defaults to ATM ± 500 rounded to step", () => {
    expect(deriveStrikeRange(25030, 25050, 50)).toEqual({ min: 24550, max: 25550 });
  });
  test("rounds inward to the step grid", () => {
    // ATM 24987 with step 100 → bounds must land on the grid
    const r = deriveStrikeRange(24987, 25000, 100);
    expect(r.min % 100).toBe(0);
    expect(r.max % 100).toBe(0);
    expect(r.min).toBeLessThanOrEqual(25000);
    expect(r.max).toBeGreaterThanOrEqual(25000);
  });
  test("never returns an inverted range", () => {
    const r = deriveStrikeRange(100, 100, 50);
    expect(r.min).toBeLessThanOrEqual(r.max);
  });
});

describe("sliceStrikesAroundATM", () => {
  const strikes = [24700, 24800, 24900, 25000, 25100, 25200, 25300];
  test("'all' returns every strike", () => {
    expect(sliceStrikesAroundATM(strikes, 25000, "all")).toEqual(strikes);
  });
  test("n returns n strikes on each side of ATM plus ATM", () => {
    expect(sliceStrikesAroundATM(strikes, 25000, 2)).toEqual([24800, 24900, 25000, 25100, 25200]);
  });
  test("clamps when the chain is shorter than n", () => {
    expect(sliceStrikesAroundATM([25000, 25100], 25000, 10)).toEqual([25000, 25100]);
  });
  test("picks the nearest listed strike as ATM when exact match missing", () => {
    // 25040 → nearest listed is 25000; ±1 → 24900/25000/25100
    expect(sliceStrikesAroundATM(strikes, 25040, 1)).toEqual([24900, 25000, 25100]);
  });
});

describe("aggregateStrikes", () => {
  test("sums OI and oiChg across expiry payloads strike-by-strike", () => {
    const a = [row(25000, 100, 10, 200, -5), row(25100, 50, 0, 60, 6)];
    const b = [row(25000, 30, 7, 40, 3)];
    const out = aggregateStrikes([a, b]);
    expect(out).toHaveLength(2); // 25100 appears in only one payload but must survive
    const atm = out.find((r) => r.strike === 25000)!;
    expect(atm.ce!.oi).toBe(130);
    expect(atm.ce!.oiChg).toBe(17);
    expect(atm.pe!.oi).toBe(240);
    expect(atm.pe!.oiChg).toBe(-2);
    const other = out.find((r) => r.strike === 25100)!;
    expect(other.ce!.oi).toBe(50);
  });
  test("treats missing legs as zero instead of crashing", () => {
    const out = aggregateStrikes([[row(25000, 10, 1, 0, 0)], [{ strike: 25000, ce: null, pe: { oi: 5, oiChg: 2 } }]]);
    expect(out[0].ce!.oi).toBe(10);
    expect(out[0].pe!.oi).toBe(5);
    expect(out[0].pe!.oiChg).toBe(2);
  });
  test("returns [] for no inputs", () => {
    expect(aggregateStrikes([])).toEqual([]);
  });
});

describe("windowOiChange", () => {
  const snap = (iso: string, rows: OiStrikeRow[]): ChainSnapshot => ({
    timestamp: iso,
    rows: rows.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi ?? 0, peOi: r.pe?.oi ?? 0 })),
  });
  const history = [
    snap("2026-11-06T06:16:00.000Z", [row(25000, 100, 0, 200, 0)]),
    snap("2026-11-06T09:00:00.000Z", [row(25000, 150, 0, 180, 0)]),
    snap("2026-11-06T09:45:00.000Z", [row(25000, 175, 0, 160, 0)]),
  ];
  test("computes per-strike change from the snapshot nearest to (now - window)", () => {
    const now = Date.parse("2026-11-06T09:45:00.000Z");
    // 45-min window → baseline is the 09:00 snapshot (150/180)
    const out = windowOiChange(history, 45 * 60_000, now);
    expect(out).toHaveLength(1);
    expect(out[0].strike).toBe(25000);
    expect(out[0].ceChg).toBe(25); // 175 - 150
    expect(out[0].peChg).toBe(-20); // 160 - 180
  });
  test("window larger than history uses the oldest snapshot", () => {
    const now = Date.parse("2026-11-06T09:45:00.000Z");
    const out = windowOiChange(history, 24 * 60 * 60_000, now);
    expect(out[0].ceChg).toBe(75); // 175 - 100
    expect(out[0].peChg).toBe(-40); // 160 - 200
  });
  test("empty history returns []", () => {
    expect(windowOiChange([], 5 * 60_000, Date.now())).toEqual([]);
  });
  test("strikes present only in the latest snapshot are still reported", () => {
    const now = Date.parse("2026-11-06T09:45:00.000Z");
    const hist = [
      snap("2026-11-06T09:00:00.000Z", [row(25000, 10, 0, 10, 0)]),
      snap("2026-11-06T09:45:00.000Z", [row(25000, 20, 0, 10, 0), row(25100, 999, 0, 0, 0)]),
    ];
    const out = windowOiChange(hist, 45 * 60_000, now);
    const late = out.find((r) => r.strike === 25100)!;
    expect(late.ceChg).toBe(999); // baseline missing → treat as 0
  });
});

describe("formatLakhCrore", () => {
  test("formats thousands without suffix", () => {
    expect(formatLakhCrore(950)).toBe("950");
  });
  test("formats lakhs with 2 decimals", () => {
    expect(formatLakhCrore(2236000)).toBe("22.36 L");
  });
  test("formats crores", () => {
    expect(formatLakhCrore(34600000)).toBe("3.46 Cr");
  });
  test("keeps the sign for negatives", () => {
    expect(formatLakhCrore(-7508000)).toBe("-75.08 L");
  });
  test("zero is 0", () => {
    expect(formatLakhCrore(0)).toBe("0");
  });
});

describe("toggleExpiry", () => {
  test("adds a newly checked expiry", () => {
    expect(toggleExpiry(["09-Nov-2026"], "17-Nov-2026", true)).toEqual(["09-Nov-2026", "17-Nov-2026"]);
  });
  test("removes an unchecked expiry", () => {
    expect(toggleExpiry(["09-Nov-2026", "17-Nov-2026"], "09-Nov-2026", false)).toEqual(["17-Nov-2026"]);
  });
  test("enforces the cap of 3 — refuses a 4th", () => {
    const three = ["a", "b", "c"];
    expect(toggleExpiry(three, "d", true)).toEqual(three);
  });
  test("cap constant is 3", () => {
    expect(MAX_AGGREGATE_EXPIRIES).toBe(3);
  });
  test("idempotent when toggling an already-on expiry off then on", () => {
    const on = toggleExpiry([], "x", true);
    expect(toggleExpiry(on, "x", false)).toEqual([]);
    expect(toggleExpiry(toggleExpiry(on, "x", false), "x", true)).toEqual(["x"]);
  });
});
