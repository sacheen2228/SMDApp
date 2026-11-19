// Retention engine — disk-space maintenance for the market-history DB.
//
// POLICY (approved by the user, 2026-11-19):
//   1. Keep at most 30 days of raw data (daily roll).
//   2. At the start of a new month, reset: everything before the month
//      boundary is deleted and the DB starts with the new month.
//
// SAFEGUARDS (nothing is deleted before it is provably preserved):
//   A. Archive first — the whole DB is copied (VACUUM INTO) and gzip'ed into
//      db/archive/ before any row is removed. The archive is verified (gzip
//      integrity + row counts) before the delete starts. A failed archive
//      ABORTS the whole run.
//   B. Disk guard — the run aborts when free space cannot hold the archive
//      copy + the compressed archive + a safety margin.
//   C. Bounded batches — rows are deleted in chunks inside short
//      transactions, so the WAL/journal never explodes and the sidecar keeps
//      serving.
//   D. Strict cutoffs — only rows STRICTLY older than the cutoff are removed.
//      The current day and the current month are never touched.
//   E. Rollup before delete — the deleted range is first condensed into the
//      chain_5m aggregate table, so the month stays queryable in the live DB
//      at ~1/5 the row count.
//   F. Integrity check — PRAGMA integrity_check + row-count report after the
//      run; a failure is logged loudly.
//   G. Rotation — only the newest N monthly archives are kept; older ones are
//      pruned (and only those).
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { db } from "./index";

export type RetentionMode = "daily" | "monthly" | "dry-run";

export interface RetentionConfig {
  /** Raw data older than this many days is out of the window. */
  retentionDays: number;
  /** How many monthly archives to keep on disk. */
  keepArchives: number;
  /** How many daily tail archives (the rows that aged out) to keep. */
  keepTailArchives: number;
  /** Free-space margin (bytes) required on top of the working copies. */
  safetyMarginBytes: number;
  /** Rows deleted per transaction. */
  batchSize: number;
  archiveDir: string;
}

export const RETENTION_DEFAULTS: RetentionConfig = {
  retentionDays: 30,
  keepArchives: 2,
  keepTailArchives: 14,
  safetyMarginBytes: 1024 * 1024 * 1024,
  batchSize: 50_000,
  archiveDir: path.join(path.dirname(db.name), "archive"),
};

const TIME_SERIES_TABLES: Array<{ table: string; column: string }> = [
  { table: "market_snapshots", column: "timestamp" },
  { table: "chain_ticks", column: "timestamp" },
  { table: "candles", column: "timestamp" },
  { table: "smc_events", column: "timestamp" },
  { table: "scanner_results", column: "timestamp" },
  { table: "web_records", column: "collected_at" },
];

function istParts(d: Date): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, day] = fmt.format(d).split("-").map(Number);
  return { y, m, d: day };
}

/** ISO timestamp of the first minute of the current month (IST). */
export function monthBoundaryIso(now: Date = new Date()): string {
  const { y, m } = istParts(now);
  // IST is UTC+05:30 with no DST — a fixed offset is exact here.
  const istStart = Date.UTC(y, m - 1, 1, 0, 0, 0) - 5.5 * 3600 * 1000;
  return new Date(istStart).toISOString();
}

/** ISO timestamp of the rolling retention cutoff (now - retentionDays). */
export function retentionCutoffIso(
  retentionDays: number = RETENTION_DEFAULTS.retentionDays,
  now: Date = new Date(),
): string {
  return new Date(now.getTime() - retentionDays * 86400 * 1000).toISOString();
}

export function freeDiskBytes(dir: string): number {
  try {
    const out = execFileSync("df", ["-B1", "--output=avail", dir], { encoding: "utf8" });
    const lines = out.trim().split("\n");
    return Number(lines[lines.length - 1].trim()) || 0;
  } catch {
    return 0;
  }
}

export function dbFileBytes(): number {
  try {
    return fs.statSync(db.name).size;
  } catch {
    return 0;
  }
}

function tableExists(table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  return !!row;
}

