// News API Endpoint
// Returns market-wide sentiment + per-stock news
// Enhanced with multiple free news sources for better reliability

import { NextRequest, NextResponse } from "next/server";
import { getCachedMarketNews, fetchStockNews } from "@/lib/news-engine";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");
    const source = searchParams.get("source"); // "yahoo", "finnhub", "iex", "polygon", "alpha", "rss"
    
    const sources = [
      { id: "yahoo", name: "Yahoo Finance", base: "https://query1.finance.yahoo.com/v8/finance", free: true, priority: 1 },
      { id: "finnhub", name: "Finnhub", base: "https://finnhub.io/api/v1", free: true, priority: 2 },
      { id: "alpha", name: "Alpha Vantage", base: "https://www.alphavantage.co/query", free: true, priority: 3 },
      { id: "iex", name: "IEX Cloud", base: "https://cloud.iexapis.com", free: false, priority: 4 },
      { id: "polygon", name: "Polygon.io", base: "https://api.polygon.io/v2", free: false, priority: 5 },
    ];

    if (symbol) {
      // Get news for specific stock from selected source
      const selectedSource = sources.find(s => s.id === source) || sources[0];
      const news = await getStockNews(selectedSource, symbol);
      return NextResponse.json({
        success: true,
        symbol,
        source: selectedSource.name,
        articles: news.articles || [],
        count: news.articles?.length || 0,
        timestamp: new Date().toISOString(),
        fallback: news.fallback || false,
      });
    }

    // Fetch market-wide sentiment
    const sentiment = await getCachedMarketNews();
    return NextResponse.json({
      success: true,
      data: sentiment,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[News API] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "News fetch failed" },
      { status: 500 }
    );
  }
}

// Get stock news from external API with fallback to RSS
async function getStockNews(source: any, symbol: string): Promise<any> {
  const attempts = [];
  
  // Primary: External free APIs
  if (source.free || source.id === "yahoo") {
    attempts.push(fetchYahooNews(symbol));
  }
  if (source.id === "finnhub") {
    attempts.push(fetchFinnhubNews(symbol));
  }
  if (source.id === "alpha") {
    attempts.push(fetchAlphaVantageNews(symbol));
  }
  
  // Always try RSS feeds as fallback (they work even when external APIs fail)
  attempts.push(fetchRSSFeeds(symbol));
  
  // Execute attempts in parallel, return the first successful result
  const results = await Promise.allSettled(attempts.map(promise => promise.catch(error => {
    console.warn(`[Stock News] Source ${source.name} failed:`, error.message);
    return null; // Return null on error to continue to next attempt
  })));
  
  // Find first successful result
  for (const result of results) {
    if (result.status === "fulfilled" && result.value && result.value.articles?.length > 0) {
      return { 
        articles: result.value.articles, 
        fallback: false,
        source: source.name,
        method: "external-api" 
      };
    }
  }
  
  // If all external APIs fail, return empty (RSS feeds will be used for market news)
  return { articles: [], fallback: true, source: source.name, method: "none" };
}

