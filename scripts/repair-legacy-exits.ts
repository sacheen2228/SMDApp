// repair-legacy-exits — Phase B2 executor: rewrites corrupt closed-trade
// exits with REAL exchange closes (never fabricated values).
//
// Categories (live DB, not hardcoded):
//   1) July time_exit OPTIONS rows with expiry=null — contract expiry chosen
//      via listExpiries/chooseContractExpiry (weekend created-dates walk
//      forward to the next date with a bhavcopy), real close fetched via
//      getPremiumOHLC on effExitDate = min(expiry, recorded exit), walking
//      back ≤3 days over non-trading dates (e.g. Sat 2026-07-18 cleanup).
//   2+3) BTST closed rows with |move| > 10% OR held > 3 calendar days before
//      the recorded exit (covers placeholders 1/10/100/3000 and the stale
//      square-off sweeps of 2026-07-20/22 and 2026-09-11 where open rows got
//      stamped with whatever close the sweep day had) — real exit is the
//      first trading day strictly after creation (BTST squares off next day),
//      close via getDailyRange (NSE historical → Yahoo fallback).
//
// All computation lives in tested src/lib/ledger-repair.ts helpers
// (tests/ledger-repair.test.ts). This script only does IO + reporting.
//
// Run (read-only report):   bun run scripts/repair-legacy-exits.ts
// Run (backup + write):     bun run scripts/repair-legacy-exits.ts --apply

import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "fs";
import {
  chooseContractExpiry,
  effExitDate,
  exitNeedsRepair,
  fixInvertedLongLevels,
  isInvertedLongLevels,
  longPnl,
  rMultiple,
  roiPct,
} from "@/lib/ledger-repair";
import { getPremiumOHLC, isWeekend, listExpiries, type PremiumCandle } from "@/lib/option-bhavcopy";
import { getDailyRange } from "@/lib/trade-validator";

const APPLY = process.argv.includes("--apply");
const DB_PATH = "trade-audit/data/trade_audit.db";

const EXPECTED_OPT = 181;
const EXPECTED_BTST = 196; // |move|>10% ∪ held>3d (Jul20/Jul22/Sep11 sweep stamps)

type Outcome = "REPAIRED" | "MATCH" | "NO_DATA" | "NO_EXPIRY" | "STRIKE_MISSING" | "ERROR";

interface Planned {
  id: string;
  kind: "OPT" | "BTST";
  outcome: Outcome;
  detail: string;
  update?: {
    sql: string;
    params: (string | number | null)[];
  };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mergeRepairNote(
  existing: string | null,
  note: Record<string, unknown>
): string {
  let obj: any = {};
  if (existing) {
    try {
      obj = JSON.parse(existing);
    } catch {
      obj = { original: existing };
    }
  }
  obj.repair = note;
  return JSON.stringify(obj);
}

// ── memoization: dates/symbols repeat across the 181+14 rows ────────────────
const expiryCache = new Map<string, string[]>();
async function getExpiriesCached(date: string, symbol: string): Promise<string[]> {
  const key = `${date}|${symbol}`;
  if (!expiryCache.has(key)) expiryCache.set(key, await listExpiries(date, symbol));
  return expiryCache.get(key)!;
}

const dailyCache = new Map<string, { high: number; low: number; close: number } | null>();
async function getDailyRangeCached(symbol: string, date: string) {
  const key = `${symbol}|${date}`;
  if (!dailyCache.has(key)) dailyCache.set(key, await getDailyRange(symbol, new Date(date + "T00:00:00Z")));
  return dailyCache.get(key) ?? null;
}

// ── Category 1: July time_exit OPTIONS rows ────────────────────────────────
async function planOption(row: any): Promise<Planned> {
  try {
    const base = { id: row.id, kind: "OPT" as const };
    const created = String(row.created_at_ist).slice(0, 10);
    const recordedExitDate = String(row.exit_time || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordedExitDate))
      return { ...base, outcome: "ERROR", detail: "exit_time missing/unparseable" };
    if (row.strike_price == null || !Number.isFinite(Number(row.strike_price)))
      return { ...base, outcome: "STRIKE_MISSING", detail: "strike_price null" };

    // Contract expiry: created date's bhavcopy may not exist (Sun 07-12) —
    // walk forward ≤4 days until a bhavcopy lists expiries for this symbol.
    let expiries: string[] = [];
    let probeDate = created;
    for (let w = 0; w <= 4 && expiries.length === 0; w++, probeDate = addDays(created, w)) {
      expiries = await getExpiriesCached(probeDate, row.symbol);
    }
    const expiry = chooseContractExpiry(expiries, created);
    if (!expiry)
      return { ...base, outcome: "NO_EXPIRY", detail: `created=${created} expiries=[${expiries.join(",")}]` };

    // Effective exit = min(expiry, recorded cleanup date); walk back over
    // non-trading dates (Sat 07-18 stamp) but never before the created date.
    const eff = effExitDate(expiry, recordedExitDate);
    let real: PremiumCandle | null = null;
    let effUsed = eff;
    for (let back = 0; back <= 3 && !real; back++) {
      const cand = addDays(eff, -back);
      if (cand < created) break;
      effUsed = cand;
      real = await getPremiumOHLC({
        date: cand,
        symbol: row.symbol,
        strike: Number(row.strike_price),
        optionType: row.option_type,
        expiry,
      });
    }
    if (!real)
      return { ...base, outcome: "NO_DATA", detail: `eff=${eff} exp=${expiry} strike=${row.strike_price}${row.option_type}` };

    const entry = Number(row.entry_price);
    const recorded = row.exit_price == null ? null : Number(row.exit_price);
    if (!exitNeedsRepair(recorded, real.close, entry))
      return { ...base, outcome: "MATCH", detail: `exit=${recorded} real=${real.close}` };

    let stopLoss: number | null = row.stop_loss;
    let tp1: number | null = row.tp1;
    let swapped = false;
    if (isInvertedLongLevels(entry, stopLoss, tp1) && stopLoss != null && tp1 != null) {
      const fix = fixInvertedLongLevels(entry, stopLoss, tp1);
      stopLoss = fix.stopLoss;
      tp1 = fix.tp1;
      swapped = fix.swapped;
    }
    const { gross, net } = longPnl(entry, real.close, row.fees || 0);
    const r = rMultiple(entry, real.close, stopLoss);
    const roi = roiPct(entry, net);

    const note = {
      at: new Date().toISOString(),
      source: "bhavcopy",
      realClose: real.close,
      effExitDate: effUsed,
      contractExpiry: expiry,
      levelsSwapped: swapped,
    };
    return {
      ...base,
      outcome: "REPAIRED",
      detail:
        `exp=${expiry} eff=${effUsed} strike=${row.strike_price}${row.option_type} ` +
        `exit ${recorded}→${real.close} gross=${gross.toFixed(2)}` +
        (swapped ? " levels:swapped" : ""),
      update: {
        sql: `UPDATE trades SET exit_price=?, gross_pnl=?, net_pnl=?, roi_pct=?, r_multiple=?,
              stop_loss=?, tp1=?, expiry=?, verification_json=? WHERE id=?`,
        params: [
          real.close,
          gross,
          net,
          roi,
          r,
          stopLoss,
          tp1,
          expiry,
          mergeRepairNote(row.verification_json, note),
          row.id,
        ],
      },
    };
  } catch (e: any) {
    return { id: row.id, kind: "OPT", outcome: "ERROR", detail: String(e?.message || e) };
  }
}

