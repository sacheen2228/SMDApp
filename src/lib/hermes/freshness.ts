// Data Freshness Engine — classifies data age into freshness levels.
// Different instruments and data types have different thresholds.

import type { DataFreshness } from "./types";

// ── Freshness Thresholds (ms) ──────────────────────────────────────────

interface FreshnessThreshold {
  live: number;
  fresh: number;
  delayed: number;
}

const THRESHOLDS: Record<string, FreshnessThreshold> = {
  tick:        { live: 15_000,   fresh: 60_000,   delayed: 300_000 },
  optionChain: { live: 30_000,   fresh: 180_000,  delayed: 600_000 },
  spot:        { live: 15_000,   fresh: 180_000,  delayed: 300_000 },
  greeks:      { live: 60_000,   fresh: 300_000,  delayed: 900_000 },
  vix:         { live: 60_000,   fresh: 300_000,  delayed: 900_000 },
  fiiDii:      { live: 3_600_000, fresh: 86_400_000, delayed: 172_800_000 },
  news:        { live: 1_800_000, fresh: 14_400_000, delayed: 86_400_000 },
  regime:      { live: 60_000,   fresh: 300_000,  delayed: 900_000 },
  volume:      { live: 30_000,   fresh: 120_000,  delayed: 600_000 },
  structure:   { live: 60_000,   fresh: 300_000,  delayed: 900_000 },
  gamma:       { live: 60_000,   fresh: 300_000,  delayed: 900_000 },
  daily:       { live: 3_600_000, fresh: 86_400_000, delayed: 172_800_000 },
  default:     { live: 30_000,   fresh: 120_000,  delayed: 600_000 },
};

// ── Classification ─────────────────────────────────────────────────────

export function classifyFreshness(
  timestamp: string | Date,
  dataType: string = "default"
): DataFreshness {
  const ts = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp.getTime();
  const now = Date.now();
  const ageMs = now - ts;

  if (ageMs < 0) return "STALE"; // future timestamp = suspicious

  const thresholds = THRESHOLDS[dataType] || THRESHOLDS.default;

  if (ageMs <= thresholds.live) return "LIVE";
  if (ageMs <= thresholds.fresh) return "FRESH";
  if (ageMs <= thresholds.delayed) return "DELAYED";
  return "STALE";
}

export function classifyFreshnessMs(
  ageMs: number,
  dataType: string = "default"
): DataFreshness {
  if (ageMs < 0) return "STALE";

  const thresholds = THRESHOLDS[dataType] || THRESHOLDS.default;

  if (ageMs <= thresholds.live) return "LIVE";
  if (ageMs <= thresholds.fresh) return "FRESH";
  if (ageMs <= thresholds.delayed) return "DELAYED";
  return "STALE";
}

// ── Usability Check ────────────────────────────────────────────────────

const MODE_FRESHNESS_ALLOW: Record<string, DataFreshness[]> = {
  QUICK:       ["LIVE", "FRESH", "DELAYED"],
  RESEARCH:    ["LIVE", "FRESH", "DELAYED", "STALE"],
  TRADE:       ["LIVE", "FRESH"],
  RISK:        ["LIVE", "FRESH"],
  BACKTEST:    ["LIVE", "FRESH", "DELAYED", "STALE"],
  EXPLAIN:     ["LIVE", "FRESH", "DELAYED", "STALE"],
  DEBUG:       ["LIVE", "FRESH", "DELAYED", "STALE"],
};

export function isDataUsable(
  freshness: DataFreshness,
  mode: string = "TRADE"
): boolean {
  const allowed = MODE_FRESHNESS_ALLOW[mode] || MODE_FRESHNESS_ALLOW.TRADE;
  return allowed.includes(freshness);
}

// ── Thresholds Getter ──────────────────────────────────────────────────

export function getFreshnessThresholds(): Record<string, FreshnessThreshold> {
  return { ...THRESHOLDS };
}

export function getThresholdForType(dataType: string): FreshnessThreshold {
  return THRESHOLDS[dataType] || THRESHOLDS.default;
}
