// Wave 3a — market-history multi-interval snapshot reader.
//
// The Daily Derivatives engine needs the SAME contract's value NOW and at
// 1 / 3 / 5 / 15 / 30 minutes ago (OI, ΔOI, premium, volume, IV) plus the
// PCR / Max-Pain history. These tests pin the reader's alignment rules:
//
//   · same expiry, same strike, same option type only
//   · NO LOOK-AHEAD — a past value is always strictly older than the as-of
//   · a missing interval is null — never interpolated, never carried forward
//   · the coverage report states what was seen and what was excluded
//
// OFFLINE ONLY. The fixture lives in a TEMP sqlite file under os.tmpdir();
// the live market-history DB is never opened, never written and never
// migrated by this suite.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";

const ROOT = process.cwd();
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dd-market-history-"));
const TMP_DB = path.join(TMP_DIR, "market_history.db");
const SCHEMA_DB = path.join(TMP_DIR, "schema_probe.db");

// The reader resolves the DB path LAZILY (at first use), so the env var only
// has to be set before the first call — but it is set here too so an early
// import can never touch the live DB.
process.env.MARKET_HISTORY_DB = TMP_DB;

import {
  readChainHistory,
  READER_SCHEMA_SQL,
  normalizeExpiry,
  sessionWindowFor,
} from "@/lib/market-history/chain-history";

// ── Fixture constants ────────────────────────────────────────────
// 2026-11-26 is a session day. 09:15 IST = 03:45Z, 10:00 IST = 04:30Z.
const SESSION_OPEN_UTC = Date.parse("2026-11-26T03:45:00.000Z");
const ASOF = "2026-11-26T04:30:00.000Z"; // 10:00 IST
const STRIKE = 24500;
const EXPIRY = "26-Nov-2026"; // the form the caller asks for
const EXPIRY_STORED = "2026-11-26"; // a DIFFERENT form of the SAME expiry
const EXPIRY_OTHER = "02-Dec-2026"; // a genuinely different contract

function at(minutesFromOpen: number): string {
  return new Date(SESSION_OPEN_UTC + minutesFromOpen * 60_000).toISOString();
}

/** Per-minute synthetic values for the main (NIFTY) fixture. */
function legValues(m: number) {
  return {
    oi: 1000 + 10 * m,
    oiChg: 10 * m,
    ltp: 100 + m,
    volume: 500 + 100 * m,
    iv: 10 + 0.5 * m,
    delta: 0.5,
  };
}

interface SeedOpts {
  symbol: string;
  minutes: number[];
  expiry?: string;
  bogusExpiry?: boolean;
  source?: string;
  spot?: number | number[];
  pcr?: boolean;
  futureRows?: number;
  skip?: number[];
}

