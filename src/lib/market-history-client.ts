// Client for the Market History sidecar engine on :4002 (Node, better-sqlite3).
// Browser + server safe. Replaces direct `@/lib/market-history/db` imports,
// which cannot run under Bun. All functions are async (HTTP over localhost).
//
// Mirrors the Trade Audit client (trade-audit-client.ts). The sidecar owns the
// SQLite connection; the Next.js (Bun) app talks to it over HTTP.

export const MARKET_HISTORY_BASE =
  process.env.NEXT_PUBLIC_MARKET_HISTORY_URL ?? "http://localhost:4002";

export interface SnapshotSummaryRow {
  symbol: string;
  timestamp: string;
  spot: number | null;
  india_vix: number | null;
  pcr_oi: number | null;
  max_pain: number | null;
  atr: number | null;
  vwap: number | null;
  volume: number | null;
  schema_version: number;
}

export interface MarketHistoryStatus {
  totalSnapshots: number;
  lastCaptureTime: string | null;
  snapshotCount: number;
  databaseSizeBytes: number;
}

export interface ScannerResultFilter {
  symbol?: string;
  scanner?: string;
  decision?: string;
  sessionId?: string;
  snapshotId?: string;
  date?: string;
  limit?: number;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mh ${res.status} ${url}`);
  return res.json();
}

// ── Writes (Recorder) ──────────────────────────────────────────
// HARD TIMEOUTS on every write. Without them a stalled sidecar (or a stalled
// socket) hung the recorder POST indefinitely; the systemd tick then held its
// flock for hours and the recorder stopped recording for the rest of the
// session. A write that cannot finish in time is a FAILED write (false), not
// a hung request.
const WRITE_TIMEOUT_MS = 8_000;

async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${MARKET_HISTORY_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function recordSnapshot(snapshot: any): Promise<boolean> {
  try {
    const res = await fetch(`${MARKET_HISTORY_BASE}/api/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

export async function recordCandles(
  symbol: string,
  interval: string,
  candles: any[],
  source?: string | null,
): Promise<boolean> {
  return postJson("/api/candles", { symbol, interval, candles, source: source ?? null });
}

export async function recordScannerResults(results: any[]): Promise<boolean> {
  if (!results.length) return true;
  return postJson("/api/scanner", { results });
}

// Idempotent outcome resolution: write the resolved outcome fields
// (WIN/LOSS/NO_FILL/CANCELLED/EXPIRED, exit reason, MFE/MAE, R, holding)
// back onto an existing scanner result by id. Never inserts.
export async function updateScannerResultOutcome(
  id: string,
  outcome: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`${MARKET_HISTORY_BASE}/api/scanner/outcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, outcome }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Reads (Replay / Evaluation / Dashboard) ───────────────────

export async function getScannerResults(filter: ScannerResultFilter = {}): Promise<any[]> {
  const q = new URLSearchParams();
  Object.entries(filter).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") q.append(k, String(v));
  });
  const data = await getJson(`${MARKET_HISTORY_BASE}/api/scanner?${q.toString()}`);
  return data.results ?? [];
}

export async function readSnapshotById(id: string): Promise<any | null> {
  try {
    return await getJson(`${MARKET_HISTORY_BASE}/api/snapshot/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

export async function getSnapshotById(id: string): Promise<any | null> {
  return readSnapshotById(id);
}

export async function getSnapshotsForSymbol(
  symbol: string,
  date?: string,
): Promise<any[]> {
  const q = new URLSearchParams({ symbol });
  if (date) q.append("date", date);
  const data = await getJson(`${MARKET_HISTORY_BASE}/api/snapshots?${q.toString()}`);
  return data.snapshots ?? [];
}

export async function getSnapshotsSummary(
  symbol: string,
  date?: string,
): Promise<SnapshotSummaryRow[]> {
  const q = new URLSearchParams({ symbol });
  if (date) q.append("date", date);
  const data = await getJson(`${MARKET_HISTORY_BASE}/api/snapshots/summary?${q.toString()}`);
  return data.snapshots ?? [];
}

// ── IV Rank for the buyer-confluence gate ─────────────────────────
// The gate's `ivRank` was a hardcoded 50 — scoreIVRank hard-blocks at >= 50,
// so every recommendation was a guaranteed NO_TRADE. The sidecar records
// india_vix every minute; the percentile of the live VIX within that history
// is the honest rank we can compute here (10+ days of data, not a 52-week
// range — but real, never fabricated). india_vix is market-wide, so the
// NIFTY history serves every symbol (stocks record no rows of their own).

let ivHistoryCache: { vals: number[]; ts: number } | null = null;
const IV_HISTORY_TTL_MS = 60_000;
const IV_HISTORY_RETRY_MS = 15_000; // after a failed refresh, retry in 15s
const IV_HISTORY_MIN = 20;         // < 20 readings = no honest percentile
const IV_HISTORY_TIMEOUT_MS = 2_500; // hot path — never hang on the sidecar

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("iv-history timeout")), ms)),
  ]);
}

/**
 * Percentile (0-100) of `currentVix` within recorded india_vix history.
 * null = no honest rank available (no history / sidecar down / VIX unknown).
 * The consumer must treat null as UNKNOWN — never as 50, never as a block.
 */
