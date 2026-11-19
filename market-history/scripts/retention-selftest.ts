// Retention self-test — runs under NODE (better-sqlite3 is not bun-loadable).
//
//   cd market-history && node_modules/.bin/ts-node --transpile-only scripts/retention-selftest.ts
//
// It builds a synthetic recorder DB in a temp folder, then proves every
// safeguard of the retention engine:
//   1. the plan counts exactly the rows outside the window
//   2. a dry-run deletes nothing
//   3. the disk guard aborts BEFORE any delete (and nothing is lost)
//   4. the monthly run archives + verifies before deleting
//   5. the deleted range survives as a chain_5m rollup
//   6. the current month is never touched
//   7. integrity_check passes and the file shrinks
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "retention-selftest-"));
const DB_PATH = path.join(TMP, "market_history.db");
process.env.MARKET_HISTORY_DB = DB_PATH;

// The engine opens the DB at import time — import it AFTER the env is set,
// and let it create the real schema (no hand-rolled DDL that could drift).
const { planRetention, runRetention, monthBoundaryIso, retentionCutoffIso, countRows } =
  require("../src/db/retention");
const Database = require("better-sqlite3");
const db = new Database(DB_PATH);

const NOW = new Date("2026-12-01T02:00:00.000Z"); // 07:30 IST on the 1st
const OLD_DATES = ["2026-11-10T06:00:00.000Z", "2026-11-18T06:00:00.000Z", "2026-11-28T10:00:00.000Z"];
const CURRENT_DATES = ["2026-12-01T00:00:00.000Z", "2026-12-01T00:01:00.000Z", "2026-12-01T00:02:00.000Z"];

const insSnap = db.prepare(
  `INSERT INTO market_snapshots
     (id, schema_version, feature_version, engine_version, symbol, timestamp, spot, features, ai_scores, payload)
   VALUES (?,1,1,'1.0.0','NIFTY',?,?,'{}','{}','{}')`,
);
const insTick = db.prepare(
  `INSERT INTO chain_ticks
     (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, volume)
   VALUES (?,?,'NIFTY',?,?,?,?,?,?,?,?)`,
);
let n = 0;
for (const ts of [...OLD_DATES, ...CURRENT_DATES]) {
  const id = `snap-${n++}`;
  insSnap.run(id, ts, 25000 + n);
  insTick.run(`tick-${n++}`, id, ts, 25000 + n * 100, "CE", 100 + n, 5000, 20, 14.2, 900);
  insTick.run(`tick-${n++}`, id, ts, 25000 + n * 100, "PE", 80 + n, 4000, -10, 15.1, 700);
}
db.close();

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

// 1 — cutoff maths
section("cutoff maths");
assert.strictEqual(monthBoundaryIso(NOW), "2026-11-30T18:30:00.000Z", "month boundary must be the IST 1st");
assert.strictEqual(retentionCutoffIso(30, NOW), "2026-11-01T02:00:00.000Z", "30-day rolling cutoff");
console.log("month boundary :", monthBoundaryIso(NOW));
console.log("30-day cutoff  :", retentionCutoffIso(30, NOW));

// 2 — the plan counts only the out-of-window rows
section("plan (no writes)");
const plan = planRetention("monthly", NOW);
assert.strictEqual(plan.wouldDelete.market_snapshots, 3, "3 old snapshots must be selected");
assert.strictEqual(plan.wouldDelete.chain_ticks, 6, "6 old ticks must be selected");
console.log("would delete   :", JSON.stringify(plan.wouldDelete));
console.log("guard          :", plan.guardReason);
assert.strictEqual(countRows("market_snapshots"), 6, "the plan must not delete anything");

// 3 — dry-run changes nothing
section("dry-run");
const dry = runRetention("dry-run", NOW);
assert.strictEqual(dry.aborted, false);
assert.strictEqual(countRows("market_snapshots"), 6, "dry-run must not delete");
assert.strictEqual(countRows("chain_ticks"), 12, "dry-run must not delete");
console.log("rows after dry-run:", countRows("market_snapshots"), countRows("chain_ticks"));

