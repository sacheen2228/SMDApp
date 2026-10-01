// ─── X (Twitter) Market Sentiment — FREE source ──────────────────────
// Real indexed X posts for Indian markets, fetched via Google News RSS
// (`site:x.com` queries — Google indexes popular public tweets as news
// cards). No API key, no fake data: fetch/empty failure → available:false.
// Scores use the same deterministic keyword analyzer as the news engine.
//
// Limitations (honest): covers tweets Google chose to index (larger
// accounts), no engagement metrics, ~1-day recency window via when:1d.
// If X_BEARER_TOKEN is added later, swap fetchXFeed internals only —
// parse/aggregate/contract stay unchanged.

import { analyzeSentiment } from "./sentiment-analyzer";
import { parseRSSItems } from "./news-engine";

export interface XTweet {
  text: string;
  author: string | null; // @handle when present in the post text
  link: string;
  publishedAt: string;
  score: number; // -1..1
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
}

export interface XBuzz {
  available: boolean;
  source: "google-news-x";
  score: number; // 0..100 (50 = neutral); 0 when unavailable
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
  tweetCount: number;
  avgSentiment: number; // -1..1
  samples: XTweet[]; // top 5 by |score|
  fetchedAt: string;
  reason?: string; // present when available=false
}

const SOURCE = "google-news-x" as const;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_MAX_AGE_DAYS = 3;
const PROFILE_ITEM_REGEX = /^.{0,60}\(@\w+\)\s*-\s*x\.com$/i;
const AUTHOR_SUFFIX_REGEX = /\s\(@(\w+)\)\s*-\s*x\.com$/i;
const TRAILING_SOURCE_REGEX = /\s+-\s+x\.com$/i;

// ─── Pure parsing / aggregation (tested) ─────────────────────────

export function parseXItems(
  xml: string,
  opts: { maxAgeDays?: number } = {}
): XTweet[] {
  if (!xml || typeof xml !== "string" || !xml.includes("<item")) return [];
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const cutoff = Date.now() - maxAgeDays * 86400_000;

  const items = parseRSSItems(xml, SOURCE);
  const tweets: XTweet[] = [];

  for (const item of items) {
    const title = item.title?.trim();
    if (!title) continue;

    // Author-profile cards ("Name (@handle) - x.com") are not tweets
    if (PROFILE_ITEM_REGEX.test(title)) continue;

    // Reject stale items (defensive — URL already has when:1d)
    const ts = new Date(item.pubDate || "").getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;

    let author: string | null = null;
    let text = title;
    const authorMatch = title.match(AUTHOR_SUFFIX_REGEX);
    if (authorMatch) {
      author = `@${authorMatch[1]}`;
      text = title.slice(0, authorMatch.index).trim();
    } else if (TRAILING_SOURCE_REGEX.test(title)) {
      text = title.replace(TRAILING_SOURCE_REGEX, "").trim();
    }
    if (text.length < 15) continue; // too short to carry signal

    const sentiment = analyzeSentiment(text);
    tweets.push({
      text,
      author,
      link: item.link || "",
      publishedAt: new Date(ts).toISOString(),
      score: sentiment.score,
      label: sentiment.label,
    });
  }

  return tweets;
}

export function aggregateTweets(tweets: XTweet[]): XBuzz {
  const base: XBuzz = {
    available: false,
    source: SOURCE,
    score: 0,
    label: "NEUTRAL",
    tweetCount: tweets.length,
    avgSentiment: 0,
    samples: [],
    fetchedAt: new Date().toISOString(),
  };

  if (tweets.length === 0) {
    return { ...base, reason: "no recent indexed X posts for this query" };
  }

  const avg = tweets.reduce((sum, t) => sum + t.score, 0) / tweets.length;
  const score = Math.round((avg + 1) * 50);
  const label: XBuzz["label"] = avg > 0.1 ? "BULLISH" : avg < -0.1 ? "BEARISH" : "NEUTRAL";

  const samples = [...tweets]
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5);

  return {
    ...base,
    available: true,
    score,
    label,
    avgSentiment: Math.round(avg * 100) / 100,
    samples,
  };
}

// ─── Network fetch + cache ────────────────────────────────────────

function buildQuery(symbol?: string): string {
  if (symbol) {
    return `site:x.com "${symbol}" (stock OR shares OR target OR results) when:1d`;
  }
  return `site:x.com (Nifty OR Sensex OR "Indian stock market" OR SEBI OR FII DII) when:1d`;
}

function unavailable(reason: string): XBuzz {
  return {
    available: false,
    source: SOURCE,
    score: 0,
    label: "NEUTRAL",
    tweetCount: 0,
    avgSentiment: 0,
    samples: [],
    fetchedAt: new Date().toISOString(),
    reason,
  };
}

const cache = new Map<string, { data: XBuzz; ts: number }>();

export function clearXCache(): void {
  cache.clear();
}

export async function fetchXBuzz(symbol?: string): Promise<XBuzz> {
  const key = symbol ? `sym:${symbol}` : "market";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  let data: XBuzz;
  try {
    const q = buildQuery(symbol);
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
    });
    if (!res.ok) {
      data = unavailable(`google-news RSS HTTP ${res.status}`);
    } else {
      const xml = await res.text();
      const tweets = parseXItems(xml);
      data = aggregateTweets(tweets);
    }
  } catch (e: any) {
    data = unavailable(`fetch failed: ${String(e?.message || e).slice(0, 120)}`);
  }

  cache.set(key, { data, ts: Date.now() });
  return data;
}
