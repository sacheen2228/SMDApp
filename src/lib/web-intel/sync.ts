// Phase 5 — Web Intelligence sync.
// Flow: local cursor → server timestamp → sync missing → dedupe → enrich →
// insert-once into the local store. Live collection continues independently
// in the Python collector (this layer never fetches the web itself).
//
// Enrichment reuses the EXISTING lexicon (news-lexicon / sentiment-analyzer /
// news-intelligence pure helpers) — no second classification implementation.
//
// PC-OFF rule: raw published_at / collected_at are preserved verbatim.
// Freshness is computed HONESTLY — a record collected long after publication
// is BACKFILLED/STALE, never LIVE.

import { analyzeSentiment } from '@/lib/sentiment-analyzer';
import { classifyEvent } from '@/lib/news-lexicon';
import {
  assessNewsImpact,
  detectNewsCategory,
  extractNewsEntities,
} from '@/lib/hermes/news-intelligence';
import type { EnrichedWebRecord, RawWebRecord, WebIntelSyncResult } from './types';
import { getLocalTotal } from './store';

export const WEB_INTEL_BASE =
  process.env.NEXT_PUBLIC_MARKET_HISTORY_URL || 'http://127.0.0.1:4002';

/** Backfill threshold: collected > 6h after publish → never looks fresh. */
export const BACKFILL_GAP_MS = 6 * 3600_000;

export type FreshnessLabel =
  | 'LIVE' | 'FRESH' | 'DELAYED' | 'STALE' | 'BACKFILLED' | 'UNKNOWN';

/**
 * Honest freshness (requirement 1):
 *  - unknown timestamps          → UNKNOWN (never guessed)
 *  - backfilled / collected >6h after publish → BACKFILLED
 *  - else age of PUBLISHED time classified via the shared freshness helper:
 *    LIVE ≤1min-equivalent, FRESH ≤5min... (api-freshness thresholds)
 */
export function computeFreshness(
  publishedAtIso: string,
  collectedAtIso: string,
  now = Date.now(),
  backfilled = false,
): FreshnessLabel {
  const pub = Date.parse(publishedAtIso);
  const col = Date.parse(collectedAtIso);
  if (!Number.isFinite(pub) || !Number.isFinite(col)) return 'UNKNOWN';
  if (backfilled || col - pub > BACKFILL_GAP_MS) return 'BACKFILLED';

  const ageMs = now - pub;
  if (ageMs < 0) return 'UNKNOWN'; // future publish clock skew — never LIVE
  if (ageMs <= 60_000) return 'LIVE';
  if (ageMs <= 15 * 60_000) return 'FRESH';
  if (ageMs <= 6 * 3600_000) return 'DELAYED';
  return 'STALE';
}

/** Raw central-store row → enriched local record (pure, testable). */
export function enrichRaw(
  raw: RawWebRecord,
  now = Date.now(),
): EnrichedWebRecord {
  const text = `${raw.title} ${raw.description || ''}`;
  const upper = text.toUpperCase();

  const sent = analyzeSentiment(text);
  const entities = extractNewsEntities(upper);
  const category = detectNewsCategory(upper);
  const event = classifyEvent(raw.title); // { type, sentimentBias, confidence }
  const impact = assessNewsImpact(upper, entities, category);

  const backfilled = !!raw.backfilled || Date.parse(raw.collected_at) - Date.parse(raw.published_at) > BACKFILL_GAP_MS;

  let provenance: Record<string, unknown> = {};
  try { provenance = JSON.parse(raw.provenance || '{}'); } catch { /* keep {} */ }

  return {
    id: raw.id,
    source: raw.source,
    sourceFeed: raw.source_feed ?? null,
    url: raw.url,
    title: raw.title,
    description: raw.description || '',
    publishedAt: raw.published_at, // ORIGINAL — verbatim
    collectedAt: raw.collected_at, // ORIGINAL — verbatim
    syncedAt: new Date(now).toISOString(),
    backfilled,
    symbols: entities,
    eventType: event.type,
    sentiment: sent.score,
    sentimentLabel: sent.label,
    impact,
    // Enrichment confidence = blend of lexicon event confidence and
    // sentiment keyword confidence (both deterministic, 0..1).
    confidence: Math.round(((event.confidence ?? 0.3) * 0.5 + sent.confidence * 0.5) * 100) / 100,
    freshness: computeFreshness(raw.published_at, raw.collected_at, now, backfilled),
    provenance: {
      ...provenance,
      enrichedBy: 'smdapp-sync',
      enrichmentLexicon: 'news-lexicon+sentiment-analyzer+news-intelligence',
    },
  };
}

export interface SyncDeps {
  fetchRecords: (
    since: string | null,
    limit: number,
  ) => Promise<{ records: RawWebRecord[]; total: number }>;
  getCursor: () => Promise<string | null>;
  exists: (id: string) => Promise<boolean>;
  insert: (rec: EnrichedWebRecord) => Promise<boolean>;
}

