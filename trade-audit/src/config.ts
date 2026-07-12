import path from "path";
import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4001),
  dbPath: process.env.DB_PATH ?? path.join(__dirname, "..", "data", "trade_audit.db"),
  defaultFeesPerTrade: Number(process.env.DEFAULT_FEES_PER_TRADE ?? 0),
  queueRetryDelaysMs: [500, 2000, 5000], // backoff schedule for failed queue jobs
};
