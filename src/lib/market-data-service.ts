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
  DataQuality,
  FailureKind,
  classifyFailure,
  normalizeCategory,
  validateEnvelope,
} from "./market-data-types";
import { runOptionChainRace, type CanonicalChain } from "./market-data-race";
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
export function toProviderHealthType(p: ProviderName): import("./provider-health").ProviderType {
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
// Last time a source answered successfully, per cache key. Survives a fallback
// (the timestamp of the last GOOD answer, not of the last attempt).
const lastSuccessAt: Map<string, number> =
  (g.__SMD_MD_LASTSUCCESS__ ??= new Map<string, number>());

const DEFAULT_TTL = 60_000;

function categoryTtl(config: MarketDataServiceConfig, category: DataCategory): number {
  return config.cacheTtl[category] ?? config.cacheTtl.default ?? DEFAULT_TTL;
}

/** Quality verdict for an envelope — derived, never hand-set by a provider. */
function classifyQuality(env: {
  source: SourceType;
  fallbackUsed: boolean;
  freshness: FreshnessLevel;
  delayed: boolean;
  providerTimestamp?: string;
  available: boolean;
  validation: ValidationResult;
}): DataQuality {
  if (!env.available) return "UNKNOWN";
  if (env.source === "CACHE" || env.freshness === "STALE") return "STALE";
  if (env.fallbackUsed || env.delayed) return "DEGRADED";
  if (!env.providerTimestamp) return "UNKNOWN";
  if (!env.validation?.valid) return "DEGRADED";
  return "OK";
}

/** Re-key a config table (priorities / cacheTtl) to canonical category names. */
function normalizeTable(table: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(table || {})) {
    out[normalizeCategory(k)] = v;
  }
  return out;
}