/** Rows per store query (sidecar caps at 2000). */
export const SYNC_PAGE_SIZE = 1000;
/**
 * Watermark overlap: start each pass 5 min BEFORE the last successful sync
 * so rows committed mid-sync are re-offered (dedup drops them). Combined with
 * hash dedup this makes the pass restart-safe.
 */
export const SYNC_OVERLAP_MS = 5 * 60_000;
/** Safety valve — never paginate more than this in one pass. */
const SYNC_MAX_PAGES = 50;

async function defaultFetchRecords(
  since: string | null,
  limit: number,
): Promise<{ records: RawWebRecord[]; total: number }> {
  const url = `${WEB_INTEL_BASE}/api/web/records?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`store HTTP ${res.status}`);
  const data = await res.json();
  return { records: data.records ?? [], total: data.total ?? 0 };
}

function defaultDeps(): SyncDeps {
  return {
    fetchRecords: defaultFetchRecords,
    getCursor: () => import('./store').then((m) => m.getSyncCursor()),
    exists: (id) => import('./store').then((m) => m.existsRecord(id)),
    insert: (rec) => import('./store').then((m) => m.insertEnriched(rec)),
  };
}

let deps: SyncDeps = defaultDeps();

/** Test seam — inject a fake central store (no network, no DB). */
export function __setWebIntelDepsForTests(partial: Partial<SyncDeps>): void {
  deps = { ...deps, ...partial };
}
export function __resetWebIntelDepsForTests(): void {
  deps = defaultDeps();
}

function pageWatermark(records: RawWebRecord[]): string | null {
  let max = '';
  for (const r of records) {
    const c = r.created_at || '';
    if (c > max) max = c;
  }
  return max || null;
}

async function ingestOne(
  raw: RawWebRecord,
  now: number,
  seen: Set<string>,
  counters: { inserted: number; duplicates: number; enriched: number; failed: number; error: string | null },
): Promise<void> {
  if (seen.has(raw.id)) { counters.duplicates++; return; }
  seen.add(raw.id);
  if (await deps.exists(raw.id)) { counters.duplicates++; return; }
  try {
    const rec = enrichRaw(raw, now);
    counters.enriched++;
    const ok = await deps.insert(rec);
    if (ok) counters.inserted++; else counters.duplicates++;
  } catch (e: any) {
    // One malformed record must never abort the rest of the batch.
    counters.failed++;
    counters.error = counters.error ?? String(e?.message ?? e);
  }
}

/**
 * One incremental sync pass (paginated, restart-safe).
 * Watermark = last successful sync time − overlap, filtered on store
 * created_at (arrival time), so offline-queue rows with an OLD collected_at
 * are still fetched and keep their original timestamps on insert.
 * `now` injectable for deterministic tests.
 */
export async function syncWebIntel(opts: { now?: number } = {}): Promise<WebIntelSyncResult> {
  const now = opts.now ?? Date.now();
  const isoNow = new Date(now).toISOString();
  const counters = { inserted: 0, duplicates: 0, enriched: 0, failed: 0, error: null as string | null };
  const seen = new Set<string>();
  let fetched = 0;
  let serverTotal = 0;

  let since: string | null = null;
  try {
    const cursor = await deps.getCursor();
    since = cursor ? new Date(Date.parse(cursor) - SYNC_OVERLAP_MS).toISOString() : null;
  } catch (e: any) {
    return {
      fetched: 0, inserted: 0, duplicates: 0, enriched: 0,
      lastSyncAt: isoNow, serverTotal: 0,
      error: String(e?.message ?? e),
    };
  }

  try {
    for (let page = 0; page < SYNC_MAX_PAGES; page++) {
      const res = await deps.fetchRecords(since, SYNC_PAGE_SIZE);
      fetched += res.records.length;
      if (page === 0) serverTotal = res.total;

      for (const raw of res.records) await ingestOne(raw, now, seen, counters);

      if (res.records.length < SYNC_PAGE_SIZE) break;
      const next = pageWatermark(res.records);
      if (!next || (since && next <= since)) break; // no forward progress
      since = next;
    }
  } catch (e: any) {
    counters.error = counters.error ?? String(e?.message ?? e);
    if (serverTotal === 0 && fetched === 0 && counters.inserted === 0 && counters.enriched === 0) {
      return {
        fetched: 0, inserted: 0, duplicates: 0, enriched: 0,
        lastSyncAt: isoNow, serverTotal: 0,
        error: String(e?.message ?? e),
      };
    }
  }

  return {
    fetched,
    inserted: counters.inserted,
    duplicates: counters.duplicates,
    enriched: counters.enriched,
    lastSyncAt: isoNow,
    serverTotal,
    ...(counters.failed > 0
      ? { error: `partial: ${counters.failed} failed (${counters.error})` }
      : {}),
  };
}

/** Manual trigger for POST /api/web-intel/sync. */
export async function syncWebIntelFull(): Promise<WebIntelSyncResult & { localTotal: number }> {
  const result = await syncWebIntel();
  return { ...result, localTotal: await getLocalTotal() };
}
