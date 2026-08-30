// Trade Opportunity Engine — Aggregates all signals into ranked opportunities
// Combines scanner scores + sector strength + volume + technicals

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
  RELIANCE: "Reliance Industries", TCS: "Tata Consultancy", HDFCBANK: "HDFC Bank",
  INFY: "Infosys", ICICIBANK: "ICICI Bank", HINDUNILVR: "Hindustan Unilever",
  ITC: "ITC", SBIN: "State Bank of India", BHARTIARTL: "Bharti Airtel",
  KOTAKBANK: "Kotak Mahindra", LT: "Larsen & Toubro", AXISBANK: "Axis Bank",
  BAJFINANCE: "Bajaj Finance", ASIANPAINT: "Asian Paints", MARUTI: "Maruti Suzuki",
  SUNPHARMA: "Sun Pharma", TITAN: "Titan", ULTRACEMCO: "UltraTech Cement",
  NESTLEIND: "Nestle India", TATAMOTORS: "Tata Motors", WIPRO: "Wipro",
  "M&M": "Mahindra & Mahindra", HCLTECH: "HCL Technologies", POWERGRID: "Power Grid",
  NTPC: "NTPC", ONGC: "ONGC", TATASTEEL: "Tata Steel", JSWSTEEL: "JSW Steel",
  ADANIENT: "Adani Enterprises", ADANIPORTS: "Adani Ports", TECHM: "Tech Mahindra",
  HDFCLIFE: "HDFC Life", SBILIFE: "SBI Life", BRITANNIA: "Britannia",
  CIPLA: "Cipla", DRREDDY: "Dr Reddy's", DIVISLAB: "Divi's Labs",
  EICHERMOT: "Eicher Motors", GRASIM: "Grasim", HEROMOTOCO: "Hero Moto",
  HINDALCO: "Hindalco", INDUSINDBK: "IndusInd Bank", BAJAJFINSV: "Bajaj Finserv",
  COALINDIA: "Coal India", BPCL: "BPCL", TRENT: "Trent",
  APOLLOHOSP: "Apollo Hospitals", LTIM: "LTIMindtree", HDFCAMC: "HDFC AMC",
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
      change: parseFloat((ltp - prev).toFixed(2)),
      changePct: parseFloat((((ltp - prev) / prev) * 100).toFixed(2)),
      volume: meta.regularMarketVolume || 0,
      prevClose: prev,
      dayHigh: meta.regularMarketDayHigh || ltp,
      dayLow: meta.regularMarketDayLow || ltp,
    };
  } catch { return null; }
}

function scoreOpportunity(stock: any, sectorAvgChange: number) {
  let score = 50;
  const reasons: string[] = [];
  const risks: string[] = [];

  if (stock.changePct > 3) { score += 20; reasons.push("Strong momentum"); }
  else if (stock.changePct > 1.5) { score += 15; reasons.push("Good momentum"); }
  else if (stock.changePct > 0.5) { score += 10; reasons.push("Positive momentum"); }
  else if (stock.changePct > 0) { score += 5; }
  else if (stock.changePct > -1) { score -= 5; }
  else { score -= 15; risks.push("Negative momentum"); }

  const sectorOutperform = stock.changePct - sectorAvgChange;
  if (sectorOutperform > 1) { score += 15; reasons.push("Sector outperformer"); }
  else if (sectorOutperform > 0) { score += 10; reasons.push("Above sector average"); }
  else if (sectorOutperform < -1) { score -= 10; risks.push("Sector underperformer"); }

  if (stock.volume > 5000000) { score += 10; reasons.push("High volume"); }
  else if (stock.volume > 2000000) { score += 5; }

  const range = stock.dayHigh - stock.dayLow;
  if (range > 0) {
    const pos = (stock.ltp - stock.dayLow) / range;
    if (pos > 0.8) { score += 10; reasons.push("Near day high"); }
    else if (pos > 0.6) { score += 5; }
    else if (pos < 0.2) { risks.push("Near day low"); score -= 5; }
  }

  let setup: string;
  if (stock.changePct > 2 && stock.volume > 3000000) setup = "MOMENTUM";
  else if (stock.changePct > 0.5 && sectorOutperform > 0.5) setup = "SECTOR LEADER";
  else if (stock.changePct > 0 && stock.changePct < 1) setup = "PULLBACK";
  else if (stock.changePct < -1 && sectorOutperform > 0) setup = "RELATIVE STRENGTH";
  else setup = "WATCH";

  let confidence: string;
  if (score >= 80) confidence = "VERY HIGH";
  else if (score >= 65) confidence = "HIGH";
  else if (score >= 50) confidence = "MEDIUM";
  else confidence = "LOW";

  const atr = range > 0 ? range : stock.ltp * 0.015;
  const entry = stock.ltp;
  const sl = stock.changePct > 0 ? entry - atr * 1.5 : entry - atr * 2;
  const tp1 = entry + atr * 2;
  const tp2 = entry + atr * 3;
  const risk = entry - sl;
  const reward = tp1 - entry;
  const rr = risk > 0 ? parseFloat((reward / risk).toFixed(1)) : 0;

  return {
    score: Math.min(100, Math.max(0, score)),
    setup, reasons, risks, confidence,
    entry: parseFloat(entry.toFixed(2)),
    sl: parseFloat(sl.toFixed(2)),
    tp1: parseFloat(tp1.toFixed(2)),
    tp2: parseFloat(tp2.toFixed(2)),
    rr,
  };
}

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 60_000;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const topN = parseInt(searchParams.get("top") || "5");

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
      return NextResponse.json({ success: true, opportunities: [], stockCount: 0 });
    }

    // Sector averages
    const sectorMap: Record<string, any[]> = {};
    for (const s of stocks) {
      if (!sectorMap[s.sector]) sectorMap[s.sector] = [];
      sectorMap[s.sector].push(s);
    }
    const sectorAvg: Record<string, number> = {};
    for (const [sec, stks] of Object.entries(sectorMap)) {
      sectorAvg[sec] = stks.reduce((sum, s) => sum + s.changePct, 0) / stks.length;
    }

    const opportunities = stocks.map(s => ({
      ...scoreOpportunity(s, sectorAvg[s.sector] || 0),
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      ltp: s.ltp,
      changePct: s.changePct,
      volume: s.volume,
    }));

    opportunities.sort((a, b) => b.score - a.score);
    const topOpps = opportunities.slice(0, Math.min(topN, 10));

    const result = {
      opportunities: topOpps,
      totalStocks: stocks.length,
      avgScore: Math.round(opportunities.reduce((sum, o) => sum + o.score, 0) / opportunities.length),
      topOppCount: opportunities.filter(o => o.score >= 70).length,
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Opportunities fetch failed" }, { status: 500 });
  }
}