function seed(db: Database, o: SeedOpts): void {
  const expiry = o.expiry ?? EXPIRY_STORED;
  const source = o.source ?? "icici-breeze";
  const skip = new Set(o.skip ?? []);
  const insertSnap = db.prepare(
    `INSERT OR REPLACE INTO market_snapshots
       (id, symbol, timestamp, spot, pcr_oi, pcr_vol, max_pain, source)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insertLeg = db.prepare(
    `INSERT OR REPLACE INTO chain_ticks
       (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, delta,
        volume, expiry, provider_timestamp, source, is_estimated, bid, ask)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const write = (m: number, ts: string, spot: number) => {
    const id = `${o.symbol}-${ts}`;
    insertSnap.run(
      id,
      o.symbol,
      ts,
      spot,
      o.pcr === false ? null : 0.8 + 0.001 * m,
      o.pcr === false ? null : 1.1 + 0.002 * m,
      o.pcr === false ? null : 25600,
      source,
    );
    const v = legValues(m);
    for (const type of ["CE", "PE"] as const) {
      insertLeg.run(
        `${id}-${expiry}-${STRIKE}-${type}`,
        id,
        o.symbol,
        ts,
        STRIKE,
        type,
        v.ltp,
        v.oi,
        v.oiChg,
        v.iv,
        v.delta,
        v.volume,
        expiry,
        ts,
        source,
        0,
        v.ltp - 0.5,
        v.ltp + 0.5,
      );
    }
    if (o.bogusExpiry) {
      // The SAME strike and type on a DIFFERENT expiry — must never be
      // compared, no matter how extreme its numbers are.
      insertLeg.run(
        `${id}-${EXPIRY_OTHER}-${STRIKE}-CE`,
        id,
        o.symbol,
        ts,
        STRIKE,
        "CE",
        9999,
        999999,
        999999,
        99,
        0.9,
        999999,
        EXPIRY_OTHER,
        ts,
        source,
        0,
        9998,
        9999,
      );
    }
  };

  for (const m of o.minutes) {
    if (skip.has(m)) continue;
    const ts = at(m);
    const spot = Array.isArray(o.spot) ? o.spot[m] ?? 25600 : o.spot ?? 25600;
    write(m, ts, spot);
  }
  // Look-ahead bait: rows recorded AFTER the as-of timestamp.
  for (let i = 1; i <= (o.futureRows ?? 0); i++) {
    const ts = new Date(Date.parse(ASOF) + i * 60_000).toISOString();
    write(60 + i, ts, 99999);
  }
}

beforeAll(() => {
  process.env.MARKET_HISTORY_DB = TMP_DB;
  const db = new Database(TMP_DB, { create: true });
  db.exec(READER_SCHEMA_SQL);
  // ── NIFTY: a complete 09:15→10:00 IST session, one minute apart.
  seed(db, { symbol: "NIFTY", minutes: Array.from({ length: 46 }, (_, i) => i), bogusExpiry: true, futureRows: 2 });

  // ── GAPTEST: the same session with a hole around 09:45 IST. The last
  //    snapshot before the 15-minute target (09:45) is 09:42 → 180 s old,
  //    beyond the 120 s staleness bound → the 15-minute interval is null.
  seed(db, {
    symbol: "GAPTEST",
    minutes: Array.from({ length: 46 }, (_, i) => i),
    skip: [28, 29, 30, 31, 32, 33, 34], // 09:43 … 09:49 IST
  });

  // ── NOPCR: recorded, but with no PCR / Max-Pain in market_snapshots.
  seed(db, { symbol: "NOPCR", minutes: Array.from({ length: 46 }, (_, i) => i), pcr: false });

  // ── STALE: yesterday only. Nothing inside today's session.
  const yesterday = db.prepare(
    `INSERT OR REPLACE INTO market_snapshots
       (id, symbol, timestamp, spot, pcr_oi, pcr_vol, max_pain, source)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const yLeg = db.prepare(
    `INSERT OR REPLACE INTO chain_ticks
       (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, delta,
        volume, expiry, provider_timestamp, source, is_estimated, bid, ask)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let m = 0; m < 46; m++) {
    const ts = new Date(SESSION_OPEN_UTC - 86_400_000 + m * 60_000).toISOString();
    const id = `STALE-${ts}`;
    yesterday.run(id, "STALE", ts, 25000, 0.9, 1.2, 25100, "icici-breeze");
    const v = legValues(m);
    yLeg.run(
      `${id}-${EXPIRY_STORED}-${STRIKE}-CE`, id, "STALE", ts, STRIKE, "CE",
      v.ltp, v.oi, v.oiChg, v.iv, v.delta, v.volume, EXPIRY_STORED, ts, "icici-breeze", 0,
      v.ltp - 0.5, v.ltp + 0.5,
    );
  }

  // ── MIXED: the provider flips between two lineages minute by minute.
  seed(db, { symbol: "MIXED", minutes: Array.from({ length: 46 }, (_, i) => i), source: "icici-breeze" });
  seed(db, { symbol: "MIXED", minutes: [44], source: "nse-api" });

  db.close();
}, 30_000);

afterAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`, SCHEMA_DB, `${SCHEMA_DB}-wal`, `${SCHEMA_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  if (process.env.MARKET_HISTORY_DB === TMP_DB) delete process.env.MARKET_HISTORY_DB;
}, 30_000);

function nifty(over: Record<string, unknown> = {}) {
  return readChainHistory({
    symbol: "NIFTY",
    expiry: EXPIRY,
    strike: STRIKE,
    optionType: "CE",
    asOf: ASOF,
    ...over,
  });
}

describe("Wave 3a — interval alignment helpers", () => {
  test("expiry strings from every recorded provider format normalize to one key", () => {
    expect(normalizeExpiry("26-Nov-2026")).toBe("2026-11-26");
    expect(normalizeExpiry("2026-11-26")).toBe("2026-11-26");
    expect(normalizeExpiry("26 Nov 2026")).toBe("2026-11-26");
    expect(normalizeExpiry("2026-12-01")).toBe("2026-12-01");
    expect(normalizeExpiry("01-Dec-2026")).toBe("2026-12-01");
    expect(normalizeExpiry(null)).toBeNull();
    expect(normalizeExpiry("not-a-date")).toBeNull();
  });

  test("the session window is the IST trading day of the as-of timestamp", () => {
    const s = sessionWindowFor(ASOF);
    expect(s.timezone).toBe("IST");
    expect(s.date).toBe("2026-11-26");
    expect(s.start).toBe("2026-11-26T03:45:00.000Z");
    expect(s.end).toBe("2026-11-26T10:00:00.000Z");
  });
});

