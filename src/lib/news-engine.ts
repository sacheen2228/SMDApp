// News Sentiment Engine for Indian Markets
// Fetches RSS feeds, scores sentiment, extracts stock entities

import {
  BULLISH_TERMS,
  BEARISH_TERMS,
  classifyEvent,
  extractStockEntities,
  extractSectorEntities,
  type EventClassification,
} from "./news-lexicon";

// ─── Types ──────────────────────────────────────────────────────
export interface NewsArticle {
  id: string;
  title: string;
  description: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: number;       // -1 to +1
  sentimentLabel: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;      // 0 to 1
  event: EventClassification;
  stockEntities: string[];
  sectorEntities: string[];
}

export interface StockSentiment {
  symbol: string;
  score: number;           // 0 to 100
  label: "STRONG_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG_BEARISH";
  articleCount: number;
  avgSentiment: number;
  topHeadline: string;
}

export interface MarketSentiment {
  overall: number;         // 0 to 100
  label: "EXTREME_FEAR" | "FEAR" | "NEUTRAL" | "GREED" | "EXTREME_GREED";
  vix: string;
  fiiFlow: string;
  topBullish: StockSentiment[];
  topBearish: StockSentiment[];
  sectorSentiment: Record<string, number>;
  articles: NewsArticle[];
  timestamp: string;
}

