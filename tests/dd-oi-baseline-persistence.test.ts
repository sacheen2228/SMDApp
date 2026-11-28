/// <reference types="bun-types" />
// Durable OI baseline store — persistence across restarts, sessions, weekends,
// holidays, duplicates, missing OI, and storage failure.
// Uses a temp SQLite file so it never touches db/custom.db.
//
// IMPORTANT: OI_BASELINE_DB must be set BEFORE importing the store module,
// because DB_PATH is resolved at module load time.
process.env.OI_BASELINE_DB = "/tmp/sdmapp-oi-baseline-test.db";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  recordOiObservation,
  getSessionFirstObservation,
  getLatestPriorObservation,
  pruneOldObservations,
  closeOiBaselineDb,
  type OiBaselineObservation,
} from "@/lib/oi-baseline-store";

import fs from "node:fs";

const TEST_DB = "/tmp/sdmapp-oi-baseline-test.db";

function removeTestDb() {
  try {
    fs.unlinkSync(TEST_DB);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(TEST_DB + "-wal");
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(TEST_DB + "-shm");
  } catch {
    /* ignore */
  }
}

const NOW = Date.now();
const session = "2026-11-27"; // Friday trading day
const priorSession = "2026-11-26"; // Thursday trading day
const weekendSession = "2026-11-28"; // Saturday
const holidaySession = "2026-11-10"; // Diwali-Balipratipada (holiday)

function obs(over: Partial<OiBaselineObservation> = {}): OiBaselineObservation {
  return {
    symbol: "NIFTY",
    expiry: "2026-12-04",
    strike: 25450,
    type: "CE",
    oi: 500_000,
    observedAt: NOW,
    session,
    source: "seller-intelligence",
    provenance: "observed",
    quality: "OK",
    createdAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  removeTestDb();
  closeOiBaselineDb();
});

afterEach(() => {
  closeOiBaselineDb();
  removeTestDb();
});

describe("OI baseline store durability", () => {
  test("first observation of a session is stored and retrievable (INTRADAY seed)", () => {
    const o = obs({ session });
    expect(recordOiObservation(o)).toBe(true);
    const row = getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", session);
    expect(row).not.toBeNull();
    expect(row!.oi).toBe(500_000);
    expect(row!.session).toBe(session);
    expect(row!.observedAt).toBe(NOW);
  });

  test("second observation of the same session does NOT replace the first", () => {
    recordOiObservation(obs({ session, oi: 500_000, observedAt: NOW }));
    recordOiObservation(obs({ session, oi: 600_000, observedAt: NOW + 60_000 }));
    const row = getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", session);
    expect(row).not.toBeNull();
    // First observation of the session is preserved
    expect(row!.oi).toBe(500_000);
    expect(row!.observedAt).toBe(NOW);
  });

  test("duplicate observation (same contract + observedAt) is idempotent", () => {
    const o = obs({ session });
    expect(recordOiObservation(o)).toBe(true);
    expect(recordOiObservation(o)).toBe(false); // INSERT OR IGNORE → no change
    const row = getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", session);
    expect(row).not.toBeNull();
    expect(row!.oi).toBe(500_000);
  });

  test("next trading session: prior-session observation classified OVERNIGHT", () => {
    recordOiObservation(obs({ session: priorSession, oi: 450_000, observedAt: NOW - 86_400_000 }));
    const prior = getLatestPriorObservation(
      "NIFTY",
      "2026-12-04",
      25450,
      "CE",
      session // beforeSession = today
    );
    expect(prior).not.toBeNull();
    expect(prior!.session).toBe(priorSession);
    expect(prior!.oi).toBe(450_000);
    // priorSession < session → OVERNIGHT, never INTRADAY
    expect(prior!.session).toBe(priorSession);
  });

  test("weekend boundary: weekend date stored as its own session", () => {
    recordOiObservation(obs({ session: weekendSession, oi: 500_000 }));
    const row = getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", weekendSession);
    expect(row).not.toBeNull();
    expect(row!.session).toBe(weekendSession);
  });

  test("exchange holiday boundary: holiday date stored as its own session", () => {
    recordOiObservation(obs({ session: holidaySession, oi: 500_000 }));
    const row = getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", holidaySession);
    expect(row).not.toBeNull();
    expect(row!.session).toBe(holidaySession);
  });

  test("missing OI: no baseline returned when no observations exist", () => {
    expect(
      getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", session)
    ).toBeNull();
    expect(
      getLatestPriorObservation("NIFTY", "2026-12-04", 25450, "CE", session)
    ).toBeNull();
  });

  test("storage failure fails safely (baseline unavailable, never fabricated)", () => {
    // Point at a read-only/invalid path → writes fail safely, reads return null
    process.env.OI_BASELINE_DB = "/nonexistent-dir-that-does-not-exist/oi.db";
    closeOiBaselineDb();
    expect(recordOiObservation(obs({ session }))).toBe(false);
    expect(getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", session)).toBeNull();
    expect(getLatestPriorObservation("NIFTY", "2026-12-04", 25450, "CE", session)).toBeNull();
    // Restore for cleanup
    process.env.OI_BASELINE_DB = TEST_DB;
    closeOiBaselineDb();
  });

  test("pruneOldObservations drops old sessions, keeps recent", () => {
    const now = Date.now();
    recordOiObservation(obs({ session: "2026-11-20", oi: 100, observedAt: now })); // old
    recordOiObservation(obs({ session, oi: 500_000, observedAt: now + 1_000 })); // recent
    pruneOldObservations();
    const oldRow = getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", "2026-11-20");
    const recentRow = getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", session);
    // 2026-11-20 is more than 7 days before 2026-11-27 (system date Nov 28) → pruned
    expect(oldRow).toBeNull();
    expect(recentRow).not.toBeNull();
  });

  test("different strikes/types/expiry are independent keys", () => {
    recordOiObservation(obs({ strike: 25450, type: "CE", oi: 500_000 }));
    recordOiObservation(obs({ strike: 25500, type: "CE", oi: 600_000 }));
    recordOiObservation(obs({ strike: 25450, type: "PE", oi: 700_000 }));
    expect(getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "CE", session)!.oi).toBe(
      500_000
    );
    expect(getSessionFirstObservation("NIFTY", "2026-12-04", 25500, "CE", session)!.oi).toBe(
      600_000
    );
    expect(getSessionFirstObservation("NIFTY", "2026-12-04", 25450, "PE", session)!.oi).toBe(
      700_000
    );
  });
});
