/// <reference types="bun-types" />
// null-pnl-repair — pure planning helpers shared by the 907-row repair
// script and the boot-time stale cleanup in instrumentation.ts (both must
// agree on IST dates, option-type aliases and WHICH real close a row needs).

import { describe, it, expect } from "bun:test";
import { istDate, normalizeOptionType, planRowExit } from "@/lib/null-pnl-repair";

describe("istDate — calendar date in IST, not UTC", () => {
  it("keeps market-hours instants on the same date", () => {
    expect(istDate(new Date("2026-09-30T10:07:43.334Z"))).toBe("2026-09-30"); // 15:37 IST
  });

  it("rolls post-18:30Z instants to the next IST day", () => {
    expect(istDate(new Date("2026-09-30T18:45:00Z"))).toBe("2026-10-01"); // 00:15 IST
  });

  it("accepts date strings", () => {
    expect(istDate("2026-07-13T09:30:00+05:30")).toBe("2026-07-13");
  });
});

describe("normalizeOptionType — journal has CE/PE and CALL/PUT", () => {
  it("maps aliases to bhavcopy types", () => {
    expect(normalizeOptionType("CALL")).toBe("CE");
    expect(normalizeOptionType("PUT")).toBe("PE");
    expect(normalizeOptionType("CE")).toBe("CE");
    expect(normalizeOptionType("PE")).toBe("PE");
    expect(normalizeOptionType("EQUITY")).toBeNull();
    expect(normalizeOptionType(null)).toBeNull();
  });
});

describe("planRowExit — which real close a corrupted row needs", () => {
  const base = {
    strategy: "option-chain-api",
    type: "CE",
    entryTime: new Date("2026-09-23T05:45:00Z"), // 11:15 IST Sep 23
    exitTime: new Date("2026-09-25T10:00:00Z"),  // boot stamp Sep 25
  };

  it("options follow the contract lifecycle (expiry vs recorded exit)", () => {
    const plan = planRowExit({ ...base });
    expect(plan).toEqual({ kind: "option", created: "2026-09-23", recordedExit: "2026-09-25" });
  });

  it("BTST / EQUITY exit next trading day after entry", () => {
    expect(planRowExit({ ...base, strategy: "BTST", type: "EQUITY" })).toEqual({
      kind: "equity",
      created: "2026-09-23",
      exitDate: "2026-09-24",
    });
    expect(planRowExit({ ...base, strategy: "intraday-scan", type: "EQUITY" })).toMatchObject({ kind: "equity" });
  });

  it("CALL/PUT rows are options too", () => {
    expect(planRowExit({ ...base, type: "CALL", strategy: "intraday-scan" })).toMatchObject({ kind: "option" });
  });
});
