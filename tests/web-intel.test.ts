/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — Web Intelligence layer tests.
//  - honest freshness (PC-off / backfill never looks LIVE)
//  - sync dedup + incremental cursor + source-failure isolation
//  - merge into existing /api/news shape (evidence only, live-first)
//  - collector status ONLINE/OFFLINE from heartbeat age
//  - agent-facing shape compatibility (≤12 budget untouched elsewhere)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  computeFreshness,
  enrichRaw,
  syncWebIntel,
  __setWebIntelDepsForTests,
  __resetWebIntelDepsForTests,
  BACKFILL_GAP_MS,
} from '@/lib/web-intel/sync';
import {
  mergeWithStoredArticles,
  recordToArticle,
  __setWebIntelMergeDepsForTests,
  __resetWebIntelMergeDepsForTests,
} from '@/lib/web-intel/merge';
import {
  getWebIntelStatus,
  newsFreshnessFrom,
  COLLECTOR_ONLINE_WINDOW_MS,
  __setWebIntelStatusDepsForTests,
  __resetWebIntelStatusDepsForTests,
} from '@/lib/web-intel/status';
import type { EnrichedWebRecord, RawWebRecord } from '@/lib/web-intel/types';
import type { NewsArticle } from '@/lib/news-engine';

const NOW = Date.parse('2026-10-08T10:00:00.000Z');
const H = 3600_000;

function raw(over: Partial<RawWebRecord> = {}): RawWebRecord {
  return {
    id: 'hash-abc',
    source: 'Economic Times',
    source_feed: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms',
    url: 'https://economictimes.indiatimes.com/markets/news/x',
    title: 'NIFTY surges as RBI holds rates, banks rally',
    description: 'Benchmark index NIFTY gained 1% after RBI kept rates unchanged.',
    published_at: new Date(NOW - 5 * 60_000).toISOString(),
    collected_at: new Date(NOW - 4 * 60_000).toISOString(),
    backfilled: 0,
    provenance: JSON.stringify({ timeInvented: false, collector: 'scrapling' }),
    ...over,
  };
}

function stored(over: Partial<EnrichedWebRecord> = {}): EnrichedWebRecord {
  const r = enrichRaw(raw(), NOW);
  return { ...r, ...over };
}

afterEach(() => {
  __resetWebIntelDepsForTests();
  __resetWebIntelMergeDepsForTests();
  __resetWebIntelStatusDepsForTests();
});

// ── 1. Freshness honesty (PC-off / backfill) ──────────────────────────────
describe('web-intel freshness (requirement: PC-OFF never looks LIVE)', () => {
  test('fresh article → LIVE', () => {
    expect(computeFreshness(
      new Date(NOW - 30_000).toISOString(),
      new Date(NOW - 20_000).toISOString(),
      NOW,
    )).toBe('LIVE');
  });

  test('5m-old article → FRESH, 2h-old → DELAYED, 30h-old → STALE', () => {
    const pub = (ms: number) => new Date(NOW - ms).toISOString();
    const col = (ms: number) => new Date(NOW - ms + 30_000).toISOString();
    expect(computeFreshness(pub(5 * 60_000), col(5 * 60_000), NOW)).toBe('FRESH');
    expect(computeFreshness(pub(2 * H), col(2 * H), NOW)).toBe('DELAYED');
    expect(computeFreshness(pub(30 * H), col(30 * H), NOW)).toBe('STALE');
  });

  test('collected >6h after publish → BACKFILLED even if published seconds ago', () => {
    const pub = new Date(NOW - 60_000).toISOString();
    const col = new Date(NOW - 60_000 + BACKFILL_GAP_MS + 1000).toISOString();
    expect(computeFreshness(pub, col, NOW)).toBe('BACKFILLED');
  });

  test('explicit backfilled flag → BACKFILLED regardless of ages', () => {
    expect(computeFreshness(
      new Date(NOW - 60_000).toISOString(),
      new Date(NOW - 50_000).toISOString(),
      NOW,
      true,
    )).toBe('BACKFILLED');
  });

  test('unparseable / missing timestamps → UNKNOWN, never LIVE', () => {
    expect(computeFreshness('not-a-date', new Date(NOW).toISOString(), NOW)).toBe('UNKNOWN');
    expect(computeFreshness('', '', NOW)).toBe('UNKNOWN');
  });

  test('future publish time (clock skew) → UNKNOWN, never LIVE', () => {
    expect(computeFreshness(
      new Date(NOW + 10 * 60_000).toISOString(),
      new Date(NOW).toISOString(),
      NOW,
    )).toBe('UNKNOWN');
  });

  test('status-level news freshness is derived from PUBLISHED time, not sync time', () => {
    expect(newsFreshnessFrom(new Date(NOW - 20_000).toISOString(), NOW)).toBe('LIVE');
    expect(newsFreshnessFrom(new Date(NOW - 3 * H).toISOString(), NOW)).toBe('DELAYED');
    expect(newsFreshnessFrom(new Date(NOW - 40 * H).toISOString(), NOW)).toBe('STALE');
    expect(newsFreshnessFrom(null, NOW)).toBe('NO_DATA');
  });
});