/** Merge a caller patch over the default config, keeping category tables keyed canonically. */
function mergeConfig(
  base: MarketDataServiceConfig,
  patch?: Partial<MarketDataServiceConfig>,
): MarketDataServiceConfig {
  if (!patch) return base;
  const merged: MarketDataServiceConfig = { ...base, ...patch };
  merged.priorities = { ...base.priorities, ...normalizeTable(patch.priorities) };
  merged.cacheTtl = { ...base.cacheTtl, ...normalizeTable(patch.cacheTtl) };
  return merged;
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
  const config: MarketDataServiceConfig = mergeConfig(DEFAULT_CONFIG, opts.config);
  // Canonical category name — the config tables and the adapters both key on it.
  const normalized: typeof opts = { ...opts, category: normalizeCategory(opts.category) };
  const key = cacheKey(normalized);

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
      env.freshness = classifyFreshness(env.ageMs, normalized.category);
      env.delayed = env.freshness === "DELAYED" || env.freshness === "STALE";
      env.quality = classifyQuality(env);
      env.lastSuccessfulUpdate = lastSuccessAt.has(key)
        ? new Date(lastSuccessAt.get(key)!).toISOString()
        : cached.envelope.lastSuccessfulUpdate;
      return env;
    }
  }

  // 2. In-flight dedup — concurrent identical requests share one fetch
  const inflight = inFlight.get(key);
  if (inflight) return (await inflight) as MarketDataEnvelope<T>;

  const promise = (async () => {
    try {
      return await doFetchMarketData<T>(normalized, config, nowMs);
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

  // ── Option chain: parallel provider race (critical live-data rule) ──
  // Launch eligible providers concurrently; first complete, valid, fresh chain
  // wins. Tie-break Breeze → MOAPI → NSE → BSE. Never merge providers; never
  // label stale/delayed data as live.
  if (category === "option-chain") {
    return doFetchOptionChainRace<T>(opts, config, nowMs);
  }

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
    lastSuccessAt.set(cacheKey(opts), nowMs);

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
      publicationTimestamp: result.providerTimestamp,
      fetchedAt: new Date(nowMs).toISOString(),
      ageMs,
      lastSuccessfulUpdate: new Date(nowMs).toISOString(),
      freshness,
      delayed,
      quality: "UNKNOWN",
      validation,
      providerErrors,
      available: true,
    };
    env.quality = classifyQuality(env);

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
          quality: "STALE",
        };
        env.freshness = "STALE";
        env.delayed = true;
        return env;
      }
    }

    return noValidProviderEnvelope<T>(category, opts, config, nowMs, providerErrors);
  }

  // ── No valid provider — shared tail for sequential and race paths ──
  async function noValidProviderEnvelope<T = any>(
    category: DataCategory,
    opts: { symbol: string; exchange?: string; instrument?: string; expiry?: string; nowMs?: number },
    config: MarketDataServiceConfig,
    nowMs: number,
    providerErrors: MarketDataEnvelope["providerErrors"],
  ): Promise<MarketDataEnvelope<T>> {
    const order = config.priorities[category] ?? config.priorities.default;

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
          quality: "STALE",
        };
        env.freshness = "STALE";
        env.delayed = true;
        return env;
      }
    }

    return {
      symbol: opts.symbol,
      exchange: opts.exchange,
      instrument: opts.instrument,
      expiry: opts.expiry,
      data: null,
      provider: "unavailable",
      source: "PRIMARY",
      fallbackUsed: false,
      providerTimestamp: undefined,
      publicationTimestamp: undefined,
      fetchedAt: new Date(nowMs).toISOString(),
      ageMs: 0,
      lastSuccessfulUpdate: lastSuccessAt.has(cacheKey(opts))
        ? new Date(lastSuccessAt.get(cacheKey(opts))!).toISOString()
        : undefined,
      freshness: "UNAVAILABLE",
      delayed: true,
      quality: "UNKNOWN",
      validation: validateEnvelope({
        symbol: opts.symbol,
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
  }

  // ── Option chain: parallel provider race ──
  // First complete, valid, fresh chain wins. Tie-break Breeze → MOAPI → NSE → BSE.
  async function doFetchOptionChainRace<T = any>(
    opts: {
      symbol: string;
      category: DataCategory;
      exchange?: string;
      instrument?: string;
      expiry?: string;
      nowMs?: number;
    },
    config: MarketDataServiceConfig,
    nowMs: number,
  ): Promise<MarketDataEnvelope<T>> {
    const { symbol, exchange, expiry } = opts;

    // Pre-market / post-market: broker feeds (Breeze / MOAPI) are not used for
    // live option data — only the exchange archives (NSE / BSE). Skipping them
    // here also avoids their timeouts when the market is closed.
    let raceProviders: ProviderName[] | undefined;
    try {
      const { getCurrentSession } = await import("./market-session");
      const session = getCurrentSession();
      if (session && session.isMarketOpen === false) {
        raceProviders = ["nse-api", "bse-api"];
      }
    } catch {
      /* session module unavailable — use the full provider list */
    }

    const race = await runOptionChainRace({
      symbol,
      exchange,
      expiry,
      nowMs,
      shadow: false,
      providers: raceProviders,
    });

    // Record every attempt with provider-health so the circuit breaker sees it.
    const validAttempts: Array<{ name: ProviderName; latencyMs: number }> = [];
    for (const a of race.attempts) {
      const phType = toProviderHealthType(a.name);
      if (a.status === "circuit_open" || a.status === "not_registered") continue;
      if (a.status === "valid") {
        providerHealth.recordSuccess(phType, a.latencyMs);
        validAttempts.push({ name: a.name, latencyMs: a.latencyMs });
        lastSuccessAt.set(cacheKey(opts), nowMs);
      } else {
        const kind = classifyFailure(new Error(a.error ?? "invalid or empty chain"), a.name);
        providerHealth.recordFailure(phType, kind, a.error ?? "invalid or empty chain");
        // Report session expiry to session-health (single owner of session alerts)
        if (kind === "SESSION_EXPIRED") {
          const ss = toSessionSource(a.name);
          if (ss) reportSessionFailure(ss, kind, a.error ?? "session expired");
        }
      }
    }

    if (!race.winner) {
      const providerErrors = race.attempts.map((a) => ({
        provider: a.name,
        error: a.error ?? "no valid chain",
        kind: a.status === "error" ? "NETWORK" : a.status === "invalid" ? "VALIDATION" : "NO_DATA",
      }));
      return noValidProviderEnvelope<T>(opts.category, opts, config, nowMs, providerErrors);
    }

    const c = race.winner;
    const pt = c.providerTimestamp ? new Date(c.providerTimestamp).getTime() : null;
    const ageMs = pt ? Math.max(0, nowMs - pt) : 0;
    let freshness: FreshnessLevel = pt
      ? classifyFreshness(ageMs, opts.category)
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

    // Source type: the winner is PRIMARY when it was the highest-priority
    // provider to return a valid answer (configured priority breaks ties).
    const order = config.priorities["option-chain"] ?? config.priorities.default;
    const firstValidRank = validAttempts
      .map((a) => order.indexOf(a.name))
      .filter((r) => r >= 0)
      .sort((a, b) => a - b)[0];
    const winnerRank = order.indexOf(c.source);
    const sourceType: SourceType = winnerRank === firstValidRank ? "PRIMARY" : "FALLBACK";
    const fallbackReason =
      sourceType === "FALLBACK"
        ? `primary provider(s) failed: ${race.attempts
            .filter((a) => a.status !== "valid" && a.status !== "circuit_open" && a.status !== "not_registered")
            .map((a) => a.name)
            .join(",")}`
        : undefined;

    const validation = validateEnvelope({
      symbol,
      provider: c.source,
      source: sourceType as SourceType,
      data: { strikes: c.strikes, spotPrice: c.spotPrice },
      providerTimestamp: c.providerTimestamp,
      fetchedAt: new Date(nowMs).toISOString(),
      ageMs,
      freshness,
      delayed,
      providerErrors: [],
      available: true,
    });

    const env: MarketDataEnvelope<T> = {
      symbol,
      exchange: opts.exchange,
      instrument: opts.instrument,
      expiry: opts.expiry,
      data: {
        strikes: c.strikes,
        spotPrice: c.spotPrice,
        expiryDates: c.expiry ? [c.expiry] : [],
        selectedExpiry: c.expiry,
        expiry: c.expiry,
        summary: { spotPrice: c.spotPrice },
      } as T,
      provider: c.source,
      source: sourceType,
      fallbackUsed: sourceType === "FALLBACK",
      fallbackReason,
      providerTimestamp: c.providerTimestamp,
      publicationTimestamp: c.providerTimestamp,
      fetchedAt: new Date(nowMs).toISOString(),
      ageMs,
      lastSuccessfulUpdate: new Date(nowMs).toISOString(),
      freshness,
      delayed,
      quality: classifyQuality({
        source: sourceType,
        fallbackUsed: sourceType === "FALLBACK",
        freshness,
        delayed,
        providerTimestamp: c.providerTimestamp,
        available: true,
        validation,
      }),
      validation,
      providerErrors: race.attempts
        .filter((a) => a.status !== "circuit_open" && a.status !== "not_registered")
        .map((a) => ({
          provider: a.name,
          error: a.error ?? null,
          kind: a.status === "error" ? "NETWORK" : a.status === "invalid" ? "VALIDATION" : "NO_DATA",
        }))
        .filter((e) => e.error),
      available: true,
    };

    // Cache the successful result
    const ttl = categoryTtl(config, opts.category);
    cache.set(cacheKey(opts), {
      envelope: env,
      expiresAt: nowMs + ttl,
    });
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

export { ensureProvidersRegistered };

export function getProvider(name: ProviderName): MarketDataProvider | undefined {
  return providers.get(name);
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

export async function fetchGreeks(opts: {
  symbol: string;
  exchange?: string;
  instrument?: string;
  expiry?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "greeks" });
}

export async function fetchMaxPain(opts: {
  symbol: string;
  exchange?: string;
  instrument?: string;
  expiry?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "max-pain" });
}

export async function fetchPreOpen(opts: {
  symbol: string;
  exchange?: string;
  instrument?: string;
  expiry?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "pre-open" });
}

export async function fetchBhavcopy(opts: {
  symbol: string;
  exchange?: string;
  instrument?: string;
  expiry?: string;
  nowMs?: number;
  config?: Partial<MarketDataServiceConfig>;
  bypassCache?: boolean;
}): Promise<MarketDataEnvelope> {
  return fetchMarketData({ ...opts, category: "bhavcopy" });
}
