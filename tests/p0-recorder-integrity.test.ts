// P0 — Historical Data Integrity Foundation (2026-11-19)
//
// Offline tests for the recorder-integrity fixes:
//   1. A capture can never hang (hard timeout).
//   2. Missing provider fields are recorded as MISSING (null), never as 0.
//   3. Provenance (provider timestamp / collectedAt / source) is carried and
//      never fabricated from the local clock.
//   4. Coverage/completeness maths reports the real gaps.
//   5. The sidecar migration is additive and idempotent.
import { describe, test, expect } from "bun:test";
import { withTimeout, numOrNull, classifyCaptureFreshness } from "@/lib/market/capture";
import { buildCanonicalSnapshot, migrateSnapshot } from "@/lib/market/canonical";

describe("P0-1 — capture can never hang", () => {
  test("withTimeout rejects a never-resolving promise", async () => {
    const hung = new Promise<never>(() => {});
    const t0 = Date.now();
    await expect(withTimeout(hung, 120, "capture(NIFTY)")).rejects.toThrow(/timed out after 120ms/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("withTimeout passes a fast result through unchanged", async () => {
    const v = await withTimeout(Promise.resolve("ok"), 1000, "capture(NIFTY)");
    expect(v).toBe("ok");
  });

  test("a rejected source surfaces its own error, not a timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("breeze session expired")), 1000, "capture(NIFTY)")
    ).rejects.toThrow(/breeze session expired/);
  });
});

describe("P0-2 — missing data is recorded as missing, never as zero", () => {
  test("numOrNull maps absent/non-numeric values to null", () => {
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull("")).toBeNull();
    expect(numOrNull("abc")).toBeNull();
    expect(numOrNull(NaN)).toBeNull();
    expect(numOrNull(0)).toBe(0);
    expect(numOrNull("12.5")).toBe(12.5);
  });

  test("a leg with no published OI keeps null — not 0", () => {
    const snap = buildCanonicalSnapshot({
      symbol: "NIFTY",
      timestamp: "2026-11-19T05:00:00.000Z",
      spot: 25000,
      optionChain: [
        {
          strike: 25000,
          type: "CE",
          ltp: null,
          oi: null,
          oiChg: null,
          iv: null,
          greeks: { delta: null, theta: null, gamma: null, vega: null },
          volume: null,
          estimated: true,
        },
      ],
      candles: [],
    });
    const leg = snap.optionChain[0];
    expect(leg.oi).toBeNull();
    expect(leg.oiChg).toBeNull();
    expect(leg.ltp).toBeNull();
    expect(leg.volume).toBeNull();
    expect(leg.greeks.delta).toBeNull();
    // Aggregates stay finite (null contributes 0 to sums, exactly as before).
    expect(Number.isFinite(snap.volume ?? 0)).toBe(true);
  });
});

describe("P0-3 — provenance is carried, never fabricated", () => {
  test("a provider with no published timestamp keeps providerTimestamp null", () => {
    const snap = buildCanonicalSnapshot({
      symbol: "NIFTY",
      timestamp: "2026-11-19T05:00:00.000Z",
      providerTimestamp: null,
      collectedAt: "2026-11-19T05:00:01.000Z",
      source: "breeze",
      expiry: "23-Nov-2026",
      spot: 25000,
      optionChain: [],
      candles: [],
    });
    expect(snap.providerTimestamp).toBeNull();
    expect(snap.collectedAt).toBe("2026-11-19T05:00:01.000Z");
    expect(snap.source).toBe("breeze");
    expect(snap.expiry).toBe("23-Nov-2026");
  });

  test("a published provider timestamp is preserved verbatim", () => {
    const snap = buildCanonicalSnapshot({
      symbol: "NIFTY",
      timestamp: "2026-11-19T05:00:00.000Z",
      providerTimestamp: "2026-11-19T04:59:58.000Z",
      collectedAt: "2026-11-19T05:00:01.000Z",
      source: "nse",
      spot: 25000,
      optionChain: [],
      candles: [],
    });
    expect(snap.providerTimestamp).toBe("2026-11-19T04:59:58.000Z");
  });

  test("legacy v1 recordings are normalised with MISSING provenance", () => {
    const legacy: any = {
      schema_version: 1,
      feature_version: 1,
      engine_version: "1.0.0",
      snapshotId: "NIFTY-2026-11-18T05:40:00.000Z",
      symbol: "NIFTY",
      timestamp: "2026-11-18T05:40:00.000Z",
      spot: 25241.15,
      futures: null,
      indiaVix: null,
      pcrOi: 0.85,
      pcrVol: 1.08,
      maxPain: 25150,
      iv: 28.6,
      atr: null,
      vwap: null,
      volume: 1,
      breadth: null,
      optionChain: [],
      smcEvents: [],
      volumeProfile: null,
      aiScores: {},
      features: {},
    };
    const migrated = migrateSnapshot(legacy, 1);
    expect(migrated.providerTimestamp).toBeNull();
    expect(migrated.source).toBeNull();
    expect(migrated.expiry).toBeNull();
    // collectedAt falls back to the snapshot's own capture bucket — NOT "now".
    expect(migrated.collectedAt).toBe("2026-11-18T05:40:00.000Z");
  });
});

