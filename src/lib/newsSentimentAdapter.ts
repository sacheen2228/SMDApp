// lib/newsSentimentAdapter.ts
//
// Adapts the existing market news API (/api/news → MarketSentiment,
// per-symbol 0-100 scores, sector scores, article list with
// BULLISH/BEARISH/NEUTRAL tags) into the NewsSentiment shape
// (-1..+1) that tradeAlertEngine.ts expects.
//
// Nothing else in the engine needs to know about the API's actual
// response format — only this file does.

import type { NewsSentiment } from "./tradeAlertEngine";
import type { MarketSentiment, NewsArticle } from "./news-engine";

// ─── Raw shape we adapt into (kept for getSentimentForSymbol) ───
export interface NewsApiArticle {
  title: string;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  source: string;
  symbols?: string[]; // e.g. ["NIFTY", "SENSEX"], ["TCS", "LT"]
  tags?: string[];    // e.g. ["EARNINGS", "GOVT_POLICY"]
}

export interface NewsApiResponse {
  overallScore: number; // 0-100, 50 = neutral (your "Market Sentiment" gauge)
  perSymbolScore: Record<string, number>; // e.g. { TCS: 87, NIFTY: 62, HDFCBANK: 40 }
  perSectorScore: Record<string, number>; // e.g. { BANKING: 41, ENERGY: 50 }
  articles: NewsApiArticle[];
  lastUpdated: string;
}

// Map an index/stock symbol to the sector bucket your API uses, for
// fallback when there's no direct per-symbol score yet (e.g. BANKNIFTY
// itself might not have a row, but BANKING sector does).
const SYMBOL_TO_SECTOR: Record<string, string> = {
  BANKNIFTY: "BANKING",
  HDFCBANK: "BANKING",
  ICICIBANK: "BANKING",
  SBIN: "BANKING",
  AXISBANK: "BANKING",
  RELIANCE: "ENERGY",
  TATASTEEL: "METAL",
  LT: "INFRA",
};

function scoreToSigned(score: number): number {
  // 0-100, 50 neutral -> -1..+1
  return Math.max(-1, Math.min(1, (score - 50) / 50));
}

function findTopHeadline(articles: NewsApiArticle[], symbol: string): { title: string; source: string } | undefined {
  const relevant = articles.filter(a => a.symbols?.includes(symbol) && a.sentiment !== "NEUTRAL");
  const pick = relevant[0] ?? articles.find(a => a.symbols?.includes(symbol));
  return pick ? { title: pick.title, source: pick.source } : undefined;
}

/**
 * Get NewsSentiment for a specific tradeable symbol (index or stock).
 * Falls back: per-symbol score -> sector score -> overall market score.
 */
export function getSentimentForSymbol(api: NewsApiResponse, symbol: string): NewsSentiment {
  const sym = symbol.toUpperCase().replace(/\s+50$/, ""); // "NIFTY 50" -> "NIFTY"

  let score = api.perSymbolScore[sym];
  let source = "symbol";

  if (score == null) {
    const sector = SYMBOL_TO_SECTOR[sym];
    if (sector && api.perSectorScore[sector] != null) {
      score = api.perSectorScore[sector];
      source = `sector:${sector}`;
    }
  }

  if (score == null) {
    score = api.overallScore;
    source = "market-overall";
  }

  const headline = findTopHeadline(api.articles, sym);

  return {
    score: scoreToSigned(score),
    topHeadline: headline?.title,
    source: headline?.source ?? source,
  };
}

/**
 * Fetch + adapt in one call. Reads the existing /api/news endpoint
 * (MarketSentiment) and maps it into the NewsApiResponse shape the
 * rest of this module consumes.
 */
export async function fetchNewsSentiment(symbol: string, base = ""): Promise<NewsSentiment> {
  const BASE = process.env.INTERNAL_API_BASE || base || "";
  try {
    const res = await fetch(`${BASE}/api/news`, {
      // Cache briefly — the feed is refreshed periodically, no need to
      // refetch on every message.
      next: { revalidate: 120 },
    });
    if (!res.ok) throw new Error(`news API ${res.status}`);
    const json = await res.json();
    const market: MarketSentiment | undefined = json?.data;
    if (!market) return { score: 0 };

    const perSymbolScore: Record<string, number> = {};
    for (const s of [...(market.topBullish ?? []), ...(market.topBearish ?? [])]) {
      perSymbolScore[s.symbol] = s.score;
    }

    const api: NewsApiResponse = {
      overallScore: market.overall ?? 50,
      perSymbolScore,
      perSectorScore: market.sectorSentiment ?? {},
      articles: (market.articles ?? []).map((a: NewsArticle) => ({
        title: a.title,
        sentiment: (a.sentimentLabel ?? (a.sentiment > 0.2 ? "BULLISH" : a.sentiment < -0.2 ? "BEARISH" : "NEUTRAL")) as NewsApiArticle["sentiment"],
        source: a.source,
        symbols: a.stockEntities,
        tags: a.sectorEntities,
      })),
      lastUpdated: market.timestamp ?? new Date().toISOString(),
    };

    return getSentimentForSymbol(api, symbol);
  } catch (err) {
    console.error("[newsSentimentAdapter] falling back to neutral:", err);
    return { score: 0 };
  }
}

/**
 * Overall market mood string for chat replies, e.g. when SDM is asked
 * "how's the market feeling" rather than about a specific trade.
 */
export function describeMarketMood(api: NewsApiResponse): string {
  const s = api.overallScore;
  const label = s >= 70 ? "Extreme Greed" : s >= 55 ? "Greed" : s <= 30 ? "Extreme Fear" : s <= 45 ? "Fear" : "Neutral";
  return `Market sentiment: ${label} (${s}/100)`;
}
