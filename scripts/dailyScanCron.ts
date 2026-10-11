// scripts/dailyScanCron.ts
//
// Self-hosted scheduler for the jobs NOT covered by the systemd timers
// (timers own: morning-signals 9:20, intraday-scan */15, daily-digest 15:25,
// recorder). This service owns ONLY: premarket readiness, BTST scan,
// BTST close, EOD square-off, institutional positioning (+19:00 watchdog).
//
//   bun x tsx scripts/dailyScanCron.ts          (dev / standalone)
//   systemctl --user start smdapp-cron.service  (prod — this box)

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
import { closeYesterdayBTST } from "../src/lib/btst-scanner";
import { isTelegramSendWindow } from "../src/lib/marketHours";
import { todayDDMMYYYYIST, positioningFreshness, latestParticipantDate, hasParticipantDataForDate } from "@/lib/institutional-positioning-engine";
import { sendSystemAlert } from "../src/lib/telegram";

const TIMEZONE = "Asia/Kolkata";
const READINESS_SCHEDULE = "10 9 * * 1-5";     // 9:10am, Mon-Fri — pre-flight readiness (before the 09:15 open)
const BTST_SCHEDULE = "15 15 * * 1-5";         // 3:15pm, Mon-Fri — BTST scan (window 3:10–3:20)
const BTST_CLOSE_SCHEDULE = "25 15 * * 1-5";   // 3:25pm, Mon-Fri — square off prior-day BTST into audit engine
const EOD_SQUAREOFF_SCHEDULE = "31 15 * * 1-5"; // 3:31pm, Mon-Fri — close intraday journal trades at real LTP (BTST excluded)
const INST_SCHEDULE = "*/20 16-18 * * 1-5";          // every 20 min, 16:00-18:40 Mon-Fri — fetch NSE participant OI data (published ~4pm IST)

console.log(`[dailyScanCron] premarket readiness scheduled for "${READINESS_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] BTST scan scheduled for "${BTST_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] BTST close scheduled for "${BTST_CLOSE_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] EOD square-off scheduled for "${EOD_SQUAREOFF_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] institutional positioning scheduled for "${INST_SCHEDULE}" (${TIMEZONE})`);

cron.schedule(
  READINESS_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] running premarket readiness pre-flight...");
    try {
      const { evaluatePremarketReadiness, formatReadinessMessage } = await import(
        "../src/lib/premarket-readiness"
      );
      const report = await evaluatePremarketReadiness();
      console.log(`[dailyScanCron] readiness ${report.gate} — ${report.summary}`);
      for (const b of report.blockers) console.log(`[dailyScanCron]   blocker: ${b}`);
      for (const w of report.warnings) console.log(`[dailyScanCron]   warning: ${w}`);

      // A healthy stack needs no Telegram noise; anything else must be seen
      // before the 09:15 open.
      if (report.gate !== "READY") {
        if (isTelegramSendWindow()) {
          await sendSystemAlert(`Pre-market readiness: ${report.gate}\n\n${formatReadinessMessage(report)}`);
        } else {
          console.log("[dailyScanCron] readiness alert suppressed — outside telegram send window");
        }
      }
    } catch (err) {
      console.error("[dailyScanCron] premarket readiness failed", err);
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
  EOD_SQUAREOFF_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] EOD square-off — closing intraday trades at real LTP...");
    try {
      const secret = process.env.DAILY_SCAN_SECRET;
      const base = process.env.INTERNAL_API_BASE || `http://localhost:${process.env.PORT || 3000}`;
      const res = await fetch(`${base}/api/cron/eod-squareoff?secret=${secret}`, { cache: "no-store" });
      const json = await res.json();
      if (json.success) {
        console.log(
          `[dailyScanCron] EOD square-off done — closed=${json.closed} noPrice=${(json.noPrice || []).length}` +
            (json.error ? ` error=${json.error}` : "")
        );
      } else {
        console.error("[dailyScanCron] EOD square-off error:", json.error);
      }
    } catch (err) {
      console.error("[dailyScanCron] EOD square-off fetch failed", err);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  INST_SCHEDULE,
  async () => {
    console.log("[dailyScanCron] fetching institutional positioning data...");
    try {
      const secret = process.env.DAILY_SCAN_SECRET;
      const base = process.env.INTERNAL_API_BASE || `http://localhost:${process.env.PORT || 3000}`;
      const res = await fetch(`${base}/api/cron/institutional-positioning?secret=${secret}`, { cache: "no-store" });
      const json = await res.json();
      if (json.success) {
        console.log(`[dailyScanCron] institutional positioning done — bias=${json.summary.bias} filter=${json.summary.filter} trap=${json.summary.trapDetected}`);
      } else {
        console.error("[dailyScanCron] institutional positioning error:", json.error);
      }
    } catch (err) {
      console.error("[dailyScanCron] institutional positioning fetch failed", err);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  "0 19 * * 1-5",
  async () => {
    console.log("[dailyScanCron] institutional positioning staleness watchdog running...");
    try {
      const today = todayDDMMYYYYIST();
      const hasData = await hasParticipantDataForDate(today);
      if (!hasData) {
        await sendSystemAlert(
          `Institutional positioning data missing for ${today} — NSE may not have published yet, or data pull failed.`
        );
      } else {
        console.log(`[dailyScanCron] positioning data fresh for ${today}`);
      }
    } catch (err) {
      console.error("[dailyScanCron] staleness watchdog error", err);
    }
  },
  { timezone: TIMEZONE }
);
