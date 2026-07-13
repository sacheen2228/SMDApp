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

export async function recordSnapshot(snapshot: any): Promise<boolean> {
  const res = await fetch(`${MARKET_HISTORY_BASE}/api/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}

export async function recordCandles(
  symbol: string,
  interval: string,
  candles: any[],
): Promise<boolean> {
  const res = await fetch(`${MARKET_HISTORY_BASE}/api/candles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, interval, candles }),
  });
  return res.ok;
}

export async function recordScannerResults(results: any[]): Promise<boolean> {
  if (!results.length) return true;
  const res = await fetch(`${MARKET_HISTORY_BASE}/api/scanner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  });
  return res.ok;
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

export async function getSnapshotVersion(
  id: string,
): Promise<{ engineVersion: string; featureVersion: number } | null> {
  try {
    return await getJson(`${MARKET_HISTORY_BASE}/api/version/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

export async function getStatus(): Promise<MarketHistoryStatus> {
  return getJson(`${MARKET_HISTORY_BASE}/api/status`);
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
