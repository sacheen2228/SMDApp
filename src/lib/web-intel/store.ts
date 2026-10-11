// Phase 5 — Web Intelligence: local enriched store (Prisma WebRecord).
// Raw central store stays on :4002; this table is the ENRICHED copy agents
// read. Insert-only: rows are never overwritten after first enrichment.

import { db } from '@/lib/db';
import type { EnrichedWebRecord, RawWebRecord } from './types';

function rowToRecord(r: any): EnrichedWebRecord {
  let symbols: string[] = [];
  let provenance: Record<string, unknown> = {};
  try { symbols = JSON.parse(r.symbols || '[]'); } catch { /* keep [] */ }
  try { provenance = JSON.parse(r.provenance || '{}'); } catch { /* keep {} */ }
  return {
    id: r.id,
    source: r.source,
    sourceFeed: r.sourceFeed,
    url: r.url,
    title: r.title,
    description: r.description || '',
    publishedAt: r.publishedAt instanceof Date ? r.publishedAt.toISOString() : String(r.publishedAt),
    collectedAt: r.collectedAt instanceof Date ? r.collectedAt.toISOString() : String(r.collectedAt),
    syncedAt: r.syncedAt instanceof Date ? r.syncedAt.toISOString() : String(r.syncedAt),
    backfilled: !!r.backfilled,
    symbols,
    eventType: r.eventType,
    sentiment: r.sentiment,
    sentimentLabel: r.sentimentLabel as EnrichedWebRecord['sentimentLabel'],
    impact: r.impact as EnrichedWebRecord['impact'],
    confidence: r.confidence,
    freshness: r.freshness as EnrichedWebRecord['freshness'],
    provenance,
  };
}

/**
 * Sync cursor = the newest `syncedAt` we hold — i.e. the WALL CLOCK of the
 * last successful pass. Sync then asks the store for rows created after
 * (cursor − overlap), so records that arrive with an old `collected_at`
 * (offline-queue drain / PC-off) are never skipped. The store itself
 * dedupes by content hash, so the overlap costs nothing but re-checks.
 * null = never synced.
 */
export async function getSyncCursor(): Promise<string | null> {
  const row = await db.webRecord.findFirst({
    orderBy: { syncedAt: 'desc' },
    select: { syncedAt: true },
  });
  if (!row) return null;
  return (row.syncedAt instanceof Date ? row.syncedAt : new Date(row.syncedAt)).toISOString();
}

export async function getLocalTotal(): Promise<number> {
  return db.webRecord.count();
}

/** Newest published_at — drives honest news freshness (BACKFILLED vs LIVE). */
export async function getNewestPublishedAt(): Promise<string | null> {
  const row = await db.webRecord.findFirst({
    orderBy: { publishedAt: 'desc' },
    select: { publishedAt: true },
  });
  if (!row) return null;
  return (row.publishedAt instanceof Date ? row.publishedAt : new Date(row.publishedAt)).toISOString();
}

/** Enriched insert. NEVER updates an existing row (immutable history). */
export async function insertEnriched(rec: EnrichedWebRecord): Promise<boolean> {
  try {
    await db.webRecord.create({
      data: {
        id: rec.id,
        source: rec.source,
        sourceFeed: rec.sourceFeed ?? null,
        url: rec.url,
        title: rec.title,
        description: rec.description,
        publishedAt: new Date(rec.publishedAt),
        collectedAt: new Date(rec.collectedAt),
        syncedAt: new Date(rec.syncedAt),
        backfilled: rec.backfilled,
        symbols: JSON.stringify(rec.symbols),
        eventType: rec.eventType,
        sentiment: rec.sentiment,
        sentimentLabel: rec.sentimentLabel,
        impact: rec.impact,
        confidence: rec.confidence,
        freshness: rec.freshness,
        provenance: JSON.stringify(rec.provenance),
      },
    });
    return true;
  } catch (e: any) {
    if (e?.code === 'P2002') return false; // duplicate hash — already synced
    throw e;
  }
}

export async function existsRecord(id: string): Promise<boolean> {
  const row = await db.webRecord.findUnique({ where: { id }, select: { id: true } });
  return !!row;
}

/** Recent records for agent merge — newest first, bounded. */
export async function getRecentRecords(opts: {
  limit?: number;
  sinceHours?: number;
} = {}): Promise<EnrichedWebRecord[]> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const since = opts.sinceHours
    ? new Date(Date.now() - opts.sinceHours * 3600_000)
    : undefined;
  const rows = await db.webRecord.findMany({
    where: since ? { publishedAt: { gte: since } } : undefined,
    orderBy: { publishedAt: 'desc' },
    take: limit,
  });
  return rows.map(rowToRecord);
}

/** Records published during a window (PC-off recovery reporting). */
export async function countPublishedBetween(fromIso: string, toIso: string): Promise<number> {
  return db.webRecord.count({
    where: {
      publishedAt: { gte: new Date(fromIso), lte: new Date(toIso) },
    },
  });
}

/** Load persisted sync-state (small JSON row alternative → file-backed). */
export async function countSince(iso: string): Promise<number> {
  return db.webRecord.count({ where: { collectedAt: { gt: new Date(iso) } } });
}
