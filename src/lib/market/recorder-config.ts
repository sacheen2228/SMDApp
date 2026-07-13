// Recorder configuration — fully config-driven via environment variables.
// No code change required to alter intervals or force a mode.

export type RecorderMode = "NORMAL" | "WEEKLY_EXPIRY" | "MONTHLY_EXPIRY" | "MANUAL";

export const RECORDER_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

const num = (key: string, def: number): number => {
  const n = parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

// Intervals in SECONDS. Override with env vars (no code change needed).
export const RECORDER_INTERVALS: Record<RecorderMode, number> = {
  NORMAL: num("RECORDER_INTERVAL_NORMAL", 60),
  WEEKLY_EXPIRY: num("RECORDER_INTERVAL_WEEKLY_EXPIRY", 60),
  MONTHLY_EXPIRY: num("RECORDER_INTERVAL_MONTHLY_EXPIRY", 30),
  MANUAL: 0,
};

export const RECORDER_CONFIG = {
  symbols: (process.env.RECORDER_SYMBOLS?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)) || [...RECORDER_SYMBOLS],
  // Systemd timer granularity (seconds) — must be <= smallest interval.
  tickGranularity: num("RECORDER_TICK_GRANULARITY", 30),
};

// Determine the active mode for a given date.
// - RECORDER_MODE env override takes precedence (e.g. "MANUAL" to disable auto capture).
// - Else: Thursday => weekly expiry; last Thursday of month => monthly expiry; else normal.
export function getRecorderMode(date: Date = new Date()): RecorderMode {
  const forced = (process.env.RECORDER_MODE ?? "").toUpperCase();
  if (forced === "MANUAL" || forced === "NORMAL" || forced === "WEEKLY_EXPIRY" || forced === "MONTHLY_EXPIRY") {
    return forced as RecorderMode;
  }
  const dow = date.getDay(); // 4 = Thursday (index expiry day)
  if (dow === 4) {
    const y = date.getFullYear();
    const m = date.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    let lastThursday = 1;
    for (let d = 1; d <= lastDay; d++) {
      if (new Date(y, m, d).getDay() === 4) lastThursday = d;
    }
    // Treat the last Thursday (and the 6 days leading into it) as monthly expiry week.
    if (date.getDate() >= lastThursday - 6) return "MONTHLY_EXPIRY";
    return "WEEKLY_EXPIRY";
  }
  return "NORMAL";
}

export function getIntervalSeconds(mode: RecorderMode = getRecorderMode()): number {
  return RECORDER_INTERVALS[mode];
}
