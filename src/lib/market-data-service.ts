// Universal Market Data Service — SDMApp
//
// Single provider-resolution + fallback engine for ALL market-data consumers.
// Every data request flows through here: quotes, option chains, candles, Greeks,
// OI/PCR, Max Pain, FII/DII, news, VIX, market status, bhavcopy, pre-open.
//
// Design principles:
//   • One provider-priority order per data category (configurable).
//   • First valid answer wins — never mix providers for one response.
//   • Source transparency is mandatory: every value carries provider, source
//     type (PRIMARY/FALLBACK/CACHE), timestamps and freshness.
//   • Never claim LIVE without a verifiable provider timestamp.
//   • Never fabricate data — return UNAVAILABLE when no source answers.
//   • Request deduplication: concurrent identical requests share one fetch.
//   • Circuit breaker via provider-health.ts; session failures via session-health.ts.

import { providerHealth } from "./provider-health";
import {
  reportSessionFailure,
  reportSessionRecovery,
  type SessionSource,
} from "./session-health";
import {
  MarketDataProvider,
  MarketDataEnvelope,
  CacheEntry,
  MarketDataServiceConfig,
  DEFAULT_CONFIG,
  ProviderName,
  DataCategory,
  FailureKind,
  classifyFailure,
  validateEnvelope,
} from "./market-data-types";
import {
  FreshnessLevel,
  classifyFreshness,
  providerTimestamp,
  providerAgeMs,
  buildFreshnessMeta,
  sessionAwareFreshness,
  withSessionAwareFreshness,
  getProviderReliability,
} from "./api-freshness";
import type { TradingSessionLabel } from "./api-freshness";

// Map our ProviderName → provider-health ProviderType for circuit-breaker lookups.
function toProviderHealthType(p: ProviderName): import("./provider-health").ProviderType {
  const map: Partial<Record<ProviderName, import("./provider-health").ProviderType>> = {
    "motilal-api": "moapi",
    "icici-breeze": "breeze",
    "nse-api": "nse",
    "bse-api": "bse",
    // The FII/DII adapter is NSE + MrChartist. It is deliberately NOT "nse":
    // a MrChartist bot-challenge must not trip the NSE session circuit.
    "fii-dii": "website",
    moneycontrol: "website",
    cache: "website",
    unavailable: "website",
  };
  return map[p] ?? "website";
}

// Map provider-health FailureKind → our FailureKind.
function toSessionSource(p: ProviderName): SessionSource | null {
  const map: Partial<Record<ProviderName, SessionSource | null>> = {
    "motilal-api": "mo",
    "icici-breeze": "breeze",
    "nse-api": "nse",
    "bse-api": "nse", // BSE has no session-health source; map to nse (never SESSION_EXPIRED)
    moneycontrol: "nse",
    cache: "nse",
    unavailable: "nse",
    // No session source: this adapter's failures are bot-challenges / provider
    // downtime, never a broker or exchange token expiring. Emitting a
    // [SYSTEM][SESSION_EXPIRED] alert here would be a false page.
    "fii-dii": null,
  };
  return map[p] ?? null;
}

// ── Registry & cache ────────────────────────────────────────────────────────

// Process-wide on globalThis: every route is its own module graph, so these
// Maps must be shared — otherwise a provider registered in one route is
// invisible in another (and each route keeps its own cache).
const g = globalThis as any;
const providers: Map<ProviderName, MarketDataProvider> =
  (g.__SMD_MD_PROVIDERS__ ??= new Map<ProviderName, MarketDataProvider>());
const cache: Map<string, CacheEntry> =
  (g.__SMD_MD_CACHE__ ??= new Map<string, CacheEntry>());
const inFlight: Map<string, Promise<MarketDataEnvelope<any>>> =
  (g.__SMD_MD_INFLIGHT__ ??= new Map<string, Promise<MarketDataEnvelope<any>>>());

const DEFAULT_TTL = 60_000;

