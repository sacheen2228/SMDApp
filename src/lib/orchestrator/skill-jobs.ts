// src/lib/orchestrator/skill-jobs.ts
//
// The scheduled jobs of the `nse-options-signal` skill, expressed as ONE
// registry so the cron mapping lives in code (and can be tested) instead of
// being duplicated in a crontab.
//
// The repo already owns a scheduler: scripts/dailyScanCron.ts (node-cron,
// run by the smdapp-cron.service user unit) plus the systemd timers.  This
// module does NOT create a second scheduler - it only describes the jobs and
// runs them through the skill's own wrapper:
//
//   skills/nse-options-signal/scripts/cron_job.sh
//     * flock  - one instance per job
//     * timeout - a hard budget per attempt
//     * bounded retries
//     * a structured JSON log line per attempt
//     * a non-zero exit code when the job failed (a job is never "successful"
//       just because the process exited)
//     * trading-day awareness (weekends + the NSE holiday list)
//
// The zip's config/crontab.txt is the source of the schedule mapping; it is
// kept in the skill as documentation (skills/nse-options-signal/config/crontab.txt).

import { spawn } from "node:child_process";
import path from "node:path";

export interface SkillJob {
  /** Job name - also the lock file and the log tag. */
  name: string;
  /** node-cron expression (Asia/Kolkata). */
  schedule: string;
  /** The command to run (argv). */
  command: string[];
  /** Hard budget per attempt (ms). */
  timeoutMs: number;
  /** Bounded retries inside the wrapper. */
  retries: number;
  /** Delay between retries (s). */
  retryDelayS: number;
  /** Skip the job when the date is not an NSE trading day. */
  tradingDayOnly: boolean;
  /** What the job does (documentation + the log line). */
  description: string;
}

export const SKILL_ROOT = path.resolve(process.cwd(), "skills/nse-options-signal");
const PY = "python3";

/**
 * The cron mapping (the zip's crontab + the GEX engine job).
 *
 *   15:35   EOD PCR + max pain from the day's own option chain
 *   19:05   EOD feeds (participant OI, FII/DII, indices); retries until 22:00
 *   08:30   pre-market bias -> data/context.json (Agent A's input)
 *   every 5 min, 09:00-14:55  live snapshot + breadth / movers
 *   every 5 min, 09:30-15:00  GEX engine (the engine's own session gates hold
 *                              the exact 09:30-15:00 window)
 *   Sunday 10:00  trading-holiday list refresh
 */
export const SKILL_JOBS: SkillJob[] = [
  {
    name: "eod-pcr",
    schedule: "35 15 * * 1-5",
    command: [PY, path.join(SKILL_ROOT, "scripts/eod_fetch.py"), "--from-snapshot",
      path.join(SKILL_ROOT, "data/live/gex_snapshot.json")],
    timeoutMs: 120_000,
    retries: 2,
    retryDelayS: 30,
    tradingDayOnly: true,
    description: "EOD PCR + max pain from the last option-chain snapshot of the day",
  },
  {
    name: "eod-fetch",
    schedule: "5 19 * * 1-5",
    command: [PY, path.join(SKILL_ROOT, "scripts/eod_fetch.py"), "--eod", "--retry-until", "22:00"],
    timeoutMs: 3 * 3600_000,
    retries: 1,
    retryDelayS: 60,
    tradingDayOnly: true,
    description: "EOD feeds (participant OI, FII/DII, indices, movers); retries missing sources until 22:00",
  },
  {
    name: "daily-bias",
    schedule: "30 8 * * 1-5",
    command: [PY, path.join(SKILL_ROOT, "scripts/daily_bias.py")],
    timeoutMs: 120_000,
    retries: 2,
    retryDelayS: 30,
    tradingDayOnly: true,
    description: "pre-market bias -> data/context.json (Agent A's context)",
  },
  {
    name: "live-breadth",
    schedule: "*/5 9-14 * * 1-5",
    command: [PY, path.join(SKILL_ROOT, "scripts/live_fetch.sh")],
    timeoutMs: 180_000,
    retries: 1,
    retryDelayS: 30,
    tradingDayOnly: true,
    description: "live snapshot (NSE) + breadth / gainers / losers / most active",
  },
  {
    name: "gex-engine",
    schedule: "*/5 9-14 * * 1-5",
    command: [PY, path.join(SKILL_ROOT, "scripts/run_gex.py"), "--symbol", "NIFTY"],
    timeoutMs: 120_000,
    retries: 1,
    retryDelayS: 30,
    tradingDayOnly: true,
    description: "GEX engine (engine=GEX, GEX channel only) + the GEX invalidation-close monitor",
  },
  {
    name: "holidays",
    schedule: "0 10 * * 0",
    command: [PY, path.join(SKILL_ROOT, "scripts/eod_fetch.py"), "--holidays"],
    timeoutMs: 120_000,
    retries: 2,
    retryDelayS: 60,
    tradingDayOnly: false,
    description: "NSE trading-holiday list refresh (weekends + holidays drive the trading-day gate)",
  },
];

export interface SkillJobResult {
  name: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Run one job through the skill's locked wrapper. */
export function runSkillJob(job: SkillJob, cwd: string = process.cwd()): Promise<SkillJobResult> {
  const wrapper = path.join(SKILL_ROOT, "scripts/cron_job.sh");
  const argv = [
    "bash", wrapper,
    "--name", job.name,
    "--timeout", String(Math.ceil(job.timeoutMs / 1000)),
    "--retries", String(job.retries),
    "--delay", String(job.retryDelayS),
    ...(job.tradingDayOnly ? ["--trading-day-only"] : []),
    "--", ...job.command,
  ];
  const started = Date.now();
  return new Promise<SkillJobResult>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, job.timeoutMs + 120_000);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ name: job.name, ok: false, code: null, stdout, stderr: stderr + String(err),
        durationMs: Date.now() - started, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ name: job.name, ok: code === 0, code, stdout, stderr,
        durationMs: Date.now() - started, timedOut });
    });
  });
}