// ─── RSS Feed Sources ───────────────────────────────────────────
const RSS_FEEDS = [
  { name: "Moneycontrol", url: "https://www.moneycontrol.com/rss/marketstrends.xml", weight: 1.0 },
  { name: "Economic Times", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", weight: 0.9 },
  { name: "LiveMint", url: "https://www.livemint.com/rss/markets", weight: 0.9 },
  { name: "NDTV Profit", url: "https://feeds.feedburner.com/ndtvprofit-latest", weight: 0.8 },
  { name: "Google News", url: "https://news.google.com/rss/search?q=indian+stock+market+NSE+BSE&hl=en-IN&gl=IN&ceid=IN:en", weight: 0.7 },
  { name: "Google Finance", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnpHZ0pOV0NBTXAB?hl=en-IN&gl=IN&ceid=IN:en", weight: 0.8 },
];

// ─── Simple VADER-like Sentiment Scorer ─────────────────────────
function computeSentiment(text: string): { score: number; confidence: number } {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  let posScore = 0;
  let negScore = 0;
  let matches = 0;

  // Check bullish terms
  for (const [term, score] of Object.entries(BULLISH_TERMS)) {
    if (lower.includes(term)) {
      posScore += score;
      matches++;
    }
  }

  // Check bearish terms
  for (const [term, score] of Object.entries(BEARISH_TERMS)) {
    if (lower.includes(term)) {
      negScore += Math.abs(score);
      matches++;
    }
  }

  // Boost/exhaustion: cap extreme scores
  const raw = posScore - negScore;
  const magnitude = posScore + negScore;

  // Normalize to -1 to 1
  let sentiment = 0;
  if (magnitude > 0) {
    sentiment = Math.max(-1, Math.min(1, raw / Math.max(magnitude, 1)));
  }

  // Confidence based on match count and text length
  const confidence = Math.min(1, matches * 0.15 + (words.length > 10 ? 0.2 : 0));

  return { score: sentiment, confidence };
}

// ─── RSS XML Parser (no external dependencies) ──────────────────
function parseRSSItems(xml: string, sourceName: string): { title: string; description: string; link: string; pubDate: string }[] {
  const items: { title: string; description: string; link: string; pubDate: string }[] = [];

  // Match <item> blocks
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = extractTag(itemXml, "title");
    const description = extractTag(itemXml, "description");
    const link = extractTag(itemXml, "link");
    const pubDate = extractTag(itemXml, "pubDate");

    if (title) {
      items.push({
        title: decodeHTMLEntities(stripHTML(title)),
        description: decodeHTMLEntities(stripHTML(description || "")),
        link: link || "",
        pubDate: pubDate || new Date().toISOString(),
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim() || "";
}

function stripHTML(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#\d+;/g, "");
}

// ─── RSS Fetcher ────────────────────────────────────────────────
async function fetchRSSFeed(feed: { name: string; url: string; weight: number }): Promise<NewsArticle[]> {
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(8000),
      headers: { "Accept": "application/rss+xml, application/xml, text/xml" },
    });

    if (!res.ok) return [];

    const xml = await res.text();
    const items = parseRSSItems(xml, feed.name);

    return items.slice(0, 15).map((item, idx) => {
      const combinedText = `${item.title} ${item.description}`;
      const sentiment = computeSentiment(combinedText);
      const event = classifyEvent(item.title);
      const stockEntities = extractStockEntities(combinedText);
      const sectorEntities = extractSectorEntities(combinedText);

      // Blend lexicon sentiment with event bias
      const blendedScore = event.confidence > 0.5
        ? (sentiment.score * 0.6 + event.sentimentBias * 0.4)
        : sentiment.score;

      const clamped = Math.max(-1, Math.min(1, blendedScore));
      const label = clamped > 0.3 ? "BULLISH" : clamped < -0.3 ? "BEARISH" : "NEUTRAL";

      return {
        id: `${feed.name}-${idx}-${Date.now()}`,
        title: item.title,
        description: item.description,
        source: feed.name,
        url: item.link,
        publishedAt: item.pubDate,
        sentiment: Math.round(clamped * 100) / 100,
        sentimentLabel: label,
        confidence: Math.round(sentiment.confidence * 100) / 100,
        event,
        stockEntities,
        sectorEntities,
      };
    });
  } catch (error) {
    return [];
  }
}

// ─── Market-Wide Sentiment Analysis ─────────────────────────────
function analyzeMarketSentiment(articles: NewsArticle[]): MarketSentiment {
  if (articles.length === 0) {
    return {
      overall: 50,
      label: "NEUTRAL",
      vix: "N/A",
      fiiFlow: "N/A",
      topBullish: [],
      topBearish: [],
      sectorSentiment: {},
      articles: [],
      timestamp: new Date().toISOString(),
    };
  }

  // Overall sentiment
  const avgSentiment = articles.reduce((sum, a) => sum + a.sentiment, 0) / articles.length;
  const overallScore = Math.round((avgSentiment + 1) * 50); // -1..1 → 0..100

  let label: MarketSentiment["label"] = "NEUTRAL";
  if (overallScore >= 75) label = "EXTREME_GREED";
  else if (overallScore >= 60) label = "GREED";
  else if (overallScore <= 25) label = "EXTREME_FEAR";
  else if (overallScore <= 40) label = "FEAR";

  // Stock-level aggregation
  const stockMap = new Map<string, { sentiments: number[]; count: number; topHeadline: string }>();
  const sectorMap = new Map<string, number[]>();

for (const article of articles) {
      // Filter out sector entities from stock entities (they have _SECTOR_ prefix)
      const stockEntities = article.stockEntities.filter(s => !s.startsWith("_SECTOR_"));
      for (const stock of stockEntities) {
        const existing = stockMap.get(stock) || { sentiments: [], count: 0, topHeadline: "" };
        existing.sentiments.push(article.sentiment);
        existing.count++;
        if (!existing.topHeadline && article.sentiment !== 0) {
          existing.topHeadline = article.title;
        }
        stockMap.set(stock, existing);
      }

      // Combine explicit sector entities with sector-prefixed stock entities
      const sectorEntities = [
        ...article.sectorEntities,
        ...article.stockEntities.filter(s => s.startsWith("_SECTOR_")).map(s => s.replace("_SECTOR_", ""))
      ];
      for (const sector of sectorEntities) {
        const existing = sectorMap.get(sector) || [];
        existing.push(article.sentiment);
        sectorMap.set(sector, existing);
      }
    }

  // Convert to sorted arrays
  const stockSentiments: StockSentiment[] = Array.from(stockMap.entries()).map(([symbol, data]) => {
    const avg = data.sentiments.reduce((a, b) => a + b, 0) / data.sentiments.length;
    const score = Math.round((avg + 1) * 50);

    let stockLabel: StockSentiment["label"] = "NEUTRAL";
    if (score >= 70) stockLabel = "STRONG_BULLISH";
    else if (score >= 55) stockLabel = "BULLISH";
    else if (score <= 30) stockLabel = "STRONG_BEARISH";
    else if (score <= 45) stockLabel = "BEARISH";

    return {
      symbol,
      score,
      label: stockLabel,
      articleCount: data.count,
      avgSentiment: Math.round(avg * 100) / 100,
      topHeadline: data.topHeadline || articles[0]?.title || "",
    };
  }).sort((a, b) => b.avgSentiment - a.avgSentiment);

  const sectorSentiment: Record<string, number> = {};
  for (const [sector, sentiments] of sectorMap) {
    const avg = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;
    sectorSentiment[sector] = Math.round((avg + 1) * 50);
  }

  return {
    overall: overallScore,
    label,
    vix: "See market data",
    fiiFlow: "See fund flow",
    topBullish: stockSentiments.filter(s => s.score >= 50).slice(0, 5),
    topBearish: stockSentiments.filter(s => s.score < 50).sort((a, b) => a.score - b.score).slice(0, 5),
    sectorSentiment,
    articles: articles.slice(0, 50),
    timestamp: new Date().toISOString(),
  };
}

// ─── Main Public Function ───────────────────────────────────────
export async function fetchMarketNews(): Promise<MarketSentiment> {
  // Fetch all feeds in parallel with rate limiting
  const results = await Promise.allSettled(
    RSS_FEEDS.map(feed => fetchRSSFeed(feed))
  );

  const allArticles: NewsArticle[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
    }
  }

  // Deduplicate by title similarity
  const unique = deduplicateArticles(allArticles);

  // Sort by published date (newest first)
  unique.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  return analyzeMarketSentiment(unique);
}

// Fetch news for a specific stock
export async function fetchStockNews(symbol: string): Promise<NewsArticle[]> {
  const market = await fetchMarketNews();
  return market.articles.filter(a =>
    a.stockEntities.includes(symbol) ||
    a.title.toLowerCase().includes(symbol.toLowerCase())
  );
}

// Get news score for a stock (0-100) for scanner integration
export async function getNewsScore(symbol: string): Promise<number> {
  const articles = await fetchStockNews(symbol);
  if (articles.length === 0) return 50; // Neutral default

  const avg = articles.reduce((sum, a) => sum + a.sentiment, 0) / articles.length;
  return Math.round((avg + 1) * 50);
}

// ─── Deduplication ──────────────────────────────────────────────
function deduplicateArticles(articles: NewsArticle[]): NewsArticle[] {
  const seen = new Map<string, NewsArticle>();

  for (const article of articles) {
    const key = normalizeTitle(article.title);
    const existing = seen.get(key);
    if (!existing || article.source === "Moneycontrol") {
      seen.set(key, article);
    }
  }

  return Array.from(seen.values());
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// ─── Cache (2 minutes) ─────────────────────────────────────────
let newsCache: { data: MarketSentiment; timestamp: number } | null = null;
const CACHE_TTL = 2 * 60 * 1000;

export async function getCachedMarketNews(): Promise<MarketSentiment> {
  if (newsCache && Date.now() - newsCache.timestamp < CACHE_TTL) {
    return newsCache.data;
  }

  const data = await fetchMarketNews();
  newsCache = { data, timestamp: Date.now() };
  return data;
}
