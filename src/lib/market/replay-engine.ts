// Replay Engine — the foundation for scanner recording, backtesting and evaluation.
// Reconstructs the exact recorded market state from a Snapshot ID or trading session,
// and validates recorder integrity (missing intervals, duplicates, incomplete captures).
import {
  readSnapshotById,
  getSnapshotsForSymbol,
  getSessionCandles,
  getSnapshotIntegrityRows,
} from "@/lib/market-history-client";
import { getRecorderMode, getIntervalSeconds } from "@/lib/market/recorder-config";
import type { CanonicalMarketSnapshot, Candle } from "@/lib/market/canonical";

// 1) Stable Snapshot ID lookup. The id is `${symbol}-${timestamp}` (see canonical).
export async function getSnapshotById(id: string): Promise<CanonicalMarketSnapshot | null> {
  return readSnapshotById(id);
}

// 2a) Reconstruct a complete trading session (all snapshots for a symbol on a date).
export async function reconstructSession(symbol: string, dateISO: string): Promise<CanonicalMarketSnapshot[]> {
  return getSnapshotsForSymbol(symbol, dateISO.slice(0, 10));
}

// 2b) Reconstruct the market state at (or just before) a given timestamp.
export async function reconstructAt(symbol: string, timestampISO: string): Promise<CanonicalMarketSnapshot | null> {
  const snaps = await getSnapshotsForSymbol(symbol, timestampISO.slice(0, 10));
  const target = new Date(timestampISO).getTime();
  let best: CanonicalMarketSnapshot | null = null;
  for (const s of snaps) {
    const t = new Date(s.timestamp).getTime();
    if (t <= target && (!best || t > new Date(best.timestamp).getTime())) best = s;
  }
  return best;
}

// 2c) Session candles aligned to the snapshot day.
export async function getSessionCandlesForReplay(symbol: string, dateISO: string, interval = "1minute"): Promise<Candle[]> {
  return getSessionCandles(symbol, interval, dateISO.slice(0, 10));
}

// 5) Recorder integrity validation.
export interface IntegrityReport {
  symbol: string;
  date: string | null;
  totalSnapshots: number;
  firstCapture: string | null;
  lastCapture: string | null;
  duplicateTimestamps: string[];
  missingIntervals: { after: string; gapSec: number }[];
  incompleteCaptures: { timestamp: string; reason: string }[];
  expectedIntervalSec: number;
  continuityPct: number;
  status: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
}

export async function validateRecorderIntegrity(
  symbol: string,
  opts?: { date?: string; expectedIntervalSec?: number },
): Promise<IntegrityReport> {
  const rows = await getSnapshotIntegrityRows(symbol, opts?.date);
  const expected = opts?.expectedIntervalSec ?? getIntervalSeconds(getRecorderMode());

  const timestamps = rows.map((r) => r.timestamp);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const t of timestamps) {
    if (seen.has(t)) duplicates.push(t);
    else seen.add(t);
  }

  const uniq = Array.from(new Set(timestamps)).sort();
  const missing: { after: string; gapSec: number }[] = [];
  for (let i = 1; i < uniq.length; i++) {
    const a = new Date(uniq[i - 1]).getTime();
    const b = new Date(uniq[i]).getTime();
    const gap = Math.round((b - a) / 1000);
    if (gap > expected * 1.5) missing.push({ after: uniq[i - 1], gapSec: gap });
  }

  const incomplete = rows
    .filter((r) => r.chainCount === 0 || r.spot == null)
    .map((r) => ({ timestamp: r.timestamp, reason: r.chainCount === 0 ? "empty option chain" : "null spot" }));

  const total = rows.length;
  const continuityPct =
    uniq.length > 1 ? Math.max(0, 100 - (missing.length / (uniq.length - 1)) * 100) : 100;
  const status: IntegrityReport["status"] =
    duplicates.length > 0 || incomplete.length > total * 0.1
      ? "UNHEALTHY"
      : missing.length > 0 || incomplete.length > 0
        ? "DEGRADED"
        : "HEALTHY";

  return {
    symbol,
    date: opts?.date ?? null,
    totalSnapshots: total,
    firstCapture: uniq[0] ?? null,
    lastCapture: uniq[uniq.length - 1] ?? null,
    duplicateTimestamps: duplicates,
    missingIntervals: missing,
    incompleteCaptures: incomplete,
    expectedIntervalSec: expected,
    continuityPct,
    status,
  };
}
