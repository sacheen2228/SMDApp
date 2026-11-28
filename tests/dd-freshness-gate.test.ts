// Anti-lag / anti-fake gates for the Daily-Derivatives card decision.
//
// Three ways the card used to be able to read "TAKE" off data that was no
// longer live:
//   1. the chain was STALE/DELAYED (the freshness field existed but never
//      gated the decision);
//   2. the candle feed had stopped (levels/EMA/VWAP all computed from a tape
//      that was minutes or a whole session old);
//   3. the sticky decision lock — designed to stop TAKE/WAIT flicker on one
//      mixed poll — held a TAKE for 2 minutes after the feed went stale.
//
// A card that reads TAKE while its inputs are stale is exactly the lagging,
// non-live signal this panel must never print.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  evaluatePlanTrade,
  resolvePlanDecision,
  __resetPlanDecisionLocksForTests,
  DESK_MAX_SIGNAL_AGE_MS,
  isFreshSetup,
  setupAgeMs,
  resolveVixSource,
  VIX_STALE_MS,
  parseNseStampToMs,
} from "@/lib/DailyDerivatives";

// Same rich baseline the hold/ladder suite uses: aligned evidence groups,
// a tight book, a valid ladder — i.e. a card that WOULD be TAKE on live data.
const base = {
  optionType: "CE" as const,
  tradable: true,
  lots: 2,
  rr: 2.0,
  entry: 250,
  stopLoss: 200,
  preferredSide: "CALL" as "CALL" | "PUT" | null,
  preferredStatus: "confirmed" as const,
  targetReach: [] as any[],
  sellerSignal: "BUY_CE" as "BUY_CE" | "BUY_PE" | "WAIT" | null,
  marketOpen: true,
  cvdVerdict: "BULLISH",
  ema: {
    trend: "UP" as const,
    adx: 28,
    plusDI: 22,
    minusDI: 14,
    emaFast: 25790,
    emaSlow: 25760,
    atr: 45,
    gapAtr: 0.8,
  },
  sellerCtx: {
    requiresRetest: false,
    entryConfirmed: true,
    score: 60,
    dealerBias: "BULLISH",
    dealerRegime: "SHORT_GAMMA",
    netDex: 5000,
    spot: 25785,
    vwap: 25700,
    priceAboveVwap: true,
  },
  bid: 249,
  ask: 251,
  chainFreshness: "LIVE",
};

beforeEach(() => {
  __resetPlanDecisionLocksForTests();
});

describe("a stale chain never reads TAKE", () => {
  test("baseline on a LIVE chain is TAKE (the gates must not block here)", () => {
    expect(evaluatePlanTrade({ ...base }).decision).toBe("TAKE");
  });

  test("STALE chain (>10 min) → WAIT, flagged as a quality wait", () => {
    const r = evaluatePlanTrade({ ...base, chainFreshness: "STALE" });
    expect(r.decision).toBe("WAIT");
    expect(r.qualityWait).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/stale/i);
  });

  test("DELAYED chain (3–10 min) → WAIT — 5-minute-old premiums are not a live quote", () => {
    const r = evaluatePlanTrade({ ...base, chainFreshness: "DELAYED" });
    expect(r.decision).toBe("WAIT");
    expect(r.qualityWait).toBe(true);
  });

  test("unreported freshness fails CLOSED — the feed never claims liveness it cannot prove", () => {
    const r = evaluatePlanTrade({ ...base, chainFreshness: null });
    expect(r.decision).toBe("WAIT");
    expect(r.qualityWait).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/freshness/i);
  });

  test("market closed is still the hard NO, not a quality wait", () => {
    const r = evaluatePlanTrade({ ...base, marketOpen: false, chainFreshness: "STALE" });
    expect(r.decision).toBe("NO");
    expect(r.qualityWait ?? false).toBe(false);
  });
});

describe("a stopped candle feed never reads TAKE", () => {
  test("last candle 20 minutes old during the session → WAIT", () => {
    const r = evaluatePlanTrade({ ...base, candleAgeMs: 20 * 60_000 });
    expect(r.decision).toBe("WAIT");
    expect(r.qualityWait).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/candle/i);
  });

  test("last candle 2 minutes old (one 5m bar) → unaffected", () => {
    const r = evaluatePlanTrade({ ...base, candleAgeMs: 2 * 60_000 });
    expect(r.decision).toBe("TAKE");
    expect(r.qualityWait ?? false).toBe(false);
  });

  test("no candle age reported → the candle gate does not fire", () => {
    const r = evaluatePlanTrade({ ...base, candleAgeMs: null });
    expect(r.decision).toBe("TAKE");
  });
});

