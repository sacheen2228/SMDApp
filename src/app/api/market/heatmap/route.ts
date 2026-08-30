// Market Heatmap API — Stock data for treemap visualization
// Uses NSE India API (single call for all NIFTY 50) — no rate limiting

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const index = searchParams.get("index") || "NIFTY50";

    const stocks = await fetchNIFTY50Stocks();

    if (stocks.length === 0) {
      return NextResponse.json({ stocks: [], sectors: [], stockCount: 0, error: "NSE data unavailable" });
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

    return NextResponse.json({
      stocks,
      sectors: sectorData,
      index,
      stockCount: stocks.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ stocks: [], sectors: [], error: error.message || "Heatmap fetch failed" });
  }
}
