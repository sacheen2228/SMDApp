// Market Heatmap API — Stock data for treemap visualization
// Fetches NIFTY 50 stocks with sector mapping, change %, volume

import { NextResponse } from "next/server";
import { STOCK_SECTOR_MAP } from "../sectors/route";

const NIFTY50 = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
  "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
  "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
  "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
  "ADANIPORTS","TECHM","HDFCLIFE","SBILIFE","BRITANNIA","CIPLA","DRREDDY",
  "DIVISLAB","EICHERMOT","GRASIM","HEROMOTOCO","HINDALCO","INDUSINDBK",
  "BAJAJFINSV","COALINDIA","BPCL","TRENT","APOLLOHOSP","LTIM","HDFCAMC","PIDILITIND",
];

const NIFTY50_NAMES: Record<string, string> = {
  RELIANCE: "Reliance", TCS: "TCS", HDFCBANK: "HDFC Bank", INFY: "Infosys",
  ICICIBANK: "ICICI Bank", HINDUNILVR: "HUL", ITC: "ITC", SBIN: "SBI",
  BHARTIARTL: "Bharti Airtel", KOTAKBANK: "Kotak Bank", LT: "L&T",
  AXISBANK: "Axis Bank", BAJFINANCE: "Bajaj Finance", ASIANPAINT: "Asian Paints",
  MARUTI: "Maruti", SUNPHARMA: "Sun Pharma", TITAN: "Titan", ULTRACEMCO: "UltraTech",
  NESTLEIND: "Nestle", TATAMOTORS: "Tata Motors", WIPRO: "Wipro", "M&M": "M&M",
  HCLTECH: "HCL Tech", POWERGRID: "Power Grid", NTPC: "NTPC", ONGC: "ONGC",
  TATASTEEL: "Tata Steel", JSWSTEEL: "JSW Steel", ADANIENT: "Adani Ent",
  ADANIPORTS: "Adani Ports", TECHM: "Tech Mahindra", HDFCLIFE: "HDFC Life",
  SBILIFE: "SBI Life", BRITANNIA: "Britannia", CIPLA: "Cipla", DRREDDY: "Dr Reddy",
  DIVISLAB: "Divi's Lab", EICHERMOT: "Eicher", GRASIM: "Grasim",
  HEROMOTOCO: "Hero Moto", HINDALCO: "Hindalco", INDUSINDBK: "IndusInd",
  BAJAJFINSV: "Bajaj Finserv", COALINDIA: "Coal India", BPCL: "BPCL",
  TRENT: "Trent", APOLLOHOSP: "Apollo Hospital", LTIM: "LTIM", HDFCAMC: "HDFC AMC",
  PIDILITIND: "Pidilite",
};

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
      name: NIFTY50_NAMES[sym] || sym,
      sector: STOCK_SECTOR_MAP[sym] || "Other",
      ltp,
      changePct: parseFloat((((ltp - prev) / prev) * 100).toFixed(2)),
      change: parseFloat((ltp - prev).toFixed(2)),
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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const index = searchParams.get("index") || "NIFTY50";

    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Fetch ALL stocks in parallel (no rate limit — Yahoo allows concurrent)
    const results = await Promise.allSettled(NIFTY50.map(fetchStock));
    const stocks = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value);

    if (stocks.length === 0) {
      return NextResponse.json({ error: "No data available" }, { status: 503 });
    }

    // Group by sector
    const sectors: Record<string, any[]> = {};
    for (const s of stocks) {
      if (!sectors[s.sector]) sectors[s.sector] = [];
      sectors[s.sector].push(s);
    }

    const sectorData = Object.entries(sectors).map(([name, stks]) => ({
      name,
      stocks: stks,
      avgChangePct: parseFloat((stks.reduce((sum, s) => sum + s.changePct, 0) / stks.length).toFixed(2)),
      totalVolume: stks.reduce((sum, s) => sum + s.volume, 0),
      advanceCount: stks.filter(s => s.changePct > 0).length,
      declineCount: stks.filter(s => s.changePct < 0).length,
    }));

    const result = {
      stocks,
      sectors: sectorData,
      index,
      stockCount: stocks.length,
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Heatmap fetch failed" }, { status: 500 });
  }
}
