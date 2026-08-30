// Market Regime API — Market regime, VIX, sentiment, trade environment
// Fallback chain: Moneycontrol → Yahoo Finance → skip for each index
// VIX: Yahoo Finance → hardcoded default (15)

import { NextResponse } from "next/server";
import { fetchWithFallback, FallbackSource } from "@/lib/fetch-with-fallback";

const INDICES = [
  { key: "NIFTY", yahoo: "^NSEI", mcId: "NIFTY 50", name: "NIFTY 50" },
  { key: "BANKNIFTY", yahoo: "^NSEBANK", mcId: "NIFTY Bank", name: "BANK NIFTY" },
  { key: "SENSEX", yahoo: "^BSESN", mcId: "SENSEX", name: "SENSEX" },
  { key: "FINNIFTY", yahoo: "^NSEMIDCAP", mcId: "", name: "FIN NIFTY" },
];

// Source A: Moneycontrol index price
async function fetchIndexMC(mcId: string): Promise<{ ltp: number; prev: number } | null> {
  const res = await fetch(`https://priceapi.moneycontrol.com/pricefeed/nse/index/${mcId}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== "200" || !json.data) return null;
  const ltp = parseFloat(json.data.pricecurrent) || 0;
  const prev = parseFloat(json.data.priceprevclose) || ltp;
  if (!ltp) return null;
  return { ltp, prev };
}

// Source B: Yahoo Finance index price
async function fetchIndexYahoo(yahooSymbol: string): Promise<{ ltp: number; prev: number } | null> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;
  return { ltp: meta.regularMarketPrice, prev: meta.chartPreviousClose || meta.regularMarketPrice };
}

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 60_000;

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Fetch each index with fallback chain
    const indexData: any[] = [];
    for (const idx of INDICES) {
      const sources: FallbackSource<{ ltp: number; prev: number }>[] = [];
      if (idx.mcId) {
        sources.push({ name: `MC:${idx.key}`, fetch: () => fetchIndexMC(idx.mcId) });
      }
      sources.push({ name: `YF:${idx.key}`, fetch: () => fetchIndexYahoo(idx.yahoo) });

      const { data } = await fetchWithFallback(sources);
      if (data) {
        indexData.push({
          key: idx.key,
          name: idx.name,
          ltp: data.ltp,
          change: parseFloat((data.ltp - data.prev).toFixed(2)),
          changePct: parseFloat((((data.ltp - data.prev) / data.prev) * 100).toFixed(2)),
          prevClose: data.prev,
        });
      }
    }

    // Fetch VIX: Yahoo Finance → hardcoded default
    let vix = { value: 15, change: 0 };
    const vixSources: FallbackSource<{ value: number; change: number }>[] = [
      {
        name: "YF:VIX",
        fetch: async () => {
          const res = await fetch(
            "https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?range=1d&interval=1d",
            { signal: AbortSignal.timeout(8000) },
          );
          if (!res.ok) return null;
          const data = await res.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta?.regularMarketPrice) return null;
          const prev = meta.chartPreviousClose || meta.regularMarketPrice;
          return {
            value: parseFloat(meta.regularMarketPrice.toFixed(2)),
            change: parseFloat((meta.regularMarketPrice - prev).toFixed(2)),
          };
        },
      },
    ];
    const { data: vixData } = await fetchWithFallback(vixSources);
    if (vixData) vix = vixData;

    // Determine regime
    const nifty = indexData.find(i => i.key === "NIFTY");
    const bankNifty = indexData.find(i => i.key === "BANKNIFTY");
    const avgChange = indexData.length > 0
      ? indexData.reduce((sum, i) => sum + i.changePct, 0) / indexData.length
      : 0;

    let regime: string;
    let bias: string;
    let tradeEnv: string;

    if (vix.value > 25) {
      regime = "HIGH VOLATILITY";
      bias = "NEUTRAL";
      tradeEnv = "CAUTION — REDUCE SIZE";
    } else if (avgChange > 1.5) {
      regime = "STRONG BULLISH";
      bias = "BULLISH";
      tradeEnv = "FAVOR LONGS";
    } else if (avgChange > 0.5) {
      regime = "BULLISH";
      bias = "BULLISH";
      tradeEnv = "FAVOR LONGS";
    } else if (avgChange > -0.5) {
      regime = "NEUTRAL";
      bias = "NEUTRAL";
      tradeEnv = "SELECTIVE — WAIT FOR CLARITY";
    } else if (avgChange > -1.5) {
      regime = "BEARISH";
      bias = "BEARISH";
      tradeEnv = "FAVOR SHORTS";
    } else {
      regime = "STRONG BEARISH";
      bias = "BEARISH";
      tradeEnv = "FAVOR SHORTS — DEFENSIVE";
    }

    // Market session
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hours = ist.getHours();
    const mins = ist.getMinutes();
    const day = ist.getDay();
    const timeNum = hours * 100 + mins;

    let session: string;
    if (day === 0 || day === 6) session = "CLOSED";
    else if (timeNum < 915) session = "PRE_OPEN";
    else if (timeNum < 930) session = "OPEN";
    else if (timeNum < 1530) session = "REGULAR";
    else if (timeNum < 1600) session = "POST_MARKET";
    else session = "CLOSED";

    const result = {
      regime,
      bias,
      tradeEnv,
      session,
      vix,
      indices: indexData,
      nifty: nifty?.ltp || 0,
      niftyChange: nifty?.changePct || 0,
      bankNifty: bankNifty?.ltp || 0,
      bankNiftyChange: bankNifty?.changePct || 0,
      avgIndexChange: parseFloat(avgChange.toFixed(2)),
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Regime fetch failed" }, { status: 500 });
  }
}