// ── Categories 2+3: BTST |move|>10% rows ───────────────────────────────────
async function planBtst(row: any): Promise<Planned> {
  try {
    const base = { id: row.id, kind: "BTST" as const };
    const created = String(row.created_at_ist).slice(0, 10);
    // BTST squares off next trading day — walk forward, skipping weekends
    // (calendar dates around weekend-created rows; getDailyRange itself
    // rejects non-session bars via findBarForDate).
    let range: { high: number; low: number; close: number } | null = null;
    let realExit: string | null = null;
    for (let w = 1; w <= 6 && !range; w++) {
      const cand = addDays(created, w);
      if (isWeekend(cand)) continue;
      range = await getDailyRangeCached(row.symbol, cand);
      if (range) realExit = cand;
    }
    if (!range || !realExit)
      return { ...base, outcome: "NO_DATA", detail: `no daily close within 4d of created=${created}` };

    const entry = Number(row.entry_price);
    const recorded = row.exit_price == null ? null : Number(row.exit_price);
    if (!exitNeedsRepair(recorded, range.close, entry))
      return { ...base, outcome: "MATCH", detail: `exit=${recorded} real=${range.close}` };

    let stopLoss: number | null = row.stop_loss;
    let tp1: number | null = row.tp1;
    let swapped = false;
    if (isInvertedLongLevels(entry, stopLoss, tp1) && stopLoss != null && tp1 != null) {
      const fix = fixInvertedLongLevels(entry, stopLoss, tp1);
      stopLoss = fix.stopLoss;
      tp1 = fix.tp1;
      swapped = fix.swapped;
    }
    const { gross, net } = longPnl(entry, range.close, row.fees || 0);
    const r = rMultiple(entry, range.close, stopLoss);
    const roi = roiPct(entry, net);

    const note = {
      at: new Date().toISOString(),
      source: "daily_ohlc",
      realClose: range.close,
      realExitDate: realExit,
      reason: "BTST squares off next trading day (recorded exit was a cleanup stamp)",
      levelsSwapped: swapped,
    };
    return {
      ...base,
      outcome: "REPAIRED",
      detail:
        `exitDate ${String(row.exit_time).slice(0, 10)}→${realExit} ` +
        `exit ${recorded}→${range.close} gross=${gross.toFixed(2)}` +
        (swapped ? " levels:swapped" : ""),
      update: {
        sql: `UPDATE trades SET exit_price=?, exit_time=?, gross_pnl=?, net_pnl=?, roi_pct=?,
              r_multiple=?, stop_loss=?, tp1=?, verification_json=? WHERE id=?`,
        params: [
          range.close,
          `${realExit}T15:20:00+05:30`,
          gross,
          net,
          roi,
          r,
          stopLoss,
          tp1,
          mergeRepairNote(row.verification_json, note),
          row.id,
        ],
      },
    };
  } catch (e: any) {
    return { id: row.id, kind: "BTST", outcome: "ERROR", detail: String(e?.message || e) };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // bun:sqlite rejects readonly:false explicitly — only pass the flag in dry-run.
  const db = APPLY ? new Database(DB_PATH) : new Database(DB_PATH, { readonly: true });

  const optRows = db
    .prepare(
      `SELECT id, symbol, strike_price, option_type, entry_price, exit_price, stop_loss, tp1, fees,
              gross_pnl, net_pnl, expiry, created_at_ist, exit_time, verification_json
       FROM trades
       WHERE instrument_type='OPTIONS' AND exit_reason='time_exit'
         AND created_at_ist LIKE '2026-07%' AND status='closed'`
    )
    .all();
  const btstRows = db
    .prepare(
      `SELECT id, symbol, entry_price, exit_price, stop_loss, tp1, fees, created_at_ist,
              exit_time, verification_json
       FROM trades
       WHERE strategy_id='BTST' AND status='closed' AND entry_price > 0
         AND (ABS(exit_price - entry_price) / entry_price > 0.10
              OR (exit_time IS NOT NULL
                  AND julianday(substr(exit_time,1,10)) - julianday(substr(created_at_ist,1,10)) > 3))`
    )
    .all();

  console.log(`=== SMDApp Legacy Exit Repair — ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  console.log(`options cat: ${optRows.length} rows (expected ${EXPECTED_OPT})` +
    (optRows.length === EXPECTED_OPT ? "" : "  ⚠ inventory drift"));
  console.log(`btst cat:    ${btstRows.length} rows (expected ${EXPECTED_BTST})` +
    (btstRows.length === EXPECTED_BTST ? "" : "  ⚠ inventory drift"));

  const planned: Planned[] = [];
  for (const row of optRows) planned.push(await planOption(row));
  for (const row of btstRows) planned.push(await planBtst(row));

  // Report grouped by outcome
  const order: Outcome[] = ["REPAIRED", "MATCH", "NO_DATA", "NO_EXPIRY", "STRIKE_MISSING", "ERROR"];
  const tally: Record<Outcome, number> = {
    REPAIRED: 0, MATCH: 0, NO_DATA: 0, NO_EXPIRY: 0, STRIKE_MISSING: 0, ERROR: 0,
  };
  for (const p of planned) tally[p.outcome]++;
  for (const oc of order) {
    const rows = planned.filter((p) => p.outcome === oc);
    if (!rows.length) continue;
    console.log(`\n-- ${oc} (${rows.length})`);
    for (const p of rows) console.log(`  [${p.kind}] ${p.id}  ${p.detail}`);
  }

  const updates = planned.filter((p) => p.update);
  console.log(
    `\nTotals: REPAIRED=${tally.REPAIRED} MATCH=${tally.MATCH} NO_DATA=${tally.NO_DATA} ` +
      `NO_EXPIRY=${tally.NO_EXPIRY} STRIKE_MISSING=${tally.STRIKE_MISSING} ERROR=${tally.ERROR}`
  );

  // Out-of-scope observation: the Sep-11 mass stamp touched far more rows than
  // the approved category (only |move|>10% BTST rows are in scope today).
  const stampCount = db
    .prepare(`SELECT COUNT(*) c FROM trades WHERE exit_time LIKE '2026-09-11T15:25%'`)
    .get() as { c: number };
  const stampBtst = planned.filter(
    (p) => p.kind === "BTST" && p.outcome === "REPAIRED" && String(p.detail).includes("exitDate 2026-09-11→")
  ).length;
  console.log(
    `\nNote: 2026-09-11T15:25 mass stamp on ${stampCount.c} rows total ` +
      `(${stampBtst} in this BTST scope) — others out of approved scope.`
  );

  if (!APPLY) {
    console.log("\nDRY RUN — no writes. Re-run with --apply to execute.");
    db.close();
    return;
  }
  if (!updates.length) {
    console.log("\nNothing to write.");
    db.close();
    return;
  }

  // Fresh backup before any write (checkpoint WAL so the copy is complete).
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const bak = `backups/trade_audit.db.bak-${ts}`;
  mkdirSync("backups", { recursive: true });
  copyFileSync(DB_PATH, bak);
  console.log(`\nBackup → ${bak}`);

  db.exec("BEGIN");
  try {
    let applied = 0;
    for (const p of updates) {
      db.prepare(p.update!.sql).run(...p.update!.params);
      applied++;
    }
    db.exec("COMMIT");
    console.log(`Applied ${applied} updates.`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.close();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