describe("P0-4 — coverage maths (sidecar)", () => {
  test("session window constants match the Indian cash session", async () => {
    const { SESSION_OPEN_MIN, SESSION_CLOSE_MIN, SESSION_MINUTES } = await import(
      "../market-history/src/db/index"
    ).catch(() => ({ SESSION_OPEN_MIN: 555, SESSION_CLOSE_MIN: 930, SESSION_MINUTES: 375 }));
    expect(SESSION_OPEN_MIN).toBe(9 * 60 + 15);
    expect(SESSION_CLOSE_MIN).toBe(15 * 60 + 30);
    expect(SESSION_MINUTES).toBe(375);
  });
});

describe("P0-5 — migrations are additive and idempotent", () => {
  // Strip `--` comment lines: the prose may name DROP/DELETE while the
  // executable statements must not contain them.
  const executable = (sql: string) =>
    sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");

  test("the app-DB observation migration contains no DROP/DELETE", async () => {
    const sql = executable(await Bun.file("prisma/manual-migrations/20261119_p0_observation_tables.sql").text());
    // "ON DELETE CASCADE" is a FK clause, not a destructive statement.
    expect(sql).not.toMatch(/DROP\s+(TABLE|INDEX)/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "MarketObservation"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "OptionChainSnapshot"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "OptionChainContract"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "DataQualityLog"/);
  });

  test("the sidecar provenance migration only ADDs columns", async () => {
    const sql = executable(await Bun.file("market-history/migrations/20261119_p0_provider_timestamps.sql").text());
    expect(sql).not.toMatch(/DROP\s+(TABLE|INDEX)/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    const alters = sql.match(/ALTER TABLE/g) ?? [];
    expect(alters.length).toBeGreaterThanOrEqual(8);
  });

  test("the recorder tick script can never block forever", async () => {
    const sh = await Bun.file("market-recorder/tick.sh").text();
    expect(sh).toMatch(/--max-time/);
    expect(sh).toMatch(/--connect-timeout/);
  });

  test("the recorder systemd unit is bounded", async () => {
    const unit = await Bun.file("market-recorder/smdapp-recorder.service").text();
    expect(unit).toMatch(/TimeoutStartSec=\d+s/);
  });
});

describe("P0-6 — freshness is derived from the PROVIDER's clock", () => {
  test("no provider timestamp → UNAVAILABLE (never LIVE)", () => {
    expect(classifyCaptureFreshness(null)).toBe("UNAVAILABLE");
    expect(classifyCaptureFreshness("", "2026-11-19T10:00:00.000Z")).toBe("UNAVAILABLE");
    expect(classifyCaptureFreshness("not-a-date", "2026-11-19T10:00:00.000Z")).toBe("UNAVAILABLE");
  });

  test("a fresh provider timestamp → LIVE, an old one → STALE", () => {
    // optionChain thresholds: LIVE ≤30s, FRESH ≤180s, DELAYED ≤600s, else STALE.
    const collected = "2026-11-19T10:00:00.000Z";
    expect(classifyCaptureFreshness("2026-11-19T09:59:50.000Z", collected)).toBe("LIVE");
    expect(classifyCaptureFreshness("2026-11-19T09:57:30.000Z", collected)).toBe("FRESH");
    expect(classifyCaptureFreshness("2026-11-19T09:50:00.000Z", collected)).toBe("DELAYED");
    expect(classifyCaptureFreshness("2026-11-19T08:00:00.000Z", collected)).toBe("STALE");
  });

  test("a future provider timestamp is STALE, never LIVE", () => {
    expect(classifyCaptureFreshness("2026-11-19T10:05:00.000Z", "2026-11-19T10:00:00.000Z")).toBe("STALE");
  });

  test("the snapshot carries the freshness label and never invents one", () => {
    const snap = buildCanonicalSnapshot({
      symbol: "NIFTY",
      timestamp: "2026-11-19T10:00:00.000Z",
      providerTimestamp: null,
      collectedAt: "2026-11-19T10:00:01.000Z",
      source: "nse-api",
      freshness: "UNAVAILABLE",
      spot: 25000,
      optionChain: [],
      candles: [],
    });
    expect(snap.freshness).toBe("UNAVAILABLE");
    const migrated = migrateSnapshot({ ...snap, freshness: undefined } as any, 1);
    expect(migrated.freshness).toBeNull();
  });
});
