// Sector Intelligence API — Sector performance, rotation, relative strength
// Uses NSE India API (single call for all NIFTY 50) — no rate limiting

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks, getStockQuoteProvenance } from "@/lib/nse-stock-data";
import { buildCardMeta, getMarketClock, unavailableMeta } from "@/lib/data-freshness";
import { sweepDailyTechnicals } from "@/lib/daily-bars";
import { getDailyBars } from "@/lib/daily-bars";

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
    const [stocks, clock] = await Promise.all([fetchNIFTY50Stocks(), getMarketClock()]);

    if (stocks.length === 0) {
      const meta = unavailableMeta(
        "No quotes available from the exchange feeds (NSE index lists / Moneycontrol).",
        "nse",
      );
      return NextResponse.json({
        success: false,
        status: "UNAVAILABLE",
        error: meta.reason,
        data: meta,
        sectors: [],
        stockCount: 0,
        timestamp: new Date().toISOString(),
      });
    }

    const prov = getStockQuoteProvenance();
    const cardMeta = buildCardMeta({
      source: prov.source === "moneycontrol" ? "moneycontrol" : "nse",
      providerTimestamp: prov.providerTimestamp ?? clock.tradeDate ?? null,
      ttlMs: 90_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    // Group by sector
    const sectorMap: Record<string, typeof stocks> = {};
    for (const s of stocks) {
      if (!sectorMap[s.sector]) sectorMap[s.sector] = [];
      sectorMap[s.sector].push(s);
    }

    // Previous-session change per symbol (real daily bars) — the rotation
    // matrix needs yesterday's relative strength, not a guess.
    const prevChange = new Map<string, number>();
    await Promise.all(
      stocks.map(async (s) => {
        const bars = await getDailyBars(s.symbol, 30);
        if (bars.length < 3) return;
        // "Yesterday" relative to the newest bar: the session before it.
        const last = bars[bars.length - 2];
        const prev = bars[bars.length - 3];
        if (!prev.c) return;
        prevChange.set(s.symbol, ((last.c - prev.c) / prev.c) * 100);
      }),
    );

    const sectors = Object.entries(sectorMap).map(([name, stks]) => {
      const avgChangePct = stks.reduce((sum, s) => sum + s.changePct, 0) / stks.length;
      const totalVolume = stks.reduce((sum, s) => sum + s.volume, 0);
      const advanceCount = stks.filter((s) => s.changePct > 0).length;
      const declineCount = stks.filter((s) => s.changePct < 0).length;

      const prevVals = stks
        .map((s) => prevChange.get(s.symbol))
        .filter((v): v is number => v != null);
      const prevAvgChangePct = prevVals.length
        ? Math.round((prevVals.reduce((a, b) => a + b, 0) / prevVals.length) * 100) / 100
        : null;

      return {
        name,
        avgChangePct: Math.round(avgChangePct * 100) / 100,
        // Real previous-session change (null when the history is missing).
        prevAvgChangePct,
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

    // Rotation matrix — real quadrant of today's vs yesterday's relative
    // strength (sector move minus market move). The component used to read
    // `rotationMatrix` that this endpoint never sent, so the four quadrants
    // were always empty.
    const marketToday = stocks.reduce((s, x) => s + x.changePct, 0) / stocks.length;
    const marketPrevVals = stocks
      .map((s) => prevChange.get(s.symbol))
      .filter((v): v is number => v != null);
    const marketPrev = marketPrevVals.length
      ? marketPrevVals.reduce((a, b) => a + b, 0) / marketPrevVals.length
      : null;
    const rotationMatrix: Record<string, string[]> = {
      leading: [],
      improving: [],
      weakening: [],
      lagging: [],
    };
    let rotationAvailable = marketPrev != null;
    for (const sec of sectors) {
      if (sec.prevAvgChangePct == null || marketPrev == null) { rotationAvailable = false; continue; }
      const rsToday = sec.avgChangePct - marketToday;
      const rsPrev = sec.prevAvgChangePct - marketPrev;
      if (rsToday >= 0 && rsPrev >= 0) rotationMatrix.leading.push(sec.name);
      else if (rsToday < 0 && rsPrev >= 0) rotationMatrix.improving.push(sec.name);
      else if (rsToday >= 0 && rsPrev < 0) rotationMatrix.weakening.push(sec.name);
      else rotationMatrix.lagging.push(sec.name);
    }

    return NextResponse.json({
      success: true,
      status: cardMeta.status,
      data: cardMeta,
      sectors,
      rotationMatrix: rotationAvailable ? rotationMatrix : null,
      rotationAvailable,
      marketChangePct: Math.round(marketToday * 100) / 100,
      prevMarketChangePct: marketPrev == null ? null : Math.round(marketPrev * 100) / 100,
      stockCount: stocks.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const meta = unavailableMeta(error.message || "Sector fetch failed", "nse");
    return NextResponse.json({
      success: false,
      status: "UNAVAILABLE",
      error: meta.reason,
      data: meta,
      sectors: [],
      timestamp: new Date().toISOString(),
    });
  }
}
