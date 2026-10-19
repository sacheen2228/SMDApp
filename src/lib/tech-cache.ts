// tech-cache.ts
// Background-computed technical snapshots so the VETO can use real structure/trigger
// reads without ever doing a network call in the alert path.
//
// The cache lives in the app process (module scope). A cron/route refreshes it on
// bar close; the veto only ever does an O(1) Map lookup. A MISSING or STALE snapshot
// is a WARNING (never a BLOCK) — the veto must never block a trade because the
// technical cache is cold.
import { analyzeTf, DEFAULT_PARAMS, type Candle, type TfRead } from "./tech-read";
import type { Layer } from "./agent-brain-gate";

export type TechTf = "5m" | "15m" | "1d";

export interface TechSnapshot {
  symbol: string;
  tf: TechTf;
  asOf: number;        // timestamp of the last candle in the read
  computedAt: number;
  read: TfRead;
  candles: number;
  error?: string;
}

/** TTL per timeframe = one bar interval (a snapshot older than that is stale). */
export const TF_TTL_MS: Record<TechTf, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1d": 24 * 3600_000,
};

const cache = new Map<string, TechSnapshot>();

const key = (symbol: string, tf: TechTf) => `${symbol.toUpperCase()}:${tf}`;

/** O(1) read — never touches the network. */
export function getSnapshot(symbol: string, tf: TechTf): TechSnapshot | undefined {
  return cache.get(key(symbol, tf));
}

/** Is the snapshot usable right now? (present + within one bar interval) */
export function isFresh(snap: TechSnapshot | undefined, tf: TechTf, nowMs = Date.now()): boolean {
  if (!snap || snap.error) return false;
  return nowMs - snap.computedAt <= TF_TTL_MS[tf];
}

/** Store a computed snapshot (used by the refresh route/job). */
export function putSnapshot(snap: TechSnapshot): void {
  cache.set(key(snap.symbol, snap.tf), snap);
}

/** Build the read from candles and cache it. */
export function buildSnapshot(symbol: string, tf: TechTf, candles: Candle[], nowMs = Date.now()): TechSnapshot | null {
  const read = analyzeTf(tf, candles, symbol, DEFAULT_PARAMS, nowMs);
  if (!read) return null;
  const snap: TechSnapshot = {
    symbol, tf,
    asOf: candles.length ? candles[candles.length - 1].t : nowMs,
    computedAt: nowMs,
    read,
    candles: candles.length,
  };
  putSnapshot(snap);
  return snap;
}

/** Structure/trigger layers from the cached read (O(1), no network). */
export function cachedLayers(
  symbol: string,
  tf: TechTf,
  dir: "call" | "put",
  structureLayer: (r: TfRead, d: "call" | "put") => Layer,
  triggerLayer: (r: TfRead, d: "call" | "put") => Layer,
): { structure?: Layer; trigger?: Layer; stale: boolean; asOf?: number } {
  const snap = getSnapshot(symbol, tf);
  if (!snap) return { stale: true };
  const fresh = isFresh(snap, tf);
  return {
    structure: structureLayer(snap.read, dir),
    trigger: triggerLayer(snap.read, dir),
    stale: !fresh,
    asOf: snap.asOf,
  };
}

/** Cache health for check_live_feed / the daily report. */
export function cacheStats(nowMs = Date.now()): {
  symbols: number; fresh: number; stale: number; errors: number; oldestComputedAt?: number; byTf: Record<string, number>;
} {
  let fresh = 0, stale = 0, errors = 0, oldest: number | undefined;
  const byTf: Record<string, number> = {};
  for (const snap of cache.values()) {
    byTf[snap.tf] = (byTf[snap.tf] || 0) + 1;
    if (snap.error) { errors++; continue; }
    if (isFresh(snap, snap.tf, nowMs)) fresh++; else stale++;
    if (oldest == null || snap.computedAt < oldest) oldest = snap.computedAt;
  }
  return { symbols: cache.size, fresh, stale, errors, oldestComputedAt: oldest, byTf };
}

/** Symbols the cache should cover: the indices plus the F&O stock list. */
export const CACHE_SYMBOLS: string[] = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"];

/** Drop entries older than 2× TTL (housekeeping). */
export function prune(nowMs = Date.now()): number {
  let dropped = 0;
  for (const [k, snap] of cache) {
    if (nowMs - snap.computedAt > TF_TTL_MS[snap.tf] * 2) { cache.delete(k); dropped++; }
  }
  return dropped;
}
