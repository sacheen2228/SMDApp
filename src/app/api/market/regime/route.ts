// Market Regime API — Market regime, VIX, sentiment, trade environment
// Uses Yahoo Finance for indices + VIX

import { NextResponse } from "next/server";

const INDICES = [
  { key: "NIFTY", yahoo: "^NSEI", name: "NIFTY 50" },
  { key: "BANKNIFTY", yahoo: "^NSEBANK", name: "BANK NIFTY" },
  { key: "SENSEX", yahoo: "^BSESN", name: "SENSEX" },
  { key: "FINNIFTY", yahoo: "^NSEMIDCAP", name: "FIN NIFTY" },
];

let lastReq = 0;
async function rlFetch(url: string) {
  const wait = Math.max(0, 2000 - (Date.now() - lastReq));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastReq = Date.now();
  return fetch(url, { signal: AbortSignal.timeout(10000) });
}

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 60_000;

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Fetch all indices
    const indexData: any[] = [];
    for (const idx of INDICES) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(idx.yahoo)}?range=1d&interval=1d`;
        const res = await rlFetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) continue;
        const prev = meta.chartPreviousClose || meta.regularMarketPrice;
        const ltp = meta.regularMarketPrice;
        indexData.push({
          key: idx.key,
          name: idx.name,
          ltp,
          change: parseFloat((ltp - prev).toFixed(2)),
          changePct: parseFloat((((ltp - prev) / prev) * 100).toFixed(2)),
          prevClose: prev,
        });
      } catch { /* skip */ }
    }

    // Fetch VIX
    let vix = { value: 15, change: 0 };
    try {
      const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?range=1d&interval=1d";
      const res = await rlFetch(url);
      if (res.ok) {
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          const prev = meta.chartPreviousClose || meta.regularMarketPrice;
          vix = {
            value: parseFloat(meta.regularMarketPrice.toFixed(2)),
            change: parseFloat((meta.regularMarketPrice - prev).toFixed(2)),
          };
        }
      }
    } catch { /* use default */ }

    // Determine regime from index performance
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
