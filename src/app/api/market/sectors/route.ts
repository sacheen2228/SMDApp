// Sector Intelligence API — Sector performance, rotation, relative strength
// Uses NSE India API (single call for all NIFTY 50) — no rate limiting

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";

export const STOCK_SECTOR_MAP: Record<string, string> = {
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

export async function GET() {
  try {
    const stocks = await fetchNIFTY50Stocks();

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
      const avgChangePct = stks.reduce((sum, s) => sum + s.changePct, 0) / stks.length;
      const totalVolume = stks.reduce((sum, s) => sum + s.volume, 0);
      const advanceCount = stks.filter(s => s.changePct > 0).length;
      const declineCount = stks.filter(s => s.changePct < 0).length;

      return {
        name,
        avgChangePct: Math.round(avgChangePct * 100) / 100,
        totalVolume,
        stockCount: stks.length,
        advanceCount,
        declineCount,
        stocks: stks.map(s => ({
          symbol: s.symbol,
          name: s.name,
          ltp: s.ltp,
          changePct: s.changePct,
          change: s.change,
          volume: s.volume,
        })),
      };
    }).sort((a, b) => b.avgChangePct - a.avgChangePct);

    return NextResponse.json({
      success: true,
      sectors,
      stockCount: stocks.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ success: true, sectors: [], error: error.message });
  }
}