// ── 2. Enrichment: original timestamps preserved, existing lexicon reused ──
describe('web-intel enrichRaw', () => {
  test('published_at / collected_at are preserved verbatim (no rewrite)', () => {
    const r = raw({
      published_at: '2026-10-05T06:30:00.000Z',
      collected_at: '2026-10-07T18:00:00.000Z',
    });
    const out = enrichRaw(r, NOW);
    expect(out.publishedAt).toBe('2026-10-05T06:30:00.000Z');
    expect(out.collectedAt).toBe('2026-10-07T18:00:00.000Z');
    expect(out.backfilled).toBe(true);
    expect(out.freshness).toBe('BACKFILLED');
  });

  test('entities extracted via the shared lexicon (index + stock)', () => {
    const out = enrichRaw(raw({ title: 'NIFTY and RELIANCE lead the charge' }), NOW);
    expect(out.symbols).toContain('NIFTY');
    expect(out.symbols).toContain('RELIANCE');
  });

  test('sentiment + event + impact are populated deterministically', () => {
    const out = enrichRaw(raw(), NOW);
    expect(typeof out.sentiment).toBe('number');
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(out.sentimentLabel);
    expect(typeof out.eventType).toBe('string');
    expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).toContain(out.impact);
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    expect(out.provenance.enrichedBy).toBe('smdapp-sync');
  });

  test('same input → identical output (no Math.random)', () => {
    const r = raw();
    expect(enrichRaw(r, NOW)).toEqual(enrichRaw(r, NOW));
  });
});

// ── 3. Sync: dedup, cursor, PC-off recovery, source failure isolation ─────
describe('web-intel sync', () => {
  test('inserts once, dedupes every subsequent sync (content-hash PK)', async () => {
    const store = new Map<string, EnrichedWebRecord>();
    __setWebIntelDepsForTests({
      getCursor: async () => null,
      fetchRecords: async () => ({ records: [raw({ id: 'hash-1' }), raw({ id: 'hash-2', url: 'u2' })], total: 2 }),
      exists: async (id) => store.has(id),
      insert: async (rec) => { if (store.has(rec.id)) return false; store.set(rec.id, rec); return true; },
    });

    const first = await syncWebIntel({ now: NOW });
    expect(first.inserted).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(first.error).toBeUndefined();

    // Second pass — same rows still served by server → all deduped.
    const second = await syncWebIntel({ now: NOW + 60_000 });
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(store.size).toBe(2);
  });

  test('PC-off gap: backdated rows sync with original timestamps + BACKFILLED', async () => {
    const store = new Map<string, EnrichedWebRecord>();
    const offline = raw({
      id: 'hash-offline',
      published_at: new Date(NOW - 30 * H).toISOString(),
      collected_at: new Date(NOW - 1 * H).toISOString(), // drained from offline queue
      backfilled: 1,
    });
    __setWebIntelDepsForTests({
      getCursor: async () => null,
      fetchRecords: async () => ({ records: [offline], total: 1 }),
      exists: async (id) => store.has(id),
      insert: async (rec) => { store.set(rec.id, rec); return true; },
    });

    await syncWebIntel({ now: NOW });
    const rec = [...store.values()][0];
    expect(rec.publishedAt).toBe(offline.published_at);
    expect(rec.collectedAt).toBe(offline.collected_at);
    expect(rec.backfilled).toBe(true);
    expect(rec.freshness).toBe('BACKFILLED');
    expect(rec.freshness).not.toBe('LIVE');
  });

  test('incremental cursor is passed to the store', async () => {
    const seen: (string | null)[] = [];
    __setWebIntelDepsForTests({
      getCursor: async () => '2026-10-08T09:00:00.000Z',
      fetchRecords: async (since) => { seen.push(since); return { records: [], total: 0 }; },
      exists: async () => false,
      insert: async () => true,
    });
    await syncWebIntel({ now: NOW });
    expect(seen).toEqual(['2026-10-08T09:00:00.000Z']);
  });

  test('central store unreachable → NO_DATA error result, never throws', async () => {
    __setWebIntelDepsForTests({
      getCursor: async () => null,
      fetchRecords: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4002'); },
      exists: async () => false,
      insert: async () => true,
    });
    const res = await syncWebIntel({ now: NOW });
    expect(res.error).toContain('ECONNREFUSED');
    expect(res.inserted).toBe(0);
    expect(res.fetched).toBe(0);
    expect(res.lastSyncAt).toBe(new Date(NOW).toISOString());
  });

  test('one bad record does not abort the rest of the batch', async () => {
    const store = new Map<string, EnrichedWebRecord>();
    __setWebIntelDepsForTests({
      getCursor: async () => null,
      fetchRecords: async () => ({
        records: [raw({ id: 'good-1' }), raw({ id: 'bad' }), raw({ id: 'good-2' })],
        total: 3,
      }),
      exists: async (id) => store.has(id),
      insert: async (rec) => {
        if (rec.id === 'bad') throw new Error('malformed record');
        store.set(rec.id, rec);
        return true;
      },
    });
    const res = await syncWebIntel({ now: NOW });
    expect(res.inserted).toBe(2);
    expect(store.size).toBe(2);
    expect(res.error).toContain('partial');
    expect(res.error).toContain('malformed record');
  });
});

