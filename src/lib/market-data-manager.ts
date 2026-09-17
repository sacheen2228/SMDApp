// Market Data Manager — unified data source orchestration with provider fallback
// Provider hierarchy: MOAPI → Breeze → NSE → Website → Yahoo (delayed)
// Yahoo is RESEARCH ONLY — never labeled LIVE for trading.

import type { DataProvider, DataFreshness, MarketDataResponse } from "./hermes/types";
import { classifyFreshness } from "./hermes/freshness";

// ── Provider State ─────────────────────────────────────────────────────

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

const PROVIDER_PRIORITY: DataProvider[] = ["moapi", "breeze", "nse", "website", "yahoo"];

const MCX_PROVIDER_PRIORITY: DataProvider[] = ["moapi", "breeze", "website", "yahoo"];

const COOLDOWN_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

// ── Market Data Manager ────────────────────────────────────────────────

class MarketDataManagerImpl {
  private providers = new Map<DataProvider, ProviderState>();
  private cache = new Map<string, { data: any; timestamp: number }>();
  private cacheTTL = 5_000; // 5s cache for live data

  constructor() {
    for (const p of PROVIDER_PRIORITY) {
      this.providers.set(p, {
        name: p,
        status: "UNKNOWN",
        lastSuccess: null,
        lastFailure: null,
        latencyMs: null,
        errorCount: 0,
        retryCount: 0,
        cooldownUntil: 0,
        circuitState: "CLOSED",
        consecutiveFailures: 0,
      });
    }
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
      const state = this.providers.get(provider);
      if (!state) continue;

      // Circuit breaker check
      if (state.circuitState === "OPEN") {
        if (Date.now() > state.cooldownUntil) {
          state.circuitState = "HALF_OPEN";
        } else {
          continue;
        }
      }

      // Rate limit / cooldown check
      if (Date.now() < state.cooldownUntil) continue;

      try {
        const start = Date.now();
        const data = await fetchFn(provider);
        const latencyMs = Date.now() - start;

        if (data === null || data === undefined) {
          this.recordFailure(provider, "null response");
          lastError = `${provider}: null response`;
          continue;
        }

        // Validate data integrity
        if (!this.validateResponse(data, dataType)) {
          this.recordFailure(provider, "validation failed");
          lastError = `${provider}: validation failed`;
          continue;
        }

        // Record success
        this.recordSuccess(provider, latencyMs);

        // Determine freshness
        const timestamp = this.extractTimestamp(data);
        const freshness = timestamp
          ? classifyFreshness(timestamp, dataType)
          : "FRESH";

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
        this.recordFailure(provider, error.message);
        lastError = `${provider}: ${error.message}`;
      }
    }

    // All providers failed
    return null;
  }

  // ── Provider Health ──────────────────────────────────────────────────

  recordSuccess(provider: DataProvider, latencyMs: number): void {
    const state = this.providers.get(provider);
    if (!state) return;
    state.lastSuccess = Date.now();
    state.latencyMs = latencyMs;
    state.errorCount = 0;
    state.consecutiveFailures = 0;
    state.circuitState = "CLOSED";
    state.status = "UP";
  }

  recordFailure(provider: DataProvider, reason: string): void {
    const state = this.providers.get(provider);
    if (!state) return;
    state.lastFailure = Date.now();
    state.errorCount++;
    state.consecutiveFailures++;
    state.retryCount++;

    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      state.circuitState = "OPEN";
      state.cooldownUntil = Date.now() + COOLDOWN_MS * state.consecutiveFailures;
      state.status = "DOWN";
    } else {
      state.status = "DEGRADED";
    }
  }

  getProviderState(provider: DataProvider): ProviderState | undefined {
    return this.providers.get(provider);
  }

  getAllProviderStates(): ProviderState[] {
    return Array.from(this.providers.values());
  }

  getActiveProvider(): DataProvider | null {
    for (const provider of PROVIDER_PRIORITY) {
      const state = this.providers.get(provider);
      if (state && state.status === "UP") return provider;
    }
    return null;
  }

  isProviderUsable(provider: DataProvider): boolean {
    const state = this.providers.get(provider);
    if (!state) return false;
    if (state.circuitState === "OPEN" && Date.now() < state.cooldownUntil) return false;
    if (state.status === "AUTH_REQUIRED" || state.status === "RATE_LIMITED") return false;
    return true;
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

  private extractTimestamp(data: any): string | null {
    if (data.timestamp) return data.timestamp;
    if (data.lastUpdate) return data.lastUpdate;
    if (data.receivedAt) return data.receivedAt;
    return null;
  }

  private getProviderReliability(provider: DataProvider): number {
    const reliabilityMap: Record<DataProvider, number> = {
      breeze: 0.95,
      moapi: 0.90,
      nse: 0.85,
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
  return marketDataManager.fetchWithFallback(
    "optionChain",
    async (provider) => {
      switch (provider) {
        case "moapi": {
          // MOAPI does not provide option chains — fall through to Breeze/NSE
          return null;
        }
        case "breeze": {
          const { getOptionChain } = await import("@/lib/icici-breeze/option-chain");
          const expiries = await (await import("@/lib/icici-breeze/option-chain")).getOptionChainExpiries(symbol);
          if (!expiries || expiries.length === 0) return null;
          return getOptionChain(symbol, expiries[0]);
        }
        case "nse": {
          const { getNSEOptionChain } = await import("@/lib/nse-api");
          return getNSEOptionChain(symbol);
        }
        case "yahoo": {
          // Yahoo doesn't provide option chains for Indian indices
          return null;
        }
        default:
          return null;
      }
    },
    { symbol, exchange, instrument: "optionChain" }
  );
}