describe("Wave 3a — the 1/3/5/15/30-minute reader", () => {
  test("1 — returns the change in OI, ΔOI, premium, volume and IV for every interval", () => {
    const res = nifty();

    expect(res.current).not.toBeNull();
    expect(res.current?.timestamp).toBe(ASOF);
    expect(res.current?.oi).toBe(1450);
    expect(res.current?.ltp).toBe(145);
    expect(res.current?.iv).toBe(32.5);

    const expected: Record<number, { oi: number; premium: number; volume: number; iv: number }> = {
      1: { oi: 10, premium: 1, volume: 100, iv: 0.5 },
      3: { oi: 30, premium: 3, volume: 300, iv: 1.5 },
      5: { oi: 50, premium: 5, volume: 500, iv: 2.5 },
      15: { oi: 150, premium: 15, volume: 1500, iv: 7.5 },
      30: { oi: 300, premium: 30, volume: 3000, iv: 15 },
    };

    for (const [mins, exp] of Object.entries(expected)) {
      const it = res.intervals[mins];
      expect(it).toBeDefined();
      expect(it.status).toBe("available");
      expect(it.reason).toBeNull();
      expect(it.past).not.toBeNull();
      expect(it.change?.oi).toBeCloseTo(exp.oi, 6);
      expect(it.change?.oiChg).toBeCloseTo(exp.oi, 6);
      expect(it.change?.premium).toBeCloseTo(exp.premium, 6);
      expect(it.change?.volume).toBeCloseTo(exp.volume, 6);
      expect(it.change?.iv).toBeCloseTo(exp.iv, 6);
    }
  });

  test("2 — a snapshot on a different expiry is excluded and never compared", () => {
    const res = nifty();
    // The bait rows carry oi = 999999 — if they leaked in, the change would
    // be nonsense. The real contract's numbers must come through untouched.
    expect(res.current?.oi).toBe(1450);
    expect(res.intervals["1"].change?.oi).toBe(10);
    expect(res.intervals["30"].change?.oi).toBe(300);
    for (const mins of Object.keys(res.intervals)) {
      expect(res.intervals[mins].past?.expiry).not.toBe(EXPIRY_OTHER);
    }
    const reasons = res.coverage.excluded.map((e) => e.reason);
    expect(reasons).toContain("expiry_mismatch");
    const mismatch = res.coverage.excluded.find((e) => e.reason === "expiry_mismatch");
    expect(mismatch?.count).toBeGreaterThan(0);
  });

  test("3 — a snapshot NEWER than the as-of time is never used (no look-ahead)", () => {
    const res = nifty();
    expect(res.current!.timestamp <= ASOF).toBe(true);
    expect(res.current?.oi).toBe(1450);
    expect(res.current?.spot).toBe(25600);
    for (const mins of Object.keys(res.intervals)) {
      const ts = res.intervals[mins].past?.timestamp;
      if (ts) expect(ts < ASOF).toBe(true);
      expect(res.intervals[mins].change?.oi).not.toBe(999999);
    }
  });

  test("4 — a missing interval is null: never interpolated, never carried forward", () => {
    const res = readChainHistory({
      symbol: "GAPTEST",
      expiry: EXPIRY,
      strike: STRIKE,
      optionType: "CE",
      asOf: ASOF,
    });
    // The hole sits around the 15-minute target (09:45 IST).
    expect(res.intervals["15"].status).toBe("missing");
    expect(res.intervals["15"].past).toBeNull();
    expect(res.intervals["15"].change).toBeNull();
    expect(res.intervals["15"].reason).toBeTruthy();
    // The intervals whose target survived the hole still work.
    expect(res.intervals["1"].status).toBe("available");
    expect(res.intervals["5"].status).toBe("available");
    expect(res.intervals["30"].status).toBe("available");
    expect(res.intervals["5"].change?.oi).toBeCloseTo(50, 6);
  });

  test("5 — PCR and Max Pain history comes back when recorded, null when not", () => {
    const withPcr = nifty();
    expect(withPcr.pcrOi.current?.value).toBeCloseTo(0.8 + 0.045, 6);
    expect(withPcr.pcrOi.intervals["5"].status).toBe("available");
    expect(withPcr.pcrOi.intervals["5"].value).toBeCloseTo(0.8 + 0.04, 6);
    expect(withPcr.pcrOi.intervals["5"].change).toBeCloseTo(0.005, 6);
    expect(withPcr.maxPain.current?.value).toBe(25600);
    expect(withPcr.maxPain.intervals["15"].value).toBe(25600);
    expect(withPcr.pcrVol.intervals["3"].value).toBeCloseTo(1.1 + 0.084, 6);

    const withoutPcr = readChainHistory({
      symbol: "NOPCR",
      expiry: EXPIRY,
      strike: STRIKE,
      optionType: "CE",
      asOf: ASOF,
    });
    expect(withoutPcr.pcrOi.current?.value ?? null).toBeNull();
    expect(withoutPcr.pcrOi.intervals["5"].value ?? null).toBeNull();
    expect(withoutPcr.maxPain.current?.value ?? null).toBeNull();
    expect(withoutPcr.maxPain.intervals["5"].value ?? null).toBeNull();
  });

  test("6 — the coverage report states the snapshots, their age range and the exclusions", () => {
    const res = nifty();
    expect(res.coverage.symbol).toBe("NIFTY");
    expect(res.coverage.snapshotsInWindow).toBeGreaterThan(0);
    expect(res.coverage.chainRowsInWindow).toBeGreaterThan(0);
    expect(res.coverage.ageMs.min).not.toBeNull();
    expect(res.coverage.ageMs.max).not.toBeNull();
    expect(res.coverage.ageMs.max).toBeGreaterThanOrEqual(res.coverage.ageMs.min!);
    expect(Object.keys(res.coverage.sourceMix)).toContain("icici-breeze");
    expect(res.coverage.excludedTotal).toBeGreaterThan(0);
    for (const e of res.coverage.excluded) {
      expect(typeof e.reason).toBe("string");
      expect(e.count).toBeGreaterThan(0);
    }
    // The session is stated explicitly, so a consumer never has to guess
    // which trading day the numbers belong to.
    expect(res.coverage.session.date).toBe("2026-11-26");
    expect(res.session.start).toBe("2026-11-26T03:45:00.000Z");
    expect(res.session.end).toBe("2026-11-26T10:00:00.000Z");
  });

  test("a snapshot from another session is never compared with one inside this session", () => {
    const res = readChainHistory({
      symbol: "STALE",
      expiry: EXPIRY,
      strike: STRIKE,
      optionType: "CE",
      asOf: ASOF,
    });
    expect(res.current).toBeNull();
    expect(res.currentReason).toBeTruthy();
    for (const mins of Object.keys(res.intervals)) {
      expect(res.intervals[mins].status).toBe("missing");
      expect(res.intervals[mins].past).toBeNull();
    }
  });

  test("the provider lineage is part of the alignment — a mixed-source minute is not compared", () => {
    const res = readChainHistory({
      symbol: "MIXED",
      expiry: EXPIRY,
      strike: STRIKE,
      optionType: "CE",
      asOf: ASOF,
    });
    // The 09:59 row came from a different lineage; the reader falls back to
    // the newest SAME-lineage row inside the staleness window.
    const one = res.intervals["1"];
    expect(one.status).toBe("available");
    expect(one.past?.source).toBe("icici-breeze");
    expect(res.current?.source).toBe("icici-breeze");
  });

  test("the rules that produced the numbers are always stated", () => {
    const res = nifty();
    expect(res.policy.sourcePolicy).toBe("exact");
    expect(res.policy.referenceMode).toBe("exclude");
    expect(res.policy.referenceTolerancePct).toBe(1);
    expect(res.policy.maxStalenessMs).toBe(120_000);
    expect(res.policy.intervals).toEqual([1, 3, 5, 15, 30]);
    expect(res.policy.allowUnknownExpiry).toBe(false);
  });
});

