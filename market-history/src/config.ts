import path from "path";
import fs from "fs";

// Market History sidecar — self-contained Node service on port 4002.
// Mirrors the Trade Audit sidecar (:4001). Backed by the SAME physical
// SQLite file (db/market_history.db) that the Node validation scripts use,
// so the bun Next.js app never imports better-sqlite3 directly.
const ROOT = fs.existsSync(path.resolve(process.cwd(), "..", "db"))
  ? path.resolve(process.cwd(), "..")
  : path.resolve(__dirname, "..", "..");

export const config = {
  port: Number(process.env.MARKET_HISTORY_PORT || 4002),
  dbPath:
    process.env.MARKET_HISTORY_DB ||
    path.join(ROOT, "db", "market_history.db"),
};
