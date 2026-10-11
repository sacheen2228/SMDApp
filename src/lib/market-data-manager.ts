// Market Data Manager — unified data source orchestration with provider fallback
//
// Provider hierarchy (canonical, see AGENTS.md "Provider hierarchy"):
//   NSE/BSE primary → MOAPI fallback → NO_DATA
//   Breeze = explicit opt-in fallback only (session-gated)
//   Yahoo = RESEARCH ONLY — never labelled LIVE for trading
//
// Circuit breaking / cooldowns are NOT implemented here. They live in
// `provider-health.ts`, which is the single source of truth for every
// external provider (LLM SDKs, Breeze, NSE, BSE, MOAPI, Yahoo, website).
// This module only mirrors that state into a legacy-shaped `ProviderState`
// so existing consumers (/api/health, Hermes paper worker) keep working.

import type { DataProvider, DataFreshness, MarketDataResponse } from "./hermes/types";
import { classifyFreshness } from "./hermes/freshness";
import { providerHealth, type ProviderType, type CircuitState } from "./provider-health";

// ── Provider State (legacy-shaped view over provider-health) ──────────

export interface ProviderState {
  name: DataProvider;
  status: "UP" | "DEGRADED" | "DOWN" | "AUTH_REQUIRED" | "RATE_LIMITED" | "STALE" | "UNKNOWN";
  lastSuccess: number | null;
  lastFailure: number | null;
  latencyMs: number | null;
  errorCount: number;
  retryCount: number;
  cooldownUntil: number;
  circuitState: "CLOSED" | "OPEN" | "HALF_OPEN";
  consecutiveFailures: number;
}

// ── Provider Fallback Chain ────────────────────────────────────────────

// NSE first: it is the primary exchange for every symbol this chain serves.
// MOAPI is the fallback; Breeze only when a session is explicitly applied;
// Yahoo last and research-only.
const PROVIDER_PRIORITY: DataProvider[] = ["nse", "moapi", "breeze", "website", "yahoo"];

// MCX has no NSE/Breeze coverage — MOAPI → scrape → Yahoo.
const MCX_PROVIDER_PRIORITY: DataProvider[] = ["moapi", "breeze", "website", "yahoo"];

// ── Market Data Manager ────────────────────────────────────────────────

/** Map a hermes DataProvider onto a provider-health ProviderType. */
function toProviderType(provider: DataProvider): ProviderType {
  switch (provider) {
    case "icici-breeze":
      return "breeze";
    case "nse-api":
      return "nse";
    case "bse-api":
      return "bse";
    case "motilal-api":
      return "moapi";
    default:
      return provider as ProviderType;
  }
}

const FRESHNESS_LEVELS = new Set([
  "LIVE", "FRESH", "DELAYED", "STALE", "BACKFILLED", "UNAVAILABLE",
]);

class MarketDataManagerImpl {
  private providers = new Map<DataProvider, ProviderState>();
  private cache = new Map<string, { data: any; timestamp: number }>();
  private cacheTTL = 5_000; // 5s cache for live data

  constructor() {
    for (const p of PROVIDER_PRIORITY) {
      this.providers.set(p, this.makeState(p));
    }
  }

  private makeState(name: DataProvider): ProviderState {
    return {
      name,
      status: "UNKNOWN",
      lastSuccess: null,
      lastFailure: null,
      latencyMs: null,
      errorCount: 0,
      retryCount: 0,
      cooldownUntil: 0,
      circuitState: "CLOSED",
      consecutiveFailures: 0,
    };
  }

  /** Rebuild the legacy ProviderState view from the authoritative health record. */
  private syncFromHealth(provider: DataProvider): ProviderState | undefined {
    const state = this.providers.get(provider);
    if (!state) return undefined;

    const h = providerHealth.getHealth(toProviderType(provider));
    state.circuitState = h.circuitState as CircuitState;
    state.cooldownUntil = h.cooldownUntil;
    state.consecutiveFailures = h.consecutiveFailures;
    state.lastSuccess = h.lastSuccessAt;
    state.lastFailure = h.lastFailureAt;
    state.latencyMs = h.lastLatencyMs;
    state.errorCount = h.totalFailures;
    state.retryCount = h.totalFailures;
    state.status = this.mapStatus(h.status, h.circuitState, h.consecutiveFailures, h.healthy);
    return state;
  }