export async function computeIvRank(currentVix: number): Promise<number | null> {
  if (!(currentVix > 0)) return null;
  if (!ivHistoryCache || Date.now() - ivHistoryCache.ts > IV_HISTORY_TTL_MS) {
    try {
      const rows = await withTimeout(getSnapshotsSummary("NIFTY"), IV_HISTORY_TIMEOUT_MS);
      const vals = rows
        .map((r) => r.india_vix)
        .filter((v): v is number => typeof v === "number" && v > 0);
      ivHistoryCache = { vals, ts: Date.now() };
    } catch {
      // Throttle retries the way fetchFiiDiiData does: a failed refresh is
      // re-attempted in 15s, not on every call. Stale vals stay usable.
      if (!ivHistoryCache) ivHistoryCache = { vals: [], ts: Date.now() };
      ivHistoryCache.ts = Date.now() - IV_HISTORY_TTL_MS + IV_HISTORY_RETRY_MS;
    }
  }
  const vals = ivHistoryCache.vals;
  if (vals.length < IV_HISTORY_MIN) return null;
  const atOrBelow = vals.filter((v) => v <= currentVix).length;
  return Math.round((atOrBelow / vals.length) * 100);
}

export async function getSessionCandles(
  symbol: string,
  interval: string,
  date: string,
): Promise<any[]> {
  const q = new URLSearchParams({ symbol, interval, date });
  const data = await getJson(`${MARKET_HISTORY_BASE}/api/candles?${q.toString()}`);
  return data.candles ?? [];
}

export async function getSnapshotIntegrityRows(
  symbol: string,
  date?: string,
): Promise<{ timestamp: string; spot: number | null; chainCount: number }[]> {
  const q = new URLSearchParams({ symbol });
  if (date) q.append("date", date);
  const data = await getJson(`${MARKET_HISTORY_BASE}/api/integrity?${q.toString()}`);
  return data.rows ?? [];
}

export interface ChainOiSnapshot {
  timestamp: string;
  spot?: number | null;
  rows: { strike: number; ceOi: number; peOi: number }[];
}

/** Per-strike OI series for one symbol/day (recorder history). */
export async function getChainOiHistory(
  symbol: string,
  date?: string,
): Promise<ChainOiSnapshot[]> {
  const q = new URLSearchParams({ symbol });
  if (date) q.append("date", date);
  try {
    const data = await getJson(`${MARKET_HISTORY_BASE}/api/chain-oi-history?${q.toString()}`);
    return data.snapshots ?? [];
  } catch {
    return [];
  }
}

export async function getSnapshotVersion(
  id: string,
): Promise<{ engineVersion: string; featureVersion: number } | null> {
  try {
    return await getJson(`${MARKET_HISTORY_BASE}/api/version/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

export interface MultiDayOiTrend {
  date: string;
  timestamp: string;
  spot: number | null;
  pcr: number | null;
  totalCallOI: number;
  totalPutOI: number;
  totalCallOIChg: number;
  totalPutOIChg: number;
  netOIChg: number;
  dayOverDayCallOIChg?: number;
  dayOverDayPutOIChg?: number;
  dayOverDaySpotChg?: number;
  buildupClass?: string;
  strikes: Array<{
    strike: number;
    ceOi: number;
    peOi: number;
    ceOiChg: number;
    peOiChg: number;
    netOiChg: number;
  }>;
}

/** Multi-day ΔOI trend analytics — per-strike OI change across multiple trading days. */
export async function getMultiDayOiTrend(
  symbol: string,
  days = 5,
): Promise<MultiDayOiTrend[]> {
  const q = new URLSearchParams({ symbol, days: String(days) });
  try {
    const data = await getJson(`${MARKET_HISTORY_BASE}/api/multi-day-oi-trend?${q.toString()}`);
    return data.trends ?? [];
  } catch {
    return [];
  }
}

/** Available dates for a symbol (for date range selection UI). */
export async function getAvailableDates(
  symbol: string,
  limit = 10,
): Promise<string[]> {
  const q = new URLSearchParams({ symbol, limit: String(limit) });
  try {
    const data = await getJson(`${MARKET_HISTORY_BASE}/api/available-dates?${q.toString()}`);
    return data.dates ?? [];
  } catch {
    return [];
  }
}

export async function getStatus(): Promise<MarketHistoryStatus> {
  return getJson(`${MARKET_HISTORY_BASE}/api/status`);
}

/** P0 — session coverage/completeness per symbol for one trading date. */
export interface CaptureCoverageRow {
  symbol: string;
  date: string;
  snapshots: number;
  firstSnapshot: string | null;
  lastSnapshot: string | null;
  expectedMinutes: number;
  coveredMinutes: number;
  coveragePct: number;
  gaps: Array<{ from: string; to: string; minutes: number }>;
  candles: number;
  firstCandle: string | null;
  lastCandle: string | null;
  providerTimestamps: number;
  missingProviderTimestamps: number;
}

export async function getCaptureCoverage(date: string, symbol?: string): Promise<CaptureCoverageRow[]> {
  const q = new URLSearchParams({ date });
  if (symbol) q.set("symbol", symbol);
  const data = await getJson(`${MARKET_HISTORY_BASE}/api/coverage?${q.toString()}`);
  return data.rows ?? [];
}

// Scalar helpers (derived from getStatus).
export async function getTotalSnapshots(): Promise<number> {
  return (await getStatus()).totalSnapshots;
}
export async function getLastCaptureTime(symbol?: string): Promise<string | null> {
  // Per-symbol last capture requires a snapshot query; reuse summary when possible.
  if (!symbol) return (await getStatus()).lastCaptureTime;
  const rows = await getSnapshotsSummary(symbol);
  return rows.length ? rows[rows.length - 1].timestamp : null;
}
export async function getDbFileSizeBytes(): Promise<number> {
  return (await getStatus()).databaseSizeBytes;
}
export async function snapshotCount(): Promise<number> {
  return (await getStatus()).snapshotCount;
}
