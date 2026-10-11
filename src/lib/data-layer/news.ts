// News module — SMDApp central data layer
// Single path for market + per-stock news/sentiment.
// Reads from the enriched Prisma WebRecord store (written by web-intel sync).
// Enrichment: news-lexicon (classifyEvent, extractStockEntities, extractSectorEntities)
//   + sentiment-analyzer (analyzeSentiment).
// This module ONLY reads from the enriched store; it never fetches the web
// itself. The Scrapling collector remains evidenceOnly.
//
// Invariants:
//   • source  = provider feed name (e.g. 'moneycontrol', 'et', 'google')
//   • fallbackUsed  tracks whether the article was backfilled (>6h gap)
//   • every article carries publishedAt (original), collectedAt, freshness
//   • agents receive sentiment label/score via AgentContextFragment.newsSentiment

import type { DataProvenance } from '@/lib/data-layer/types';
import { analyzeSentiment } from '@/lib/sentiment-analyzer';
import { detectNewsCategory, detectNewsSector, extractNewsEntities } from '@/lib/hermes/news-intelligence';

// ── Enriched news item shape ──────────────────────────────────────────

export interface EnrichedNewsItem {
  id: string;
  title: string;
  description: string;
  publishedAt: string;     // ORIGINAL — never rewritten
  collectedAt: string;     // when fetched
  source: string;
  url: string;
  sentimentScore: number;  // -1..+1 from sentiment-analyzer
  sentimentLabel: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  eventType: string;       // from classifyEvent
  stockEntities: string[];
  sectorEntities: string[];
  provenance: DataProvenance;
  fallbackUsed: boolean;
}

// ── Fetch newest N enriched records from Prisma WebRecord ─────────────

export async function getRecentNews(limit = 50): Promise<EnrichedNewsItem[]> {
  try {
    const { getRecentRecords } = await import('@/lib/web-intel/store');
    const records = await getRecentRecords({ limit });
    return records.map((r) => {
      const backfilled = r.backfilled ||
        Date.parse(r.collectedAt) - Date.parse(r.publishedAt) > 6 * 3600_000;
      const provenance: DataProvenance = {
        source: r.sourceFeed || r.source,
        publishedAt: r.publishedAt,
        collectedAt: r.collectedAt,
        fallbackUsed: backfilled,
      };
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        publishedAt: r.publishedAt,
        collectedAt: r.collectedAt,
        source: r.sourceFeed || r.source,
        url: r.url,
        sentimentScore: r.sentiment,
        sentimentLabel: r.sentimentLabel as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
        eventType: r.eventType,
        stockEntities: r.symbols,
        sectorEntities: [],
        provenance,
        fallbackUsed: backfilled,
      };
    });
  } catch {
    return [];
  }
}

// ── Enrich a raw RSS/Atom item into the canonical EnrichedNewsItem ────

export function enrichNewsItem(
  raw: {
    id: string;
    title: string;
    description?: string;
    url: string;
    published_at?: string;
    collected_at?: string;
    source_feed?: string;
    provenance?: string;
  },
  now = Date.now(),
): EnrichedNewsItem {
  const publishedAt = raw.published_at ?? new Date(now).toISOString();
  const collectedAt = raw.collected_at ?? new Date(now).toISOString();
  const provenance: DataProvenance = {
    source: raw.source_feed ?? 'unknown',
    publishedAt,
    collectedAt,
    fallbackUsed: false,
  };

  const backfilled =
    Date.parse(collectedAt) - Date.parse(publishedAt) > 6 * 3600_000;

  const text = `${raw.title} ${raw.description || ''}`;
  const upper = text.toUpperCase();

  const sent = analyzeSentiment(text);
  const sentimentScore = sent.score;
  const sentimentLabel = sent.label as 'BULLISH' | 'BEARISH' | 'NEUTRAL';

  const eventType = detectNewsCategory(raw.title);

  const stockEntities = extractNewsEntities(upper);
  const sectorEntities = [detectNewsSector(upper, stockEntities)].filter(Boolean);

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description || '',
    publishedAt,
    collectedAt,
    source: provenance.source,
    url: raw.url,
    sentimentScore,
    sentimentLabel,
    eventType,
    stockEntities,
    sectorEntities,
    provenance,
    fallbackUsed: backfilled,
  };
}

// ── Build AgentContextFragment.newsSentiment from enriched items ──────

export function buildNewsSentiment(items: EnrichedNewsItem[]): {
  label: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
  timestamp: string;
} {
  if (items.length === 0) {
    return { label: 'NEUTRAL', score: 0, timestamp: new Date().toISOString() };
  }

  const total = items.reduce((sum, it) => sum + it.sentimentScore, 0);
  const avg = total / items.length;

  const label = avg > 0.1 ? 'BULLISH' : avg < -0.1 ? 'BEARISH' : 'NEUTRAL';
  return {
    label,
    score: Math.round(avg * 100) / 100,
    timestamp: items[0].collectedAt,
  };
}
