// scripts/repair-pe-sign.ts
// ONE-OFF REPAIR — the journal rows where a PE stop-out was booked as a PROFIT.
//
// THE DEFECT
// A bought PE can carry a MIRRORED (bearish) plan: the stop sits ABOVE the
// entry and the targets BELOW it. The journal writer priced the exit with a
// long-side formula, so the premium rising INTO the stop (a loss) was booked
// as a gain: "type='PE', stopLoss > entryPrice, status SL_HIT, pnl > 0".
// The sidecar ledger priced the very same trade with the right SIGN (a loss)
// but sized it from the ₹20K budget, while the app journal sized it with
// NIFTY's 65 — so the journal and the ledger disagreed on the sign AND on the
// magnitude of the same trade.
//
// WHAT IT REPAIRS (one row, both numbers)
//   pnl        → -(points × lot)   the stop-out as the LOSS it was
//   pnlPercent → -(points / entry) × 100
// The lot size is the REAL NSE F&O lot (NewBrdLotQty) — the rows were written
// with NIFTY's 65 (the old getSymbolConfig fallback), so the old ₹ was off by
// the lot ratio (7-12× for these stocks). The lot is looked up from the NSE
// F&O bhavcopy via src/lib/option-bhavcopy.ts (the local cache only — no
// network), then from src/lib/symbol-config.ts (the same bhavcopy values,
// table form).
//
// USAGE (dry run by default — it only PRINTS until --apply is given)
//   bun scripts/repair-pe-sign.ts                     # dry run (read-only)
//   bun scripts/repair-pe-sign.ts --apply             # backup + write
//   bun scripts/repair-pe-sign.ts --db <path>         # another SQLite file
//   bun scripts/repair-pe-sign.ts --backup <path>     # explicit backup path
//   bun scripts/repair-pe-sign.ts --lot <n>           # force the lot size
//   bun scripts/repair-pe-sign.ts --sign-only         # flip the sign only
//                                                       # (keep the old ₹ size)
//   bun scripts/repair-pe-sign.ts --help
//
// IDEMPOTENT: after a repair the rows no longer match the selection (their
// pnl is negative), so a second run finds 0 rows and changes nothing.
//
// The operator runs this. The script is not run by the agent.

import { copyFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { getLotSize, hasKnownLotSize } from "../src/lib/symbol-config";
import { loadBhavcopy } from "../src/lib/option-bhavcopy";

// ── CLI ────────────────────────────────────────────────────────────────
function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

const APPLY = process.argv.includes("--apply");
const SIGN_ONLY = process.argv.includes("--sign-only");
const DB_OVERRIDE = argValue("--db");
const BACKUP_OVERRIDE = argValue("--backup");
const FORCED_LOT = Number(argValue("--lot") ?? NaN);
const FORCE_LOT = Number.isFinite(FORCED_LOT) && FORCED_LOT > 0 ? Math.floor(FORCED_LOT) : null;

/** The repo root — the DB, the bhavcopy cache and the backups live under it,
 *  so the script behaves the same from any working directory. */
const REPO_ROOT = path.resolve(import.meta.dir, "..");

// ── Row + plan types ───────────────────────────────────────────────────
export interface JournalRow {
  id: string;
  tradeId: string;
  symbol: string;
  type: string;
  status: string;
  entryPrice: number;
  stopLoss: number;
  exitPrice: number | null;
  pnl: number;
  pnlPercent: number | null;
  strategy: string;
  createdAt: Date | number;
}

export interface RepairPlan {
  id: string;
  tradeId: string;
  symbol: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  points: number;      // premium points lost (entry → stop)
  lotSize: number;
  lotSource: string;
  oldPnl: number;
  newPnl: number;
  oldPnlPercent: number | null;
  newPnlPercent: number;
}

/**
 * The rows this script repairs: a PE whose stop-out was booked as a profit.
 * The stop ABOVE the entry is what makes the plan mirrored (bearish) — a
 * long-side pricing of that exit is a gain on paper and a loss in reality.
 */
export function isWrongSignRow(row: Partial<JournalRow>): boolean {
  return (
    row.type === "PE" &&
    row.status === "SL_HIT" &&
    Number(row.stopLoss) > Number(row.entryPrice) &&
    Number(row.pnl) > 0
  );
}

/**
 * The corrected numbers for one row. The exit is the stop (or the recorded
 * exit price); the premium ROSE into it, so the P&L is negative.
 *
 * `signOnly` keeps the ₹ magnitude the row already has (only the sign and the
 * % are corrected) — use it when the lot size cannot be trusted.
 */
export function planRepair(
  row: JournalRow,
  opts: { lotSize?: number | null; lotSource?: string; signOnly?: boolean } = {}
): RepairPlan | null {
  const entry = Number(row.entryPrice);
  const exit = Number(row.exitPrice ?? row.stopLoss);
  if (!(entry > 0) || !(exit > 0)) return null;
  const points = exit - entry; // > 0: the premium rose into the stop
  if (!(points > 0)) return null;

  const oldPnl = Number(row.pnl);
  const lotSize = opts.lotSize && opts.lotSize > 0 ? opts.lotSize : 0;
  const newPnl = opts.signOnly
    ? -Math.abs(oldPnl)
    : lotSize > 0
      ? -(points * lotSize)
      : -Math.abs(oldPnl);
  const newPnlPercent = -((points / entry) * 100);

  return {
    id: row.id,
    tradeId: row.tradeId,
    symbol: row.symbol,
    strategy: row.strategy,
    entryPrice: entry,
    exitPrice: exit,
    points,
    lotSize,
    lotSource: opts.lotSource ?? (opts.signOnly ? "sign-only (magnitude kept)" : "unresolved"),
    oldPnl,
    newPnl,
    oldPnlPercent: row.pnlPercent ?? null,
    newPnlPercent,
  };
}

/**
 * The lot size used for the repair:
 *   an explicit --lot → the NSE F&O bhavcopy NewBrdLotQty (via option-bhavcopy,
 *   the local cache only) → the same bhavcopy values in symbol-config's table →
 *   the row's own implied lot (which keeps the current magnitude but only as a
 *   last resort) → 0 (unresolved).
 */
export function resolveLotSize(
  row: JournalRow,
  forced: number | null,
  bhavcopyLot?: { lotSize: number; source: string } | null
): { lotSize: number; source: string } {
  if (forced) return { lotSize: forced, source: "--lot" };
  if (bhavcopyLot && bhavcopyLot.lotSize > 0) {
    return { lotSize: bhavcopyLot.lotSize, source: bhavcopyLot.source };
  }
  if (hasKnownLotSize(row.symbol)) {
    return { lotSize: getLotSize(row.symbol), source: "NSE F&O lot (symbol-config / NewBrdLotQty)" };
  }
  const points = Math.abs(Number(row.exitPrice ?? row.stopLoss) - Number(row.entryPrice));
  const implied = points > 0 ? Math.abs(Number(row.pnl)) / points : 0;
  if (implied > 0) {
    return { lotSize: Math.round(implied), source: "implied from the row (magnitude kept)" };
  }
  return { lotSize: 0, source: "unresolved" };
}

// ── The NSE F&O bhavcopy (NewBrdLotQty) ────────────────────────────────
// The local cache only — the file list decides which dates are readable, so
// the repair never reaches the network.
const BHAVCOPY_FILE = /^BhavCopy_NSE_FO_0_0_0_(\d{8})_F_0000\.csv$/;

/** Where the bhavcopy cache lives (resolved at call time — the script chdirs
 *  to the repo root first so this is the same path option-bhavcopy uses). */
export function bhavcopyDir(): string {
  return path.join(process.cwd(), "db", "bhavcopy");
}

/** The bhavcopy dates available locally, newest first. */
export function cachedBhavcopyDates(dir: string = bhavcopyDir()): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = BHAVCOPY_FILE.exec(f);
    if (m) out.push(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`);
  }
  return out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** The IST trade date of a journal row (createdAt is UTC ms). */
export function rowTradeDate(row: JournalRow): string {
  const raw: any = row.createdAt;
  const ms = raw instanceof Date ? raw.getTime() : Number(raw);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * The REAL contract lot of a symbol, straight from the NSE F&O bhavcopy
 * (NewBrdLotQty) — the row's own trade date when it is cached, else the newest
 * cached bhavcopy. Returns null when the bhavcopy has no row for the symbol.
 */
export async function lotFromBhavcopy(
  symbol: string,
  tradeDate: string
): Promise<{ lotSize: number; source: string } | null> {
  const sym = String(symbol || "").toUpperCase();
  const dates = cachedBhavcopyDates();
  if (!dates.length || !sym) return null;
  const wanted = tradeDate && dates.includes(tradeDate) ? tradeDate : dates[0];
  // The file IS cached (it came from the listing) → parsed locally, no fetch.
  const rows = await loadBhavcopy(wanted);
  const hit = rows.find((r) => r.symbol === sym);
  if (hit && hit.lotSize > 0) {
    return { lotSize: hit.lotSize, source: `NSE F&O bhavcopy ${wanted} (NewBrdLotQty)` };
  }
  return null;
}

// ── DB plumbing ────────────────────────────────────────────────────────
function dbFilePath(): string {
  if (DB_OVERRIDE) return path.resolve(DB_OVERRIDE);
  const url = process.env.DATABASE_URL || "";
  const raw = url.replace(/^file:/, "");
  if (raw) return raw.startsWith("/") ? raw : path.resolve(process.cwd(), raw);
  return path.resolve(process.cwd(), "db/custom.db");
}

function backupPath(dbFile: string): string {
  if (BACKUP_OVERRIDE) return path.resolve(BACKUP_OVERRIDE);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.resolve(process.cwd(), `backups/${path.basename(dbFile)}.bak-repair-pe-sign-${ts}`);
}
function makeBackup(prisma: PrismaClient, dbFile: string): string {
  try {
    prisma.$executeRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* not in WAL — fine */
  }
  const dest = backupPath(dbFile);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(dbFile, dest);
  return dest;
}

const SELECT_SQL = `
  SELECT id, tradeId, symbol, type, status, entryPrice, stopLoss, exitPrice, pnl, pnlPercent, strategy, createdAt
  FROM Trade
  WHERE type = 'PE' AND stopLoss > entryPrice AND status = 'SL_HIT' AND pnl > 0
  ORDER BY createdAt ASC
`;

async function main(): Promise<void> {
  // Anchor to the repo root: the bhavcopy cache (option-bhavcopy resolves it
  // from process.cwd()) and the default DB path live under it.
  try {
    process.chdir(REPO_ROOT);
  } catch {
    /* keep the current cwd */
  }
  const dbFile = dbFilePath();
  const prisma = new PrismaClient(
    DB_OVERRIDE ? { datasourceUrl: `file:${dbFile}` } : undefined
  );

  try {
    if (!existsSync(dbFile)) {
      console.error(`[repair-pe-sign] DB not found: ${dbFile}`);
      process.exitCode = 1;
      return;
    }

    const rows = (await prisma.$queryRawUnsafe<JournalRow[]>(SELECT_SQL)) ?? [];
    const plans: RepairPlan[] = [];
    // The REAL contract lot per row: the NSE F&O bhavcopy (NewBrdLotQty) first,
    // then symbol-config's table, then the row's own implied lot.
    const bhavcopyLots = new Map<string, { lotSize: number; source: string } | null>();
    for (const row of rows) {
      const key = `${row.symbol}|${rowTradeDate(row)}`;
      if (!bhavcopyLots.has(key)) {
        try {
          bhavcopyLots.set(key, await lotFromBhavcopy(row.symbol, rowTradeDate(row)));
        } catch {
          bhavcopyLots.set(key, null);
        }
      }
      const { lotSize, source } = resolveLotSize(row, FORCE_LOT, bhavcopyLots.get(key) ?? null);
      const plan = planRepair(row, { lotSize, lotSource: source, signOnly: SIGN_ONLY });
      if (plan) plans.push(plan);
    }

    console.log(
      `[repair-pe-sign] db=${dbFile} mode=${APPLY ? "APPLY" : "DRY RUN"} ` +
        `signOnly=${SIGN_ONLY} forcedLot=${FORCE_LOT ?? "-"} candidates=${rows.length} repairable=${plans.length}`
    );

    if (plans.length === 0) {
      console.log("[repair-pe-sign] nothing to repair — the journal is already consistent.");
      return;
    }

    const pad = (s: string, n: number) => String(s).padEnd(n).slice(0, n);
    console.log("");
    console.log(
      `${pad("tradeId", 30)} ${pad("symbol", 10)} ${pad("strategy", 14)} ${pad("entry", 9)} ` +
        `${pad("stop", 9)} ${pad("lot", 6)} ${pad("old pnl", 12)} ${pad("new pnl", 12)} ` +
        `${pad("old %", 9)} ${pad("new %", 9)} lot source`
    );
    console.log("-".repeat(165));
    for (const p of plans) {
      console.log(
        `${pad(p.tradeId, 30)} ${pad(p.symbol, 10)} ${pad(p.strategy, 14)} ` +
          `${pad(p.entryPrice.toFixed(2), 9)} ${pad(p.exitPrice.toFixed(2), 9)} ` +
          `${pad(String(p.lotSize || "-"), 6)} ${pad(p.oldPnl.toFixed(2), 12)} ` +
          `${pad(p.newPnl.toFixed(2), 12)} ` +
          `${pad(p.oldPnlPercent == null ? "-" : p.oldPnlPercent.toFixed(2), 9)} ` +
          `${pad(p.newPnlPercent.toFixed(2), 9)} ${p.lotSource}`
      );
    }
    const oldTotal = plans.reduce((s, p) => s + p.oldPnl, 0);
    const newTotal = plans.reduce((s, p) => s + p.newPnl, 0);
    console.log("");
    console.log(
      `[repair-pe-sign] ${plans.length} row(s) — ₹ ${oldTotal.toFixed(2)} → ₹ ${newTotal.toFixed(2)} ` +
        `(swing ₹ ${(newTotal - oldTotal).toFixed(2)})`
    );

    if (!APPLY) {
      console.log(
        "[repair-pe-sign] DRY RUN — nothing was written. Re-run with --apply to back up the DB and repair."
      );
      return;
    }

    const dest = makeBackup(prisma, dbFile);
    console.log(`[repair-pe-sign] backup → ${dest}`);

    for (const p of plans) {
      await prisma.trade.update({
        where: { id: p.id },
        data: { pnl: p.newPnl, pnlPercent: p.newPnlPercent },
      });
    }

    const left = (await prisma.$queryRawUnsafe<JournalRow[]>(SELECT_SQL)) ?? [];
    console.log(
      `[repair-pe-sign] DONE. repaired=${plans.length} rows still matching the selection=${left.length} ` +
        `(0 = idempotent — a second run changes nothing)`
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "repair-pe-sign — fix the PE stop-out rows booked with the wrong sign",
        "",
        "  bun scripts/repair-pe-sign.ts                   dry run (prints, writes nothing)",
        "  bun scripts/repair-pe-sign.ts --apply           backup + write",
        "  bun scripts/repair-pe-sign.ts --db <path>       another SQLite file",
        "  bun scripts/repair-pe-sign.ts --backup <path>   explicit backup path",
        "  bun scripts/repair-pe-sign.ts --lot <n>         force the lot size",
        "  bun scripts/repair-pe-sign.ts --sign-only       flip the sign, keep the ₹ magnitude",
      ].join("\n")
    );
  } else {
    main().catch((e) => {
      console.error("[repair-pe-sign] FATAL", e);
      process.exitCode = 1;
    });
  }
}
