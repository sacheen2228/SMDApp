// Sector Intelligence API — Sector performance, rotation, relative strength
// Uses Yahoo Finance for sector ETFs + NIFTY 50 stock sector mapping

import { NextResponse } from "next/server";

// Major NSE sector indices (Yahoo Finance symbols)
const SECTOR_ETFS: Record<string, { yahoo: string; name: string }> = {
  BANKNIFTY: { yahoo: "^NSEBANK", name: "Banking" },
  IT: { yahoo: "^CNXIT", name: "IT" },
  AUTO: { yahoo: "^CNXAUTO", name: "Auto" },
  PHARMA: { yahoo: "^CNXPHARMA", name: "Pharma" },
  FMCG: { yahoo: "^CNXFMCG", name: "FMCG" },
  METAL: { yahoo: "^CNXMETAL", name: "Metal" },
  REALTY: { yahoo: "^CNXREALTY", name: "Realty" },
  ENERGY: { yahoo: "^CNXENERGY", name: "Energy" },
  INFRA: { yahoo: "^CNXINFRA", name: "Infrastructure" },
  PSUBANK: { yahoo: "^CNXPSUBANK", name: "PSU Bank" },
  PVTBANK: { yahoo: "^CNXPVTBANK", name: "Private Bank" },
  MEDIA: { yahoo: "^CNXMEDIA", name: "Media" },
  COMMODITIES: { yahoo: "^CNXCOMMODITIES", name: "Commodities" },
  FINANCE: { yahoo: "^CNXFINANCE", name: "Finance" },
  SERVICES: { yahoo: "^CNXSERVICES", name: "Services" },
};

// Stock → Sector mapping (NIFTY 50)
const STOCK_SECTOR: Record<string, string> = {
  RELIANCE: "Energy", TCS: "IT", HDFCBANK: "Banking", INFY: "IT",
  ICICIBANK: "Banking", HINDUNILVR: "FMCG", ITC: "FMCG", SBIN: "Banking",
  BHARTIARTL: "Services", KOTAKBANK: "Banking", LT: "Infrastructure",
  AXISBANK: "Banking", BAJFINANCE: "Finance", ASIANPAINT: "Consumer",
  MARUTI: "Auto", SUNPHARMA: "Pharma", TITAN: "Consumer", ULTRACEMCO: "Commodities",
  NESTLEIND: "FMCG", TATAMOTORS: "Auto", WIPRO: "IT", "M&M": "Auto",
  HCLTECH: "IT", POWERGRID: "Energy", NTPC: "Energy", ONGC: "Energy",
  TATASTEEL: "Metal", JSWSTEEL: "Metal", ADANIENT: "Services",
  ADANIPORTS: "Infrastructure", TECHM: "IT", HDFCLIFE: "Finance",
  SBILIFE: "Finance", BRITANNIA: "FMCG", CIPLA: "Pharma",
  DRREDDY: "Pharma", DIVISLAB: "Pharma", EICHERMOT: "Auto",
  GRASIM: "Commodities", HEROMOTOCO: "Auto", HINDALCO: "Metal",
  INDUSINDBK: "Banking", BAJAJFINSV: "Finance", COALINDIA: "Commodities",
  BPCL: "Energy", TRENT: "Consumer", APOLLOHOSP: "Services",
  LTIM: "IT", HDFCAMC: "Finance", PIDILITIND: "Commodities",
};

let lastReq = 0;
async function rlFetch(url: string) {
  const wait = Math.max(0, 2000 - (Date.now() - lastReq));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastReq = Date.now();
  return fetch(url, { signal: AbortSignal.timeout(10000) });
}

interface SectorData {
  key: string;
  name: string;
  changePct: number;
  ltp: number;
  prevClose: number;
  volume: number;
  advanceCount: number;
  declineCount: number;
  stocks: { symbol: string; changePct: number; ltp: number }[];
}

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 120_000; // 2 min

export const STOCK_SECTOR_MAP = STOCK_SECTOR;

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Fetch sector ETF data
    const sectors: SectorData[] = [];
    for (const [key, info] of Object.entries(SECTOR_ETFS)) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(info.yahoo)}?range=1d&interval=1d`;
        const res = await rlFetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) continue;

        const prev = meta.chartPreviousClose || meta.regularMarketPrice;
        const ltp = meta.regularMarketPrice;
        const changePct = prev ? ((ltp - prev) / prev) * 100 : 0;

        sectors.push({
          key,
          name: info.name,
          changePct: parseFloat(changePct.toFixed(2)),
          ltp,
          prevClose: prev,
          volume: meta.regularMarketVolume || 0,
          advanceCount: 0,
          declineCount: 0,
          stocks: [],
        });
      } catch { /* skip */ }
    }

    // Sort by performance
    sectors.sort((a, b) => b.changePct - a.changePct);

    // Classify rotation
    const classified = sectors.map((s, i) => {
      const pct = (i / sectors.length) * 100;
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
