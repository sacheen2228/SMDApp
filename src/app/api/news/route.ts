// News API Endpoint
// Returns market-wide sentiment + per-stock news
//
// Honesty notes (2026-10-20 audit):
//   • The route advertised "Yahoo Finance" as its default source and
//     reported `source: "Yahoo Finance"` even though every article came
//     from the RSS feeds. Yahoo is banned (SOP §1) — the label now names
//     the feed that actually answered.
//   • Articles without a publication date were stamped with "now", which
//     made undated headlines look brand new. The date is now null.
//   • A feed that returned nothing is reported as UNAVAILABLE with the
//     reason — the card never renders a sentiment score over zero articles.

import { NextRequest, NextResponse } from "next/server";
import { getCachedMarketNews } from "@/lib/news-engine";
import { analyzeSentiment } from "@/lib/sentiment-analyzer";
import { buildCardMeta, unavailableMeta } from "@/lib/data-freshness";

// ── Phase 5 Web Intelligence ────────────────────────────────────────────
// Stored web records are merged into the SAME articles array hermes already
// fetches (/api/news, zero extra fetches → ≤12 budget untouched). Evidence
// only: no order can be created from here, and market data sources
// (MOAPI/NSE/BSE/Breeze) are never touched by this layer.
let lastWebSyncAt = 0;
const WEB_SYNC_MIN_INTERVAL_MS = 60_000;

async function maybeSyncWebIntel(): Promise<void> {
  // Fire-and-forget: sync failure must NEVER block or fail /api/news.
  const now = Date.now();
  if (now - lastWebSyncAt < WEB_SYNC_MIN_INTERVAL_MS) return;
  lastWebSyncAt = now;
  try {
    const { syncWebIntel } = await import("@/lib/web-intel/sync");
    await syncWebIntel({ now });
  } catch (e: any) {
    console.warn("[WebIntel] background sync skipped:", String(e?.message ?? e));
  }
}

async function mergeWebIntel(articles: any[]): Promise<{ articles: any[]; meta: any }> {
  try {
    const { mergeWithStoredArticles } = await import("@/lib/web-intel/merge");
    const res = await mergeWithStoredArticles(articles, { limit: 50, sinceHours: 48 });
    return {
      articles: res.articles,
      meta: {
        storedMerged: res.storedMerged,
        storedTotal: res.storedTotal,
        evidenceOnly: true,
      },
    };
  } catch (e: any) {
    // Local store down → live-only. News never fails the request.
    console.warn("[WebIntel] merge skipped:", String(e?.message ?? e));
    return { articles, meta: { storedMerged: 0, storedTotal: 0, evidenceOnly: true } };
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");
    const source = searchParams.get("source"); // "x" | "rss"

    if (symbol) {
      // X (Twitter) buzz for a symbol — free Google News index source
      if (source === "x") {
        const { fetchXBuzz } = await import("@/lib/x-sentiment");
        const buzz = await fetchXBuzz(symbol);
        return NextResponse.json({
          success: true,
          symbol,
          source: "X (indexed posts)",
          x: buzz,
          count: buzz.tweetCount,
          timestamp: new Date().toISOString(),
        });
      }

      // Per-symbol news from the real RSS feeds.
      const news = await getStockNews(symbol);
      const articles = news.articles || [];
      const meta = articles.length
        ? buildCardMeta({
            source: "rss",
            providerTimestamp: newestPublishedAt(articles),
            ttlMs: 30 * 60_000,
          })
        : unavailableMeta("No RSS feed published a headline for this symbol.", "rss");
      return NextResponse.json({
        success: articles.length > 0,
        status: articles.length ? meta.status : "UNAVAILABLE",
        symbol,
        // The REAL source (the feeds that answered) — not "Yahoo Finance".
        source: articles.length ? sourceLabel(articles) : "none",
        meta,
        articles,
        count: articles.length,
        timestamp: new Date().toISOString(),
        fallback: news.fallback || false,
      });
    }

    // Fetch market-wide sentiment
    const sentiment = await getCachedMarketNews();

    // Background incremental sync (never blocks this response) + merge of
    // already-synced stored records into the articles list agents consume.
    maybeSyncWebIntel().catch(() => {});
    const merged = await mergeWebIntel(sentiment.articles || []);

    const articles = merged.articles;
    const meta = articles.length
      ? buildCardMeta({
          source: "rss",
          providerTimestamp: newestPublishedAt(articles),
          ttlMs: 30 * 60_000,
        })
      : unavailableMeta("No RSS feed answered — market sentiment unavailable.", "rss");

    return NextResponse.json({
      success: articles.length > 0,
      status: articles.length ? meta.status : "UNAVAILABLE",
      meta,
      source: articles.length ? sourceLabel(articles) : "none",
      // `data` holds the sentiment payload the UI reads (overall/label/…).
      data: { ...sentiment, articles, webIntel: merged.meta },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[News API] Error:", error);
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: error.message || "News fetch failed" },
      { status: 500 }
    );
  }
}