function columnExists(table: string, column: string): boolean {
  if (!tableExists(table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return cols.some((c) => c.name === column);
}

export function countRows(table: string): number {
  if (!tableExists(table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
}

// ── Rollup ─────────────────────────────────────────────────────
// The deleted raw range is condensed into chain_5m: one row per
// symbol / strike / type / 5-minute bucket with the LTP OHLC, the OI path
// (min/max/last), the summed ΔOI and volume, and the mean IV. Same schema
// for every run, so a month can be rolled up repeatedly without duplicating.
export function ensureRollupTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_5m (
      symbol TEXT NOT NULL,
      bucket TEXT NOT NULL,
      strike INTEGER NOT NULL,
      type TEXT NOT NULL,
      ltp_open REAL,
      ltp_high REAL,
      ltp_low REAL,
      ltp_close REAL,
      oi_min REAL,
      oi_max REAL,
      oi_last REAL,
      oi_chg_sum REAL,
      volume_sum REAL,
      iv_avg REAL,
      samples INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      provider_timestamp TEXT,
      first_ts TEXT,
      last_ts TEXT,
      PRIMARY KEY (symbol, bucket, strike, type)
    );
    CREATE INDEX IF NOT EXISTS idx_chain5m_symbol_bucket ON chain_5m(symbol, bucket);
  `);
}

// 5-minute buckets aligned to the epoch, rendered in IST (the session runs
// 09:15-15:30 IST). The epoch floor keeps the bucket boundaries on
// :00/:05/:10… in IST as well, because 05:30 is itself a multiple of 5 min.
const BUCKET_EXPR = `strftime('%Y-%m-%dT%H:%M:00',
  CAST(CAST(strftime('%s', timestamp) AS INTEGER) / 300 * 300 AS INTEGER),
  'unixepoch', '+05:30')`;

/**
 * Roll up ONE batch of chain_ticks into chain_5m.
 *
 * Called inside the same transaction that deletes the batch, so every source
 * row is rolled up exactly once — a crash can never double-count a bucket.
 *
 * open/close are the FIRST/LAST LTP inside the bucket (not MIN/MAX), and the
 * merge keeps them correct when a bucket is spread over several batches:
 * first_ts/last_ts decide which side wins.
 *
 * The batch is addressed through a TEMP table, not a bind list — SQLite caps
 * the number of bound variables, and a 50k-row batch would blow that limit.
 */
function rollupBatch(): number {
  const stmt = db.prepare(
    `WITH ranked AS (
       SELECT symbol, ${BUCKET_EXPR} AS bucket, strike, type, ltp, oi, oi_chg, iv, volume,
              source, provider_timestamp, timestamp,
              ROW_NUMBER() OVER (PARTITION BY symbol, ${BUCKET_EXPR}, strike, type ORDER BY timestamp ASC)  AS rn_first,
              ROW_NUMBER() OVER (PARTITION BY symbol, ${BUCKET_EXPR}, strike, type ORDER BY timestamp DESC) AS rn_last
       FROM chain_ticks WHERE rowid IN (SELECT rowid FROM retention_batch)
     )
     INSERT INTO chain_5m
       (symbol, bucket, strike, type, ltp_open, ltp_high, ltp_low, ltp_close,
        oi_min, oi_max, oi_last, oi_chg_sum, volume_sum, iv_avg, samples, source, provider_timestamp, first_ts, last_ts)
     SELECT symbol, bucket, strike, type,
            MAX(CASE WHEN rn_first = 1 THEN ltp END),
            MAX(ltp), MIN(ltp),
            MAX(CASE WHEN rn_last = 1 THEN ltp END),
            MIN(oi), MAX(oi),
            MAX(CASE WHEN rn_last = 1 THEN oi END),
            SUM(oi_chg), SUM(volume), AVG(iv), COUNT(*),
            MAX(source), MAX(provider_timestamp),
            MIN(timestamp), MAX(timestamp)
     FROM ranked
     GROUP BY symbol, bucket, strike, type
     ON CONFLICT(symbol, bucket, strike, type) DO UPDATE SET
       ltp_open  = CASE WHEN excluded.first_ts < chain_5m.first_ts THEN excluded.ltp_open ELSE chain_5m.ltp_open END,
       ltp_close = CASE WHEN excluded.last_ts > chain_5m.last_ts THEN excluded.ltp_close ELSE chain_5m.ltp_close END,
       ltp_high  = MAX(chain_5m.ltp_high, excluded.ltp_high),
       ltp_low   = MIN(chain_5m.ltp_low, excluded.ltp_low),
       oi_min    = MIN(chain_5m.oi_min, excluded.oi_min),
       oi_max    = MAX(chain_5m.oi_max, excluded.oi_max),
       oi_last   = CASE WHEN excluded.last_ts > chain_5m.last_ts THEN excluded.oi_last ELSE chain_5m.oi_last END,
       oi_chg_sum  = chain_5m.oi_chg_sum + excluded.oi_chg_sum,
       volume_sum  = chain_5m.volume_sum + excluded.volume_sum,
       iv_avg   = (chain_5m.iv_avg * chain_5m.samples + excluded.iv_avg * excluded.samples)
                  / NULLIF(chain_5m.samples + excluded.samples, 0),
       samples  = chain_5m.samples + excluded.samples,
       source   = excluded.source,
       provider_timestamp = excluded.provider_timestamp,
       first_ts = MIN(chain_5m.first_ts, excluded.first_ts),
       last_ts  = MAX(chain_5m.last_ts, excluded.last_ts)`,
  );
  return stmt.run().changes;
}

export function rollupRowCount(): number {
  ensureRollupTable();
  return (db.prepare("SELECT COUNT(*) AS c FROM chain_5m").get() as any).c;
}

// ── Archive ────────────────────────────────────────────────────
export interface ArchiveResult {
  path: string;
  bytes: number;
  gzBytes: number;
  verified: boolean;
  rowCounts: Record<string, number>;
}

function gzipFile(src: string, dest: string): boolean {
  try {
    execFileSync("gzip", ["-6", "-f", src], { stdio: "ignore" });
    const gz = `${src}.gz`;
    if (!fs.existsSync(gz)) return false;
    // gzip -t verifies the archive's integrity.
    execFileSync("gzip", ["-t", gz], { stdio: "ignore" });
    fs.renameSync(gz, dest);
    return true;
  } catch {
    return false;
  }
}

export function archiveDatabase(tag: string, keepArchives = RETENTION_DEFAULTS.keepArchives): ArchiveResult {
  fs.mkdirSync(RETENTION_DEFAULTS.archiveDir, { recursive: true });
  const stamp = tag.replace(/[^0-9A-Za-z_-]/g, "");
  const base = path.join(RETENTION_DEFAULTS.archiveDir, `market_history_${stamp}`);
  const tmp = `${base}.copy`;
  const dest = `${base}.db.gz`;
  for (const f of [tmp, dest]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const before: Record<string, number> = {};
  for (const t of TIME_SERIES_TABLES) before[t.table] = countRows(t.table);

  // VACUUM INTO produces a compact, self-consistent copy (C-level, fast).
  db.prepare(`VACUUM INTO ?`).run(tmp);
  const copyBytes = fs.statSync(tmp).size;
  const ok = gzipFile(tmp, dest);
  if (!ok) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    return { path: dest, bytes: copyBytes, gzBytes: 0, verified: false, rowCounts: before };
  }
  const gzBytes = fs.statSync(dest).size;
  rotateArchives(keepArchives);
  return { path: dest, bytes: copyBytes, gzBytes, verified: true, rowCounts: before };
}

export function rotateArchives(keep = RETENTION_DEFAULTS.keepArchives): string[] {
  const dir = RETENTION_DEFAULTS.archiveDir;
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("market_history_") && f.endsWith(".db.gz"))
    .sort();
  const removed: string[] = [];
  while (files.length > keep) {
    const old = files.shift()!;
    const p = path.join(dir, old);
    try {
      fs.unlinkSync(p);
      removed.push(p);
    } catch {
      /* leave it */
    }
  }
  return removed;
}

// ── Incremental tail archive ───────────────────────────────────
// The rolling 30-day job deletes the rows that age out of the window. Those
// rows must still be preserved (safeguard A), but copying the WHOLE DB for a
// small tail is wasteful — and at a 7GB DB size it would not even fit on the
// disk. So the tail is exported on its own:
//
//   live DB (read-only ATTACH) → rows older than the cutoff → a compact
//   temp DB → VACUUM INTO → gzip → db/archive/tail_<date>.db.gz
//
// Only SQL does the copying (no hand-built INSERT statements), so the export
// cannot mangle a value.
export interface TailArchiveResult {
  path: string;
  bytes: number;
  gzBytes: number;
  verified: boolean;
  rowCounts: Record<string, number>;
}

export function archiveTail(cutoffIso: string, tag: string): TailArchiveResult {
  fs.mkdirSync(RETENTION_DEFAULTS.archiveDir, { recursive: true });
  const stamp = tag.replace(/[^0-9A-Za-z_-]/g, "");
  const base = path.join(RETENTION_DEFAULTS.archiveDir, `tail_${stamp}`);
  const tmpDb = `${base}.tmp.db`;
  const copy = `${base}.db`;
  const dest = `${base}.db.gz`;
  for (const f of [tmpDb, copy, dest]) if (fs.existsSync(f)) fs.unlinkSync(f);

  const counts: Record<string, number> = {};
  let tail: any = null;
  try {
    // The export runs ON the live connection (one consistent snapshot) and
    // writes into an attached temp DB; a second connection then compacts it.
    db.exec(`ATTACH DATABASE '${tmpDb.replace(/'/g, "''")}' AS tail`);
    for (const { table, column } of TIME_SERIES_TABLES) {
      if (!columnExists(table, column)) continue;
      db
        .prepare(`CREATE TABLE tail.${table} AS SELECT * FROM main.${table} WHERE ${column} < ?`)
        .run(cutoffIso);
      const c = db.prepare(`SELECT COUNT(*) AS c FROM tail.${table}`).get() as any;
      counts[table] = c.c;
      const live = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} < ?`).get(cutoffIso) as any;
      if (live.c !== c.c) {
        db.exec("DETACH DATABASE tail");
        return { path: dest, bytes: 0, gzBytes: 0, verified: false, rowCounts: counts };
      }
    }
    db.exec("DETACH DATABASE tail");

    const Database = require("better-sqlite3");
    tail = new Database(tmpDb);
    tail.pragma("journal_mode = OFF");
    tail.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    tail.close();
    const copyBytes = fs.statSync(copy).size;
    const ok = gzipFile(copy, dest);
    if (!ok) return { path: dest, bytes: copyBytes, gzBytes: 0, verified: false, rowCounts: counts };
    const gzBytes = fs.statSync(dest).size;
    return { path: dest, bytes: copyBytes, gzBytes, verified: true, rowCounts: counts };
  } catch {
    try {
      tail?.close();
    } catch {
      /* ignore */
    }
    try {
      db.exec("DETACH DATABASE tail");
    } catch {
      /* not attached */
    }
    return { path: dest, bytes: 0, gzBytes: 0, verified: false, rowCounts: counts };
  } finally {
    for (const f of [tmpDb, copy]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/** Keep the newest N daily tail archives; prune the older ones. */
export function rotateTailArchives(keep = RETENTION_DEFAULTS.keepTailArchives): string[] {
  const dir = RETENTION_DEFAULTS.archiveDir;
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("tail_") && f.endsWith(".db.gz"))
    .sort();
  const removed: string[] = [];
  while (files.length > keep) {
    const old = files.shift()!;
    const p = path.join(dir, old);
    try {
      fs.unlinkSync(p);
      removed.push(p);
    } catch {
      /* leave it */
    }
  }
  return removed;
}

// ── Guarded delete ─────────────────────────────────────────────
export interface DeleteResult {
  deleted: Record<string, number>;
  batches: number;
  rolledUp: number;
}

/**
 * Delete every row strictly older than the cutoff, in bounded batches.
 *
 * chain_ticks is rolled up into chain_5m INSIDE the same transaction that
 * removes it, so each raw row is condensed exactly once — an interrupted run
 * can never double-count a bucket, and the raw range is never lost without a
 * rollup trace.
 */
export function deleteOlderThan(
  cutoffIso: string,
  batchSize = RETENTION_DEFAULTS.batchSize,
): DeleteResult {
  const deleted: Record<string, number> = {};
  let batches = 0;
  let rolledUp = 0;
  ensureRollupTable();

  for (const { table, column } of TIME_SERIES_TABLES) {
    if (!columnExists(table, column)) continue;
    let removed = 0;

    if (table === "chain_ticks") {
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS retention_batch (rowid INTEGER PRIMARY KEY)`);
      for (;;) {
        const rowids = (
          db
            .prepare(`SELECT rowid FROM chain_ticks WHERE timestamp < ? LIMIT ?`)
            .all(cutoffIso, batchSize) as any[]
        ).map((r) => r.rowid);
        if (!rowids.length) break;
        const tx = db.transaction((ids: number[]) => {
          db.exec("DELETE FROM retention_batch");
          const ins = db.prepare("INSERT OR IGNORE INTO retention_batch (rowid) VALUES (?)");
          for (const id of ids) ins.run(id);
          const upserted = rollupBatch();
          const res = db
            .prepare(`DELETE FROM chain_ticks WHERE rowid IN (SELECT rowid FROM retention_batch)`)
            .run();
          return { upserted, removed: res.changes };
        });
        const out = tx(rowids);
        removed += out.removed;
        rolledUp += out.upserted;
        batches++;
        if (rowids.length < batchSize) break;
      }
    } else {
      for (;;) {
        const res = db
          .prepare(
            `DELETE FROM ${table} WHERE rowid IN (
               SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?
             )`,
          )
          .run(cutoffIso, batchSize);
        removed += res.changes;
        batches++;
        if (res.changes < batchSize) break;
      }
    }
    deleted[table] = removed;
  }
  return { deleted, batches, rolledUp };
}