  private mapStatus(
    status: string,
    circuit: CircuitState,
    consecutiveFailures: number,
    healthy: boolean,
  ): ProviderState["status"] {
    if (status === "rate_limited") return "RATE_LIMITED";
    if (status === "balance_exhausted" || status === "disabled") return "AUTH_REQUIRED";
    if (circuit === "OPEN") return "DOWN";
    if (status === "offline" || status === "timeout") return "DOWN";
    if (status === "ready" && healthy) return "UP";
    if (consecutiveFailures > 0) return "DEGRADED";
    return "UNKNOWN";
  }

  // ── Main Fetch with Fallback ─────────────────────────────────────────

  async fetchWithFallback<T>(
    dataType: string,
    fetchFn: (provider: DataProvider) => Promise<T | null>,
    options: {
      exchange?: string;
      instrument?: string;
      symbol?: string;
      preferFresh?: boolean;
      maxAgeMs?: number;
    } = {}
  ): Promise<MarketDataResponse<T> | null> {
    const isMCX = options.exchange === "MCX";
    const priority = isMCX ? MCX_PROVIDER_PRIORITY : PROVIDER_PRIORITY;

    let lastError: string | undefined;

    for (const provider of priority) {
      if (!this.providers.has(provider)) continue;

      // Circuit breaker + cooldown live in provider-health.
      if (providerHealth.shouldSkip(toProviderType(provider))) {
        this.syncFromHealth(provider);
        const h = providerHealth.getHealth(toProviderType(provider));
        lastError = lastError ?? `${provider}: circuit ${h.circuitState} (${h.lastError ?? "unknown"})`;
        continue;
      }

      try {
        const start = Date.now();
        const data = await fetchFn(provider);
        const latencyMs = Date.now() - start;

        if (data === null || data === undefined) {
          this.recordFailure(provider, "null response");
          lastError = `${provider}: null response`;
          continue;
        }

        if (!this.validateResponse(data, dataType)) {
          this.recordFailure(provider, "validation failed");
          lastError = `${provider}: validation failed`;
          continue;
        }

        this.recordSuccess(provider, latencyMs);

        const timestamp = this.extractTimestamp(data);
        const freshness = this.resolveFreshness(data, timestamp, dataType);

        // Yahoo is always DELAYED for trading purposes
        const effectiveFreshness = provider === "yahoo" && freshness === "LIVE"
          ? "DELAYED"
          : freshness;

        const isDelayed = provider === "yahoo" || effectiveFreshness === "DELAYED";

        return {
          data,
          provider,
          source: `${provider}`,
          exchange: options.exchange || "NSE",
          instrument: options.instrument || options.symbol || "UNKNOWN",
          timestamp: timestamp || new Date().toISOString(),
          ageMs: timestamp ? Date.now() - new Date(timestamp).getTime() : 0,
          freshness: effectiveFreshness,
          reliability: this.getProviderReliability(provider),
          delayed: isDelayed,
          fallbackUsed: provider !== priority[0],
          fallbackReason: provider !== priority[0] ? lastError : undefined,
        };
      } catch (error: any) {
        this.recordFailure(provider, error?.message ?? String(error));
        lastError = `${provider}: ${error?.message ?? error}`;
      }
    }

    // All providers failed
    return null;
  }

  // ── Provider Health (delegates to provider-health) ───────────────────

  recordSuccess(provider: DataProvider, latencyMs: number): void {
    providerHealth.recordSuccess(toProviderType(provider), latencyMs);
    const state = this.syncFromHealth(provider);
    if (state) state.status = "UP";
  }

