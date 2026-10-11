// Phase 5 — Web Intelligence: shared types.
// Evidence layer only. Nothing here creates a trade or bypasses Grok /
// Option Engine / ₹5 / ₹15K gates / validator / trade lock / Telegram.

// Raw record as stored by the market-history central store (:4002).
export interface RawWebRecord {
  id: string; // sha256 content hash — dedup key
  source: string;
  source_feed?: string | null;
  url: string;
  title: string;
  description?: string | null;
  published_at: string; // ORIGINAL publish time (ISO) — never rewritten
  collected_at: string; // when the collector actually fetched it (ISO)
  backfilled?: number | null; // 1 = collected >6h after publish (PC-off gap)
  symbols?: string | null; // JSON array (raw); TS extracts at sync
  provenance?: string | null; // JSON object
  created_at?: string;
}

// Enriched record as stored locally (Prisma WebRecord) and served to agents.
export interface EnrichedWebRecord {
  id: string;
  source: string;
  sourceFeed?: string | null;
  url: string;
  title: string;
  description: string;
  publishedAt: string;
  collectedAt: string;
  syncedAt: string;
  backfilled: boolean;
  symbols: string[];
  eventType: string;
  sentiment: number; // -1..+1
  sentimentLabel: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  impact: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  confidence: number; // 0..1
  freshness: 'LIVE' | 'FRESH' | 'DELAYED' | 'STALE' | 'BACKFILLED' | 'UNKNOWN';
  provenance: Record<string, unknown>;
}

export interface WebIntelSyncResult {
  fetched: number;
  inserted: number;
  duplicates: number;
  enriched: number;
  lastSyncAt: string;
  serverTotal: number;
  error?: string;
}

export interface SourceHealthRow {
  source: string;
  status: string;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  total_ok: number;
  total_fail: number;
  updated_at: string;
}

export interface CollectorState {
  status: string;
  statusRaw: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  lastCollectionAt: string | null;
  recordsTotal: number;
  recordsThisRun: number;
  lastError: string | null;
  version: string | null;
  updatedAt: string | null;
}

export interface WebIntelStatus {
  collector: CollectorState & { online: boolean };
  sync: {
    lastSyncAt: string | null;
    localTotal: number;
    pendingServerRecords: number;
    missedWhileOffline: number;
  };
  freshness: {
    news: string; // LIVE | FRESH | DELAYED | STALE | BACKFILLED | NO_DATA
    newsNewestPublishedAt: string | null;
    market: string; // market recorder freshness (from /api/market-recorder/status)
    marketLastCapture: string | null;
  };
  sources: SourceHealthRow[];
  store: { serverTotal: number };
  evidenceOnly: true;
}
