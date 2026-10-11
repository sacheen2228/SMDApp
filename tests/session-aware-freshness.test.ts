/// <reference types="bun-types" />
// TDD for session-aware freshness: LIVE is only truthful while the exchange
// is open and printing. A fetch on a weekend/holiday/pre-open/after-hours
// returns the last known state and must be classified STALE, never LIVE.

import { describe, test, expect } from "bun:test";
import {
  sessionAwareFreshness,
  withSessionAwareFreshness,
  type FreshnessLevel,
} from "@/lib/api-freshness";

describe("sessionAwareFreshness", () => {
  test("LIVE survives only in OPEN and REGULAR sessions", () => {
    expect(sessionAwareFreshness("LIVE", "OPEN")).toBe("LIVE");
    expect(sessionAwareFreshness("LIVE", "REGULAR")).toBe("LIVE");
  });

  test("LIVE is downgraded to STALE outside market hours", () => {
    expect(sessionAwareFreshness("LIVE", "PRE_OPEN")).toBe("STALE");
    expect(sessionAwareFreshness("LIVE", "POST_MARKET")).toBe("STALE");
    expect(sessionAwareFreshness("LIVE", "CLOSED")).toBe("STALE");
  });

  test("never promotes a weaker level up to LIVE", () => {
    const levels: FreshnessLevel[] = ["FRESH", "DELAYED", "STALE", "UNAVAILABLE"];
    for (const level of levels) {
      for (const session of ["OPEN", "REGULAR"] as const) {
        expect(sessionAwareFreshness(level, session)).toBe(level);
      }
    }
  });

  test("non-LIVE levels are passed through unchanged in any session", () => {
    const levels: FreshnessLevel[] = ["FRESH", "DELAYED", "STALE", "UNAVAILABLE"];
    const sessions = ["PRE_OPEN", "OPEN", "REGULAR", "POST_MARKET", "CLOSED"] as const;
    for (const level of levels) {
      for (const session of sessions) {
        expect(sessionAwareFreshness(level, session)).toBe(level);
      }
    }
  });
});

describe("withSessionAwareFreshness", () => {
  const base = {
    provider: "nse",
    source: "nse",
    timestamp: "2026-10-10T09:00:00.000Z",
    ageMs: 1200,
    freshness: "LIVE" as FreshnessLevel,
    delayed: false,
    fallbackUsed: false,
  };

  test("downgrades LIVE to STALE outside market hours and flips delayed", () => {
    const out = withSessionAwareFreshness(base, "CLOSED");
    expect(out.freshness).toBe("STALE");
    expect(out.delayed).toBe(true);
  });

  test("keeps LIVE and delayed=false while the market is open", () => {
    const out = withSessionAwareFreshness(base, "OPEN");
    expect(out.freshness).toBe("LIVE");
    expect(out.delayed).toBe(false);
  });

  test("preserves provenance — only the classification moves", () => {
    const out = withSessionAwareFreshness(base, "POST_MARKET");
    expect(out.ageMs).toBe(1200);
    expect(out.timestamp).toBe("2026-10-10T09:00:00.000Z");
    expect(out.provider).toBe("nse");
    expect(out.source).toBe("nse");
  });

  test("recomputes delayed from the final freshness level", () => {
    const freshButClosed = { ...base, freshness: "FRESH" as FreshnessLevel, delayed: false };
    const out = withSessionAwareFreshness(freshButClosed, "CLOSED");
    // FRESH is not touched by the session rule, so delayed stays false.
    expect(out.freshness).toBe("FRESH");
    expect(out.delayed).toBe(false);
  });

  test("does not mutate the input meta", () => {
    const input = { ...base };
    withSessionAwareFreshness(input, "CLOSED");
    expect(input.freshness).toBe("LIVE");
    expect(input.delayed).toBe(false);
  });
});