// 4 — the disk guard aborts BEFORE anything is deleted
section("disk guard");
const guarded = runRetention("monthly", NOW, { freeBytes: 1024 });
assert.strictEqual(guarded.aborted, true, "the guard must abort the run");
assert.strictEqual(guarded.archive, null, "no archive may be produced on a guard abort");
assert.strictEqual(countRows("market_snapshots"), 6, "a guard abort must not delete");
assert.strictEqual(countRows("chain_ticks"), 12, "a guard abort must not delete");
console.log("abort reason   :", guarded.abortReason);

// 5 — the real run: archive first, then rollup, then delete
section("monthly run");
const run = runRetention("monthly", NOW);
assert.strictEqual(run.aborted, false, "the run must not abort");
assert.ok(run.archive && run.archive.verified, "the archive must exist and be verified");
assert.ok(run.archive.gzBytes > 0, "the archive must not be empty");
assert.strictEqual(run.integrity, "ok", "integrity_check must pass");
assert.strictEqual(countRows("market_snapshots"), 3, "only the current month must remain");
assert.strictEqual(countRows("chain_ticks"), 6, "only the current month ticks must remain");
console.log("archive        :", run.archive.path, `(${(run.archive.gzBytes / 1024).toFixed(1)}KB gz)`);
console.log("deleted        :", JSON.stringify(run.deleted));
console.log("space          :", run.space.before, "->", run.space.after);

// 6 — the deleted range survives as a rollup
section("rollup");
const roll = require("../src/db/retention");
const db2 = new Database(DB_PATH);
const buckets = db2.prepare("SELECT COUNT(*) c FROM chain_5m").get().c;
const sample = db2.prepare("SELECT * FROM chain_5m LIMIT 2").all();
assert.ok(buckets > 0, "the rollup must keep the deleted range");
console.log("chain_5m rows  :", buckets);
console.log("sample         :", JSON.stringify(sample));
db2.close();

// 6b — open/close ordering + a bucket split across batches
section("rollup open/close + batch split");
const TS = ["2026-11-20T06:00:00.000Z", "2026-11-20T06:01:00.000Z", "2026-11-20T06:02:00.000Z"];
const LTPS = [100, 110, 90];
const dbSplit = new Database(DB_PATH);
const insSnap2 = dbSplit.prepare(
  `INSERT INTO market_snapshots
     (id, schema_version, feature_version, engine_version, symbol, timestamp, spot, features, ai_scores, payload)
   VALUES (?,1,1,'1.0.0','NIFTY',?,?,'{}','{}','{}')`,
);
const insTick2 = dbSplit.prepare(
  `INSERT INTO chain_ticks
     (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, volume)
   VALUES (?,?,'NIFTY',?,25100,'CE',?,?,5,14.2,900)`,
);
TS.forEach((ts, i) => {
  const id = `snap-split-${i}`;
  insSnap2.run(id, ts, 25000);
  insTick2.run(`tick-split-${i}`, id, ts, LTPS[i], 5000 + i);
});
dbSplit.close();

const { deleteOlderThan } = require("../src/db/retention");
const del2 = deleteOlderThan("2026-11-30T18:30:00.000Z", 1); // batchSize 1 → the bucket spans 3 batches
const db4 = new Database(DB_PATH, { readonly: true });
const row = db4.prepare("SELECT * FROM chain_5m WHERE strike=25100 AND type='CE'").get();
assert.ok(row, "the split bucket must be rolled up");
assert.strictEqual(row.ltp_open, 100, "open must be the FIRST ltp");
assert.strictEqual(row.ltp_high, 110, "high must be the max ltp");
assert.strictEqual(row.ltp_low, 90, "low must be the min ltp");
assert.strictEqual(row.ltp_close, 90, "close must be the LAST ltp");
assert.strictEqual(row.samples, 3, "all three samples must be counted");
assert.strictEqual(row.oi_chg_sum, 15, "the summed dOI must not be double counted");
assert.strictEqual(row.volume_sum, 2700, "the summed volume must not be double counted");
console.log("split bucket   :", JSON.stringify(row));
db4.close();

