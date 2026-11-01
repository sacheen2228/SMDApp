// tests/market-session-late-option-gate.test.ts
//
// The late-session option gate (no NEW CE/PE entries after 13:00 IST) is
// applied to the shared session phases, so every consumer of
// isTradeAllowed() (the option-chain auto-registration path, the SDM
// recommendation timing gate and the Hermes trade validator) obeys ONE rule.
//
// Evidence — trade-audit ledger, 353 closed OPTION trades:
//   before 13:00 IST — n=234, WR 40.2%, net +₹385,318, avgR +0.477
//   after  13:00 IST — n=119, WR 16.0%, net −₹719,751, avgR −1.730
//   option-chain-api after 13:00 — n=52, 0 wins, avgR −2.774
//   ZERO_HERO_AI after 13:00    — n=42, WR 23.8%, avgR −1.195
import { describe, test, expect, afterEach } from "bun:test";
import {
  getSessionForMinutes,
  isTradeAllowed,
  lateOptionBuysBlocked,
  LATE_OPTION_BUY_CUTOFF_IST_MINUTES,
} from "@/lib/market-session";

const AT_1045 = 10 * 60 + 45; // primary window
const AT_1250 = 12 * 60 + 50; // low liquidity (still allowed)
const AT_1300 = 13 * 60;      // cutoff
const AT_1420 = 14 * 60 + 20; // afternoon
const AT_1450 = 14 * 60 + 50; // afternoon, still inside the session

afterEach(() => {
  delete process.env.SMD_ALLOW_LATE_OPTION_BUYS;
});

describe("market-session — late option-buy gate", () => {
  test("the cutoff is 13:00 IST", () => {
    expect(LATE_OPTION_BUY_CUTOFF_IST_MINUTES).toBe(780);
    expect(lateOptionBuysBlocked(AT_1250)).toBe(false);
    expect(lateOptionBuysBlocked(AT_1300)).toBe(true);
  });

  test("option buys are ALLOWED before 13:00 (primary + low-liquidity phases)", () => {
    for (const mins of [AT_1045, AT_1250]) {
      const s = getSessionForMinutes(mins);
      expect(s.allowedActions).toContain("BUY_CALL");
      expect(s.allowedActions).toContain("BUY_PUT");
      expect(isTradeAllowed("CALL", s).allowed).toBe(true);
      expect(isTradeAllowed("PUT", s).allowed).toBe(true);
    }
  });

  test("option buys are BLOCKED from 13:00 to the close (13:45 and 14:50)", () => {
    for (const mins of [AT_1300, AT_1420, AT_1450]) {
      const s = getSessionForMinutes(mins);
      expect(s.allowedActions).not.toContain("BUY_CALL");
      expect(s.allowedActions).not.toContain("BUY_PUT");
      expect(isTradeAllowed("CALL", s).allowed).toBe(false);
      expect(isTradeAllowed("PUT", s).allowed).toBe(false);
    }
  });

  test("the rejection says WHY (the reason is actionable, not a bare refusal)", () => {
    const s = getSessionForMinutes(AT_1420);
    const r = isTradeAllowed("CALL", s);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("No New Option Buys");
    expect(s.description).toContain("13:00");
  });

  test("SMD_ALLOW_LATE_OPTION_BUYS=1 restores late-day option entries", () => {
    process.env.SMD_ALLOW_LATE_OPTION_BUYS = "1";
    const s = getSessionForMinutes(AT_1420);
    expect(s.allowedActions).toContain("BUY_CALL");
    expect(isTradeAllowed("CALL", s).allowed).toBe(true);
  });

  test("the gate never blocks the pre-market / closed phases (already WAIT)", () => {
    for (const mins of [540, 900]) {
      const s = getSessionForMinutes(mins);
      expect(s.allowedActions).toEqual(["WAIT"]);
    }
  });
});
