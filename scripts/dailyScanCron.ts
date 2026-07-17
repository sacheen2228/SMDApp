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

// Load .env (TELEGRAM_* tokens etc.) BEFORE any module that reads env at
// eval-time is imported. ES imports are hoisted + evaluated in order, so this
// must come first.
import "./_loadEnv";

import cron from "node-cron";
import { sendDailyDigest } from "../src/lib/sendDailyDigest";
import { sendIntradayAlerts } from "../src/lib/sendIntradayAlerts";
import { closeYesterdayBTST } from "../src/lib/btst-scanner";
import { runEodClose } from "./eod-close";
import { isTelegramSendWindow } from "../src/lib/marketHours";

const TIMEZONE = "Asia/Kolkata";
const DAILY_SCHEDULE = "10 9 * * 1-5";        // 9:10am, Mon-Fri — the morning digest (within 09:10-15:20 window)
const INTRADAY_SCHEDULE = "*/15 9-15 * * 1-5"; // every 15 min, 9am-3:59pm window
                                                 // (sendIntradayAlerts() itself checks the
                                                 //  precise 9:15-15:30 market-hours boundary)
const BTST_SCHEDULE = "15 15 * * 1-5";         // 3:15pm, Mon-Fri — BTST scan (window 3:10–3:20)
const BTST_CLOSE_SCHEDULE = "25 15 * * 1-5";   // 3:25pm, Mon-Fri — square off prior-day BTST into audit engine
const EOD_CLOSE_SCHEDULE = "45 15 * * 1-5";    // 3:45pm, Mon-Fri — force-close still-open trades with real closing premium
// Runs AFTER market close (NSE/BSE keep the final day's option chain with
// full OI/OI-chg/volume available past 7:30pm IST). Collects all F&O stock
// option chains into the DomAnalysis table for next-day pre-market analysis.
const DOM_ANALYSIS_SCHEDULE = "35 19 * * 1-5"; // 7:35pm, Mon-Fri — after-hours DOM capture

console.log(`[dailyScanCron] daily digest scheduled for "${DAILY_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] intraday scan scheduled for "${INTRADAY_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] BTST scan scheduled for "${BTST_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] BTST close scheduled for "${BTST_CLOSE_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] DOM analysis (after-hours) scheduled for "${DOM_ANALYSIS_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] EOD close scheduled for "${EOD_CLOSE_SCHEDULE}" (${TIMEZONE})`);

cron.schedule(
  DAILY_SCHEDULE,
  async () => {
    if (!isTelegramSendWindow()) {
      console.log("[dailyScanCron] skipping digest — outside 09:10-15:20 IST window");
      return;
    }
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

cron.schedule(
  BTST_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] running BTST scan...");
    try {
      const base = process.env.INTERNAL_API_BASE || `http://localhost:${process.env.PORT || 3000}`;
      const res = await fetch(`${base}/api/btst?alert=1`, { method: "POST" });
      const json = await res.json();
      if (json.success) {
        console.log(`[dailyScanCron] BTST scan done — candidates=${json.data.count} alerted=${json.alerted}`);
      } else {
        console.error("[dailyScanCron] BTST scan returned error:", json.error);
      }
    } catch (err) {
      console.error("[dailyScanCron] BTST scan failed", err);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  BTST_CLOSE_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] squaring off prior-day BTST signals...");
    try {
      const result = await closeYesterdayBTST();
      console.log(`[dailyScanCron] BTST close done — closed=${result.closed}`);
    } catch (err) {
      console.error("[dailyScanCron] BTST close failed", err);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  EOD_CLOSE_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] EOD close — force-closing open trades with closing premium...");
    try {
      const result = await runEodClose();
      console.log(`[dailyScanCron] EOD close done — closed=${result.closed} skipped=${result.skipped} errors=${result.errors}`);
    } catch (err) {
      console.error("[dailyScanCron] EOD close failed", err);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  DOM_ANALYSIS_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] running after-hours DOM analysis (all F&O stocks)...");
    try {
      const base = process.env.INTERNAL_API_BASE || `http://localhost:${process.env.PORT || 3000}`;
      const secret = process.env.DAILY_SCAN_SECRET || "sdm-cron-9f3a2b";
      const res = await fetch(`${base}/api/cron/dom-analysis?all=true&secret=${encodeURIComponent(secret)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(300000), // allow several minutes for ~180 symbols
      });
      const json = await res.json();
      if (json.success) {
        console.log(`[dailyScanCron] DOM analysis done — analyzed=${json.analyzed} stored=${json.stored} errors=${(json.errors || []).length}`);
      } else {
        console.error("[dailyScanCron] DOM analysis returned error:", json.error);
      }
    } catch (err) {
      console.error("[dailyScanCron] DOM analysis failed", err);
    }
  },
  { timezone: TIMEZONE }
);
