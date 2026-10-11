// Phase 5 — Web Intelligence: merge stored enriched records into the live
// /api/news articles array (evidence layer only — never creates a trade,
// never touches MOAPI/NSE/BSE/Breeze, zero extra fetches).
//
// NOTE: faithful reconstruction of the consumer contract in
// src/app/api/news/route.ts (mergeWithStoredArticles → { articles,
// storedMerged, storedTotal }) against web-intel/store + types.

import { getRecentRecords } from './store';
import type { EnrichedWebRecord } from './types';

export interface MergeOptions {
  limit?: number;
  sinceHours?: number;
}

export interface MergeResult {
  articles: any[];
  storedMerged: number;
  storedTotal: number;
}

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    // strip common tracking params
    for (const k of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref)/i.test(k)) parsed.searchParams.delete(k);
    }
    let out = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}${parsed.search}`;
    return out.replace(/\/$/, '').toLowerCase();
  } catch {
    return (u || '').trim().toLowerCase().replace(/\/$/, '');
  }
}

function normalizeTitle(t: string): string {
  return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** EnrichedWebRecord → the same article shape /api/news already serves. */
function recordToArticle(rec: EnrichedWebRecord): any {
  return {
    id: `webintel-${rec.id}`,
    title: rec.title,
    description: rec.description || '',
    source: rec.source,
    url: rec.url,
    publishedAt: rec.publishedAt,
    sentiment: rec.sentiment,
    sentimentLabel: rec.sentimentLabel,
    confidence: rec.confidence,
    event: {
      type: rec.eventType,
      sentimentBias: rec.sentiment,
      confidence: rec.confidence,
    },
    stockEntities: rec.symbols || [],
    sectorEntities: [],
    // evidence-quality metadata (read-only; agents use it, orders never do)
    webIntel: {
      freshness: rec.freshness,
      impact: rec.impact,
      backfilled: rec.backfilled,
      collectedAt: rec.collectedAt,
      provenance: rec.provenance,
    },
  };
}

/**
 * Merge locally-stored enriched web records into the live articles array.
 * - Live articles win on URL/title collision (no double-counting).
 * - Stored-only items are appended, newest publishedAt first, capped at
 *   `limit` total articles.
 * - Throws only if the local store is down — the route catches and
 *   degrades to live-only, so news never fails the request.
 */
export async function mergeWithStoredArticles(
  liveArticles: any[],
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const sinceHours = opts.sinceHours ?? 48;

  const stored = await getRecentRecords({ limit, sinceHours });
  const storedTotal = stored.length;

  const live = Array.isArray(liveArticles) ? liveArticles : [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  for (const a of live) {
    if (a?.url) seenUrls.add(normalizeUrl(String(a.url)));
    if (a?.title) seenTitles.add(normalizeTitle(String(a.title)));
  }

  const merged = [...live];
  let storedMerged = 0;

  for (const rec of stored) {
    if (merged.length >= limit) break;
    const u = normalizeUrl(rec.url);
    const t = normalizeTitle(rec.title);
    if ((u && seenUrls.has(u)) || (t && seenTitles.has(t))) continue; // live already covers it
    if (u) seenUrls.add(u);
    if (t) seenTitles.add(t);
    merged.push(recordToArticle(rec));
    storedMerged++;
  }

  // newest first, stable for already-sorted live input
  merged.sort((a, b) => {
    const ta = Date.parse(a?.publishedAt || '') || 0;
    const tb = Date.parse(b?.publishedAt || '') || 0;
    return tb - ta;
  });

  return { articles: merged.slice(0, limit), storedMerged, storedTotal };
}