// ── 4. Merge into /api/news (evidence only, live-first) ───────────────────
describe('web-intel merge into /api/news', () => {
  const live: NewsArticle[] = [
    {
      id: 'live-1',
      title: 'NIFTY surges as RBI holds rates, banks rally',
      description: 'live',
      source: 'LiveMint',
      url: 'https://livemint.com/1',
      publishedAt: new Date(NOW - 60_000).toISOString(),
      sentiment: 0.5,
      sentimentLabel: 'BULLISH',
      confidence: 0.7,
      event: { type: 'MACRO', sentimentBias: 0.5, confidence: 0.7 },
      stockEntities: ['NIFTY'],
      sectorEntities: [],
    },
  ];

  test('stored record matching a live title is NOT duplicated (live wins)', async () => {
    __setWebIntelMergeDepsForTests({
      getRecords: async () => [stored({ title: 'NIFTY surges as RBI holds rates, banks rally' })],
    });
    const res = await mergeWithStoredArticles(live, { limit: 50, sinceHours: 48 });
    expect(res.storedMerged).toBe(0);
    expect(res.articles.length).toBe(1);
    expect(res.articles[0].id).toBe('live-1');
  });

  test('non-duplicate stored record is appended with honest freshness + provenance', async () => {
    const offlineStored = stored({
      id: 'hash-offline-2',
      title: 'SEBI tightens intraday position limits for brokers',
      url: 'https://sebi.gov.in/x',
      publishedAt: new Date(NOW - 40 * H).toISOString(),
      collectedAt: new Date(NOW - 2 * H).toISOString(),
      backfilled: true,
      freshness: 'BACKFILLED',
      impact: 'HIGH',
    });
    __setWebIntelMergeDepsForTests({ getRecords: async () => [offlineStored] });

    const res = await mergeWithStoredArticles(live, { limit: 50, sinceHours: 48 });
    expect(res.storedMerged).toBe(1);
    expect(res.articles.length).toBe(2);
    // live article still first — live market priority
    expect(res.articles[0].id).toBe('live-1');
    const merged = res.articles[1] as any;
    expect(merged.publishedAt).toBe(offlineStored.publishedAt);
    expect(merged.freshness).toBe('BACKFILLED');
    expect(merged.backfilled).toBe(true);
    expect(merged.provenance.evidenceOnly).toBe(true);
    expect(merged.title).toContain('SEBI');
  });

  test('local store down → live-only response, news never fails', async () => {
    __setWebIntelMergeDepsForTests({
      getRecords: async () => { throw new Error('db locked'); },
    });
    const res = await mergeWithStoredArticles(live);
    expect(res.articles.length).toBe(1);
    expect(res.storedMerged).toBe(0);
  });

  test('merged article shape is what hermes context consumes', () => {
    const art = recordToArticle(stored({ title: 'Crude oil slips 3% on demand worries' }));
    expect(typeof art.title).toBe('string');
    expect(typeof art.publishedAt).toBe('string');
    expect(Number.isFinite(Date.parse(art.publishedAt))).toBe(true);
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(art.sentimentLabel);
    expect(typeof art.sentiment).toBe('number');
    expect(typeof art.event.type).toBe('string');
    expect(Array.isArray(art.stockEntities)).toBe(true);
    // context.ts: headlines = articles.slice(0,5).map(a => a.title.substring(0,100))
    expect(art.title.substring(0, 100).length).toBeLessThanOrEqual(100);
  });

  test('merge output never exceeds live + 50 stored additions', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      stored({ id: `h-${i}`, title: `Stored headline number ${i}` }));
    __setWebIntelMergeDepsForTests({ getRecords: async () => many });
    const res = await mergeWithStoredArticles(live, { limit: 50 });
    expect(res.storedMerged).toBeLessThanOrEqual(50);
    expect(res.articles.length).toBeLessThanOrEqual(51);
  });
});

