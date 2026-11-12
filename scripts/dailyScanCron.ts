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
import { sendSystemAlert } from "@/lib/telegram";
import { SKILL_JOBS, runSkillJob } from "@/lib/orchestrator/skill-jobs";

const TIMEZONE = "Asia/Kolkata";
const READINESS_SCHEDULE = "10 9 * * 1-5";     // 9:10am, Mon-Fri — pre-flight readiness (before the 09:15 open)
const PREOPEN_LAB_SCHEDULE = "50 8 * * 1-5";   // 8:50am, Mon-Fri — NSE CM+F&O pre-open research snapshot
const PREOPEN_LAB_RETRY = "8 9 * * 1-5";       // 9:08am, Mon-Fri — retry if first pass failed
// Phase 12 — Automated Quant Research Operations (trading-day gated + locked)
const LAB_COLLECT = "2 9 * * 1-5";             // 9:02am — collect pre-open + research (in pre-open window)
const LAB_RECORD = "20 9 * * 1-5";             // 9:20am — record shadow predictions (two-phase PENDING)
const LAB_ATTACH_1 = "5 10 * * 1-5";           // 10:05am — partial outcome attach
const LAB_ATTACH_2 = "35 11 * * 1-5";          // 11:35am — partial outcome attach
const LAB_ATTACH_3 = "35 14 * * 1-5";          // 2:35pm — partial outcome attach
const LAB_ATTACH_EOD = "45 15 * * 1-5";        // 3:45pm — EOD outcome attach / unavailable
const LAB_OPTION_1 = "15 18 * * 1-5";          // 6:15pm — bhavcopy option sim warm
const LAB_OPTION_2 = "0 19 * * 1-5";           // 7:00pm — bhavcopy retry
const LAB_OPTION_3 = "0 20 * * 1-5";           // 8:00pm — bhavcopy final retry
const LAB_REPORT = "45 19 * * 1-5";            // 7:45pm — daily research report
const BTST_SCHEDULE = "15 15 * * 1-5";         // 3:15pm, Mon-Fri — BTST scan (window 3:10–3:20)
const BTST_CLOSE_SCHEDULE = "25 15 * * 1-5";   // 3:25pm, Mon-Fri — square off prior-day BTST into audit engine
const EOD_SQUAREOFF_SCHEDULE = "31 15 * * 1-5"; // 3:31pm, Mon-Fri — close intraday journal trades at real LTP (BTST excluded)
const INST_SCHEDULE = "*/20 16-18 * * 1-5";          // every 20 min, 16:00-18:40 Mon-Fri — fetch NSE participant OI data (published ~4pm IST)
const EVENING_SCHEDULE = "0 20 * * 1-5";            // 8:00pm, Mon-Fri — evening watchlist digest
const WATCHLIST_PREOPEN_SCHEDULE = "8 9 * * 1-5";   // 9:08am, Mon-Fri — preopen re-rank (coexists with PREOPEN_LAB_RETRY)
const WATCH_SCHEDULE = "*/2 9-14,15 * * 1-5";       // every 2 min, 09:00-15:30 Mon-Fri — live watch alerts
const EVALUATE_SCHEDULE = "40 15 * * 1-5";          // 3:40pm, Mon-Fri — end-of-day grading
const PLAN_SCHEDULE = "30 9 * * 1-5";               // 9:30am, Mon-Fri — trade plan generation

// The nse-options-signal skill's jobs (EOD PCR/max-pain, EOD feeds, pre-market
// bias, live breadth/movers, the GEX engine, the holiday list).  They live in
// the SAME registry so the cron mapping is documented in one place - see
// src/lib/orchestrator/skill-jobs.ts and
// skills/nse-options-signal/config/crontab.txt.  Each job runs through the
// skill's locked wrapper (flock + timeout + bounded retries + structured log).
for (const job of SKILL_JOBS) {
  cron.schedule(
    job.schedule,
    async () => {
      console.log(`[dailyScanCron] skill job ${job.name} starting (${job.description})...`);
      const result = await runSkillJob(job);
      if (result.ok) {
        console.log(`[dailyScanCron] skill job ${job.name} ok in ${result.durationMs}ms`);
      } else {
        console.error(
          `[dailyScanCron] skill job ${job.name} FAILED code=${result.code} ` +
          `timedOut=${result.timedOut}: ${result.stderr.slice(-500)}`
        );
      }
    },
    { timezone: TIMEZONE }
  );
}

console.log(`[dailyScanCron] premarket readiness scheduled for "${READINESS_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] premarket-lab collect scheduled for "${PREOPEN_LAB_SCHEDULE}" + retry "${PREOPEN_LAB_RETRY}" (${TIMEZONE})`);
console.log(`[dailyScanCron] phase12 lab: collect=${LAB_COLLECT} record=${LAB_RECORD} attach=${LAB_ATTACH_1}/${LAB_ATTACH_2}/${LAB_ATTACH_3}/${LAB_ATTACH_EOD} option=${LAB_OPTION_1}/${LAB_OPTION_2}/${LAB_OPTION_3} report=${LAB_REPORT} (${TIMEZONE})`);
console.log(`[dailyScanCron] BTST scan scheduled for "${BTST_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] BTST close scheduled for "${BTST_CLOSE_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] EOD square-off scheduled for "${EOD_SQUAREOFF_SCHEDULE}" (${TIMEZONE})`);
console.log(`[dailyScanCron] institutional positioning scheduled for "${INST_SCHEDULE}" (${TIMEZONE})`);

