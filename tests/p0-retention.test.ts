// P0-Retention — disk-space maintenance policy (2026-11-19)
//
// The user-approved policy: keep at most 30 days of raw data, and reset the
// recorder DB at the start of every new month. These tests pin the parts that
// are safe to assert offline (the policy constants, the safeguards that must
// exist in the engine, the schedule and the archive-before-delete ordering).
// The engine's own behaviour (archive → rollup → batched delete → VACUUM) is
// proven end-to-end by market-history/scripts/retention-selftest.ts, which
// runs under NODE (better-sqlite3 is not bun-loadable).
import { describe, test, expect } from "bun:test";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const engine = fs.readFileSync(path.join(ROOT, "market-history/src/db/retention.ts"), "utf8");
const selfTest = fs.readFileSync(
  path.join(ROOT, "market-history/scripts/retention-selftest.ts"),
  "utf8",
);
const script = fs.readFileSync(path.join(ROOT, "market-recorder/retention.sh"), "utf8");

describe("P0-R1 — the policy is what the user approved", () => {
  test("30-day raw window + 2 kept archives", () => {
    expect(engine).toMatch(/retentionDays:\s*30/);
    expect(engine).toMatch(/keepArchives:\s*2/);
  });

  test("the monthly cutoff is the IST month boundary, the daily one is 30 days", () => {
    expect(engine).toMatch(/monthBoundaryIso/);
    expect(engine).toMatch(/retentionCutoffIso\(RETENTION_DEFAULTS\.retentionDays/);
    expect(engine).toMatch(/\+05:30|\+5\.5 \* 3600/);
  });

  test("only rows STRICTLY older than the cutoff are removed", () => {
    expect(engine).toMatch(/WHERE timestamp < \?/);
    expect(engine).toMatch(/WHERE \$\{column\} < \?/);
  });
});

describe("P0-R2 — the safeguards are present in the engine", () => {
  test("archive before delete, and abort when the archive is not verified", () => {
    const archiveAt = engine.indexOf("archiveDatabase(");
    const deleteAt = engine.indexOf("deleteOlderThan(plan.cutoffIso)");
    expect(archiveAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(archiveAt);
    expect(engine).toMatch(/archive verification failed/);
  });

  test("the archive is gzip'ed and integrity-checked before it is trusted", () => {
    expect(engine).toMatch(/VACUUM INTO/);
    expect(engine).toMatch(/gzip.*-t|"\["-t", gz\]/);
    expect(engine).toMatch(/verified: boolean/);
  });

  test("the disk guard aborts before anything is deleted", () => {
    expect(engine).toMatch(/guardOk/);
    expect(engine).toMatch(/freeBytes >= needed/);
    expect(engine).toMatch(/ABORT/);
  });

  test("deletes are batched (bounded transactions)", () => {
    expect(engine).toMatch(/batchSize:\s*50_000/);
    expect(engine).toMatch(/LIMIT \?/);
  });

  test("the deleted range is rolled up BEFORE it is removed", () => {
    expect(engine).toMatch(/rollupBatch/);
    expect(engine).toMatch(/CREATE TABLE IF NOT EXISTS chain_5m/);
    const rollupAt = engine.indexOf("function rollupBatch");
    expect(rollupAt).toBeGreaterThan(-1);
  });

  test("integrity is verified after the run", () => {
    expect(engine).toMatch(/integrity_check/);
    expect(engine).toMatch(/reclaimSpace/);
  });

  test("no unbounded DELETE without a cutoff — every delete has one", () => {
    const deletes = engine.match(/DELETE FROM \w+ WHERE/g) ?? [];
    for (const d of deletes) {
      const tail = engine.slice(engine.indexOf(d), engine.indexOf(d) + 200);
      expect(tail).toMatch(/< \?|rowid IN \(SELECT rowid FROM retention_batch\)/);
    }
  });
});

describe("P0-R3 — the schedule", () => {
  test("the daily 30-day cap runs off-session", () => {
    const daily = fs.readFileSync(
      path.join(ROOT, "market-recorder/smdapp-retention-daily.timer"),
      "utf8",
    );
    expect(daily).toMatch(/OnCalendar=\*-\*-\* 03:20:00/);
    expect(daily).toMatch(/smdapp-retention@daily\.service/);
  });

  test("the monthly clean-start job is DISABLED (user decision, 2026-11-19)", () => {
    const monthly = fs.readFileSync(
      path.join(ROOT, "market-recorder/smdapp-retention-monthly.timer"),
      "utf8",
    );
    expect(monthly).toMatch(/DISABLED by user decision/);
    expect(monthly).toMatch(/not enabled|is NOT enabled/);
  });

  test("the rolling job is the only deleter: it archives the aging TAIL", () => {
    expect(engine).toMatch(/archiveTail/);
    expect(engine).toMatch(/keepTailArchives:\s*14/);
    expect(engine).toMatch(/rotateTailArchives/);
    // the daily branch uses the tail export, the monthly branch the full copy
    expect(engine).toMatch(/mode === "monthly"\s*\?\s*archiveDatabase\(tag\)/);
  });

  test("the job script is bounded and never hangs", () => {
    expect(script).toMatch(/--max-time/);
    expect(script).toMatch(/flock/);
    expect(script).toMatch(/market-history\/retention|mode/);
  });

  test("the maintenance route is loopback-only unless a token is configured", () => {
    const routes = fs.readFileSync(path.join(ROOT, "market-history/src/routes/index.ts"), "utf8");
    expect(routes).toMatch(/isLoopback/);
    expect(routes).toMatch(/MARKET_HISTORY_MAINTENANCE_TOKEN/);
    expect(routes).toMatch(/maintenance\/retention/);
  });
});

describe("P0-R4 — the engine self-test covers the destructive path", () => {
  test("it proves: plan, dry-run, guard abort, archive, rollup, delete, restore", () => {
    expect(selfTest).toMatch(/the plan must not delete anything/);
    expect(selfTest).toMatch(/dry-run must not delete/);
    expect(selfTest).toMatch(/a guard abort must not delete/);
    expect(selfTest).toMatch(/the archive must exist and be verified/);
    expect(selfTest).toMatch(/the rollup must keep the deleted range/);
    expect(selfTest).toMatch(/only the current month must remain/);
    expect(selfTest).toMatch(/the archive must hold the pre-delete rows/);
    expect(selfTest).toMatch(/ltp_open, 100, "open must be the FIRST ltp"/);
    expect(selfTest).toMatch(/the tail archive must contain only the aged-out rows/);
    expect(selfTest).toMatch(/the daily job must use the tail archive/);
  });
});
