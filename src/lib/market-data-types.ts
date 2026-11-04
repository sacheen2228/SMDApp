// Universal Market Data Types — SDMApp
//
// Single standard response envelope for ALL market-data consumers across the
// entire application: every dashboard tab, card, scanner, engine, agent and
// Hermes tool receives data in this shape. Source transparency is mandatory
// — every value carries its provider, source type, timestamp and freshness.
//
// No consumer may independently implement a different fallback system or
// fabricate missing market data.

export type ProviderName =
  | "motilal-api"
  | "icici-breeze"
  | "nse-api"
  | "bse-api"
  | "moneycontrol"
  // FII/DII adapter (NSE + MrChartist chain). It MUST have its own name:
  // `providers` is a Map keyed by ProviderName, so sharing "nse-api" with the
  // main NSE adapter silently overwrote it and NSE disappeared from every
  // other category (option chain, VIX, market status …).
  | "fii-dii"
  | "cache"
  | "unavailable";

// Where the data actually came from.
export type SourceType = "PRIMARY" | "FALLBACK" | "CACHE";

// Universal freshness classification.
export type FreshnessLevel = "LIVE" | "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";

// Data category — each has its own provider-priority order.
export type DataCategory =
  | "quotes"
  | "option-chain"
  | "candles"
  | "greeks"
  | "oi-pcr"
  | "max-pain"
  | "spot"
  | "index-quote"
  | "fii-dii"
  | "news"
  | "vix"
  | "market-status"
  | "bhavcopy"
  | "pre-open"
  | "default";

// Validation result for a provider response.
export interface ValidationResult {
  valid: boolean;
  missingFields: string[];
  invalidFields: string[];
  reason: string;
}

// Standardized envelope returned by the shared data service for every request.
export interface MarketDataEnvelope<T = any> {
  // Instrument identification
  symbol: string;
  exchange?: string;
  instrument?: string;   // 'EQUITY' | 'INDEX' | 'FUTURES' | 'OPTION' | 'CE' | 'PE'
  expiry?: string;       // YYYY-MM-DD when applicable

  // Actual market value (the payload — shape depends on category)
  data: T;

  // Source attribution (mandatory, never hidden)
  provider: ProviderName;
  source: SourceType;           // PRIMARY / FALLBACK / CACHE
  fallbackUsed: boolean;
  fallbackReason?: string;      // why we fell off the primary

  // Timestamps
  providerTimestamp?: string;   // the provider's own publication time (ISO)
  fetchedAt: string;            // when we fetched it (ISO)
  ageMs: number;                // fetchedAt − providerTimestamp (or 0 if undated)

  // Quality
  freshness: FreshnessLevel;
  delayed: boolean;
  validation: ValidationResult;

  // Provider errors (from any provider we tried and failed)
  providerErrors: Array<{ provider: ProviderName; error: string; kind: "SESSION_EXPIRED" | "NO_DATA" | "SOURCE_UNAVAILABLE" | "NETWORK" | "VALIDATION" }>;

  // Availability verdict
  available: boolean;           // false when NO valid source answered
  unavailableReason?: string;
}

// Per-category provider priority order (configurable).
export interface ProviderPriority {
  category: DataCategory;
  order: ProviderName[];        // tried in this order; first valid answer wins
}

// Snapshot cached in the shared cache.
export interface CacheEntry<T = any> {
  envelope: MarketDataEnvelope<T>;
  expiresAt: number;
}

// Circuit-breaker-friendly failure classification (mirrors session-health.ts
// kinds but lives here so the data service can classify without importing
// session-health's alerting surface).
export type FailureKind = "SESSION_EXPIRED" | "NO_DATA" | "SOURCE_UNAVAILABLE" | "NETWORK" | "VALIDATION";

export function classifyFailure(err: any, provider: ProviderName): FailureKind {
  const msg = String(err?.message || err || "").toLowerCase();
  const auth = /session expired|invalid token|unauthorized|401|403|auth token not verified|auth failed|could not authenticate|invalid api session|token may be expired|not verified|invalid session/.test(msg);
  const network = /timeout|fetch failed|network|econn|esocket|etimedout|enotfound|not implemented|capability|no candle endpoint|unknown symbol|not in allowlist|current session only|has no intraday|derivatives-only|eod daily only/.test(msg);
  const empty = /no rows|no data|empty|not found/.test(msg);
  if (auth) return "SESSION_EXPIRED";
  if (network) return "NETWORK";
  if (empty) return "NO_DATA";
  return "SOURCE_UNAVAILABLE";
}

