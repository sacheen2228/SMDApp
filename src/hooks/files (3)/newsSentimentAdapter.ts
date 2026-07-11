// lib/newsSentimentAdapter.ts
//
// Adapts your existing news sentiment API (per-symbol 0-100 scores,
// sector scores, article list with BULLISH/BEARISH/NEUTRAL tags) into
// the NewsSentiment shape (-1..+1) that tradeAlertEngine.ts expects.
//
// Nothing else in the engine needs to know about your API's actual
// response format — only this file does.

import type { NewsSentiment } from "./tradeAlertEngine";

// ─── Raw shape of your news API's response (trim/extend to match exactly) ───
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
 * Fetch + adapt in one call. Point this at your actual news sentiment
 * endpoint — everything downstream (tradeAlertEngine, SDM chat,
 * Telegram) just consumes the returned NewsSentiment shape.
 */
export async function fetchNewsSentiment(symbol: string): Promise<NewsSentiment> {
  try {
    const res = await fetch(`${process.env.INTERNAL_API_BASE}/api/news-sentiment`, {
      // Cache briefly — your feed says "50 articles from RSS sources",
      // refreshed periodically, no need to refetch on every message.
      next: { revalidate: 120 },
    });
    if (!res.ok) throw new Error(`news-sentiment API ${res.status}`);
    const api: NewsApiResponse = await res.json();
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