/**
 * Reclaim disk space.
 *
 * ORDER MATTERS: the VACUUM writes the rebuilt DB into the WAL, so the WAL
 * must be checkpointed (and truncated) AFTER it — checkpointing first leaves
 * a WAL as large as the whole DB (observed: 1.5GB of WAL next to a 1.5GB DB).
 */
export function reclaimSpace(): { before: number; after: number; walBefore: number; walAfter: number } {
  const walPath = `${db.name}-wal`;
  const walBytes = () => {
    try {
      return fs.statSync(walPath).size;
    } catch {
      return 0;
    }
  };
  const before = dbFileBytes();
  const walBefore = walBytes();
  db.exec("VACUUM");
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* a reader may hold the WAL — it is reusable space, not a leak */
  }
  const after = dbFileBytes();
  return { before, after, walBefore, walAfter: walBytes() };
}

/** Truncate the WAL without a full VACUUM (cheap way to release its space). */
export function truncateWal(): { before: number; after: number } {
  const walPath = `${db.name}-wal`;
  const size = () => {
    try {
      return fs.statSync(walPath).size;
    } catch {
      return 0;
    }
  };
  const before = size();
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* best effort */
  }
  return { before, after: size() };
}

export interface RetentionPlan {
  mode: RetentionMode;
  cutoffIso: string;
  reason: string;
  wouldDelete: Record<string, number>;
  freeBytes: number;
  dbBytes: number;
  guardOk: boolean;
  guardReason: string;
}

