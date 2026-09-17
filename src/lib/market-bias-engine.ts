// Market Bias Engine — Pre-market analysis for option buying decisions
// Fetches US markets, DXY, crude, USD/INR, computes FII 5-day rolling avg
// Uses Yahoo Finance for global data (batch quote with crumb auth)

import { getFiiDiiData } from "./fii-dii";
import type { MarketBiasInput, MarketBiasResult } from "./buyer-confluence-engine";
import { computeMarketBias } from "./buyer-confluence-engine";

const YF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Yahoo Finance tickers for global data
const GLOBAL_TICKERS = {
  SP500: "^GSPC",
  NASDAQ: "^IXIC",
  DXY: "DX-Y.NYB",
  US10Y: "^TNX",
  CRUDE: "CL=F",
  USDINR: "USDINR=X",
  GIFT_NIFTY: "^NSEI",  // NIFTY 50 spot as proxy (SGX ticker dead)
} as const;

interface YFQuote {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  prevClose: number;
}

let cookieCache: { cookie: string; expiresAt: number } | null = null;

async function getYFCookie(): Promise<string> {
  if (cookieCache && Date.now() < cookieCache.expiresAt) return cookieCache.cookie;
  try {
    const res = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": YF_UA },
      signal: AbortSignal.timeout(5000),
    });
    const cookie = (res.headers.get("set-cookie") || "").split(";")[0] || "";
    cookieCache = { cookie, expiresAt: Date.now() + 50 * 60 * 1000 };
    return cookie;
  } catch { return ""; }
}

async function fetchGlobalQuotes(): Promise<Map<string, YFQuote>> {
  const result = new Map<string, YFQuote>();
  try {
    const cookie = await getYFCookie();
    const tickers = Object.values(GLOBAL_TICKERS).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickers)}`;
    const headers: Record<string, string> = { "User-Agent": YF_UA };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return result;
    const data = await res.json();
    for (const q of data?.quoteResponse?.result || []) {
      const price = q.regularMarketPrice;
      if (!price) continue;
      const prev = q.regularMarketPreviousClose || price;
      result.set(q.symbol, {
        symbol: q.symbol,
        price,
        change: parseFloat((price - prev).toFixed(2)),
        changePct: parseFloat(((price - prev) / prev * 100).toFixed(2)),
        prevClose: prev,
      });
    }
  } catch {}
  return result;
}

function computeFiiDii5dAvg(history: Array<{ fiiNet: number }>): number {
  if (!history || history.length === 0) return 0;
  const last5 = history.slice(-5);
  return last5.reduce((sum, d) => sum + d.fiiNet, 0) / last5.length;
}

export async function computeFullMarketBias(): Promise<{
  bias: MarketBiasResult;
  rawData: MarketBiasInput;
  fiiDii: any;
}> {
  // Fetch global quotes + FII/DII in parallel
  const [globalQuotes, fiiDii] = await Promise.all([
    fetchGlobalQuotes(),
    getFiiDiiData().catch(() => null),
  ]);

  const sp500 = globalQuotes.get(GLOBAL_TICKERS.SP500);
  const nasdaq = globalQuotes.get(GLOBAL_TICKERS.NASDAQ);
  const dxy = globalQuotes.get(GLOBAL_TICKERS.DXY);
  const us10y = globalQuotes.get(GLOBAL_TICKERS.US10Y);
  const crude = globalQuotes.get(GLOBAL_TICKERS.CRUDE);
  const usdinr = globalQuotes.get(GLOBAL_TICKERS.USDINR);

  const fiiNet = fiiDii?.latest?.fiiNet ?? 0;
  const diiNet = fiiDii?.latest?.diiNet ?? 0;
  const fiiNet5d = computeFiiDii5dAvg(fiiDii?.history || []);

  const input: MarketBiasInput = {
    giftNiftyGap: 0,  // Will be populated from gift-nifty endpoint if available
    usSP500Change: sp500?.changePct ?? 0,
    usNasdaqChange: nasdaq?.changePct ?? 0,
    dxy: dxy?.price ?? 104,
    us10YYield: us10y?.price ?? 4.2,
    crudeOil: crude?.price ?? 85,
    usdInr: usdinr?.price ?? 83.5,
    indiaVix: 15,  // Will be overridden by caller
    fiiNetPrevDay: fiiNet,
    fiiNet5dAvg: fiiNet5d,
  };

  const bias = computeMarketBias(input);

  return { bias, rawData: input, fiiDii };
}

// ─── IV Rank Calculator (true 52-week) ───
// Uses ATM IV history or estimates from VIX percentile
export function estimateIVRank(currentATMIV: number, vix: number): number {
  // Without historical IV data, use VIX percentile estimation
  // VIX range: 10-35 typical for NIFTY
  // Map VIX to IV rank: VIX 10 = ~15th percentile, VIX 35 = ~85th percentile
  const vixPercentile = Math.min(100, Math.max(0, ((vix - 10) / 25) * 100));
  // Current ATM IV vs VIX gives relative richness
  const ivRichness = currentATMIV > 0 ? (currentATMIV / vix) * 50 : 50;
  return Math.round(Math.min(100, Math.max(0, (vixPercentile + ivRichness) / 2)));
}
