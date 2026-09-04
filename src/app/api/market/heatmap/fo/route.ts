// Market Heatmap F&O Enrichment — Separate endpoint to avoid blocking main heatmap
// Fetches Index F&O + per-stock F&O data (PCR, OI, futures)
// Cached for 5 minutes — this is expensive (~20s for 47 stocks)

import { NextResponse } from "next/server";
import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";

const FO_STOCKS = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
  "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
  "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
  "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
  "ADANIPORTS","TECHM","HDFCLIFE","SBILIFE","BRITANNIA","CIPLA","DRREDDY",
  "DIVISLAB","EICHERMOT","GRASIM","HEROMOTOCO","HINDALCO","INDUSINDBK",
  "BAJAJFINSV","COALINDIA","BPCL","TRENT","APOLLOHOSP","LTIM","HDFCAMC","PIDILITIND",
];

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 300_000; // 5 min

async function fetchStockFOData(symbol: string): Promise<any> {
  try {
    const res = await fetch(`http://localhost:3000/api/option-chain?symbol=${symbol}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const raw = await res.json();
    const a = raw?.analysis;
    if (!a) return null;
    return {
      pcr: a.pcr || 0,
      totalCallOI: a.totalCallOI || 0,
      totalPutOI: a.totalPutOI || 0,
      maxPain: a.maxPain || 0,
      callWall: a.callWall || 0,
      putFloor: a.putFloor || 0,
      expiry: a.expiryDate || "",
      atmStrike: a.atmStrike || 0,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    // Return cached data if fresh
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // 1. Index F&O (NIFTY/BANKNIFTY/SENSEX)
    let indexFO: any[] = [];
    try {
      const ctx = await buildMarketIntelligenceContext();
      indexFO = [
        {
          symbol: "NIFTY",
          spot: ctx.nifty?.spot || 0,
          pcr: ctx.nifty?.pcr || 0,
          totalCallOI: ctx.nifty?.totalCallOI || 0,
          totalPutOI: ctx.nifty?.totalPutOI || 0,
          expiry: ctx.nifty?.expiry || "",
          maxPain: ctx.nifty?.maxPain || 0,
          callWall: ctx.nifty?.callWall || 0,
          putFloor: ctx.nifty?.putFloor || 0,
          futuresLtp: ctx.niftyFutures?.ltp || 0,
          futuresBasisPct: ctx.niftyFutures?.basisPercent || 0,
          futuresOI: ctx.niftyFutures?.oi || 0,
          futuresOIChange: ctx.niftyFutures?.oiChange || 0,
        },
        {
          symbol: "BANKNIFTY",
          spot: ctx.banknifty?.spot || 0,
          pcr: ctx.banknifty?.pcr || 0,
          totalCallOI: ctx.banknifty?.totalCallOI || 0,
          totalPutOI: ctx.banknifty?.totalPutOI || 0,
          expiry: ctx.banknifty?.expiry || "",
          maxPain: ctx.banknifty?.maxPain || 0,
          callWall: ctx.banknifty?.callWall || 0,
          putFloor: ctx.banknifty?.putFloor || 0,
          futuresLtp: ctx.bankniftyFutures?.ltp || 0,
          futuresBasisPct: ctx.bankniftyFutures?.basisPercent || 0,
          futuresOI: ctx.bankniftyFutures?.oi || 0,
          futuresOIChange: ctx.bankniftyFutures?.oiChange || 0,
        },
        {
          symbol: "SENSEX",
          spot: ctx.sensex?.spot || 0,
          pcr: ctx.sensex?.pcr || 0,
          totalCallOI: ctx.sensex?.totalCallOI || 0,
          totalPutOI: ctx.sensex?.totalPutOI || 0,
          expiry: ctx.sensex?.expiry || "",
          maxPain: ctx.sensex?.maxPain || 0,
          callWall: ctx.sensex?.callWall || 0,
          putFloor: ctx.sensex?.putFloor || 0,
          futuresLtp: ctx.sensexFutures?.ltp || 0,
          futuresBasisPct: ctx.sensexFutures?.basisPercent || 0,
          futuresOI: ctx.sensexFutures?.oi || 0,
          futuresOIChange: ctx.sensexFutures?.oiChange || 0,
        },
      ];
    } catch {}

    // 2. Per-stock F&O (batches of 5, ~20s total)
    const stockFO: Record<string, any> = {};
    for (let i = 0; i < FO_STOCKS.length; i += 5) {
      const batch = FO_STOCKS.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(fetchStockFOData));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "fulfilled" && (results[j] as any).value) {
          stockFO[batch[j]] = (results[j] as any).value;
        }
      }
      if (i + 5 < FO_STOCKS.length) await new Promise(r => setTimeout(r, 200));
    }

    const result = {
      indexFO,
      stockFO,
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "F&O fetch failed" }, { status: 500 });
  }
}
