// Market Breadth API — Advance/Decline, % above MAs, new highs/lows
// Uses Yahoo Finance batch quotes for NIFTY 50 stocks

import { NextResponse } from "next/server";

const NIFTY50 = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
  "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
  "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
  "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
  "ADANIPORTS","TECHM","HDFCLIFE","SBILIFE","BRITANNIA","CIPLA","DRREDDY",
  "DIVISLAB","EICHERMOT","GRASIM","HEROMOTOCO","HINDALCO","INDUSINDBK",
  "BAJAJFINSV","COALINDIA","BPCL","TRENT","APOLLOHOSP","LTIM","HDFCAMC","PIDILITIND",
];

async function fetchStock(sym: string) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?range=1d&interval=1d`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const prev = meta.chartPreviousClose || meta.regularMarketPrice;
    const ltp = meta.regularMarketPrice;
    return {
      symbol: sym,
      ltp,
      change: ltp - prev,
      changePct: prev ? ((ltp - prev) / prev) * 100 : 0,
      volume: meta.regularMarketVolume || 0,
      prevClose: prev,
      dayHigh: meta.regularMarketDayHigh || ltp,
      dayLow: meta.regularMarketDayLow || ltp,
      weekHigh52: meta.fiftyTwoWeekHigh || ltp,
      weekLow52: meta.fiftyTwoWeekLow || ltp,
    };
  } catch { return null; }
}

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 60_000;

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Fetch ALL stocks in parallel
    const results = await Promise.allSettled(NIFTY50.map(fetchStock));
    const stocks = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value);

    if (stocks.length === 0) {
      return NextResponse.json({ error: "No live data available" }, { status: 503 });
    }

    const advances = stocks.filter(s => s.changePct > 0).length;
    const declines = stocks.filter(s => s.changePct < 0).length;
    const unchanged = stocks.filter(s => s.changePct === 0).length;
    const total = stocks.length;

    const newHighs = stocks.filter(s => s.ltp >= s.weekHigh52 * 0.99).length;
    const newLows = stocks.filter(s => s.ltp <= s.weekLow52 * 1.01).length;

    const volAdvancing = stocks.filter(s => s.changePct > 0).reduce((sum, s) => sum + s.volume, 0);
    const volDeclining = stocks.filter(s => s.changePct < 0).reduce((sum, s) => sum + s.volume, 0);

    const adRatio = declines > 0 ? advances / declines : advances > 0 ? 100 : 1;
    const adScore = Math.min(100, Math.round((adRatio / 3) * 100));
    const volScore = volDeclining > 0 ? Math.min(100, Math.round((volAdvancing / volDeclining) * 50)) : 50;
    const highLowScore = total > 0 ? Math.min(100, Math.round(((newHighs - newLows + total) / (2 * total)) * 100)) : 50;
    const breadthScore = Math.round(adScore * 0.4 + volScore * 0.3 + highLowScore * 0.3);

    const sorted = [...stocks].sort((a, b) => b.changePct - a.changePct);
    const topGainers = sorted.slice(0, 5).map(s => ({ symbol: s.symbol, changePct: parseFloat(s.changePct.toFixed(2)), ltp: s.ltp }));
    const topLosers = sorted.slice(-5).reverse().map(s => ({ symbol: s.symbol, changePct: parseFloat(s.changePct.toFixed(2)), ltp: s.ltp }));

    const result = {
      advances,
      declines,
      unchanged,
      total,
      adRatio: parseFloat(adRatio.toFixed(2)),
      breadthScore,
      adScore,
      volScore,
      highLowScore,
      newHighs,
      newLows,
      volAdvancing,
      volDeclining,
      volRatio: volDeclining > 0 ? parseFloat((volAdvancing / volDeclining).toFixed(2)) : 1,
      topGainers,
      topLosers,
      stocks,
      label: breadthScore >= 70 ? "STRONG" : breadthScore >= 50 ? "MODERATE" : breadthScore >= 30 ? "WEAK" : "VERY WEAK",
      bias: advances > declines * 1.5 ? "BULLISH" : declines > advances * 1.5 ? "BEARISH" : "NEUTRAL",
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Breadth fetch failed" }, { status: 500 });
  }
}