export function validateEnvelope<T>(env: MarketDataEnvelope<T>): ValidationResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const reason: string[] = [];

  if (env.provider === "unavailable") {
    missing.push("provider");
    reason.push("no provider answered");
  }
  if (env.data == null) {
    missing.push("data");
    reason.push("no data payload");
  }
  if (env.providerTimestamp == null) {
    missing.push("providerTimestamp");
    reason.push("no verifiable provider timestamp");
  }
  if (!env.available) {
    reason.push(env.unavailableReason || "unavailable");
  }

  return {
    valid: env.available && env.data != null && missing.length === 0,
    missingFields: missing,
    invalidFields: invalid,
    reason: reason.join("; "),
  }
}

// Configuration for the shared service.
export interface MarketDataServiceConfig {
  // Per-category provider priority.
  priorities: Record<DataCategory, ProviderName[]>;
  // Per-provider fetch timeout (ms).
  timeouts: Record<ProviderName, number>;
  // Cache TTL per category (ms).
  cacheTtl: Record<DataCategory, number>;
  // Whether to allow stale cache as last resort.
  allowStaleCache: boolean;
  // Max consecutive failures before circuit-breaker skip (handled by provider-health).
  maxConsecutiveFailures: number;
}

export const DEFAULT_CONFIG: MarketDataServiceConfig = {
  priorities: {
    quotes: ["motilal-api", "icici-breeze", "nse-api", "moneycontrol"],
    optionChain: ["motilal-api", "nse-api", "bse-api", "icici-breeze"],
    candles: ["motilal-api", "icici-breeze", "nse-api"],
    greeks: ["motilal-api", "icici-breeze", "nse-api"],
    "oi-pcr": ["motilal-api", "nse-api", "bse-api"],
    "max-pain": ["motilal-api", "nse-api", "bse-api"],
    spot: ["motilal-api", "icici-breeze", "nse-api", "bse-api"],
    "index-quote": ["motilal-api", "icici-breeze", "nse-api", "bse-api"],
    "fii-dii": ["fii-dii"],
    news: ["moneycontrol"],
    vix: ["nse-api"],
    "market-status": ["nse-api"],
    bhavcopy: ["nse-api", "bse-api"],
    "pre-open": ["nse-api", "bse-api"],
    default: ["motilal-api", "icici-breeze", "nse-api", "bse-api", "moneycontrol"],
  },
  timeouts: {
    "motilal-api": 15_000,
    "icici-breeze": 10_000,
    "nse-api": 8_000,
    "bse-api": 8_000,
    moneycontrol: 8_000,
    "fii-dii": 15_000,
    cache: 0,
    unavailable: 0,
  },
  cacheTtl: {
    quotes: 30_000,
    optionChain: 60_000,
    candles: 300_000,
    greeks: 30_000,
    "oi-pcr": 60_000,
    "max-pain": 60_000,
    spot: 15_000,
    "index-quote": 15_000,
    "fii-dii": 3_600_000,
    news: 300_000,
    vix: 60_000,
    "market-status": 60_000,
    bhavcopy: 86_400_000,
    "pre-open": 60_000,
    default: 60_000,
  },
  allowStaleCache: true,
  maxConsecutiveFailures: 5,
};

// A provider adapter: every data source plugs in through this interface.
export interface MarketDataProvider<T = any> {
  name: ProviderName;
  // Categories this provider can serve (empty = all).
  categories?: DataCategory[];
  // Fetch + validate one request. Return null when this provider cannot answer.
  fetch: (opts: {
    symbol: string;
    category: DataCategory;
    exchange?: string;
    instrument?: string;
    expiry?: string;
    nowMs?: number;
  }) => Promise<{ data: T; providerTimestamp?: string; validation?: ValidationResult } | null>;
}
