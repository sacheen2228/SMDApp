/// <reference types="bun-types" />
// TDD for the single trade-grade helper (Phase 5) — one formula, one home.

import { describe, test, expect } from "bun:test";
import { tradeGradeFromScore } from "@/lib/trade-grade";

describe("tradeGradeFromScore", () => {
  test("thresholds match the page.tsx ladder", () => {
    expect(tradeGradeFromScore(80)).toBe("A+");
    expect(tradeGradeFromScore(75)).toBe("A+");
    expect(tradeGradeFromScore(74)).toBe("A");
    expect(tradeGradeFromScore(65)).toBe("A");
    expect(tradeGradeFromScore(64)).toBe("B+");
    expect(tradeGradeFromScore(55)).toBe("B+");
    expect(tradeGradeFromScore(54)).toBe("B");
    expect(tradeGradeFromScore(45)).toBe("B");
    expect(tradeGradeFromScore(44)).toBe("C");
    expect(tradeGradeFromScore(0)).toBe("C");
    expect(tradeGradeFromScore(40)).toBe("C"); // the diagnostic snapshot
  });
});
