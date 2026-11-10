// Market Data Manager — unified data source orchestration with provider fallback.
//
// ALL fetching now delegates to the central engine (src/lib/market-data-service.ts),
// which owns the single provider-priority order per category, the shared NseGate,
// in-flight dedup, the process-wide cache and the provider-health circuit breaker.
// This module keeps its legacy `MarketDataResponse` / `ProviderState` API surface
// so existing consumers (/api/health, Hermes paper worker) keep working unchanged.
//
// Provider hierarchy (enforced by the engine, per category):
//   LIVE data: ICICI Breeze → Motilal Oswal MOAPI → NSE → BSE → Moneycontrol
//   PRE/POST market: NSE → BSE → Moneycontrol (exchange archives only)
//   There is NO Yahoo provider: it is banned by the data policy (AGENTS.md).
//
// Circuit breaking / cooldowns live in `provider-health.ts` (single source of
// truth). This module only mirrors that state into a legacy-shaped `ProviderState`.

import type { DataProvider, DataFreshness, MarketDataResponse } from "./hermes/types";
import { classifyFreshness } from "./hermes/freshness";
import { providerHealth, type ProviderType, type CircuitState } from "./provider-health";
import {
  fetchMarketData as engineFetchMarketData,
  fetchOptionChain as engineFetchOptionChain,
  fetchSpot as engineFetchSpot,
  type MarketDataEnvelope,
  type ProviderName,
} from "./market-data-service";
import { normalizeCategory, type DataCategory } from "./market-data-types";

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

const FRESHNESS_LEVELS = new Set([
  "LIVE", "FRESH", "DELAYED", "STALE", "BACKFILLED", "UNAVAILABLE",
]);

class MarketDataManagerImpl {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private cacheTTL = 5_000; // 5s cache for live data

