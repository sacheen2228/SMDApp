// Market Breadth API — Advance/Decline, % above MAs, new highs/lows
// Uses NSE India API (single call for all NIFTY 50) — no rate limiting

import { NextResponse } from "next/server";
import { getBreadthData, fetchNIFTY50Stocks } from "@/lib/nse-stock-data";

export async function GET() {
  try {
    const [breadth, stocks] = await Promise.all([getBreadthData(), fetchNIFTY50Stocks()]);

    if (stocks.length === 0) {
      return NextResponse.json({ breadth: { score: 0, advances: 0, declines: 0 }, stocks: [], error: "NSE data unavailable" });
    }

    const { advances, declines, unchanged, total, newHighs, newLows, volAdvancing, volDeclining, topGainers, topLosers } = breadth;

    const adRatio = declines > 0 ? advances / declines : advances > 0 ? 100 : 1;
    const adScore = Math.min(100, Math.round((adRatio / 3) * 100));
    const volScore = volDeclining > 0 ? Math.min(100, Math.round((volAdvancing / volDeclining) * 50)) : 50;
    const highLowScore = total > 0 ? Math.min(100, Math.round(((newHighs - newLows + total) / (2 * total)) * 100)) : 50;
    const breadthScore = Math.round(adScore * 0.4 + volScore * 0.3 + highLowScore * 0.3);

    return NextResponse.json({
      breadth: {
        score: breadthScore,
        advances,
        declines,
        unchanged,
        total,
        adRatio: Math.round(adRatio * 100) / 100,
        newHighs,
        newLows,
        volAdvancing,
        volDeclining,
        adScore,
        volScore,
        highLowScore,
      },
      stocks: stocks.map(s => ({ symbol: s.symbol, name: s.name, changePct: s.changePct, ltp: s.ltp, sector: s.sector })),
      topGainers,
      topLosers,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ breadth: { score: 0, advances: 0, declines: 0 }, stocks: [], error: error.message });
  }
}
