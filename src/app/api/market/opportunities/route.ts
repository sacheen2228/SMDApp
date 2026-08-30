// Trade Opportunity Engine — Aggregates all signals into ranked opportunities
// Uses NSE India API (single call for all NIFTY 50) — no rate limiting

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";

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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const topN = parseInt(searchParams.get("top") || "5");

    const stocks = await fetchNIFTY50Stocks();

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
      sectorAvg[sec] = stks.reduce((sum: number, s: any) => sum + s.changePct, 0) / stks.length;
    }

    const opportunities = stocks.map((s: any) => ({
      ...scoreOpportunity(s, sectorAvg[s.sector] || 0),
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      ltp: s.ltp,
      changePct: s.changePct,
      volume: s.volume,
    }));

    opportunities.sort((a: any, b: any) => b.score - a.score);
    const topOpps = opportunities.slice(0, Math.min(topN, 10));

    return NextResponse.json({
      opportunities: topOpps,
      totalStocks: stocks.length,
      avgScore: Math.round(opportunities.reduce((sum: number, o: any) => sum + o.score, 0) / opportunities.length),
      topOppCount: opportunities.filter((o: any) => o.score >= 70).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Opportunities fetch failed" }, { status: 500 });
  }
}
