// tests/repair-pe-sign.test.ts
// The pure logic of the one-off repair script (scripts/repair-pe-sign.ts).
// The script itself is run by the OPERATOR — here only its maths is checked.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isWrongSignRow,
  planRepair,
  resolveLotSize,
  cachedBhavcopyDates,
  rowTradeDate,
  type JournalRow,
} from "../scripts/repair-pe-sign";

function row(over: Partial<JournalRow> = {}): JournalRow {
  return {
    id: "row-1",
    tradeId: "stk-TECHM-1792479814066",
    symbol: "TECHM",
    type: "PE",
    status: "SL_HIT",
    entryPrice: 37,
    stopLoss: 44.4,
    exitPrice: 44.4,
    pnl: 481,
    pnlPercent: 1300,
    strategy: "stock-scanner",
    createdAt: new Date("2026-10-20T12:33:34.130+05:30"),
    ...over,
  };
}

describe("repair-pe-sign — which rows are wrong", () => {
  test("a PE stop-out booked as a profit is selected", () => {
    expect(isWrongSignRow(row())).toBe(true);
  });

  test("a correctly signed PE stop-out is NOT selected", () => {
    expect(isWrongSignRow(row({ pnl: -481 }))).toBe(false);
  });

  test("a long-side PE (stop below the entry) is NOT selected", () => {
    expect(isWrongSignRow(row({ stopLoss: 30, exitPrice: 30, pnl: 481 }))).toBe(false);
  });

  test("a CE row is NEVER selected", () => {
    expect(isWrongSignRow(row({ type: "CE" }))).toBe(false);
  });

  test("a row that is not a stop-out is NOT selected", () => {
    expect(isWrongSignRow(row({ status: "TP1_HIT" }))).toBe(false);
    expect(isWrongSignRow(row({ status: "ACTIVE" }))).toBe(false);
  });
});

describe("repair-pe-sign — the corrected numbers", () => {
  test("a mirrored PE stop-out becomes a loss of points × the REAL lot", () => {
    const p = planRepair(row(), { lotSize: 600, lotSource: "NSE F&O lot" });
    expect(p).not.toBeNull();
    expect(p!.points).toBeCloseTo(7.4, 6);
    expect(p!.newPnl).toBeCloseTo(-(7.4 * 600), 6); // −₹4,440 (was +₹481)
    expect(p!.newPnlPercent).toBeCloseTo(-20, 6); // 20% of the premium lost
    expect(p!.oldPnl).toBe(481);
  });

  test("--sign-only keeps the ₹ magnitude and only fixes the sign + the %", () => {
    const p = planRepair(row(), { lotSize: 600, signOnly: true });
    expect(p!.newPnl).toBeCloseTo(-481, 6);
    expect(p!.newPnlPercent).toBeCloseTo(-20, 6);
  });

  test("the exit price is used when the row has one", () => {
    const p = planRepair(row({ exitPrice: 45.5 }), { lotSize: 600 });
    expect(p!.exitPrice).toBeCloseTo(45.5, 6);
    expect(p!.points).toBeCloseTo(8.5, 6);
    expect(p!.newPnl).toBeCloseTo(-(8.5 * 600), 6);
  });

  test("a row without usable levels is not repaired", () => {
    expect(planRepair(row({ entryPrice: 0 }), { lotSize: 600 })).toBeNull();
    expect(planRepair(row({ exitPrice: null, stopLoss: 0 }), { lotSize: 600 })).toBeNull();
  });

  test("a repaired row no longer matches the selection (idempotent)", () => {
    const p = planRepair(row(), { lotSize: 600 })!;
    expect(isWrongSignRow(row({ pnl: p.newPnl }))).toBe(false);
  });
});

describe("repair-pe-sign — the lot size", () => {
  test("a known symbol uses the real NSE F&O lot", () => {
    const r = resolveLotSize(row({ symbol: "TECHM" }), null);
    expect(r.lotSize).toBe(600);
    expect(r.source).toMatch(/NSE F&O lot/);
  });

  test("an explicit --lot wins", () => {
    const r = resolveLotSize(row({ symbol: "TECHM" }), 65);
    expect(r.lotSize).toBe(65);
    expect(r.source).toBe("--lot");
  });

  test("an unknown symbol falls back to the row's own implied lot", () => {
    const r = resolveLotSize(row({ symbol: "NOT_A_SYMBOL" }), null);
    expect(r.lotSize).toBe(65); // 481 / 7.4
    expect(r.source).toMatch(/implied/);
  });

  test("the bhavcopy lot (NewBrdLotQty) wins over the static table", () => {
    const r = resolveLotSize(row({ symbol: "TECHM" }), null, {
      lotSize: 999,
      source: "NSE F&O bhavcopy 2026-10-19 (NewBrdLotQty)",
    });
    expect(r.lotSize).toBe(999);
    expect(r.source).toMatch(/bhavcopy/);
  });

  test("an explicit --lot still wins over the bhavcopy", () => {
    const r = resolveLotSize(row({ symbol: "TECHM" }), 65, {
      lotSize: 999,
      source: "bhavcopy",
    });
    expect(r.lotSize).toBe(65);
    expect(r.source).toBe("--lot");
  });

  test("a bhavcopy lot of 0 is ignored (never a division by zero)", () => {
    const r = resolveLotSize(row({ symbol: "TECHM" }), null, { lotSize: 0, source: "bhavcopy" });
    expect(r.lotSize).toBe(600);
    expect(r.source).toMatch(/NSE F&O lot/);
  });
});

describe("repair-pe-sign — the bhavcopy cache", () => {
  test("the cached dates are found, newest first", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bhav-"));
    try {
      writeFileSync(path.join(dir, "BhavCopy_NSE_FO_0_0_0_20261019_F_0000.csv"), "x");
      writeFileSync(path.join(dir, "BhavCopy_NSE_FO_0_0_0_20261012_F_0000.csv"), "x");
      writeFileSync(path.join(dir, "not-a-bhavcopy.csv"), "x");
      const dates = cachedBhavcopyDates(dir);
      expect(dates).toEqual(["2026-10-19", "2026-10-12"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty cache yields no dates (never a crash)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bhav-empty-"));
    try {
      expect(cachedBhavcopyDates(dir)).toEqual([]);
      expect(cachedBhavcopyDates(path.join(dir, "does-not-exist"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the row's trade date is the IST date of createdAt", () => {
    // 2026-10-20T03:49:13.716Z → 09:19 IST → 2026-10-20
    expect(rowTradeDate(row({ createdAt: 1792468153716 }))).toBe("2026-10-20");
    // 2026-10-19T18:30:00Z → 2026-10-20 00:00 IST → still the 20th
    expect(rowTradeDate(row({ createdAt: Date.parse("2026-10-19T18:30:00Z") }))).toBe("2026-10-20");
    // a Date object works too
    expect(rowTradeDate(row({ createdAt: new Date("2026-10-20T12:33:34.130+05:30") }))).toBe(
      "2026-10-20"
    );
  });
});
