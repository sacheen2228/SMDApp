/// <reference types="bun-types" />
// spot → PREMIUM level conversion for Today's Trade option rows
// (playbook: "repriced stop premium, not a flat guess"; Rule Set C stop floor).

import { describe, it, expect } from "bun:test";
import { spotToPremiumLevels, OPTION_STOP_PCT } from "@/lib/greeks";

const NOW = new Date("2026-10-04T10:00:00Z");
const EXPIRY = "09-Oct-2026"; // ~5 days out from NOW

describe("OPTION_STOP_PCT", () => {
  it("Rule Set C: option stop risks at most 10% of premium", () => {
    expect(OPTION_STOP_PCT).toBe(0.10);
  });
});

describe("spotToPremiumLevels", () => {
  it("PE happy path → premium space: sl < entry < tp1 <= tp2, spot levels echoed", () => {
    const r = spotToPremiumLevels({
      spotEntry: 178, spotStopLoss: 182, spotT1: 172.66, spotT2: 169.99,
      premium: 8.4, strike: 177.5, expiry: EXPIRY, isCall: false, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toBe(8.4);
    expect(r.stopLoss).toBeLessThan(r.entry);
    expect(r.target1).toBeGreaterThan(r.entry);
    expect(r.target2).toBeGreaterThanOrEqual(r.target1);
    expect(r.riskReward).toBeGreaterThan(0);
  });

  it("10% stop floor is enforced (wide ATR stop tightens to entry × 90%)", () => {
    const r = spotToPremiumLevels({
      spotEntry: 178, spotStopLoss: 182, spotT1: 172.66, spotT2: 169.99,
      premium: 8.4, strike: 177.5, expiry: EXPIRY, isCall: false, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const floor = Math.round(r.entry * (1 - OPTION_STOP_PCT) * 20) / 20;
    expect(r.stopLoss).toBeGreaterThanOrEqual(floor - 0.01);
  });

  it("floor never widens an already-tight stop (keeps the tighter BS stop)", () => {
    const r = spotToPremiumLevels({
      spotEntry: 100, spotStopLoss: 99.5, spotT1: 102, spotT2: 103.5,
      premium: 5, strike: 100, expiry: EXPIRY, isCall: true, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const floor = Math.round(r.entry * (1 - OPTION_STOP_PCT) * 20) / 20;
    // tiny spot stop → BS stop sits above the 10% floor; must NOT be pushed down to floor
    expect(r.stopLoss).toBeGreaterThan(floor);
  });

  it("CE happy path → premium rises toward higher spot target", () => {
    const r = spotToPremiumLevels({
      spotEntry: 2308, spotStopLoss: 2215.8, spotT1: 2446.6, spotT2: 2538.9,
      premium: 42.5, strike: 2300, expiry: EXPIRY, isCall: true, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target1).toBeGreaterThan(r.entry);
    expect(r.stopLoss).toBeLessThan(r.entry);
  });

  it("fails honestly when premium missing (no fabricated numbers)", () => {
    const r = spotToPremiumLevels({
      spotEntry: 178, spotStopLoss: 182, spotT1: 172.66, spotT2: 169.99,
      premium: 0, strike: 177.5, expiry: EXPIRY, isCall: false, now: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/premium/i);
  });

  it("fails honestly when strike missing", () => {
    const r = spotToPremiumLevels({
      spotEntry: 178, spotStopLoss: 182, spotT1: 172.66, spotT2: 169.99,
      premium: 8.4, strike: 0, expiry: EXPIRY, isCall: false, now: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/strike/i);
  });

  it("fails honestly when expiry missing/unparseable", () => {
    const r = spotToPremiumLevels({
      spotEntry: 178, spotStopLoss: 182, spotT1: 172.66, spotT2: 169.99,
      premium: 8.4, strike: 177.5, expiry: "", isCall: false, now: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/expiry/i);
  });

  it("fails honestly when premium is below intrinsic (IV inversion impossible)", () => {
    const r = spotToPremiumLevels({
      spotEntry: 170, spotStopLoss: 174, spotT1: 165, spotT2: 162,
      premium: 5, strike: 177.5, expiry: EXPIRY, isCall: false, now: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/IV|premium/i);
  });

  it("fails honestly when repriced stop is not below entry (bad spot levels)", () => {
    const r = spotToPremiumLevels({
      spotEntry: 178, spotStopLoss: 174, spotT1: 182, spotT2: 185, // inverted: PE stop on the wrong side
      premium: 8.4, strike: 177.5, expiry: EXPIRY, isCall: false, now: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/stop|target|invalid/i);
  });
});
