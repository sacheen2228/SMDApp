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
