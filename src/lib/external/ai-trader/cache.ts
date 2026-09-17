// ═══════════════════════════════════════════════════════════════════════════
// AI-Trader Signal Cache — Deduplicate and cache external signals
// ═══════════════════════════════════════════════════════════════════════════

import type { AITraderSignal } from './types';

interface CacheEntry {
  signal: AITraderSignal;
  receivedAt: number;
}

const signalCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(signal: AITraderSignal): string {
  return `${signal.agent_name}:${signal.symbol}:${signal.action}:${signal.strike || 'no-strike'}:${signal.expiry || 'no-expiry'}`;
}

export function isDuplicateSignal(signal: AITraderSignal): boolean {
  const key = getCacheKey(signal);
  const existing = signalCache.get(key);
  if (!existing) return false;

  // If signal is older than what we have, it's a duplicate
  if (new Date(signal.timestamp).getTime() <= new Date(existing.signal.timestamp).getTime()) {
    return true;
  }

  // If received within TTL, it's a duplicate
  if (Date.now() - existing.receivedAt < CACHE_TTL_MS) {
    return true;
  }

  return false;
}

export function cacheSignal(signal: AITraderSignal): void {
  const key = getCacheKey(signal);
  signalCache.set(key, {
    signal,
    receivedAt: Date.now(),
  });

  // Cleanup old entries
  const now = Date.now();
  for (const [k, v] of signalCache.entries()) {
    if (now - v.receivedAt > CACHE_TTL_MS) {
      signalCache.delete(k);
    }
  }
}

export function getCachedSignals(): AITraderSignal[] {
  return Array.from(signalCache.values()).map(e => e.signal);
}

export function clearSignalCache(): void {
  signalCache.clear();
}