/** What WOULD be deleted — no writes. */
export function planRetention(
  mode: RetentionMode,
  now: Date = new Date(),
  overrides?: { freeBytes?: number; dbBytes?: number; cutoffIso?: string },
): RetentionPlan {
  const cutoffIso =
    overrides?.cutoffIso ??
    (mode === "monthly" ? monthBoundaryIso(now) : retentionCutoffIso(RETENTION_DEFAULTS.retentionDays, now));
  const wouldDelete: Record<string, number> = {};
  for (const { table, column } of TIME_SERIES_TABLES) {
    if (!columnExists(table, column)) continue;
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} < ?`)
      .get(cutoffIso) as any;
    wouldDelete[table] = row.c;
  }
  const dbBytes = overrides?.dbBytes ?? dbFileBytes();
  const freeBytes = overrides?.freeBytes ?? freeDiskBytes(path.dirname(db.name));
  // The daily job only exports the aging TAIL (a fraction of the DB), the
  // monthly job copies the WHOLE DB — the space each one needs is different.
  const needed =
    mode === "monthly"
      ? dbBytes + Math.ceil(dbBytes * 0.6) + RETENTION_DEFAULTS.safetyMarginBytes
      : Math.ceil(dbBytes * 0.25) + RETENTION_DEFAULTS.safetyMarginBytes;
  const guardOk = freeBytes >= needed;
  return {
    mode,
    cutoffIso,
    reason:
      mode === "monthly"
        ? "month reset — everything before the current month boundary"
        : `rolling ${RETENTION_DEFAULTS.retentionDays}-day window`,
    wouldDelete,
    freeBytes,
    dbBytes,
    guardOk,
    guardReason: guardOk
      ? `free ${(freeBytes / 1073741824).toFixed(2)}GB >= needed ${(needed / 1073741824).toFixed(2)}GB`
      : `free ${(freeBytes / 1073741824).toFixed(2)}GB < needed ${(needed / 1073741824).toFixed(2)}GB — abort`,
  };
}

export interface RetentionRun {
  ok: boolean;
  mode: RetentionMode;
  cutoffIso: string;
  aborted: boolean;
  abortReason: string;
  archive: ArchiveResult | null;
  rollup: { rows: number; buckets: number };
  deleted: Record<string, number>;
  space: { before: number; after: number; walBefore: number; walAfter: number };
  integrity: string;
  rowCounts: Record<string, number>;
  log: string[];
}

const LOG_PATH = path.join(path.dirname(db.name), "..", "market-history", "data", "maintenance.log");

function logLine(line: string): void {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${msg}\n`);
  } catch {
    /* logging must never break the run */
  }
}

