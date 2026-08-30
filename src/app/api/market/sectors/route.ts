// Sector Intelligence API — Sector performance, rotation, relative strength
// Computes sector metrics from individual NIFTY 50 stock data (Yahoo Finance)

import { NextResponse } from "next/server";

const STOCK_SECTOR: Record<string, string> = {
  RELIANCE: "Energy", TCS: "IT", HDFCBANK: "Banking", INFY: "IT",
  ICICIBANK: "Banking", HINDUNILVR: "FMCG", ITC: "FMCG", SBIN: "Banking",
  BHARTIARTL: "Telecom", KOTAKBANK: "Banking", LT: "Infrastructure",
  AXISBANK: "Banking", BAJFINANCE: "NBFC", ASIANPAINT: "Consumer",
  MARUTI: "Auto", SUNPHARMA: "Pharma", TITAN: "Consumer", ULTRACEMCO: "Cement",
  NESTLEIND: "FMCG", TATAMOTORS: "Auto", WIPRO: "IT", "M&M": "Auto",
  HCLTECH: "IT", POWERGRID: "Power", NTPC: "Power", ONGC: "Energy",
  TATASTEEL: "Metal", JSWSTEEL: "Metal", ADANIENT: "Conglomerate",
  ADANIPORTS: "Infrastructure", TECHM: "IT", HDFCLIFE: "Insurance",
  SBILIFE: "Insurance", BRITANNIA: "FMCG", CIPLA: "Pharma",
  DRREDDY: "Pharma", DIVISLAB: "Pharma", EICHERMOT: "Auto",
  GRASIM: "Cement", HEROMOTOCO: "Auto", HINDALCO: "Metal",
  INDUSINDBK: "Banking", BAJAJFINSV: "NBFC", COALINDIA: "Mining",
  BPCL: "Energy", TRENT: "Retail", APOLLOHOSP: "Healthcare",
  LTIM: "IT", HDFCAMC: "Finance", PIDILITIND: "Chemical",
};

const NIFTY50 = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
  "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
  "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
  "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
  "ADANIPORTS","TECHM","HDFCLIFE","SBILIFE","BRITANNIA","CIPLA","DRREDDY",
  "DIVISLAB","EICHERMOT","GRASIM","HEROMOTOCO","HINDALCO","INDUSINDBK",
  "BAJAJFINSV","COALINDIA","BPCL","TRENT","APOLLOHOSP","LTIM","HDFCAMC","PIDILITIND",
];

export const STOCK_SECTOR_MAP = STOCK_SECTOR;

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
      sector: STOCK_SECTOR[sym] || "Other",
      changePct: parseFloat((((ltp - prev) / prev) * 100).toFixed(2)),
      ltp,
      volume: meta.regularMarketVolume || 0,
    };
  } catch { return null; }
}

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 120_000;

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Fetch stocks in batches of 10 with stagger to avoid Yahoo rate limits
    const BATCH_SIZE = 10;
    const stocks: any[] = [];
    for (let i = 0; i < NIFTY50.length; i += BATCH_SIZE) {
      const batch = NIFTY50.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(fetchStock));
      for (const r of results) {
        if (r.status === "fulfilled" && r.value !== null) stocks.push(r.value);
      }
      if (i + BATCH_SIZE < NIFTY50.length) await new Promise(r => setTimeout(r, 500));
    }

    if (stocks.length === 0) {
      return NextResponse.json({ success: true, sectors: [], stockCount: 0 });
    }

    // Group by sector
    const sectorMap: Record<string, typeof stocks> = {};
    for (const s of stocks) {
      if (!sectorMap[s.sector]) sectorMap[s.sector] = [];
      sectorMap[s.sector].push(s);
    }

    const sectors = Object.entries(sectorMap).map(([name, stks]) => {
      const avgChangePct = parseFloat((stks.reduce((sum, s) => sum + s.changePct, 0) / stks.length).toFixed(2));
      return {
        key: name,
        name,
        changePct: avgChangePct,
        totalVolume: stks.reduce((sum, s) => sum + s.volume, 0),
        advanceCount: stks.filter(s => s.changePct > 0).length,
        declineCount: stks.filter(s => s.changePct < 0).length,
        stocks: stks.map(s => ({ symbol: s.symbol, changePct: s.changePct, ltp: s.ltp })),
      };
    });

    sectors.sort((a, b) => b.changePct - a.changePct);

    const classified = sectors.map((s, i) => {
      const pct = (i / Math.max(1, sectors.length - 1)) * 100;
      let rotation: string;
      if (pct < 20) rotation = "LEADING";
      else if (pct < 40) rotation = "IMPROVING";
      else if (pct < 60) rotation = "NEUTRAL";
      else if (pct < 80) rotation = "WEAKENING";
      else rotation = "LAGGING";
      return {
        ...s,
        rotation,
        strength: s.changePct > 1 ? "STRONG" : s.changePct > 0 ? "POSITIVE" : s.changePct > -1 ? "FLAT" : "WEAK",
      };
    });

    const result = {
      sectors: classified,
      leading: classified.filter(s => s.rotation === "LEADING"),
      improving: classified.filter(s => s.rotation === "IMPROVING"),
      weakening: classified.filter(s => s.rotation === "WEAKENING"),
      lagging: classified.filter(s => s.rotation === "LAGGING"),
      rotationMatrix: {
        leading: classified.filter(s => s.rotation === "LEADING").map(s => s.name),
        improving: classified.filter(s => s.rotation === "IMPROVING").map(s => s.name),
        weakening: classified.filter(s => s.rotation === "WEAKENING").map(s => s.name),
        lagging: classified.filter(s => s.rotation === "LAGGING").map(s => s.name),
      },
      sectorStrengthScore: Math.round(
        classified.reduce((sum, s) => sum + Math.max(0, 50 + s.changePct * 20), 0) / classified.length
      ),
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Sector fetch failed" }, { status: 500 });
  }
}
