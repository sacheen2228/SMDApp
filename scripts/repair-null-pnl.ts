// repair-null-pnl — price the EXPIRED/null-pnl journal backlog with REAL
// market closes (stale_reload_cleanup boots never wrote exitPrice/pnl).
//
//   bun scripts/repair-null-pnl.ts           # dry run (read-only)
//   bun scripts/repair-null-pnl.ts --apply   # backup + write
//
// Resolution rules live in src/lib/null-pnl-repair.ts (shared with the boot
// cleanup in instrumentation.ts so new rows get priced the same way).
// Unresolvable rows (fake strikes, dead contracts) stay NULL — honest NO_DATA.

import { copyFileSync, mkdirSync } from "node:fs";
import { db } from "@/lib/db";
import { resolveRealExit } from "@/lib/null-pnl-repair";

const APPLY = process.argv.includes("--apply");
const TARGET_STATUSES = ["EXPIRED", "SL_HIT", "TP3_HIT", "CLOSED"]; // terminal only

async function backupDatabase(): Promise<string> {
  try {
    await db.$executeRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* not in WAL — fine */
  }
  const url = process.env.DATABASE_URL || "";
  const raw = url.replace(/^file:/, "");
  const path = raw.startsWith("/") ? raw : `${process.cwd()}/${raw}`;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = `${process.cwd()}/backups/custom.db.bak-${ts}`;
  mkdirSync(`${process.cwd()}/backups`, { recursive: true });
  copyFileSync(path, dest);
  return dest;
}

async function countUnpriced(): Promise<number> {
  return db.trade.count({ where: { status: { in: TARGET_STATUSES }, pnl: null } });
}

async function main() {
  const rows = await db.trade.findMany({
    where: { status: { in: TARGET_STATUSES }, pnl: null },
    select: {
      id: true,
      tradeId: true,
      symbol: true,
      strategy: true,
      type: true,
      side: true,
      entryPrice: true,
      entryTime: true,
      exitTime: true,
      strike: true,
      status: true,
    },
    orderBy: { entryTime: "asc" },
  });
  console.log(`[repair-null-pnl] targets=${rows.length} mode=${APPLY ? "APPLY" : "DRY"}`);
  if (rows.length === 0) return;

  if (APPLY) {
    const dest = await backupDatabase();
    console.log(`[repair-null-pnl] backup → ${dest}`);
  }

  const tally: Record<string, number> = {};
  const priced: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const res = await resolveRealExit(row);
    tally[res.outcome] = (tally[res.outcome] || 0) + 1;
    if (res.outcome === "PRICED") {
      priced.push(
        `${row.tradeId} ${row.symbol} ${row.type} entry=${row.entryPrice} → exit=${res.exitPrice} pnl=${res.pnl} (${res.detail})`
      );
      if (APPLY) {
        await db.trade.update({
          where: { id: row.id },
          data: { exitPrice: res.exitPrice, pnl: res.pnl, pnlPercent: res.pnlPercent },
        });
      }
    } else {
      failed.push(`${row.tradeId} [${res.outcome}] ${res.detail}`);
    }
    if (i > 0 && i % 50 === 0) console.log(`[repair-null-pnl] ${i}/${rows.length} …`);
  }

  console.log(`\n[repair-null-pnl] tally: ${JSON.stringify(tally)}`);
  console.log(`\nPRICED sample (${Math.min(12, priced.length)} of ${priced.length}):`);
  priced.slice(0, 12).forEach((l) => console.log("  " + l));
  if (failed.length) {
    console.log(`\nUNPRICED sample (${Math.min(12, failed.length)} of ${failed.length}):`);
    failed.slice(0, 12).forEach((l) => console.log("  " + l));
  }

  if (APPLY) {
    const left = await countUnpriced();
    console.log(`\n[repair-null-pnl] DONE. unpriced terminal rows remaining: ${left} (was ${rows.length})`);
  } else {
    console.log(`\n[repair-null-pnl] DRY RUN — rerun with --apply to write ${tally.PRICED || 0} repairs.`);
  }
}

main()
  .catch((e) => {
    console.error("[repair-null-pnl] FATAL", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
