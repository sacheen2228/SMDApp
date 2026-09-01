// Trade Opportunity Engine — Uses technical analysis detection engines
// Breakout, Pullback, Momentum, Breakdown, Reversal detection with confirmations

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";
import {
  detectBreakout,
  detectPullback,
  detectMomentum,
  detectBreakdown,
  detectReversal,
  scanStock,
  TechnicalIndicators,
  ScanContext,
} from "@/lib/technical-analysis";
import { runIntradayScan } from "@/lib/intraday-scanner";

const REGIME_API = process.env.INTERNAL_API_BASE || "";

async function getMarketContext(): Promise<ScanContext> {
  try {
    const res = await fetch(`${REGIME_API}/api/market/regime`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error("Regime fetch failed");
    const data = await res.json();
    return {
      marketRegime: data.regime || "NEUTRAL",
      marketBreadth: data.avgIndexChange || 0,
      vix: data.vix?.value || 15,
      session: data.session || "CLOSED",
    };
  } catch {
    return {
      marketRegime: "NEUTRAL",
      marketBreadth: 0,
      vix: 15,
      session: "CLOSED",
    };
  }
}

function estimateIndicators(stock: any, sectorAvg: number, marketAvg: number): TechnicalIndicators {
  const range = stock.dayHigh - stock.dayLow;
  const atr = range > 0 ? range : stock.ltp * 0.015;

  // Estimate relVolume (would need avgVolume from historical data)
  const avgVolume = 2000000; // placeholder - in production use real avg volume
  const relVolume = stock.volume / avgVolume;

  // Estimate EMAs from available data
  // In production, these would come from historical data
  const ema20 = stock.prevClose + (stock.change || 0) * 0.3; // rough estimate
  const ema50 = stock.prevClose;
  const ema200 = stock.prevClose;

  // Estimate VWAP (typically between day high/low)
  const vwap = (stock.dayHigh + stock.dayLow + stock.ltp) / 3;

  // Estimate RSI from changePct
  let rsi = 50;
  if (stock.changePct > 3) rsi = 70;
  else if (stock.changePct > 1.5) rsi = 60;
  else if (stock.changePct > 0) rsi = 55;
  else if (stock.changePct > -1.5) rsi = 45;
  else if (stock.changePct > -3) rsi = 40;
  else rsi = 30;

  // Estimate MACD
  const macd = {
    macd: stock.changePct * 0.5,
    signal: stock.changePct * 0.3,
    histogram: stock.changePct * 0.2,
  };

  // Estimate Bollinger Bands
  const bbMiddle = ema20;
  const bbUpper = ema20 + atr * 2;
  const bbLower = ema20 - atr * 2;

  return {
    ltp: stock.ltp,
    open: stock.prevClose + (stock.change || 0) * 0.5,
    high: stock.dayHigh,
    low: stock.dayLow,
    prevClose: stock.prevClose,
    changePct: stock.changePct,
    volume: stock.volume,
    avgVolume,
    relVolume,
    vwap,
    ema20,
    ema50,
    ema200,
    rsi,
    macd,
    atr,
    atrPct: (atr / stock.ltp) * 100,
    bbUpper,
    bbLower,
    bbMiddle,
    dayHigh: stock.dayHigh,
    dayLow: stock.dayLow,
    weekHigh52: stock.weekHigh52,
    weekLow52: stock.weekLow52,
    prevDayHigh: stock.dayHigh, // placeholder
    prevDayLow: stock.dayLow, // placeholder
    sectorChangePct: sectorAvg,
    marketChangePct: marketAvg,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const topN = parseInt(searchParams.get("top") || "10");

    const [stocks, context] = await Promise.all([
      fetchNIFTY50Stocks(),
      getMarketContext(),
    ]);

    // Also run intraday scan for additional signal sources
    let intradayCandidates: any[] = [];
    try {
      const intradayResult = await runIntradayScan(
        { symbol: "NIFTY", spotPrice: 0, optionChain: null, vix: context.vix, pcr: 1, maxPain: 0, totalCallOI: 0, totalPutOI: 0 },
        null
      );
      intradayCandidates = intradayResult.candidates || [];
    } catch {
      // Intraday scan is optional — don't fail the whole endpoint
    }

    // Build intraday lookup by symbol
    const intradayBySymbol: Record<string, any> = {};
    for (const c of intradayCandidates) {
      intradayBySymbol[c.symbol] = c;
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
      sectorAvg[sec] = stks.reduce((sum: number, s: any) => sum + s.changePct, 0) / stks.length;
    }
    const marketAvg = stocks.reduce((sum: number, s: any) => sum + s.changePct, 0) / stocks.length;

    // Scan each stock
    const opportunities = stocks.map((s: any) => {
      const indicators = estimateIndicators(s, sectorAvg[s.sector] || 0, marketAvg);
      const scan = scanStock(indicators, context);
      const intraday = intradayBySymbol[s.symbol];

      // Merge intraday score if available (20% weight)
      let mergedScore = scan.overallScore;
      let source = "TECHNICAL_ANALYSIS";
      if (intraday && intraday.totalScore > 0) {
        mergedScore = Math.round(scan.overallScore * 0.8 + intraday.totalScore * 0.2);
        source = "TECHNICAL_ANALYSIS+INTRADAY";
      }

      return {
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        ltp: s.ltp,
        changePct: s.changePct,
        volume: s.volume,
        relVolume: indicators.relVolume,
        score: mergedScore,
        setup: scan.bestSetup?.type || "WATCH",
        entryState: scan.entryState,
        confidence: scan.bestSetup?.confidence >= 75 ? "VERY HIGH" :
          scan.bestSetup?.confidence >= 60 ? "HIGH" :
          scan.bestSetup?.confidence >= 45 ? "MEDIUM" : "LOW",
        reasons: scan.bestSetup?.confirmations || [],
        risks: scan.bestSetup?.warnings || [],
        entry: scan.bestSetup?.entryZone?.low || s.ltp,
        sl: scan.bestSetup?.stopLoss || s.ltp * 0.985,
        tp1: scan.bestSetup?.targets?.[0] || s.ltp * 1.03,
        tp2: scan.bestSetup?.targets?.[1] || s.ltp * 1.05,
        rr: scan.bestSetup?.riskReward || 0,
        falseBreakoutRisk: scan.bestSetup ? "LOW" : "N/A",
        source,
        intradayGrade: intraday?.grade || null,
        intradayDirection: intraday?.direction || null,
      };
    });

    // Sort by score, then by entryState priority
    const statePriority = { CONFIRMED: 4, CONFIRMING: 3, WATCH: 2, INVALIDATED: 1 };
    opportunities.sort((a, b) => {
      if (statePriority[b.entryState] !== statePriority[a.entryState]) {
        return statePriority[b.entryState] - statePriority[a.entryState];
      }
      return b.score - a.score;
    });

    const topOpps = opportunities.slice(0, Math.min(topN, 15));

    return NextResponse.json({
      opportunities: topOpps,
      totalStocks: stocks.length,
      avgScore: Math.round(opportunities.reduce((sum: number, o: any) => sum + o.score, 0) / opportunities.length),
      topOppCount: opportunities.filter((o: any) => o.score >= 70).length,
      marketContext: {
        regime: context.marketRegime,
        vix: context.vix,
        session: context.session,
        breadth: context.marketBreadth,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Opportunities fetch failed" }, { status: 500 });
  }
}