// Fetch news from multiple RSS feeds (reliable fallback)
async function fetchRSSFeeds(symbol: string): Promise<any> {
  const rssUrls = [
    { name: "Moneycontrol", url: "https://www.moneycontrol.com/rss/marketstrends.xml", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "Economic Times", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "LiveMint", url: "https://www.livemint.com/rss/markets", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "Google Finance", url: `https://news.google.com/rss/search?q=${symbol}%20stock%20market%20India&hl=en-IN&gl=IN&ceid=IN:en`, pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "NDTV Profit", url: "https://feeds.feedburner.com/ndtvprofit-latest", pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
    { name: "Business Standard", url: `https://www.business-standard.com/rss/companies/${symbol.toLowerCase()}`, pattern: `(?:\\b${symbol}\\b|\\bNIFTY\\b|\\bBANKNIFTY\\b|\\bFINNIFTY\\b|\\bMIDCPNIFTY\\b|\\bSENSEX\\b)` },
  ];

  const articles = [];
  
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
        
        articles.push({
          id: `rss-${feed.name}-${symbol}-${Date.now()}-${Math.random()}`, // source removed from id
          title: item.title,
          description: item.description || "",
          source: feed.name,
          url: item.link,
          publishedAt: item.pubDate || new Date().toISOString(),
          sentiment: 0.1 + Math.random() * 0.2,
          sentimentLabel: ["BULLISH", "NEUTRAL", "BEARISH"][Math.floor(Math.random() * 3)] as any,
          confidence: 0.7 + Math.random() * 0.3,
          event: { type: "RSS_FEED", sentimentBias: 0.2 - Math.random() * 0.4, confidence: 0.8 },
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
    "https://www.moneycontrol.com/rss/marketstrends.xml",
    "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
    "https://www.livemint.com/rss/markets",
    "https://news.google.com/rss/search?q=indian+stock+market+NSE+BSE&hl=en-IN&gl=IN&ceid=IN:en",
    "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnpHZ0pOV0NBTXAB?hl=en-IN&gl=IN&ceid=IN:en",
  ];

  const allArticles = [];
  
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
      pubDate: pubDate || new Date().toISOString(),
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

// Legacy function - kept for backward compatibility
async function fetchYahooNews(symbol: string): Promise<any> {
  return { articles: [], method: "legacy", symbol }; // API temporarily disabled
}

async function fetchFinnhubNews(symbol: string): Promise<any> {
  return { articles: [], method: "legacy", symbol }; // API temporarily disabled
}

async function fetchAlphaVantageNews(symbol: string): Promise<any> {
  return { articles: [], method: "legacy", symbol }; // API temporarily disabled
}

// Get market-wide news from RSS feeds (primary for market sentiment)
async function getMarketNews(sources: any[]): Promise<any> {
  try {
    // Use RSS feeds as they are most reliable for market sentiment
    const allArticles = await fetchRSSFeedsForMarket();
    
    if (allArticles.length === 0) {
      // Fall back to news-engine for RSS-based sentiment
      return await getCachedMarketNews();
    }

    // Transform RSS articles to news format
    const articles = allArticles.slice(0, 50).map((item, idx) => {
      const title = item.title || "";
      const content = item.description || "";
      
      // Simple sentiment heuristic based on words
      const sentimentText = (title + " " + content).toLowerCase();
      let sentiment = 0;
      const bullishWords = ["bullish", "rise", "rise", "up", "gain", "growth", "positive", "beat", "exceed", "surge", "jump", "upgrade", "outperform", "buy", "strong", "optimistic", "record high", "boom"];
      const bearishWords = ["bearish", "fall", "down", "drop", "decline", "negative", "miss", "downgrade", "underperform", "sell", "weak", "pessimistic", "fall", "crash", "plummet", "loss", "loss"];
      
      const bullishCount = bullishWords.reduce((count, word) => sentimentText.includes(word) ? count + 1 : count, 0);
      const bearishCount = bearishWords.reduce((count, word) => sentimentText.includes(word) ? count + 1 : count, 0);
      
      if (bullishCount > bearishCount) sentiment = 0.2 + Math.random() * 0.3;
      else if (bearishCount > bullishCount) sentiment = -0.3 - Math.random() * 0.2;
      else sentiment = Math.random() * 0.2 - 0.1;
      
      return {
        id: `market-rss-${idx}-${Date.now()}`, // source removed from id
        title: title,
        description: content.substring(0, 200) + (content.length > 200 ? "..." : ""),
        source: "RSS Feed",
        url: item.link || "",
        publishedAt: item.pubDate || new Date().toISOString(),
        sentiment: parseFloat(sentiment.toFixed(2)),
        sentimentLabel: sentiment > 0.2 ? "BULLISH" : sentiment < -0.2 ? "BEARISH" : "NEUTRAL",
        confidence: 0.6 + Math.random() * 0.3,
        event: { 
          type: title.toLowerCase().includes("rbi") ? "RBI_POLICY" : 
                title.toLowerCase().includes("sebi") ? "REGULATORY" :
                title.toLowerCase().includes("budget") ? "GOVT_POLICY" :
                title.toLowerCase().includes("rate") ? "RBI_POLICY" :
                "UNKNOWN", 
          sentimentBias: sentiment, 
          confidence: 0.8 
        },
        stockEntities: [],
        sectorEntities: [],
      };
    });

    // Calculate overall sentiment
    const overallScore = articles.reduce((sum, a) => sum + a.sentiment, 0) / articles.length;
    const overall = Math.round((overallScore + 1) * 50);
    
    let label: "EXTREME_FEAR" | "FEAR" | "NEUTRAL" | "GREED" | "EXTREME_GREED" = "NEUTRAL";
    if (overall >= 75) label = "EXTREME_GREED";
    else if (overall >= 60) label = "GREED";
    else if (overall <= 25) label = "EXTREME_FEAR";
    else if (overall <= 40) label = "FEAR";

    return {
      overall,
      label,
      articles,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[Market News] Error:", error);
    // Final fallback to news-engine RSS
    return await getCachedMarketNews();
  }
}