async function runPreopenLabCollect(label: string): Promise<void> {
  console.log(`[dailyScanCron] premarket-lab ${label} starting...`);
  try {
    const { collectPreopenSnapshot } = await import("../src/lib/premarket-lab/collector");
    const result = await collectPreopenSnapshot();
    if (result.ok) {
      console.log(
        `[dailyScanCron] premarket-lab ${label} ok cm=${result.cmRows} fno=${result.fnoRows} symbols=${result.studySymbols.length} quality=${result.quality.overall}`
      );
    } else {
      console.error(`[dailyScanCron] premarket-lab ${label} FAILED: ${result.error} quality=${result.quality.overall}`);
    }
  } catch (err) {
    console.error(`[dailyScanCron] premarket-lab ${label} error`, err);
  }
}

/** Phase 12 — run one lab pipeline stage (trading-day gated + file-locked inside). */
async function runLabStage(
  stage: "collect" | "record" | "attach_partial" | "attach_eod" | "option_sim" | "report",
  label: string,
): Promise<void> {
  console.log(`[dailyScanCron] lab ${stage} (${label}) starting...`);
  try {
    const pipe = await import("../src/lib/premarket-lab/daily-pipeline");
    let r: import("../src/lib/premarket-lab/daily-pipeline").PipelineResult;
    if (stage === "collect") r = await pipe.runCollectStage();
    else if (stage === "record") r = await pipe.runRecordStage({ sdm: false, options: true });
    else if (stage === "attach_partial") r = await pipe.runAttachStage({ eod: false });
    else if (stage === "attach_eod") r = await pipe.runAttachStage({ eod: true });
    else if (stage === "option_sim") r = await pipe.runOptionSimStage();
    else r = await pipe.runReportStage();
    if (r.ok) {
      console.log(`[dailyScanCron] lab ${stage} ok: ${r.message}`);
    } else if (r.skipped) {
      console.log(`[dailyScanCron] lab ${stage} skipped (${r.skipped}): ${r.message}`);
    } else {
      console.error(`[dailyScanCron] lab ${stage} FAILED: ${r.message}`);
    }
  } catch (err) {
    console.error(`[dailyScanCron] lab ${stage} error`, err);
  }
}

cron.schedule(PREOPEN_LAB_SCHEDULE, () => runPreopenLabCollect("collect-08:50"), { timezone: TIMEZONE });
cron.schedule(PREOPEN_LAB_RETRY, () => runPreopenLabCollect("retry-09:08"), { timezone: TIMEZONE });

// Phase 12 automated quant research ops (research-only — no Telegram/trades)
cron.schedule(LAB_COLLECT, () => runLabStage("collect", "09:02"), { timezone: TIMEZONE });
cron.schedule(LAB_RECORD, () => runLabStage("record", "09:20"), { timezone: TIMEZONE });
cron.schedule(LAB_ATTACH_1, () => runLabStage("attach_partial", "10:05"), { timezone: TIMEZONE });
cron.schedule(LAB_ATTACH_2, () => runLabStage("attach_partial", "11:35"), { timezone: TIMEZONE });
cron.schedule(LAB_ATTACH_3, () => runLabStage("attach_partial", "14:35"), { timezone: TIMEZONE });
cron.schedule(LAB_ATTACH_EOD, () => runLabStage("attach_eod", "15:45"), { timezone: TIMEZONE });
cron.schedule(LAB_OPTION_1, () => runLabStage("option_sim", "18:15"), { timezone: TIMEZONE });
cron.schedule(LAB_OPTION_2, () => runLabStage("option_sim", "19:00"), { timezone: TIMEZONE });
cron.schedule(LAB_OPTION_3, () => runLabStage("option_sim", "20:00"), { timezone: TIMEZONE });
cron.schedule(LAB_REPORT, () => runLabStage("report", "19:45"), { timezone: TIMEZONE });

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
cron.schedule(EVENING_SCHEDULE, async () => {
  console.log("[dailyScanCron] evening watchlist digest starting...");
  try {
    const result = await import("@/lib/watchlist-scanner").then((m) => m.runEveningMode());
    console.log("[dailyScanCron] evening watchlist digest completed:", result);
  } catch (err) {
    console.error("[dailyScanCron] evening watchlist digest error:", err);
  }
}, { timezone: TIMEZONE });
cron.schedule(WATCHLIST_PREOPEN_SCHEDULE, async () => {
  console.log("[dailyScanCron] preopen re-rank starting...");
  try {
    const result = await import("@/lib/watchlist-scanner").then((m) => m.runPreopenMode());
    console.log("[dailyScanCron] preopen re-rank completed:", result);
  } catch (err) {
    console.error("[dailyScanCron] preopen re-rank error:", err);
  }
}, { timezone: TIMEZONE });
cron.schedule(WATCH_SCHEDULE, async () => {
  console.log("[dailyScanCron] watch mode starting...");
  try {
    const result = await import("@/lib/watchlist-scanner").then((m) => m.runWatchMode());
    console.log("[dailyScanCron] watch mode completed:", result);
  } catch (err) {
    console.error("[dailyScanCron] watch mode error:", err);
  }
}, { timezone: TIMEZONE });
cron.schedule(EVALUATE_SCHEDULE, async () => {
  console.log("[dailyScanCron] evaluate mode starting...");
  try {
    const result = await import("@/lib/watchlist-scanner").then((m) => m.runEvaluateMode());
    console.log("[dailyScanCron] evaluate mode completed:", result);
  } catch (err) {
    console.error("[dailyScanCron] evaluate mode error:", err);
  }
}, { timezone: TIMEZONE });
cron.schedule(PLAN_SCHEDULE, async () => {
  console.log("[dailyScanCron] plan mode starting...");
  try {
    const result = await import("@/lib/watchlist-scanner").then((m) => m.runPlanMode());
    console.log("[dailyScanCron] plan mode completed:", result);
  } catch (err) {
    console.error("[dailyScanCron] plan mode error:", err);
  }
}, { timezone: TIMEZONE });
