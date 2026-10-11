// Phase 5 — Web Intelligence status aggregation.
// Single surface for: collector ONLINE/OFFLINE, last collection, last sync,
// market + news freshness, per-source health, missed records.
//
// Honesty rules:
//  - Collector ONLINE only if it heart-beat within 5 minutes (same window as
//    the sidecar) — a dead process never reports itself alive.
//  - News freshness derived from the newest PUBLISHED record, never from
//    "we just synced" (syncing old news does not make it fresh).
//  - Missed records counted from the raw store for the window the local
//    sync has not consumed yet.

import { WEB_INTEL_BASE } from './sync';
import { getLocalTotal, getNewestPublishedAt, getSyncCursor, countSince } from './store';
import type { SourceHealthRow, CollectorState, WebIntelStatus } from './types';

export const COLLECTOR_ONLINE_WINDOW_MS = 5 * 60 * 1000;

interface SidecarWebStatus {
  collector: CollectorState & { status: string; heartbeatAgeMs: number | null };
  store: { totalRecords: number };
  sources: SourceHealthRow[];
}

export interface StatusDeps {
  fetchSidecar: () => Promise<SidecarWebStatus | null>;
  fetchMarket: () => Promise<{ level: string; lastCapture: string | null }>;
}

async function defaultSidecar(): Promise<SidecarWebStatus | null> {
  try {
    const res = await fetch(`${WEB_INTEL_BASE}/api/web/status`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

let statusDeps: StatusDeps = { fetchSidecar: defaultSidecar, fetchMarket: fetchMarketFreshness };

/** Test seam — fake sidecar/market status without network. */
export function __setWebIntelStatusDepsForTests(partial: Partial<StatusDeps>): void {
  statusDeps = { ...statusDeps, ...partial };
}
export function __resetWebIntelStatusDepsForTests(): void {
  statusDeps = { fetchSidecar: defaultSidecar, fetchMarket: fetchMarketFreshness };
}

interface RecorderStatus {
  lastSuccessfulCapture?: string | null;
}

async function fetchMarketFreshness(): Promise<{ level: string; lastCapture: string | null }> {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/market-recorder/status', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { level: 'UNAVAILABLE', lastCapture: null };
    const data: RecorderStatus = await res.json();
    const last = data.lastSuccessfulCapture ?? null;
    if (!last) return { level: 'NO_DATA', lastCapture: null };
    const ageMs = Date.now() - Date.parse(last);
    if (!Number.isFinite(ageMs)) return { level: 'UNKNOWN', lastCapture: last };
    // Market recorder only runs 09:15–15:30 IST — outside those hours the
    // last capture is legitimately old, so cap the label at STALE.
    const level =
      ageMs <= 2 * 60_000 ? 'LIVE'
      : ageMs <= 30 * 60_000 ? 'FRESH'
      : ageMs <= 24 * 3600_000 ? 'DELAYED'
      : 'STALE';
    return { level, lastCapture: last };
  } catch {
    return { level: 'UNAVAILABLE', lastCapture: null };
  }
}

/** News freshness from the newest record's PUBLISHED time (never from sync). */
export function newsFreshnessFrom(
  newestPublishedAt: string | null,
  now = Date.now(),
): string {
  if (!newestPublishedAt) return 'NO_DATA';
  const ageMs = now - Date.parse(newestPublishedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'UNKNOWN';
  if (ageMs <= 60_000) return 'LIVE';
  if (ageMs <= 15 * 60_000) return 'FRESH';
  if (ageMs <= 6 * 3600_000) return 'DELAYED';
  return 'STALE';
}

export async function getWebIntelStatus(now = Date.now()): Promise<WebIntelStatus> {
  const sidecar = await statusDeps.fetchSidecar();
  const [localTotal, newestPublished, cursor] = await Promise.all([
    getLocalTotal(),
    getNewestPublishedAt(),
    getSyncCursor(),
  ]);

  const hbAge = sidecar?.collector?.heartbeatAgeMs ?? null;
  const online =
    hbAge !== null && hbAge >= 0 && hbAge < COLLECTOR_ONLINE_WINDOW_MS;

  // Records sitting in the raw store that local sync has not consumed yet.
  let pendingServer = 0;
  if (cursor) {
    try {
      pendingServer = await countSince(cursor);
    } catch { pendingServer = 0; }
  } else {
    pendingServer = sidecar?.store?.totalRecords ?? 0;
  }

  // "Missed" = raw records collected while we had no fresh sync AND the
  // collector believes it collected more than we have locally.
  const serverTotal = sidecar?.store?.totalRecords ?? 0;
  const missedWhileOffline = Math.max(0, serverTotal - localTotal - pendingServer);

  const market = await statusDeps.fetchMarket();

  return {
    collector: {
      online,
      status: online ? 'ONLINE' : 'OFFLINE',
      statusRaw: sidecar?.collector?.statusRaw ?? null,
      lastHeartbeatAt: sidecar?.collector?.lastHeartbeatAt ?? null,
      heartbeatAgeMs: hbAge,
      lastCollectionAt: sidecar?.collector?.lastCollectionAt ?? null,
      recordsTotal: sidecar?.collector?.recordsTotal ?? 0,
      recordsThisRun: sidecar?.collector?.recordsThisRun ?? 0,
      lastError: sidecar?.collector?.lastError ?? null,
      version: sidecar?.collector?.version ?? null,
      updatedAt: sidecar?.collector?.updatedAt ?? null,
    },
    sync: {
      lastSyncAt: cursor,
      localTotal,
      pendingServerRecords: pendingServer,
      missedWhileOffline,
    },
    freshness: {
      news: newsFreshnessFrom(newestPublished, now),
      newsNewestPublishedAt: newestPublished,
      market: market.level,
      marketLastCapture: market.lastCapture,
    },
    sources: sidecar?.sources ?? [],
    store: { serverTotal },
    evidenceOnly: true,
  };
}
