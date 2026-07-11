// scripts/dailyScanCron.ts
//
// Self-hosted scheduler. Run this as its own long-lived process (e.g. via
// pm2 alongside your Next.js app) if you're not using an external/HTTP cron.
//
//   bun add node-cron tsx
//   bun x tsx scripts/dailyScanCron.ts          (dev / standalone)
//   pm2 start "bun x tsx scripts/dailyScanCron.ts" --name sdm-daily-cron   (prod)
//
// Fires at 9:20am IST every weekday. Adjust the cron expression / days as needed.

import fs from "node:fs";
import path from "node:path";

// ─── Load .env (bun does this automatically; this keeps it working
// under plain `tsx` / node too, so the cron sees TELEGRAM_* tokens). ───
function loadEnv(): void {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* best-effort */
  }
}
loadEnv();

import cron from "node-cron";
import { sendDailyDigest } from "../src/lib/sendDailyDigest";
import { sendIntradayAlerts } from "../src/lib/sendIntradayAlerts";

const TIMEZONE = "Asia/Kolkata";
const DAILY_SCHEDULE = "20 9 * * 1-5";        // 9:20am, Mon-Fri — the morning digest
const INTRADAY_SCHEDULE = "*/15 9-15 * * 1-5"; // every 15 min, 9am-3:59pm window
                                                 // (sendIntradayAlerts() itself checks the
                                                 //  precise 9:15-15:30 market-hours boundary)

console.log(`[dailyScanCron] daily digest scheduled for "${DAILY_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] intraday scan scheduled for "${INTRADAY_SCHEDULE}" (${TIMEZONE})`);

cron.schedule(
  DAILY_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] running morning digest...");
    try {
      const result = await sendDailyDigest();
      console.log(`[dailyScanCron] digest done — sent=${result.sent} picks=${result.pickCount}`);
    } catch (err) {
      console.error("[dailyScanCron] digest failed", err);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  INTRADAY_SCHEDULE,
  async () => {
    try {
      const result = await sendIntradayAlerts();
      if (result.ran) {
        console.log(`[dailyScanCron] intraday scan done — newAlerts=${result.newAlerts}`);
      }
    } catch (err) {
      console.error("[dailyScanCron] intraday scan failed", err);
    }
  },
  { timezone: TIMEZONE }
);