// 6c — the DAILY job exports only the rows that age out (tail archive)
section("daily tail archive");
const dbDaily = new Database(DB_PATH);
const insSnap3 = dbDaily.prepare(
  `INSERT INTO market_snapshots
     (id, schema_version, feature_version, engine_version, symbol, timestamp, spot, features, ai_scores, payload)
   VALUES (?,1,1,'1.0.0','NIFTY',?,?,'{}','{}','{}')`,
);
const insTick3 = dbDaily.prepare(
  `INSERT INTO chain_ticks
     (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, volume)
   VALUES (?,?,'NIFTY',?,26000,'CE',50,1000,1,12.5,10)`,
);
for (let i = 0; i < 2; i++) {
  const ts = `2026-10-0${5 + i}T06:00:00.000Z`; // older than the 30-day window
  const id = `snap-aged-${i}`;
  insSnap3.run(id, ts, 25000);
  insTick3.run(`tick-aged-${i}`, id, ts);
}
const before = {
  snaps: dbDaily.prepare("SELECT COUNT(*) c FROM market_snapshots").get().c,
  ticks: dbDaily.prepare("SELECT COUNT(*) c FROM chain_ticks").get().c,
};
dbDaily.close();

const DAILY_CUTOFF = "2026-11-01T02:00:00.000Z";
const dailyRun = runRetention("daily", NOW, { cutoffIso: DAILY_CUTOFF });
assert.strictEqual(dailyRun.aborted, false, "the daily run must not abort");
assert.ok(dailyRun.archive && dailyRun.archive.verified, "the tail archive must be verified");
assert.ok(dailyRun.archive.path.includes("tail_"), "the daily job must use the tail archive");
const db5 = new Database(DB_PATH, { readonly: true });
const after = {
  snaps: db5.prepare("SELECT COUNT(*) c FROM market_snapshots").get().c,
  ticks: db5.prepare("SELECT COUNT(*) c FROM chain_ticks").get().c,
};
db5.close();
assert.strictEqual(after.snaps, before.snaps - 2, "exactly the aged snapshots must go");
assert.strictEqual(after.ticks, before.ticks - 2, "exactly the aged ticks must go");

// the tail archive holds ONLY the rows that aged out
const { execFileSync: exec2 } = require("child_process");
exec2("gzip", ["-t", dailyRun.archive.path], { stdio: "ignore" });
const restoredTail = path.join(TMP, "restored-tail.db");
exec2("bash", ["-c", `gunzip -c "${dailyRun.archive.path}" > "${restoredTail}"`]);
const db6 = new Database(restoredTail, { readonly: true });
const tailRows = db6.prepare("SELECT COUNT(*) c FROM chain_ticks").get().c;
const tailAged = db6.prepare("SELECT COUNT(*) c FROM chain_ticks WHERE timestamp < ?").get(DAILY_CUTOFF).c;
db6.close();
assert.strictEqual(tailRows, tailAged, "the tail archive must contain only the aged-out rows");
assert.ok(tailAged > 0, "the tail archive must not be empty");
console.log("tail archive  :", dailyRun.archive.path, `${(dailyRun.archive.gzBytes / 1024).toFixed(1)}KB gz`);
console.log("tail rows     :", tailRows, "(all older than the cutoff)");
console.log("deleted       :", JSON.stringify(dailyRun.deleted));

// 7 — the archive really is restorable (gunzip + open)
section("archive integrity");
const { execFileSync } = require("child_process");
execFileSync("gzip", ["-t", run.archive.path], { stdio: "ignore" });
const restored = path.join(TMP, "restored.db");
execFileSync("bash", ["-c", `gunzip -c "${run.archive.path}" > "${restored}"`]);
const db3 = new Database(restored, { readonly: true });
const restoredRows = db3.prepare("SELECT COUNT(*) c FROM chain_ticks").get().c;
assert.strictEqual(restoredRows, 12, "the archive must hold the pre-delete rows");
console.log("restored rows  :", restoredRows);
db3.close();

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\nALL RETENTION SELF-TESTS PASSED");
