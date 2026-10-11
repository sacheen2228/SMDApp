// API Freshness Utilities
// Shared helpers for adding data freshness metadata to API responses
// Used by: option-chain, regime, fii-dii, and other data routes

export type FreshnessLevel = "LIVE" | "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";

export interface FreshnessMeta {
  provider: string;
  source: string;
  timestamp: string;
  ageMs: number;
  freshness: FreshnessLevel;
  delayed: boolean;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

// Provider reliability scores (0-1)
const PROVIDER_RELIABILITY: Record<string, number> = {
  "icici-breeze": 0.95,
  "motilal-api": 0.90,
  "nse-api": 0.85,
  "bse-api": 0.80,
  "yahoo-finance": 0.60,
  "mrchartist": 0.65,
  "simulation": 0.0,
};

// Freshness thresholds by data type (ms)
const FRESHNESS_THRESHOLDS: Record<string, { live: number; fresh: number; delayed: number }> = {
  optionChain: { live: 30_000, fresh: 180_000, delayed: 600_000 },
  spot: { live: 15_000, fresh: 180_000, delayed: 300_000 },
  regime: { live: 60_000, fresh: 300_000, delayed: 900_000 },
  fiiDii: { live: 3_600_000, fresh: 86_400_000, delayed: 172_800_000 },
  default: { live: 30_000, fresh: 120_000, delayed: 600_000 },
};

/**
 * Classify data freshness based on age
 */
export function classifyFreshness(ageMs: number, dataType: string = "default"): FreshnessLevel {
  if (ageMs < 0) return "STALE";
  const t = FRESHNESS_THRESHOLDS[dataType] || FRESHNESS_THRESHOLDS.default;
  if (ageMs <= t.live) return "LIVE";
  if (ageMs <= t.fresh) return "FRESH";
  if (ageMs <= t.delayed) return "DELAYED";
  return "STALE";
}

/**
 * Extract age in ms from a provider payload's own published timestamp.
 * Returns null when the payload carries no verifiable timestamp — callers
 * must then NOT claim LIVE (a 200 response is not proof of liveness).
 * When a timestamp is present, a future/backdated value clamps to >= 0.
 */
/**
 * The provider's own publication timestamp, as a Date, or null when the
 * payload carries none. Never falls back to "now" — an undated payload is
 * undated.
 */
export function providerTimestamp(raw: any): Date | null {
  const ts =
    raw?.records?.timestamp ??
    raw?.records?.TimeVal ??
    raw?.timestamp ??
    raw?.lastUpdate ??
    raw?.lastUpdateTime ??
    raw?.TimeVal ??
    raw?.tradeDate ??
    // BSE DerivOptionChain_IV: { ASON: { DT_TM: "09 Oct 2026 | 19:21 " } }
    raw?.ASON?.DT_TM ??
    null;
  if (ts == null || ts === "") return null;
  const normalized = String(ts).replace(' | ', ' ');
  const ms = typeof ts === 'number' ? ts : new Date(normalized).getTime();
  if (isNaN(ms)) return null;
  return new Date(ms);
}

export function providerAgeMs(raw: any): number | null {
  const d = providerTimestamp(raw);
  if (!d) return null;
  return Math.max(0, Date.now() - d.getTime());
}

/**
 * Freshness for a freshly-collected provider payload.
 * With a provider timestamp: age is computed honestly.
 * Without one: capped at FRESH (collected now, but unverifiable — never LIVE).
 */
export function collectedFreshness(raw: any, dataType = "optionChain"): FreshnessLevel {
  const age = providerAgeMs(raw);
  if (age === null) return "FRESH";
  return classifyFreshness(age, dataType);
}

/**
 * Build freshness metadata for an API response
 */
export function buildFreshnessMeta(params: {
  provider: string;
  source?: string;
  dataTimestamp: Date | string;
  dataType?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
}): FreshnessMeta {
  const dataTs = typeof params.dataTimestamp === "string"
    ? new Date(params.dataTimestamp).getTime()
    : params.dataTimestamp.getTime();
  const ageMs = Date.now() - dataTs;
  const freshness = classifyFreshness(ageMs, params.dataType || "default");

  return {
    provider: params.provider,
    source: params.source || params.provider,
    timestamp: new Date(dataTs).toISOString(),
    ageMs: Math.max(0, ageMs),
    freshness,
    delayed: freshness === "DELAYED" || freshness === "STALE",
    fallbackUsed: params.fallbackUsed || false,
    fallbackReason: params.fallbackReason,
  };
}

/**
 * Get reliability score for a provider
 */
export function getProviderReliability(provider: string): number {
  return PROVIDER_RELIABILITY[provider] ?? 0.5;
}

/** Coarse trading-session labels from expiry-liquidity/market-session-config. */
export type TradingSessionLabel = "PRE_OPEN" | "OPEN" | "REGULAR" | "POST_MARKET" | "CLOSED";

/**
 * LIVE is only truthful while the exchange is open and actually printing.
 * A successful fetch on a weekend, holiday, pre-open or after-hours returns
 * the last known state — classify it STALE, never LIVE. A cache hit that
 * lands outside market hours must not be promoted either.
 */
export function sessionAwareFreshness(
  freshness: FreshnessLevel,
  session: TradingSessionLabel,
): FreshnessLevel {
  if (freshness === "LIVE" && session !== "OPEN" && session !== "REGULAR") return "STALE";
  return freshness;
}

/**
 * Downgrade a built meta when it was collected outside market hours.
 * Keeps ageMs/timestamp/provider intact — only the classification moves.
 */
export function withSessionAwareFreshness<T extends { freshness: FreshnessLevel; delayed: boolean }>(
  meta: T,
  session: TradingSessionLabel,
): T {
  const freshness = sessionAwareFreshness(meta.freshness, session);
  return {
    ...meta,
    freshness,
    delayed: freshness === "DELAYED" || freshness === "STALE",
  };
}
