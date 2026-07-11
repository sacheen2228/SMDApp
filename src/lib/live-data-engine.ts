// Live Data Engine - Central data source with caching, retry, and health tracking
// Fetches from Breeze API or simulation with automatic fallback

import type { OptionChainResponse } from "@/types";

// ─── Types ───────────────────────────────────────────────────────
interface CacheEntry {
  data: OptionChainResponse;
  fetchedAt: number;
}

interface EngineConfig {
  maxRetries: number;
  retryDelayMs: number;
  cacheTtlMs: number;
}

// ─── Defaults ────────────────────────────────────────────────────
const DEFAULT_CONFIG: EngineConfig = {
  maxRetries: 3,
  retryDelayMs: 500,
  cacheTtlMs: 5000, // 5 seconds - matching 5-min candle seed stability
};

// ─── State ───────────────────────────────────────────────────────
const cache = new Map<string, CacheEntry>();
let config = { ...DEFAULT_CONFIG };

// ─── Internal helpers ────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < config.cacheTtlMs;
}

function getBreezeApiKey(): string | undefined {
  return process.env.BREEZE_API_KEY;
}

function getBreezeSecretKey(): string | undefined {
  return process.env.BREEZE_SECRET_KEY;
}

// Attempt to fetch from Breeze API via real SDK
async function fetchFromBreeze(
  symbol: string,
  expiry?: string
): Promise<OptionChainResponse | null> {
  try {
    const { getOptionChain, getOptionChainExpiries } = await import("@/lib/icici-breeze/option-chain");
    const { initSession } = await import("@/lib/icici-breeze/auth");
    await initSession().catch(() => {});

    const expiries = expiry ? [expiry] : await getOptionChainExpiries(symbol);
    for (const exp of expiries.slice(0, 3)) {
      const chain = await getOptionChain(symbol, exp);
      if (chain) {
        return {
          spotPrice: chain.spotPrice,
          data: chain.strikes.map((strike) => ({
            strike,
            ce: chain.calls.find((c) => c.strikePrice === strike) || null,
            pe: chain.puts.find((p) => p.strikePrice === strike) || null,
          })),
          expiries: expiries.map((e) => ({ date: e })),
          selectedExpiry: exp,
        };
      }
    }
    return null;
  } catch (err) {
    console.error(`[live-data-engine] Breeze API error for ${symbol}:`, err);
    return null;
  }
}

// Attempt to fetch from NSE API
async function fetchFromNSE(
  symbol: string
): Promise<OptionChainResponse | null> {
  try {
    const { getNSEOptionChain } = await import("@/lib/nse-api");
    const nseData = await getNSEOptionChain(symbol);
    if (nseData?.records?.data) {
      return {
        spotPrice: nseData.records?.underlyingValue || 0,
        data: nseData.records.data.map((row: any) => ({
          strike: row.strikePrice,
          ce: row.CE ? {
            ltp: row.CE.lastPrice || 0, oi: row.CE.openInterest || 0,
            oiChg: row.CE.changeinOpenInterest || 0, volume: row.CE.totalTradedVolume || 0,
            iv: row.CE.impliedVolatility || 0,
          } : null,
          pe: row.PE ? {
            ltp: row.PE.lastPrice || 0, oi: row.PE.openInterest || 0,
            oiChg: row.PE.changeinOpenInterest || 0, volume: row.PE.totalTradedVolume || 0,
            iv: row.PE.impliedVolatility || 0,
          } : null,
        })),
        expiries: (nseData.records?.expiryDates || []).map((d: string) => ({ date: d })),
        selectedExpiry: nseData.records?.expiryDates?.[0] || "",
      };
    }
    return null;
  } catch (err) {
    console.error(`[live-data-engine] NSE error for ${symbol}:`, err);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Fetch live data with retry logic and fallback chain:
 * 1. Breeze API (if credentials present)
 * 2. NSE API (public scraper)
 * 3. Simulation (guaranteed fallback)
 */
export async function fetchLiveData(
  symbol: string,
  expiry?: string
): Promise<OptionChainResponse> {
  const cacheKey = `${symbol}:${expiry || "auto"}`;

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && isFresh(cached)) {
    return cached.data;
  }

  let lastError: Error | null = null;

  // Try Breeze API first
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const breezeData = await fetchFromBreeze(symbol, expiry);
      if (breezeData) {
        cache.set(cacheKey, { data: breezeData, fetchedAt: Date.now() });
        return breezeData;
      }
      break; // Breeze returned null (no credentials) - skip retries
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[live-data-engine] Breeze attempt ${attempt}/${config.maxRetries} failed:`,
        lastError.message
      );
      if (attempt < config.maxRetries) {
        await sleep(config.retryDelayMs * attempt);
      }
    }
  }

  // Try NSE API second
  try {
    const nseData = await fetchFromNSE(symbol);
    if (nseData) {
      cache.set(cacheKey, { data: nseData, fetchedAt: Date.now() });
      return nseData;
    }
  } catch (err) {
    console.warn(`[live-data-engine] NSE failed:`, err);
  }

  // All retries exhausted — throw error instead of returning fake data
  throw new Error(
    `[live-data-engine] No real data available for ${symbol}. Breeze and NSE both failed.`
  );
}

/**
 * Get cached data for a symbol if it exists and is fresh.
 * Returns null if no cache or stale.
 */
export function getCachedData(symbol: string): OptionChainResponse | null {
  const entries = Array.from(cache.entries());
  for (const [key, entry] of entries) {
    if (key.startsWith(symbol + ":") && isFresh(entry)) {
      return entry.data;
    }
  }
  return null;
}

/**
 * Clear cache. If symbol is provided, only clears entries for that symbol.
 * If no symbol, clears entire cache.
 */
export function clearCache(symbol?: string): void {
  if (!symbol) {
    cache.clear();
    return;
  }

  const keysToDelete: string[] = [];
  for (const key of cache.keys()) {
    if (key.startsWith(symbol + ":")) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    cache.delete(key);
  }
}

/**
 * Update engine configuration at runtime.
 */
export function configureEngine(overrides: Partial<EngineConfig>): void {
  config = { ...config, ...overrides };
}

/**
 * Get current cache stats for monitoring.
 */
export function getCacheStats(): { size: number; keys: string[]; fresh: number; stale: number } {
  let fresh = 0;
  let stale = 0;
  const keys = Array.from(cache.keys());

  for (const entry of cache.values()) {
    if (isFresh(entry)) fresh++;
    else stale++;
  }

  return { size: cache.size, keys, fresh, stale };
}