function categoryTtl(config: MarketDataServiceConfig, category: DataCategory): number {
  return config.cacheTtl[category] ?? config.cacheTtl.default ?? DEFAULT_TTL;
}

function providerTimeout(config: MarketDataServiceConfig, provider: ProviderName): number {
  return config.timeouts[provider] ?? config.timeouts.default ?? 10_000;
}

function cacheKey(opts: {
  symbol: string;
  category: DataCategory;
  exchange?: string;
  instrument?: string;
  expiry?: string;
}): string {
  return [
    opts.category,
    opts.exchange || "",
    opts.symbol.toUpperCase(),
    opts.instrument || "",
    opts.expiry || "",
  ].join("|");
}

// ── Core fetch ──────────────────────────────────────────────────────────────

export async function fetchMarketData<T = any>(
  opts: {
    symbol: string;
    category: DataCategory;
    exchange?: string;
    instrument?: string;
    expiry?: string;
    nowMs?: number;
    config?: Partial<MarketDataServiceConfig>;
    bypassCache?: boolean;
  },
): Promise<MarketDataEnvelope<T>> {
  await ensureProvidersRegistered();

  const nowMs = opts.nowMs ?? Date.now();
  const config: MarketDataServiceConfig = { ...DEFAULT_CONFIG, ...opts.config };
  const key = cacheKey(opts);

  // 1. Cache hit (not bypassed, not expired)
  if (!opts.bypassCache) {
    const cached = cache.get(key);
    if (cached && nowMs < cached.expiresAt) {
      const env: MarketDataEnvelope<T> = {
        ...cached.envelope,
        source: "CACHE",
        fetchedAt: new Date(nowMs).toISOString(),
        ageMs: nowMs - new Date(cached.envelope.fetchedAt).getTime(),
      };
      env.freshness = classifyFreshness(env.ageMs, opts.category);
      env.delayed = env.freshness === "DELAYED" || env.freshness === "STALE";
      return env;
    }
  }

  // 2. In-flight dedup — concurrent identical requests share one fetch
  const inflight = inFlight.get(key);
  if (inflight) return (await inflight) as MarketDataEnvelope<T>;

  const promise = (async () => {
    try {
      return await doFetchMarketData<T>(opts, config, nowMs);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

async function doFetchMarketData<T = any>(
  opts: {
    symbol: string;
    category: DataCategory;
    exchange?: string;
    instrument?: string;
    expiry?: string;
    nowMs?: number;
    config?: Partial<MarketDataServiceConfig>;
  },
  config: MarketDataServiceConfig,
  nowMs: number,
): Promise<MarketDataEnvelope<T>> {
  const { symbol, category } = opts;
  const order = config.priorities[category] ?? config.priorities.default;

  const providerErrors: MarketDataEnvelope["providerErrors"] = [];
  let lastValid: MarketDataEnvelope<T> | null = null;
  let usedProvider: ProviderName | null = null;
  let sourceType: SourceType = "PRIMARY";
  let fallbackReason: string | undefined;

  for (let i = 0; i < order.length; i++) {
    const providerName = order[i];
    const provider = providers.get(providerName);
    if (!provider) continue;

    // Circuit-breaker: skip unhealthy providers
    const phType = toProviderHealthType(providerName);
    if (providerHealth.shouldSkip(phType)) {
      providerErrors.push({
        provider: providerName,
        error: "circuit breaker open",
        kind: "SOURCE_UNAVAILABLE",
      });
      continue;
    }

    const timeoutMs = providerTimeout(config, providerName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let result: { data: T; providerTimestamp?: string; validation?: ValidationResult } | null = null;
    let err: any = null;

    try {
      result = await Promise.race([
        provider.fetch({
          symbol,
          category,
          exchange: opts.exchange,
          instrument: opts.instrument,
          expiry: opts.expiry,
          nowMs,
        }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () =>
            reject(new Error("provider timeout")),
          ),
        ),
      ]);
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(timer);
    }

    if (!result || !result.data) {
      const kind = err ? classifyFailure(err, providerName) : "NO_DATA";
      providerErrors.push({
        provider: providerName,
        error: err?.message || "no data returned",
        kind,
      });
      // Report session expiry to session-health (single owner of session alerts)
      if (kind === "SESSION_EXPIRED") {
        const ss = toSessionSource(providerName);
        if (ss) reportSessionFailure(ss, kind, err?.message || "session expired");
      }
      continue;
    }

    // Build envelope from this provider's answer
    const pt = result.providerTimestamp
      ? new Date(result.providerTimestamp).getTime()
      : null;
    const ageMs = pt ? Math.max(0, nowMs - pt) : 0;
    let freshness: FreshnessLevel = pt
      ? classifyFreshness(ageMs, category)
      : "FRESH"; // undated → collected now, unverifiable → never LIVE

    // Session-aware downgrade
    try {
      const { getCurrentSession } = await import("./market-session");
      const session = getCurrentSession();
      const sessionLabel: TradingSessionLabel =
        session?.isMarketOpen === true ? "REGULAR" : session?.session === "CLOSED"
          ? "CLOSED"
          : "PRE_OPEN";
      freshness = sessionAwareFreshness(freshness, sessionLabel);
    } catch {
      /* session module unavailable — keep raw freshness */
    }
    const delayed = freshness === "DELAYED" || freshness === "STALE";

    const validation = result.validation ?? validateEnvelope({
      symbol,
      provider: providerName,
      source: sourceType as SourceType,
      data: result.data,
      providerTimestamp: result.providerTimestamp,
      fetchedAt: new Date(nowMs).toISOString(),
      ageMs,
      freshness,
      delayed,
      providerErrors: [],
      available: true,
    });

    const available =
      result.data != null &&
      validation.valid &&
      providerName !== "unavailable";

    if (!available) {
      providerErrors.push({
        provider: providerName,
        error: validation.reason || "validation failed",
        kind: "VALIDATION",
      });
      continue;
    }

    // Valid answer found — first valid wins
    usedProvider = providerName;
    sourceType = i === 0 ? "PRIMARY" : "FALLBACK";
    fallbackReason = i > 0 ? `primary provider(s) failed: ${providerErrors.map((e) => e.provider).join(",")}` : undefined;

    // Record success with circuit breaker
    providerHealth.recordSuccess(
      phType,
      ageMs,
    );

    // Report recovery if this source was previously in a failed episode
    const ss = toSessionSource(providerName);
    if (ss) reportSessionRecovery(ss);

    const env: MarketDataEnvelope<T> = {
      symbol,
      exchange: opts.exchange,
      instrument: opts.instrument,
      expiry: opts.expiry,
      data: result.data,
      provider: providerName,
      source: sourceType,
      fallbackUsed: i > 0,
      fallbackReason,
      providerTimestamp: result.providerTimestamp,
      fetchedAt: new Date(nowMs).toISOString(),
      ageMs,
      freshness,
      delayed,
      validation,
      providerErrors,
      available: true,
    };

    lastValid = env;
    break;
  }

  // No provider answered validly
  if (!lastValid) {
    // Try stale cache as last resort (if allowed)
    if (config.allowStaleCache) {
      const cached = cache.get(cacheKey(opts));
      if (cached) {
        const env: MarketDataEnvelope<T> = {
          ...cached.envelope,
          source: "CACHE",
          fetchedAt: new Date(nowMs).toISOString(),
          ageMs: nowMs - new Date(cached.envelope.fetchedAt).getTime(),
          providerErrors,
          available: false,
          unavailableReason: "all providers failed; serving stale cache",
        };
        env.freshness = "STALE";
        env.delayed = true;
        return env;
      }
    }

    const env: MarketDataEnvelope<T> = {
      symbol,
      exchange: opts.exchange,
      instrument: opts.instrument,
      expiry: opts.expiry,
      data: null,
      provider: "unavailable",
      source: "PRIMARY",
      fallbackUsed: false,
      providerTimestamp: undefined,
      fetchedAt: new Date(nowMs).toISOString(),
      ageMs: 0,
      freshness: "UNAVAILABLE",
      delayed: true,
      validation: validateEnvelope({
        symbol,
        provider: "unavailable",
        source: "PRIMARY",
        data: null,
        providerTimestamp: undefined,
        fetchedAt: new Date(nowMs).toISOString(),
        ageMs: 0,
        freshness: "UNAVAILABLE",
        delayed: true,
        providerErrors: [],
        available: false,
      }),
      providerErrors,
      available: false,
      unavailableReason: `no valid provider for category ${category} (${order.join(" → ")})`,
    };
    return env;
  }

  // Cache the successful result
  const ttl = categoryTtl(config, category);
  cache.set(cacheKey(opts), {
    envelope: lastValid,
    expiresAt: nowMs + ttl,
  });

  return lastValid;
}

// ── Provider registration ───────────────────────────────────────────────────

/**
 * Load the adapter registry on first use.
 *
 * `market-data-providers.ts` registers by SIDE EFFECT, and nothing in the app
 * imported it — so the registry stayed empty and every category answered
 * "no valid provider" (the FII/DII card 503'd on every poll). The import is
 * dynamic because that module imports `registerProvider` from here: loading it
 * statically creates a cycle, while a deferred import runs after this module's
 * bindings are initialised.
 */
async function ensureProvidersRegistered(): Promise<void> {
  if (providers.size > 0) return;
  try {
    await import("./market-data-providers");
  } catch (err) {
    console.error("[MarketData] provider registration failed:", err);
  }
}

export function registerProvider(provider: MarketDataProvider): void {
  providers.set(provider.name, provider);
}

export function unregisterProvider(name: ProviderName): void {
  providers.delete(name);
}

export function getRegisteredProviders(): ProviderName[] {
  return Array.from(providers.keys());
}

// ── Cache management ────────────────────────────────────────────────────────

export function clearCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

export function getCacheStats(): { size: number; keys: string[] } {
  return { size: cache.size, keys: Array.from(cache.keys()) };
}

// ── Convenience wrappers per category ───────────────────────────────────────

export async function fetchQuotes(opts: {
  symbol: string;
  exchange?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "quotes" });
}

export async function fetchOptionChain(opts: {
  symbol: string;
  exchange?: string;
  instrument?: string;
  expiry?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "optionChain" });
}

export async function fetchCandles(opts: {
  symbol: string;
  exchange?: string;
  instrument?: string;
  expiry?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "candles" });
}

export async function fetchSpot(opts: {
  symbol: string;
  exchange?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "spot" });
}

export async function fetchIndexQuote(opts: {
  symbol: string;
  exchange?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "index-quote" });
}

export async function fetchOIPCR(opts: {
  symbol: string;
  exchange?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "oi-pcr" });
}

export async function fetchFIIDII(opts: {
  symbol?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({
    symbol: opts.symbol || "NIFTY",
    category: "fii-dii",
    nowMs: opts.nowMs,
    config: opts.config,
    bypassCache: opts.bypassCache,
  });
}

export async function fetchNews(opts: {
  symbol?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({
    symbol: opts.symbol || "MARKET",
    category: "news",
    nowMs: opts.nowMs,
    config: opts.config,
    bypassCache: opts.bypassCache,
  });
}

export async function fetchVIX(opts: {
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({
    symbol: "INDIA_VIX",
    category: "vix",
    nowMs: opts.nowMs,
    config: opts.config,
    bypassCache: opts.bypassCache,
  });
}

export async function fetchMarketStatus(opts: {
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({
    symbol: "NSE",
    category: "market-status",
    nowMs: opts.nowMs,
    config: opts.config,
    bypassCache: opts.bypassCache,
  });
}