/** Newest publication date across the articles (null when undated). */
function newestPublishedAt(articles: any[]): Date | null {
  let newest: number | null = null;
  for (const a of articles) {
    const t = a?.publishedAt ? Date.parse(a.publishedAt) : NaN;
    if (Number.isFinite(t) && (newest == null || t > newest)) newest = t;
  }
  return newest ? new Date(newest) : null;
}

/** The feeds that actually answered. */
function sourceLabel(articles: any[]): string {
  const names = Array.from(new Set(articles.map((a) => a?.source).filter(Boolean))) as string[];
  if (!names.length) return "rss";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

// Get stock news from the RSS feeds
async function getStockNews(symbol: string): Promise<any> {
  return fetchRSSFeeds(symbol);
}

// Fetch news from multiple RSS feeds (reliable fallback)
async function fetchRSSFeeds(symbol: string): Promise<any> {
  const rssUrls = [
    { name: "Investing.com", url: "https://in.investing.com/rss/news.rss", pattern: "" },
    { name: "Moneycontrol", url: "https://www.moneycontrol.com/rss/marketstrends.xml", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "Economic Times", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "LiveMint", url: "https://www.livemint.com/rss/markets", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "Google Finance", url: `https://news.google.com/rss/search?q=${symbol}%20stock%20market%20India&hl=en-IN&gl=IN&ceid=IN:en`, pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "NDTV Profit", url: "https://feeds.feedburner.com/ndtvprofit-latest", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "Business Standard", url: `https://www.business-standard.com/rss/companies/${symbol.toLowerCase()}`, pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
  ];

  const articles: any[] = [];

  for (const feed of rssUrls) {
    try {
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/rss+xml, application/xml, text/xml",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) continue;

      const xml = await response.text();
      const parsed = parseRSSFeed(xml);

      for (const item of parsed) {
        // Filter by symbol if pattern provided
        if (feed.pattern && !new RegExp(feed.pattern, "i").test(item.title + " " + item.description)) {
          continue;
        }

        const s = analyzeSentiment(item.title + " " + (item.description || ""));
        articles.push({
          id: `rss-${feed.name}-${symbol}-${Date.now()}-${Math.random()}`,
          title: item.title,
          description: item.description || "",
          source: feed.name,
          url: item.link,
          // null when the feed carried no date — never "now".
          publishedAt: item.pubDate || null,
          sentiment: s.score,
          sentimentLabel: s.label,
          confidence: s.confidence,
          event: { type: s.eventType, sentimentBias: s.score, confidence: s.confidence },
          stockEntities: [symbol],
          sectorEntities: [],
        });
      }

      if (articles.length > 0) break; // Found articles, stop checking other feeds
    } catch (error) {
      console.warn(`[RSS Feed] ${feed.name} failed for ${symbol}:`, error);
    }
  }

  return { articles, fallback: articles.length === 0 };
}

// Legacy RSS fetch for market-wide news (simplified)
async function fetchRSSFeedsForMarket(): Promise<any> {
  const feedUrls = [
    "https://in.investing.com/rss/news.rss",
    "https://www.moneycontrol.com/rss/marketstrends.xml",
    "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
    "https://www.livemint.com/rss/markets",
    "https://news.google.com/rss/search?q=indian+stock+market+NSE+BSE&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnpHZ0pOV0NBTXAB?hl=en-IN&gl=IN&ceid=IN:en",
  ];

  const allArticles: any[] = [];

  for (const url of feedUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/rss+xml, application/xml, text/xml",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) continue;

      const xml = await response.text();
      const items = parseRSSFeed(xml);
      allArticles.push(...items);
    } catch (error) {
      console.warn(`[Market RSS] Failed for ${url}:`, error);
    }
  }

  return allArticles;
}

// Parse RSS XML to extract items
function parseRSSFeed(xml: string): any[] {
  const items: any[] = [];

  // Match <item> blocks
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];

    const title = extractTag(itemXml, "title");
    if (!title) continue;

    const description = extractTag(itemXml, "description") || "";
    const link = extractTag(itemXml, "link") || "";
    const pubDate = extractTag(itemXml, "pubDate");

    items.push({
      title: decodeHTMLEntities(stripHTML(title)),
      description: decodeHTMLEntities(stripHTML(description)),
      link: link,
      // Keep the RAW date; "" means the feed carried none.
      pubDate: pubDate || "",
    });
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\/${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim() || "";
}

function stripHTML(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\\s+/g, " ").trim();
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;#(\d+);/g, "");
}
