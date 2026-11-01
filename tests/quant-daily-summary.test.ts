import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  maybeEnqueueDailySummary,
  __setQuantEngineDepsForTests,
} from "../src/lib/quant/quant-engine";
import { db } from "@/lib/db";
import { istIso, istDayKey } from "../src/lib/quant/quant-data";

// IST = UTC+5:30 → 15:31 IST == 10:01 UTC
const MONDAY_NOON_IST = Date.UTC(2026, 9, 26, 6, 30); // 12:00 IST Mon Oct 26
const MONDAY_1531_IST = Date.UTC(2026, 9, 26, 10, 1); // 15:31 IST Mon Oct 26

const KEY_MARKER = "QUANT_DAILY_SUMMARY";
// Rows enqueued under test are stamped `qtest_sys:` (the engine treats a set
// test-deps object as "this is a test cycle"). Never touch the live 15:30
// summary — the old cleanup (contains "QUANT_DAILY_SUMMARY") deleted it too,
// and the fixture day collided with the real trading day.
const TEST_ROW = { alertType: KEY_MARKER, idempotencyKey: { startsWith: "qtest_sys:" } } as const;

beforeEach(() => {
  __setQuantEngineDepsForTests({}); // stamp → distinguishable from live rows
});

afterAll(async () => {
  __setQuantEngineDepsForTests(null);
  await db.quantAlertOutbox.deleteMany({ where: TEST_ROW });
});

describe("quant daily summary alert flow", () => {
  // Scope every assertion to THIS test's fixture day (2026-10-26 IST) — other
  // tests / real ticks legitimately enqueue a summary for the REAL current day.
  const fixtureDay = istDayKey(MONDAY_1531_IST);
  const rowsForFixtureDay = async () =>
    (
      await db.quantAlertOutbox.findMany({ where: TEST_ROW })
    ).filter((r) => r.idempotencyKey.includes(fixtureDay));

  test("before 15:30 IST → not queued, no outbox row", async () => {
    const res = await maybeEnqueueDailySummary(MONDAY_NOON_IST);
    expect(res.queued).toBe(false);
    expect(res.reason).toBe("before-1530-ist");
    expect((await rowsForFixtureDay()).length).toBe(0);
  });

  test("at/after 15:30 IST → queued PENDING with performance payload", async () => {
    const res = await maybeEnqueueDailySummary(MONDAY_1531_IST);
    expect(res.queued).toBe(true);
    expect(res.eventId).toBeDefined();
    const rows = await rowsForFixtureDay();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("PENDING");
    const payload = JSON.parse(rows[0].payload);
    expect(payload.note).toContain("Paper results only");
    expect(payload.performance).toBeDefined();
    expect(rows[0].idempotencyKey).toContain(fixtureDay);
  });

  test("second call same IST day → deduped (no second row)", async () => {
    const res = await maybeEnqueueDailySummary(MONDAY_1531_IST + 60_000);
    expect(res.deduped).toBe(true);
    expect((await rowsForFixtureDay()).length).toBe(1);
  });

  test("istIso minute extraction sanity (15:31 IST)", () => {
    const iso = istIso(MONDAY_1531_IST);
    expect(iso.slice(11, 16)).toBe("15:31");
  });
});