describe("the sticky lock drops a stale TAKE immediately", () => {
  test("confirmed TAKE + a quality WAIT is confirmed on the spot", () => {
    resolvePlanDecision("NIFTY", "CE", "TAKE", 1_000);
    const r = resolvePlanDecision("NIFTY", "CE", "WAIT", 1_500, true);
    expect(r.decision).toBe("WAIT");
    expect(r.status).toBe("confirmed");
    // …and it stays WAIT: the stale lock was overwritten, not pending.
    expect(resolvePlanDecision("NIFTY", "CE", "WAIT", 2_000).decision).toBe("WAIT");
  });

  test("an OPINION wait still needs persistence (no flicker on one mixed poll)", () => {
    resolvePlanDecision("NIFTY", "PE", "TAKE", 1_000);
    const r = resolvePlanDecision("NIFTY", "PE", "WAIT", 61_000);
    expect(r.decision).toBe("TAKE");
    expect(r.status).toBe("pending");
  });
});

describe("an old setup never drives a live card", () => {
  const NOW = Date.parse("2026-11-26T09:30:00+05:30");

  test("a setup from earlier today inside the window is fresh", () => {
    const t = NOW - 10 * 60_000;
    expect(isFreshSetup(t, NOW)).toBe(true);
    expect(setupAgeMs(t, NOW)).toBe(10 * 60_000);
  });

  test("a setup from earlier today BEYOND the window is stale", () => {
    const t = NOW - (DESK_MAX_SIGNAL_AGE_MS + 60_000);
    expect(isFreshSetup(t, NOW)).toBe(false);
  });

  test("a setup from a previous session is never fresh, however recent-looking", () => {
    const t = NOW - 20 * 3_600_000;
    expect(isFreshSetup(t, NOW)).toBe(false);
  });

  test("an unparseable timestamp is never fresh", () => {
    expect(isFreshSetup("not-a-date", NOW)).toBe(false);
    expect(setupAgeMs("not-a-date", NOW)).toBeNull();
  });

  test("the freshness window is the desk's own signal window", () => {
    expect(DESK_MAX_SIGNAL_AGE_MS).toBe(45 * 60_000);
  });
});

describe("the VIX must be live before it sizes anything", () => {
  test("a fresh exchange VIX is the source", () => {
    const r = resolveVixSource({
      exchangeValue: 16.81,
      exchangeAgeMs: 30_000,
      atmIvAvailable: true,
      marketOpen: true,
    });
    expect(r.source).toBe("nse");
    expect(r.stale).toBe(false);
  });

  test("a STALE exchange VIX during the session falls back to the chain's ATM IV", () => {
    const r = resolveVixSource({
      exchangeValue: 16.81,
      exchangeAgeMs: VIX_STALE_MS + 60_000,
      atmIvAvailable: true,
      marketOpen: true,
    });
    expect(r.source).toBe("atm-iv");
    expect(r.stale).toBe(true);
  });

  test("a stale exchange VIX with no ATM IV leaves nothing usable (never an estimate as a gate)", () => {
    const r = resolveVixSource({
      exchangeValue: 16.81,
      exchangeAgeMs: VIX_STALE_MS + 60_000,
      atmIvAvailable: false,
      marketOpen: true,
    });
    expect(r.source).toBe("estimate");
    expect(r.stale).toBe(true);
  });

  test("after the close the exchange number IS the number of the day", () => {
    const r = resolveVixSource({
      exchangeValue: 16.81,
      exchangeAgeMs: 5 * 3_600_000,
      atmIvAvailable: true,
      marketOpen: false,
    });
    expect(r.source).toBe("nse");
    expect(r.stale).toBe(false);
  });

  test("no exchange number at all → the chain's ATM IV, or nothing", () => {
    expect(
      resolveVixSource({ exchangeValue: null, exchangeAgeMs: null, atmIvAvailable: true, marketOpen: true }).source,
    ).toBe("atm-iv");
    expect(
      resolveVixSource({ exchangeValue: null, exchangeAgeMs: null, atmIvAvailable: false, marketOpen: true }).source,
    ).toBe("estimate");
  });
});

describe("the NSE stamp is read as IST, never as the server's timezone", () => {
  test("'26-Nov-2026 15:40:00' is 15:40 IST (10:10 UTC)", () => {
    const ms = parseNseStampToMs("26-Nov-2026 15:40:00");
    expect(ms).toBe(Date.parse("2026-11-26T15:40:00+05:30"));
  });

  test("a plain ISO stamp still parses", () => {
    expect(parseNseStampToMs("2026-11-26T10:10:00.000Z")).toBe(Date.parse("2026-11-26T10:10:00.000Z"));
  });

  test("an unreadable stamp is null, never 'now'", () => {
    expect(parseNseStampToMs("not-a-date")).toBeNull();
    expect(parseNseStampToMs(null)).toBeNull();
    expect(parseNseStampToMs(undefined)).toBeNull();
  });
});