  recordFailure(provider: DataProvider, reason: string): void {
    const msg = String(reason ?? "");
    // statusCode 0 → body-pattern classification (timeout/network/…)
    const errorType = providerHealth.classifyError(0, msg);
    providerHealth.recordFailure(toProviderType(provider), errorType, msg);
    this.syncFromHealth(provider);
  }

  getProviderState(provider: DataProvider): ProviderState | undefined {
    return this.syncFromHealth(provider);
  }

  getAllProviderStates(): ProviderState[] {
    return PROVIDER_PRIORITY
      .map((p) => this.syncFromHealth(p))
      .filter((s): s is ProviderState => !!s);
  }

  getActiveProvider(): DataProvider | null {
    for (const provider of PROVIDER_PRIORITY) {
      const state = this.syncFromHealth(provider);
      if (state && state.status === "UP") return provider;
    }
    return null;
  }

  isProviderUsable(provider: DataProvider): boolean {
    if (!this.providers.has(provider)) return false;
    const pt = toProviderType(provider);
    if (providerHealth.shouldSkip(pt)) return false;
    const state = this.syncFromHealth(provider);
    return state?.status !== "AUTH_REQUIRED" && state?.status !== "RATE_LIMITED";
  }

  // ── Option Chain (canonical entry point) ─────────────────────────────
  //
  // The Hermes paper worker prices open paper trades through this call.
  // It goes straight to the canonical exchange-aware chain (NSE/BSE primary)
  // instead of the legacy provider switch, and re-labels the canonical
  // lowercase `ce`/`pe` keys as `CE`/`PE` so legacy readers keep working.

  async fetchOptionChain(
    symbol: string,
    expiry?: string,
    _options?: { mode?: string },
  ): Promise<MarketDataResponse<any> | null> {
    try {
      const { getOptionChain } = await import("@/lib/data-layer/chains/option-chain");
      const started = Date.now();
      const res = await getOptionChain(symbol, expiry);
      if (!res.data) return null;

      const chain = {
        ...res.data,
        strikes: res.data.strikes.map((s: any) => ({
          ...s,
          strikePrice: s.strike,
          CE: this.aliasLeg(s.ce),
          PE: this.aliasLeg(s.pe),
        })),
      };

      const ts = chain.timestamp || new Date().toISOString();
      return {
        data: chain,
        provider: (res.source as any) || "nse",
        source: res.source,
        exchange: res.source === "BSE" ? "BSE" : "NSE",
        instrument: symbol,
        timestamp: ts,
        ageMs: Math.max(0, Date.now() - new Date(ts).getTime()),
        freshness: chain.freshness ?? classifyFreshness(ts, "optionChain"),
        reliability: this.getProviderReliability((res.source as any) || "nse"),
        delayed: (chain.freshness ?? "") === "DELAYED",
        fallbackUsed: !!res.fallbackUsed,
        fallbackReason: res.fallbackReason,
        latencyMs: Date.now() - started,
      } as MarketDataResponse<any>;
    } catch (e: any) {
      this.recordFailure("nse", e?.message ?? String(e));
      return null;
    }
  }

  /** Legacy readers do `option.lastPrice || option.ltp`. */
  private aliasLeg(leg: any): any {
    if (!leg) return null;
    return { ...leg, lastPrice: leg.ltp, ltpPrice: leg.ltp };
  }

  // ── Data Quality Gate ────────────────────────────────────────────────

  validateResponse(data: any, dataType: string): boolean {
    if (data === null || data === undefined) return false;
    if (typeof data === "object" && Object.keys(data).length === 0) return false;
    return true;
  }

  validateForTrading(response: MarketDataResponse<any>): { valid: boolean; failures: string[]; warnings: string[] } {
    const failures: string[] = [];
    const warnings: string[] = [];

    if (response.freshness === "STALE") failures.push("Data is STALE");
    if (response.freshness === "UNAVAILABLE") failures.push("Data is UNAVAILABLE");
    if (response.delayed) warnings.push("Data is DELAYED — research only");

    const data = response.data;
    if (data && typeof data === "object") {
      if (data.spot !== undefined && data.spot <= 0) failures.push("Invalid spot price");
      if (data.ltp !== undefined && data.ltp <= 0) failures.push("Invalid LTP");
    }

    return { valid: failures.length === 0, failures, warnings };
  }

