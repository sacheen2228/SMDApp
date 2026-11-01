// scanner-data-quality.ts
// 6-state data quality for the intraday scanner
// Maps provider freshness + market session + source availability to:
//   LIVE | DELAYED | STALE | PARTIAL | CLOSED | ERROR

import { classifyFreshness, sessionAwareFreshness, type FreshnessLevel } from "./api-freshness";

export type DataQuality = "LIVE" | "DELAYED" | "STALE" | "PARTIAL" | "CLOSED" | "ERROR";

export interface SourceStatus {
  ok: boolean;
  ageMs: number | null;
  source: string;
}

export interface DataQualityInput {
  chain: SourceStatus;
  quotes: SourceStatus;
  daily: { ok: boolean; count: number };
  clock: {
    isOpen: boolean;
    marketState: string;
    tradeDate: string | null;
    tradeAgeMs: number | null;
  };
  errors: string[];
}

// Thresholds (ms) — align with api-freshness FRESHNESS_THRESHOLDS
const CHAIN_STALE_MS = 600_000;   // 10 min — option chain degrades fast
const QUOTES_STALE_MS = 300_000;  // 5 min — quotes older are STALE
const DAILY_MIN_COUNT = 20;       // minimum daily candles for "ok"

function sourceFreshness(ageMs: number | null, staleMs: number): FreshnessLevel {
  if (ageMs == null) return "UNAVAILABLE";
  if (ageMs <= 30_000) return "LIVE";
  if (ageMs <= 120_000) return "FRESH";
  if (ageMs <= 600_000) return "DELAYED";
  return "STALE";
}

/**
 * Classify the scanner's overall data quality from source statuses and market clock.
 *
 * Priority (highest first):
 *   1. ERROR — any provider exception
 *   2. CLOSED — market closed (session trumps freshness)
 *   3. STALE — market open but critical source exceeds STALE threshold
 *   4. DELAYED — market open, sources present but in DELAYED bucket
 *   5. PARTIAL — market open, at least one source missing
 *   6. LIVE — market open, all sources fresh
 */
export function classifyScannerDataQuality(input: DataQualityInput): DataQuality {
  const { chain, quotes, daily, clock, errors } = input;

  // 1. Provider errors → ERROR (trumps everything)
  if (errors.length > 0) return "ERROR";

  // 2. Market closed → CLOSED (session trumps freshness)
  if (!clock.isOpen) return "CLOSED";

  // Market is open from here on
  const hasChain = chain.ok && chain.ageMs != null;
  const hasQuotes = quotes.ok && quotes.ageMs != null;
  const hasDaily = daily.ok && daily.count >= DAILY_MIN_COUNT;

  // 3. STALE: critical source (chain or quotes) exceeds STALE threshold
  const chainFreshness = sourceFreshness(chain.ageMs, CHAIN_STALE_MS);
  const quotesFreshness = sourceFreshness(quotes.ageMs, QUOTES_STALE_MS);
  if ((hasChain && chainFreshness === "STALE") || (hasQuotes && quotesFreshness === "STALE")) {
    return "STALE";
  }

  // 4. DELAYED: sources present but in DELAYED bucket (no STALE)
  if ((hasChain && chainFreshness === "DELAYED") || (hasQuotes && quotesFreshness === "DELAYED")) {
    return "DELAYED";
  }

  // 5. PARTIAL: at least one expected source missing/unavailable
  if (!hasChain || !hasQuotes || !hasDaily) {
    return "PARTIAL";
  }

  // 6. LIVE: all sources present and fresh (LIVE or FRESH)
  return "LIVE";
}