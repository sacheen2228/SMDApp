/**
 * Backfill quantity + recompute P&L for trades recorded before the
 * position-sizing fix (Oct 2026). Applies the same ₹20k budget rules as
 * src/utils/sizing.ts. Safe to re-run: recomputes from raw entry/exit.
 *
 * Usage:  AUDIT_TRADE_BUDGET=20000 bun scripts/backfill-quantity.ts
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { computeClosePnl, defaultQuantity, estimateFees } from "../src/utils/sizing";

const dbPath = path.resolve(__dirname, "../data/trade_audit.db");
if (!fs.existsSync(dbPath)) {
  console.error("DB not found:", dbPath);
  process.exit(1);
}

// Backup before rewriting
const backup = dbPath.replace(/\.db$/, `.backup-sizing-${Date.now()}.db`);
fs.copyFileSync(dbPath, backup);
console.log("backup →", backup);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const rows = db
  .prepare(
    `SELECT id, symbol, instrument_type, entry_price, stop_loss, tp1, tp2, exit_price, status
     FROM trades`
  )
  .all() as Array<{
  id: string;
  symbol: string;
  instrument_type: string;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number | null;
  exit_price: number | null;
  status: string;
}>;

const upd = db.prepare(
  `UPDATE trades SET
     quantity = @quantity,
     gross_pnl = @grossPnl,
     fees = @fees,
     net_pnl = @netPnl,
     roi_pct = @roiPct,
     r_multiple = @rMultiple
   WHERE id = @id`
);

let open = 0, closed = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    const quantity = defaultQuantity(r.instrument_type, r.symbol, r.entry_price);
    if (r.status !== "closed" || r.exit_price == null) {
      // open trades: set quantity only so future closes are rupee-honest
      db.prepare("UPDATE trades SET quantity = ? WHERE id = ?").run(quantity, r.id);
      open++;
      continue;
    }
    const isLong = r.entry_price <= r.tp1; // same convention as the engine
    const fees = estimateFees(r.entry_price, r.exit_price, quantity);
    const { grossPnl, netPnl, roiPct, rMultiple } = computeClosePnl({
      isLong,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      quantity,
      fees,
      stopLoss: r.stop_loss,
    });
    upd.run({ id: r.id, quantity, grossPnl, fees, netPnl, roiPct, rMultiple });
    closed++;
  }
});
tx();

console.log(`done: ${closed} closed trades recomputed, ${open} open trades quantity-set`);
db.close();
