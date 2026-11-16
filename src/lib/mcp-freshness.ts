/// NSE MCP Research Layer — Freshness Engine (Minimal)
/// Exchange-calendar-aware freshness classification for NSE MCP data.
/// Imports types from mcp-types.ts — no duplicate declarations.

import { McpFreshness } from "./mcp-types";

// ──────────────────────────────────────────────────────────────
// NSE Trading Calendar 2026 (minimal set)
// ──────────────────────────────────────────────────────────────

// Key NSE holidays 2026 that close the market
const CLOSED_DATES = new Set([
  "2026-01-26", // Republic Day
  "2026-03-08", // Holi
  "2026-04-06", // Good Monday
  "2026-04-14", // Dr. Ambedkar Jayanti
  "2026-05-01", // Labour Day
  "2026-05-26", // Buddha Purnima
  "2026-08-15", // Independence Day
  "2026-10-02", // Gandhi Jayanti
  "2026-11-15", // Guru Nanak Jayanti
]);

// Market session constants (IST minutes)
const MARKET_OPEN = 9 * 60 + 15;   // 9:15 IST
const MARKET_CLOSE = 15 * 60 + 30; // 15:30 IST
const PRE_MARKET = 9 * 60;         // 9:00 IST

// ──────────────────────────────────────────────────────────────
// Timestamp Parsing (IST conversion)
// ──────────────────────────────────────────────────────────────

/** Parse ISO timestamp, return minutes-since-midnight in IST, or null. */
function parseISTMin(ts: string): number | null {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    const h = d.getUTCHours(), m = d.getUTCMinutes();
    let ih = h + 5, im = m + 30;
    if (im >= 60) { im -= 60; ih++; }
    if (ih >= 24) ih -= 24;
    return ih * 60 + im;
  } catch { return null; }
}

/** Get current IST minutes-since-midnight. */
function nowISTMin(): number {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ──────────────────────────────────────────────────────────────
// Freshness Determination
// ──────────────────────────────────────────────────────────────

/**
 * Determine MCP data freshness state.
 * @param tsISO ISO timestamp string (e.g. "2026-11-15T15:30:00+05:30")
 * @param currentISTMin Current time in IST minutes-since-midnight
 * @param isTradingDay True if the data date is an NSE trading day
 * @returns McpFreshness enum value
 */
export function determineFreshness(
  tsISO: string | null | undefined,
  currentISTMin: number,
  isTradingDay: boolean
): McpFreshness {
  if (!tsISO || typeof tsISO !== "string" || tsISO.trim().length === 0)
    return McpFreshness.INVALID;

  const dt = parseISTMin(tsISO);
  if (dt === null) return McpFreshness.INVALID;

  // Future timestamp
  if (dt > currentISTMin) return McpFreshness.FUTURE;

  // Not a trading day
  if (!isTradingDay) return McpFreshness.CLOSED;

  // During regular trading session (9:15–15:30 IST) → FRESH
  if (PRE_MARKET < dt && dt <= MARKET_CLOSE) return McpFreshness.FRESH;

  // Post-market (after 15:30 IST)
  if (dt <= PRE_MARKET) {
    const age = currentISTMin - dt;
    if (age <= 5) return McpFreshness.FRESH;
    if (age <= 15) return McpFreshness.DELAYED;
    return McpFreshness.STALE;
  }

  // Pre-market (before 9:15 IST)
  if (dt < PRE_MARKET) {
    const age = currentISTMin - dt;
    if (age <= 30) return McpFreshness.FRESH;
    if (age <= 60) return McpFreshness.DELAYED;
    return McpFreshness.STALE;
  }

  // After trading ends
  if (dt > MARKET_CLOSE) {
    const age = currentISTMin - dt;
    if (age <= 5) return McpFreshness.FRESH;
    if (age <= 15) return McpFreshness.DELAYED;
    return McpFreshness.STALE;
  }

  return McpFreshness.UNKNOWN;
}

// ──────────────────────────────────────────────────────────────
// Exported Types
// ──────────────────────────────────────────────────────────────

export type { McpFreshness };

// ──────────────────────────────────────────────────────────────
// Convenience: classify a timestamp's session
// ──────────────────────────────────────────────────────────────

function sessionOf(istMin: number): string {
  if (istMin < PRE_MARKET) return "pre_market";
  if (istMin < MARKET_OPEN) return "pre_market";
  if (istMin <= MARKET_CLOSE) return "regular";
  return "post_market";
}

// ──────────────────────────────────────────────────────────────
// Validation Helpers (simple)
// ──────────────────────────────────────────────────────────────

/** Basic pre-market/intraday validation result. */
export interface SimpleValidationResult {
  symbol: string;
  spotPrice: number;
  changePct: number;
  volume: number;
  timestamp: string;
  freshness: McpFreshness;
  errors: string[];
}

/** Validate minimal pre-market/intraday data. */
export function simpleValidate(raw: any): SimpleValidationResult {
  const errors: string[] = [];
  const symbol = (raw.symbol || "").toString().trim().toUpperCase() || "UNKNOWN";
  const spotPrice = Number(raw.spotPrice);
  const changePct = Number(raw.changePct);
  const volume = Number(raw.volume);
  const timestamp = String(raw.timestamp || "");
  const istMin = nowISTMin();
  let freshness = McpFreshness.INVALID;

  if (!timestamp) errors.push("timestamp required");
  else {
    const pt = parseISTMin(timestamp);
    if (pt === null) errors.push("timestamp unparseable");
    else freshness = determineFreshness(timestamp, istMin, true);
  }

  if (!isFinite(spotPrice) || spotPrice <= 0) errors.push("spotPrice must be finite positive");
  if (!isFinite(changePct)) errors.push("changePct must be finite");
  if (!isFinite(volume) || volume < 0) errors.push("volume must be non-negative");

  return {
    symbol,
    spotPrice: isFinite(spotPrice) && spotPrice > 0 ? spotPrice : 0,
    changePct: isFinite(changePct) ? changePct : 0,
    volume: isFinite(volume) && volume >= 0 ? volume : 0,
    timestamp,
    freshness,
    errors,
  };
}