describe("Wave 3a — the reader survives the pre-migration schema", () => {
  test("a chain_ticks table WITHOUT the book columns still reads (no bid/ask → null)", () => {
    const oldDb = path.join(TMP_DIR, "pre_migration.db");
    const db = new Database(oldDb, { create: true });
    // The pre-change shape of the two tables.
    db.exec(`
      CREATE TABLE market_snapshots (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, timestamp TEXT NOT NULL,
        spot REAL, pcr_oi REAL, pcr_vol REAL, max_pain REAL, source TEXT
      );
      CREATE TABLE chain_ticks (
        id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, symbol TEXT NOT NULL, timestamp TEXT NOT NULL,
        strike REAL NOT NULL, type TEXT NOT NULL, ltp REAL, oi REAL, oi_chg REAL, iv REAL,
        delta REAL, theta REAL, gamma REAL, vega REAL, volume REAL, expiry TEXT, source TEXT
      );
    `);
    const insSnap = db.prepare(
      `INSERT INTO market_snapshots (id, symbol, timestamp, spot, pcr_oi, pcr_vol, max_pain, source)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const insLeg = db.prepare(
      `INSERT INTO chain_ticks (id, snapshot_id, symbol, timestamp, strike, type, ltp, oi, oi_chg, iv, delta, volume, expiry, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let m = 0; m <= 45; m++) {
      const ts = at(m);
      const id = `OLD-${ts}`;
      insSnap.run(id, "OLD", ts, 25600, 0.9, 1.1, 25600, "icici-breeze");
      const v = legValues(m);
      insLeg.run(`${id}-CE`, id, "OLD", ts, STRIKE, "CE", v.ltp, v.oi, v.oiChg, v.iv, v.delta, v.volume, EXPIRY_STORED, "icici-breeze");
    }
    db.close();

    const previous = process.env.MARKET_HISTORY_DB;
    process.env.MARKET_HISTORY_DB = oldDb;
    try {
      const res = readChainHistory({
        symbol: "OLD",
        expiry: EXPIRY,
        strike: STRIKE,
        optionType: "CE",
        asOf: ASOF,
      });
      expect(res.current?.timestamp).toBe(ASOF);
      expect(res.current?.bid ?? null).toBeNull();
      expect(res.current?.ask ?? null).toBeNull();
      expect(res.intervals["5"].status).toBe("available");
      expect(res.intervals["5"].change?.oi).toBeCloseTo(50, 6);
    } finally {
      process.env.MARKET_HISTORY_DB = previous;
    }
  });
});

describe("Wave 3a — the chain_ticks schema carries the book", () => {
  test("7 — the chain_ticks insert path accepts bid/ask", () => {
    // better-sqlite3 cannot be loaded by Bun (it aborts the process), so the
    // sidecar's insert path is exercised under NODE, against a TEMP DB.
    const harness = path.join(TMP_DIR, "schema-harness.ts");
    const target = path.join(ROOT, "market-history", "src", "db", "index.ts");
    fs.writeFileSync(
      harness,
      [
        `import { pathToFileURL } from "node:url";`,
        `import path from "node:path";`,
        `const mod = require(pathToFileURL(${JSON.stringify(target)}).href);`,
        `const ok = mod.insertSnapshot({`,
        `  schema_version: 1, feature_version: 1, engine_version: "1.0.0",`,
        `  symbol: "SCHEMA", timestamp: "2026-11-26T04:30:00.000Z", spot: 25600,`,
        `  expiry: "26-Nov-2026", source: "icici-breeze",`,
        `  optionChain: [{ strike: 24500, type: "CE", ltp: 120, oi: 10, oiChg: 1, iv: 12,`,
        `    greeks: { delta: 0.5, theta: -1, gamma: 0.01, vega: 2 }, volume: 5,`,
        `    bid: 119.5, ask: 120.5 }],`,
        `  smcEvents: [],`,
        `});`,
        `const row = mod.db.prepare("SELECT bid, ask FROM chain_ticks WHERE symbol='SCHEMA'").get();`,
        `console.log("__RESULT__" + JSON.stringify({ ok, row }));`,
        "",
      ].join("\n"),
      "utf8",
    );

    const proc = Bun.spawnSync({
      cmd: [path.join(ROOT, "node_modules", ".bin", "tsx"), harness],
      cwd: ROOT,
      env: { ...process.env, MARKET_HISTORY_DB: SCHEMA_DB },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const out = proc.stdout.toString();
    const err = proc.stderr.toString();
    const marker = out.split("__RESULT__")[1];
    expect(marker, `sidecar insert failed:\n${err}`).toBeTruthy();
    const parsed = JSON.parse(marker.split("\n")[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.row.bid).toBe(119.5);
    expect(parsed.row.ask).toBe(120.5);
  }, 60_000);
});