// ── 5. Collector status (honest ONLINE/OFFLINE) ───────────────────────────
describe('web-intel status', () => {
  const baseStore = { totalRecords: 900 };

  afterEach(() => {
    __resetWebIntelStatusDepsForTests();
  });

  test('fresh heartbeat → ONLINE; stale heartbeat → OFFLINE', async () => {
    const hb = (ageMs: number) => ageMs;
    for (const [age, expected] of [
      [30_000, 'ONLINE'],
      [COLLECTOR_ONLINE_WINDOW_MS + 60_000, 'OFFLINE'],
    ] as const) {
      __setWebIntelStatusDepsForTests({
        fetchSidecar: async () => ({
          collector: {
            status: age < COLLECTOR_ONLINE_WINDOW_MS ? 'RUNNING' : 'STOPPED',
            statusRaw: 'RUNNING',
            lastHeartbeatAt: new Date(NOW - age).toISOString(),
            heartbeatAgeMs: hb(age),
            lastCollectionAt: new Date(NOW - 60_000).toISOString(),
            recordsTotal: 900,
            recordsThisRun: 953,
            lastError: null,
            version: '1.0',
            updatedAt: new Date(NOW - age).toISOString(),
          },
          store: baseStore,
          sources: [],
        }),
        fetchMarket: async () => ({ level: 'FRESH', lastCapture: new Date(NOW - 60_000).toISOString() }),
      });
      const status = await getWebIntelStatus(NOW);
      expect(status.collector.status).toBe(expected);
      expect(status.collector.online).toBe(expected === 'ONLINE');
    }
  });

  test('sidecar unreachable → collector OFFLINE + empty sources, no throw', async () => {
    __setWebIntelStatusDepsForTests({
      fetchSidecar: async () => null,
      fetchMarket: async () => ({ level: 'UNAVAILABLE', lastCapture: null }),
    });
    const status = await getWebIntelStatus(NOW);
    expect(status.collector.online).toBe(false);
    expect(status.collector.status).toBe('OFFLINE');
    expect(status.sources).toEqual([]);
    expect(status.store.serverTotal).toBe(0);
    expect(status.evidenceOnly).toBe(true);
  });

  test('freshness block reports news + market independently', async () => {
    __setWebIntelStatusDepsForTests({
      fetchSidecar: async () => ({
        collector: {
          status: 'RUNNING', statusRaw: null, lastHeartbeatAt: null,
          heartbeatAgeMs: 1000, lastCollectionAt: null, recordsTotal: 0,
          recordsThisRun: 0, lastError: null, version: null, updatedAt: null,
        },
        store: baseStore,
        sources: [],
      }),
      fetchMarket: async () => ({ level: 'STALE', lastCapture: new Date(NOW - 40 * H).toISOString() }),
    });
    const status = await getWebIntelStatus(NOW);
    expect(status.freshness.market).toBe('STALE');
    expect(status.freshness.marketLastCapture).toBe(new Date(NOW - 40 * H).toISOString());
    expect(['NO_DATA', 'LIVE', 'FRESH', 'DELAYED', 'STALE', 'UNKNOWN']).toContain(status.freshness.news);
  });
});
