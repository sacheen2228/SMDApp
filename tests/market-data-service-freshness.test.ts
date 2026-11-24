// ═══════════════════════════════════════════════════════════════════════════
// market-data-service — freshness on a CACHE HIT must use the PROVIDER's age.
//
// The cache path computed `ageMs = now - cached.fetchedAt` (how long ago WE
// wrote the entry) and classified from that, while the envelope still carried
// the provider's own `providerTimestamp`. A 60s-old cache entry holding a
// 22h-old exchange payload therefore reported freshness LIVE.
//
// Live symptom (2026-11-24, an NSE holiday):
//   freshness= LIVE  chainTimestamp= 23-Nov-2026 15:40:00   (22h old)
// The first (uncached) call correctly said STALE — only the re-serve lied.
//
// Contract under test: the provider's stamp decides; undated is capped at
// FRESH (never LIVE); age is never negative.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "bun:test";
import { payloadAgeAndFreshness } from "@/lib/market-data-service";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 8, 41, 0); // 24-Nov-2026 14:11 IST

describe("payloadAgeAndFreshness — the provider's stamp decides", () => {
  it("a 22h-old provider stamp is STALE even when we collected it 30s ago", () => {
    // The bug: age came from `collectedAtMs` (30s) → LIVE.
    // ISO so the age bound is timezone-independent.
    const out = payloadAgeAndFreshness(
      new Date(NOW - 22.7 * HOUR).toISOString(),
      NOW - 30_000, // we wrote the cache 30s ago
      NOW,
      "optionChain",
    );
    expect(out.ageMs).toBeGreaterThan(22 * HOUR);
    expect(out.ageMs).toBeLessThan(23 * HOUR);
    expect(out.freshness).toBe("STALE");
  });

  it("the exchange's own DD-MMM-YYYY stamp also classifies STALE", () => {
    // Verdict only — the parsed instant shifts with the server TZ, but every
    // plausible reading of 23-Nov-2026 is far past the 600s delayed window.
    const out = payloadAgeAndFreshness("23-Nov-2026 15:40:00", NOW - 30_000, NOW, "optionChain");
    expect(out.freshness).toBe("STALE");
    expect(out.ageMs).toBeGreaterThan(0);
  });

  it("a fresh provider stamp is LIVE", () => {
    const out = payloadAgeAndFreshness(new Date(NOW - 5_000).toISOString(), NOW - 5_000, NOW, "optionChain");
    expect(out.freshness).toBe("LIVE");
    expect(out.ageMs).toBeLessThan(30_000);
  });

  it("a provider stamp inside the fresh window is FRESH, not LIVE", () => {
    const out = payloadAgeAndFreshness(new Date(NOW - 120_000).toISOString(), NOW - 120_000, NOW, "optionChain");
    expect(out.freshness).toBe("FRESH");
  });

  it("an undated payload is capped at FRESH — never LIVE", () => {
    // A 200 response is not proof of liveness.
    const out = payloadAgeAndFreshness(null, NOW - 30_000, NOW, "optionChain");
    expect(out.freshness).toBe("FRESH");
    expect(out.ageMs).toBe(30_000);
  });

  it("a future-dated stamp clamps to age 0 instead of going negative", () => {
    const out = payloadAgeAndFreshness(new Date(NOW + 3_600_000).toISOString(), NOW, NOW, "optionChain");
    expect(out.ageMs).toBe(0);
    expect(out.freshness).toBe("LIVE");
  });

  it("an unparseable stamp falls back to the undated verdict (FRESH)", () => {
    const out = payloadAgeAndFreshness("not-a-date", NOW - 60_000, NOW, "optionChain");
    expect(out.freshness).toBe("FRESH");
    expect(out.ageMs).toBe(60_000);
  });
});
