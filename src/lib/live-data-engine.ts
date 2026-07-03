// Live Data Engine - Central data source with caching, retry, and health tracking
// Fetches from Breeze API or simulation with automatic fallback

import { generateOptionChain, OptionChainResponse } from "./option-chain-data";

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

// Attempt to fetch from Breeze API (stub - returns null to trigger fallback)
async function fetchFromBreeze(
  symbol: string,
  expiry?: string
): Promise<OptionChainResponse | null> {
  const apiKey = getBreezeApiKey();
  const secretKey = getBreezeSecretKey();

  if (!apiKey || !secretKey) {
    return null; // No credentials - fall through to simulation
  }

  try {
    // Breeze API integration point - when implemented, this will call the API
    // For now, return null to trigger simulation fallback
    // The existing Breeze client code in src/lib/icici-breeze/ can be wired here
    return null;
  } catch (err) {
    console.error(`[live-data-engine] Breeze API error for ${symbol}:`, err);
    return null;
  }
}

// Fetch from simulation (always succeeds)
function fetchFromSimulation(
  symbol: string,
  expiry?: string
): OptionChainResponse {
  return generateOptionChain(symbol, expiry);
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Fetch live data with retry logic and fallback chain:
 * 1. Breeze API (if credentials present)
 * 2. Simulation (guaranteed fallback)
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

  // Fallback to simulation
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const simData = fetchFromSimulation(symbol, expiry);
      cache.set(cacheKey, { data: simData, fetchedAt: Date.now() });
      return simData;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[live-data-engine] Simulation attempt ${attempt}/${config.maxRetries} failed:`,
        lastError.message
      );
      if (attempt < config.maxRetries) {
        await sleep(config.retryDelayMs);
      }
    }
  }

  // All retries exhausted - should not happen for simulation, but just in case
  throw new Error(
    `[live-data-engine] Failed to fetch data for ${symbol} after ${config.maxRetries} retries: ${lastError?.message}`
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
