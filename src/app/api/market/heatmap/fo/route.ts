// Market Heatmap F&O Enrichment — Separate endpoint to avoid blocking main heatmap
// Fetches Index F&O + per-stock F&O data (PCR, OI, futures)
// Cached for 5 minutes — this is expensive (~20s for 47 stocks)
//
// Honesty note (2026-10-20 audit): every field used to be coerced with
// `|| 0`, so a chain that carried no max pain / call wall / futures data was
// rendered as "max pain 0", "PCR 0", "futures OI 0" — numbers that look real
// and are not. Missing values are now null and the payload says which
// symbols actually resolved.

import { NextResponse } from "next/server";
import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { buildCardMeta, getMarketClock } from "@/lib/data-freshness";

const FO_STOCKS = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
  "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
  "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","WIPRO","M&M",
  "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
  "ADANIPORTS","TECHM","HDFCLIFE","SBILIFE","BRITANNIA","CIPLA","DRREDDY",
  "DIVISLAB","EICHERMOT","GRASIM","HEROMOTOCO","HINDALCO","INDUSINDBK",
  "BAJAJFINSV","COALINDIA","BPCL","TRENT","APOLLOHOSP","HDFCAMC","PIDILITIND",
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
    // null (not 0) for anything the chain did not publish.
    return {
      pcr: a.pcr ?? null,
      totalCallOI: a.totalCallOI ?? null,
      totalPutOI: a.totalPutOI ?? null,
      maxPain: a.maxPain ?? null,
      callWall: a.callWall ?? null,
      putFloor: a.putFloor ?? null,
      expiry: a.expiryDate || "",
      atmStrike: a.atmStrike ?? null,
      // Total OI — the F&O filters in the heatmap read `oi`/`oiChangePct`,
      // which this endpoint never provided (they always rendered 0).
      oi:
        a.totalCallOI != null && a.totalPutOI != null ? a.totalCallOI + a.totalPutOI : null,
      oiChangePct: a.oiChangePct ?? null,
      source: raw?.source || raw?.data?.source || "nse",
      fetchedAt: raw?.timestamp || new Date().toISOString(),
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
          spot: ctx.nifty?.spot ?? null,
          pcr: ctx.nifty?.pcr ?? null,
          totalCallOI: ctx.nifty?.totalCallOI ?? null,
          totalPutOI: ctx.nifty?.totalPutOI ?? null,
          expiry: ctx.nifty?.expiry || "",
          maxPain: ctx.nifty?.maxPain ?? null,
          callWall: ctx.nifty?.callWall ?? null,
          putFloor: ctx.nifty?.putFloor ?? null,
          futuresLtp: ctx.niftyFutures?.ltp ?? null,
          futuresBasisPct: ctx.niftyFutures?.basisPercent ?? null,
          futuresOI: ctx.niftyFutures?.oi ?? null,
          futuresOIChange: ctx.niftyFutures?.oiChange ?? null,
        },
        {
          symbol: "BANKNIFTY",
          spot: ctx.banknifty?.spot ?? null,
          pcr: ctx.banknifty?.pcr ?? null,
          totalCallOI: ctx.banknifty?.totalCallOI ?? null,
          totalPutOI: ctx.banknifty?.totalPutOI ?? null,
          expiry: ctx.banknifty?.expiry || "",
          maxPain: ctx.banknifty?.maxPain ?? null,
          callWall: ctx.banknifty?.callWall ?? null,
          putFloor: ctx.banknifty?.putFloor ?? null,
          futuresLtp: ctx.bankniftyFutures?.ltp ?? null,
          futuresBasisPct: ctx.bankniftyFutures?.basisPercent ?? null,
          futuresOI: ctx.bankniftyFutures?.oi ?? null,
          futuresOIChange: ctx.bankniftyFutures?.oiChange ?? null,
        },
        {
          symbol: "SENSEX",
          spot: ctx.sensex?.spot ?? null,
          pcr: ctx.sensex?.pcr ?? null,
          totalCallOI: ctx.sensex?.totalCallOI ?? null,
          totalPutOI: ctx.sensex?.totalPutOI ?? null,
          expiry: ctx.sensex?.expiry || "",
          maxPain: ctx.sensex?.maxPain ?? null,
          callWall: ctx.sensex?.callWall ?? null,
          putFloor: ctx.sensex?.putFloor ?? null,
          futuresLtp: ctx.sensexFutures?.ltp ?? null,
          futuresBasisPct: ctx.sensexFutures?.basisPercent ?? null,
          futuresOI: ctx.sensexFutures?.oi ?? null,
          futuresOIChange: ctx.sensexFutures?.oiChange ?? null,
        },
      ];
    } catch {}

    // 2. Per-stock F&O (batches of 10 — each internal option-chain call takes
    //    ~4-6s via the NSE path, so 5 batches ≈ 25s cold, less when warm)
    const stockFO: Record<string, any> = {};
    const attempted = FO_STOCKS.length;
    for (let i = 0; i < FO_STOCKS.length; i += 10) {
      const batch = FO_STOCKS.slice(i, i + 10);
      const results = await Promise.allSettled(batch.map(fetchStockFOData));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "fulfilled" && (results[j] as any).value) {
          stockFO[batch[j]] = (results[j] as any).value;
        }
      }
      if (i + 10 < FO_STOCKS.length) await new Promise((r) => setTimeout(r, 100));
    }

    const clock = await getMarketClock();
    const resolved = Object.keys(stockFO).length;
    const meta = buildCardMeta({
      source: "nse",
      providerTimestamp: clock.tradeDate,
      ttlMs: 15 * 60_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    const result = {
      status: resolved > 0 ? meta.status : "UNAVAILABLE",
      data: meta,
      coverage: { requested: attempted, resolved, complete: resolved === attempted },
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