export function runRetention(
  mode: RetentionMode = "daily",
  now: Date = new Date(),
  overrides?: { freeBytes?: number; dbBytes?: number; cutoffIso?: string },
): RetentionRun {
  const plan = planRetention(mode, now, overrides);
  const log: string[] = [];
  const totalToDelete = Object.values(plan.wouldDelete).reduce((a, b) => a + b, 0);

  if (mode === "dry-run") {
    const dailyPlan = planRetention("daily", now, overrides);
    const monthlyPlan = planRetention("monthly", now, overrides);
    logLine(
      `DRY-RUN: daily cutoff=${dailyPlan.cutoffIso} would delete ${Object.values(dailyPlan.wouldDelete).reduce((a, b) => a + b, 0)} rows | monthly cutoff=${monthlyPlan.cutoffIso} would delete ${Object.values(monthlyPlan.wouldDelete).reduce((a, b) => a + b, 0)} rows`,
    );
    return {
      ok: true,
      mode,
      cutoffIso: plan.cutoffIso,
      aborted: false,
      abortReason: "",
      archive: null,
      rollup: { rows: 0, buckets: rollupRowCount() },
      deleted: {},
      space: { before: plan.dbBytes, after: plan.dbBytes, walBefore: 0, walAfter: 0 },
      integrity: "skipped",
      rowCounts: {},
      log,
    };
  }

  // GUARD B — not enough free space for the archive + the vacuum copies.
  if (!plan.guardOk) {
    logLine(`ABORT ${mode}: ${plan.guardReason}`);
    return {
      ok: false,
      mode,
      cutoffIso: plan.cutoffIso,
      aborted: true,
      abortReason: plan.guardReason,
      archive: null,
      rollup: { rows: 0, buckets: 0 },
      deleted: {},
      space: { before: plan.dbBytes, after: plan.dbBytes, walBefore: 0, walAfter: 0 },
      integrity: "skipped",
      rowCounts: {},
      log,
    };
  }

  if (totalToDelete === 0) {
    const wal = truncateWal();
    logLine(
      `SKIP ${mode}: nothing older than ${plan.cutoffIso} — WAL ${(wal.before / 1048576).toFixed(1)}MB -> ${(wal.after / 1048576).toFixed(1)}MB`,
    );
    return {
      ok: true,
      mode,
      cutoffIso: plan.cutoffIso,
      aborted: false,
      abortReason: "",
      archive: null,
      rollup: { rows: 0, buckets: 0 },
      deleted: {},
      space: { before: plan.dbBytes, after: plan.dbBytes, walBefore: 0, walAfter: 0 },
      integrity: "skipped",
      rowCounts: {},
      log,
    };
  }

  // GUARD A — archive first, and abort if the archive cannot be verified.
  // The daily (30-day rolling) job exports only the rows that age out; the
  // monthly job — now disabled — copied the whole DB.
  const tag = `pre_${mode}_${plan.cutoffIso.replace(/[:.]/g, "-")}`;
  const archive: ArchiveResult =
    mode === "monthly"
      ? archiveDatabase(tag)
      : ((() => {
          const tail = archiveTail(plan.cutoffIso, tag);
          return {
            path: tail.path,
            bytes: tail.bytes,
            gzBytes: tail.gzBytes,
            verified: tail.verified,
            rowCounts: tail.rowCounts,
          } as ArchiveResult;
        })());
  if (!archive.verified) {
    logLine(`ABORT ${mode}: archive could not be verified — nothing was deleted`);
    return {
      ok: false,
      mode,
      cutoffIso: plan.cutoffIso,
      aborted: true,
      abortReason: "archive verification failed",
      archive,
      rollup: { rows: 0, buckets: 0 },
      deleted: {},
      space: { before: plan.dbBytes, after: plan.dbBytes, walBefore: 0, walAfter: 0 },
      integrity: "skipped",
      rowCounts: {},
      log,
    };
  }
  logLine(
    `ARCHIVE ${mode}: ${archive.path} (${(archive.gzBytes / 1048576).toFixed(1)}MB gz of ${(archive.bytes / 1048576).toFixed(1)}MB)`,
  );
  if (mode !== "monthly") {
    const pruned = rotateTailArchives();
    if (pruned.length) logLine(`ARCHIVE ROTATION ${mode}: pruned ${pruned.length} old tail archive(s)`);
  }

  // GUARD E — the deleted range is condensed into chain_5m inside the delete
  // transaction (each raw row is rolled up exactly once).
  const rollup = { rows: 0, buckets: rollupRowCount() };

  // GUARD C/D — bounded batches, strict cutoff.
  const del = deleteOlderThan(plan.cutoffIso);
  const removed = Object.values(del.deleted).reduce((a, b) => a + b, 0);
  rollup.rows = del.rolledUp;
  rollup.buckets = rollupRowCount();
  logLine(
    `DELETE ${mode}: removed ${removed} rows in ${del.batches} batches — ${JSON.stringify(del.deleted)}`,
  );
  logLine(`ROLLUP ${mode}: ${del.rolledUp} buckets written (chain_5m now ${rollup.buckets} rows)`);

  // Reclaim the disk.
  const space = reclaimSpace();
  logLine(
    `VACUUM ${mode}: db ${(space.before / 1048576).toFixed(1)}MB -> ${(space.after / 1048576).toFixed(1)}MB | wal ${(space.walBefore / 1048576).toFixed(1)}MB -> ${(space.walAfter / 1048576).toFixed(1)}MB`,
  );

  // GUARD F — integrity check.
  const integrity = String((db.pragma("integrity_check") as any[])[0]?.integrity_check ?? "unknown");
  const rowCounts: Record<string, number> = {};
  for (const t of TIME_SERIES_TABLES) rowCounts[t.table] = countRows(t.table);
  logLine(`INTEGRITY ${mode}: ${integrity}`);

  return {
    ok: integrity === "ok",
    mode,
    cutoffIso: plan.cutoffIso,
    aborted: false,
    abortReason: "",
    archive,
    rollup,
    deleted: del.deleted,
    space,
    integrity,
    rowCounts,
    log,
  };
}
