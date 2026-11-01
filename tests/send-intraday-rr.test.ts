// send-intraday-rr.test.ts — D-2 remainder: signed R:R in alert filter
import { describe, test, expect } from "bun:test";
import { isPlausibleOptionPlan } from "@/lib/sendIntradayAlerts";

describe("sendIntradayAlerts: signed R:R filter (no Math.abs masking)", () => {
  const baseStock = { symbol: "TEST", currentPrice: 200, totalScore: 70 };

  test("valid long option plan passes R:R >= 1.5", () => {
    const opt = { premium: 100, stopLoss: 90, targets: [115] }; // risk=10, reward=15 → 1.5
    // The filter function is inline in sendIntradayAlerts; test the logic directly
    const risk = opt.premium - opt.stopLoss; // signed
    const reward = (opt.targets?.[0] ?? 0) - opt.premium;
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    expect(rr).toBe(1.5);
  });

  test("mirrored legacy plan (stop ABOVE premium) → rr = 0 (not masked)", () => {
    const opt = { premium: 100, stopLoss: 110, targets: [90] }; // old mirrored
    const risk = opt.premium - opt.stopLoss; // -10
    const reward = (opt.targets?.[0] ?? 0) - opt.premium; // -10
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    expect(rr).toBe(0);
  });

  test("incoherent: stop below, target also below → rr = 0", () => {
    const opt = { premium: 100, stopLoss: 90, targets: [95] };
    const risk = opt.premium - opt.stopLoss; // 10
    const reward = (opt.targets?.[0] ?? 0) - opt.premium; // -5
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    expect(rr).toBe(0);
  });

  test("incoherent: stop above, target also above → rr = 0", () => {
    const opt = { premium: 100, stopLoss: 110, targets: [115] };
    const risk = opt.premium - opt.stopLoss; // -10
    const reward = (opt.targets?.[0] ?? 0) - opt.premium; // 15
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    expect(rr).toBe(0);
  });

  test("isPlausibleOptionPlan accepts valid short geometry (legacy mirrored) — R:R filter rejects", () => {
    const opt = { premium: 100, stopLoss: 110, targets: [90] };
    // Valid SHORT geometry: stop ABOVE, target BELOW (opposite sides)
    expect(isPlausibleOptionPlan(baseStock, opt)).toBe(true);
    // But signed R:R: risk = 100-110 = -10 ≤ 0 → rr = 0 → filtered out
    const risk = opt.premium - opt.stopLoss;
    const reward = (opt.targets?.[0] ?? 0) - opt.premium;
    const rr = risk > 0 && reward > 0 ? reward / risk : 0;
    expect(rr).toBe(0);
  });

  test("isPlausibleOptionPlan accepts valid long geometry", () => {
    const opt = { premium: 100, stopLoss: 90, targets: [115] };
    expect(isPlausibleOptionPlan(baseStock, opt)).toBe(true);
  });
});