  // ── Cache ────────────────────────────────────────────────────────────

  getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  setCache(key: string, data: any, ttlMs?: number): void {
    this.cache.set(key, { data, timestamp: Date.now() });
    if (ttlMs) {
      setTimeout(() => this.cache.delete(key), ttlMs);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Prefer a freshness the provider itself already computed (derived from
   * the provider's published timestamp). Only fall back to classifying the
   * raw timestamp when the payload carries none.
   */
  private resolveFreshness(data: any, timestamp: string | null, dataType: string): DataFreshness {
    const own = data?.freshness;
    if (typeof own === "string" && FRESHNESS_LEVELS.has(own)) return own as DataFreshness;
    if (timestamp) return classifyFreshness(timestamp, dataType);
    // No timestamp at all → we cannot claim LIVE; it is at best unverified.
    return "FRESH";
  }

  private extractTimestamp(data: any): string | null {
    if (data.timestamp) return data.timestamp;
    if (data.lastUpdate) return data.lastUpdate;
    if (data.receivedAt) return data.receivedAt;
    return null;
  }

  private getProviderReliability(provider: DataProvider): number {
    const reliabilityMap: Record<string, number> = {
      breeze: 0.95,
      moapi: 0.90,
      nse: 0.85,
      bse: 0.85,
      website: 0.70,
      yahoo: 0.60,
    };
    return reliabilityMap[provider] || 0.5;
  }

  // ── Status Summary ───────────────────────────────────────────────────

  getStatusSummary(): {
    providers: Array<{ name: string; status: string; latencyMs: number | null; lastSuccess: number | null }>;
    activeProvider: string | null;
  } {
    return {
      providers: this.getAllProviderStates().map(s => ({
        name: s.name,
        status: s.status,
        latencyMs: s.latencyMs,
        lastSuccess: s.lastSuccess,
      })),
      activeProvider: this.getActiveProvider(),
    };
  }
}

export const marketDataManager = new MarketDataManagerImpl();

// ── Convenience Functions ──────────────────────────────────────────────

export async function fetchSpotWithFallback(
  symbol: string,
  exchange: string = "NSE"
): Promise<MarketDataResponse<any> | null> {
  return marketDataManager.fetchWithFallback(
    "spot",
    async (provider) => {
      switch (provider) {
        case "moapi": {
          const { getLTPBySymbol, getCurrentAuthToken } = await import("@/lib/motilal/market");
          const token = getCurrentAuthToken();
          if (!token) return null;
          return getLTPBySymbol(symbol, token);
        }
        case "breeze": {
          const { getQuotes } = await import("@/lib/icici-breeze/option-chain");
          return getQuotes(symbol, "NSE");
        }
        case "nse": {
          const { getNSEOptionChain } = await import("@/lib/nse-api");
          const chain = await getNSEOptionChain(symbol);
          return chain?.priceInfo ? { ltp: chain.priceInfo.lastPrice, ...chain.priceInfo } : null;
        }
        case "website": {
          // No dedicated non-Yahoo web quote source — keep as an explicit
          // no-op so the chain moves on to Yahoo rather than faking data.
          return null;
        }
        case "yahoo": {
          const { fetchYahooIndexData } = await import("@/lib/yahoo-finance-api");
          return fetchYahooIndexData(symbol);
        }
        default:
          return null;
      }
    },
    { symbol, exchange, instrument: "spot" }
  );
}

export async function fetchOptionChainWithFallback(
  symbol: string,
  exchange: string = "NSE"
): Promise<MarketDataResponse<any> | null> {
  // Canonical exchange-aware chain — same path the option-chain route uses.
  return marketDataManager.fetchOptionChain(symbol, undefined, { mode: "fallback" });
}
