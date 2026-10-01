/// <reference types="bun-types" />
// EOD square-off — pure rules for the 15:31 IST closer:
//   - which open trades close at the end of THEIR session (intraday + trailed
//     TP1/TP2) and which must survive to their own lifecycle (BTST exits next
//     day via closeYesterdayBTST; test rows stay untouched)
//   - P&L math identical to the production SL/TP close path (getPnl in
//     activeTradeTracker): BUY long, SELL inverted, premium/equity points.

import { describe, it, expect } from "bun:test";
import {
  isEodEligible,
  computeEodClose,
  holdingMinutes,
  type EodTradeRow,
} from "@/lib/eod-squareoff";

const row = (over: Partial<EodTradeRow> = {}): EodTradeRow => ({
  tradeId: "sdm-NIFTY-24500-CE-1",
  strategy: "sdm",
  status: "ACTIVE",
  side: "BUY",
  entryPrice: 100,
  entryTime: new Date("2026-10-01T09:30:00+05:30"),
  ...over,
});

describe("isEodEligible — close intraday at EOD, never BTST/test/terminal", () => {
  it("includes ACTIVE intraday trades", () => {
    expect(isEodEligible(row())).toBe(true);
  });

  it("includes OPEN and PENDING statuses", () => {
    expect(isEodEligible(row({ status: "OPEN" }))).toBe(true);
    expect(isEodEligible(row({ status: "PENDING" }))).toBe(true);
  });

  it("includes trailed TP1/TP2 rows — still open money", () => {
    expect(isEodEligible(row({ status: "TP1_HIT" }))).toBe(true);
    expect(isEodEligible(row({ status: "TP2_HIT" }))).toBe(true);
  });

  it("excludes BTST — it squares off next day via closeYesterdayBTST", () => {
    expect(isEodEligible(row({ strategy: "BTST" }))).toBe(false);
  });

  it("excludes test strategies (same convention as stale cleanup)", () => {
    expect(isEodEligible(row({ strategy: "e2e-test" }))).toBe(false);
    expect(isEodEligible(row({ strategy: "prod-verify" }))).toBe(false);
  });

  it("excludes terminal statuses", () => {
    for (const status of ["CLOSED", "EXPIRED", "SL_HIT", "TP3_HIT", "CANCELLED"]) {
      expect(isEodEligible(row({ status }))).toBe(false);
    }
  });

  it("treats a missing strategy as eligible (default intraday rows)", () => {
    expect(isEodEligible(row({ strategy: undefined as any }))).toBe(true);
  });
});

describe("computeEodClose — same math as the SL/TP close path", () => {
  it("BUY profits when exit above entry", () => {
    const r = computeEodClose("BUY", 100, 110);
    expect(r).toEqual({ pnl: 10, pnlPercent: 10 });
  });

  it("BUY loses when exit below entry", () => {
    expect(computeEodClose("BUY", 100, 95)).toEqual({ pnl: -5, pnlPercent: -5 });
  });

  it("SELL inverts the sign", () => {
    expect(computeEodClose("SELL", 100, 90)).toEqual({ pnl: 10, pnlPercent: 10 });
    expect(computeEodClose("SELL", 100, 110)).toEqual({ pnl: -10, pnlPercent: -10 });
  });

  it("rounds to 2 decimals", () => {
    expect(computeEodClose("BUY", 100, 100.555)).toEqual({ pnl: 0.56, pnlPercent: 0.56 });
    // sub-paisa float noise absorbs to zero instead of a phantom 0.01
    expect(computeEodClose("BUY", 67.6, 67.595)!.pnl).toBe(0);
  });

  it("rejects non-positive prices (never fabricate a close)", () => {
    expect(computeEodClose("BUY", 100, 0)).toBeNull();
    expect(computeEodClose("BUY", -1, 100)).toBeNull();
  });
});

describe("holdingMinutes", () => {
  it("reports whole minutes between entry and now", () => {
    expect(holdingMinutes("2026-10-01T09:30:00+05:30", new Date("2026-10-01T11:00:00+05:30"))).toBe(90);
  });

  it("never returns negative (bad clocks clamp to 0)", () => {
    expect(holdingMinutes("2026-10-01T11:00:00+05:30", new Date("2026-10-01T09:30:00+05:30"))).toBe(0);
  });
});