  /** Map a hermes DataProvider onto a provider-health ProviderType. */
  private toProviderType(provider: DataProvider): ProviderType {
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

  /** Engine provider name → hermes DataProvider label for response envelopes. */
  private mapProvider(p: ProviderName): DataProvider {
    switch (p) {
      case "icici-breeze": return "icici-breeze";
      case "motilal-api": return "motilal-api";
      case "nse-api": return "nse-api";
      case "bse-api": return "bse-api";
      case "moneycontrol": return "website";
      case "fii-dii": return "nse-api";
      default: return "website";
    }
  }

  /** Rebuild the legacy ProviderState view from the authoritative health record. */
  private syncFromHealth(provider: DataProvider): ProviderState | undefined {
    const h = providerHealth.getHealth(this.toProviderType(provider));
    const state: ProviderState = {
      name: provider,
      status: this.mapStatus(h.status, h.circuitState, h.consecutiveFailures, h.healthy),
      lastSuccess: h.lastSuccessAt,
      lastFailure: h.lastFailureAt,
      latencyMs: h.lastLatencyMs,
      errorCount: h.totalFailures,
      retryCount: h.totalFailures,
      cooldownUntil: h.cooldownUntil,
      circuitState: h.circuitState as CircuitState,
      consecutiveFailures: h.consecutiveFailures,
    };
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
  //
  // Delegates to the engine, which runs the parallel provider race per category
  // (bounded timeouts, first valid answer wins, tie-break Breeze → MOAPI → NSE → BSE,
  // no merging of providers). The `fetchFn` per-provider callback is retained for
  // signature compatibility but is no longer invoked — the engine handles fallback
  // internally.

  async fetchWithFallback<T>(
    dataType: string,
    _fetchFn: (provider: DataProvider) => Promise<T | null>,
    options: {
      exchange?: string;
      instrument?: string;
      symbol?: string;
      preferFresh?: boolean;
      maxAgeMs?: number;
      config?: Partial<import("./market-data-types").MarketDataServiceConfig>;
      bypassCache?: boolean;
    } = {},
  ): Promise<MarketDataResponse<T> | null> {
    const category = normalizeCategory(dataType) as DataCategory;
    const env = await engineFetchMarketData<T>({
      symbol: options.symbol ?? "",
      category,
      exchange: options.exchange,
      instrument: options.instrument,
      nowMs: options.nowMs,
      config: options.config,
      bypassCache: options.bypassCache,
    });
    return this.envelopeToResponse(env, options.exchange ?? "NSE", options.instrument ?? options.symbol ?? "UNKNOWN");
  }

  private envelopeToResponse<T>(
    env: MarketDataEnvelope<T>,
    exchange: string,
    instrument: string,
  ): MarketDataResponse<T> | null {
    if (!env || !env.available || env.data == null) return null;
    const freshness: DataFreshness =
      typeof env.freshness === "string" && FRESHNESS_LEVELS.has(env.freshness)
        ? env.freshness
        : classifyFreshness(env.providerTimestamp ?? env.fetchedAt, "optionChain");
    return {
      data: env.data,
      provider: this.mapProvider(env.provider),
      source: env.source,
      exchange,
      instrument,
      timestamp: env.fetchedAt,
      ageMs: env.ageMs,
      freshness,
      reliability: this.getProviderReliability(env.provider),
      delayed: env.delayed,
      fallbackUsed: env.fallbackUsed,
      fallbackReason: env.fallbackReason,
    };
  }

  // ── Provider Health (delegates to provider-health) ───────────────────

  recordSuccess(provider: DataProvider, latencyMs: number): void {
    providerHealth.recordSuccess(this.toProviderType(provider), latencyMs);
  }

  recordFailure(provider: DataProvider, reason: string): void {
    const msg = String(reason ?? "");
    const errorType = providerHealth.classifyError(0, msg);
    providerHealth.recordFailure(this.toProviderType(provider), errorType, msg);
  }

  getProviderState(provider: DataProvider): ProviderState | undefined {
    return this.syncFromHealth(provider);
  }

  getAllProviderStates(): ProviderState[] {
    const order: DataProvider[] = ["nse-api", "bse-api", "motilal-api", "icici-breeze", "website"];
    return order
      .map((p) => this.syncFromHealth(p))
      .filter((s): s is ProviderState => !!s);
  }

  getActiveProvider(): DataProvider | null {
    const order: DataProvider[] = ["nse-api", "bse-api", "motilal-api", "icici-breeze", "website"];
    for (const provider of order) {
      const state = this.syncFromHealth(provider);
      if (state && state.status === "UP") return provider;
    }
    return null;
  }

  isProviderUsable(provider: DataProvider): boolean {
    const pt = this.toProviderType(provider);
    if (providerHealth.shouldSkip(pt)) return false;
    const state = this.syncFromHealth(provider);
    return state?.status !== "AUTH_REQUIRED" && state?.status !== "RATE_LIMITED";
  }

  // ── Option Chain (canonical entry point) ─────────────────────────────
  //
  // The Hermes paper worker prices open paper trades through this call.
  // Delegates to the engine's option-chain category (exchange-aware: NSE primary
  // for NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY + equities, BSE primary for SENSEX/
  // BANKEX), then re-labels the lowercase `ce`/`pe` keys as `CE`/`PE` so legacy
  // readers keep working.

  async fetchOptionChain(
    symbol: string,
    expiry?: string,
    _options?: { mode?: string },
  ): Promise<MarketDataResponse<any> | null> {
    const env = await engineFetchOptionChain({ symbol, expiry, nowMs: Date.now() });
    if (!env?.available || !env.data) return null;

    const chain = env.data as any;
    const mapped = {
      ...chain,
      strikes: chain.strikes.map((s: any) => ({
        ...s,
        strikePrice: s.strike,
        CE: this.aliasLeg(s.ce),
        PE: this.aliasLeg(s.pe),
      })),
    };

    const ts = mapped.timestamp || new Date().toISOString();
    return {
      data: mapped,
      provider: this.mapProvider(env.provider),
      source: env.source,
      exchange: env.exchange ?? "NSE",
      instrument: symbol,
      timestamp: ts,
      ageMs: env.ageMs,
      freshness: env.freshness,
      reliability: this.getProviderReliability(env.provider),
      delayed: env.delayed,
      fallbackUsed: env.fallbackUsed,
      fallbackReason: env.fallbackReason,
      latencyMs: env.ageMs,
    } as MarketDataResponse<any>;
  }

  /** Legacy readers do `option.lastPrice || option.ltp`. */
  private aliasLeg(leg: any): any {
    if (!leg) return null;
    return { ...leg, lastPrice: leg.ltp, ltpPrice: leg.ltp };
  }

  // ── Spot with fallback ───────────────────────────────────────────────

  async fetchSpotWithFallback(
    symbol: string,
    exchange: string = "NSE",
  ): Promise<MarketDataResponse<any> | null> {
    const env = await engineFetchSpot({ symbol, exchange, nowMs: Date.now() });
    return this.envelopeToResponse(env, exchange, symbol);
  }

  // ── Option chain with fallback ───────────────────────────────────────

  async fetchOptionChainWithFallback(
    symbol: string,
    exchange: string = "NSE",
  ): Promise<MarketDataResponse<any> | null> {
    return this.fetchOptionChain(symbol, undefined, { mode: "fallback", exchange });
  }

  // ── Data Quality Gate ────────────────────────────────────────────────

  validateResponse(data: any, _dataType: string): boolean {
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

  private getProviderReliability(provider: ProviderName): number {
    const reliabilityMap: Record<string, number> = {
      "icici-breeze": 0.95,
      "motilal-api": 0.90,
      "nse-api": 0.85,
      "bse-api": 0.85,
      moneycontrol: 0.70,
      "fii-dii": 0.75,
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
  return marketDataManager.fetchSpotWithFallback(symbol, exchange);
}

export async function fetchOptionChainWithFallback(
  symbol: string,
  exchange: string = "NSE"
): Promise<MarketDataResponse<any> | null> {
  return marketDataManager.fetchOptionChainWithFallback(symbol, exchange);
}
