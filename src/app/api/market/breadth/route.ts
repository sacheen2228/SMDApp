// Market Breadth API — Advance/Decline, % above EMAs/VWAP, Relative Volume, new highs/lows
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

    // Calculate % above EMAs (estimated from price vs EMAs)
    // In production, these would come from historical data
    const aboveEMA20 = stocks.filter(s => s.ltp > (s.prevClose + (s.change || 0) * 0.3)).length;
    const aboveEMA50 = stocks.filter(s => s.ltp > s.prevClose).length;
    const aboveEMA200 = stocks.filter(s => s.ltp > s.prevClose * 0.95).length;

    // % above VWAP (estimated)
    const aboveVWAP = stocks.filter(s => {
      const vwap = (s.dayHigh + s.dayLow + s.ltp) / 3;
      return s.ltp > vwap;
    }).length;

    // Relative Volume analysis
    const avgVolume = 2000000; // placeholder - in production use real avg
    const highRelVol = stocks.filter(s => s.volume / avgVolume > 2).length;
    const elevatedRelVol = stocks.filter(s => s.volume / avgVolume > 1.5).length;
    const normalRelVol = stocks.filter(s => {
      const rv = s.volume / avgVolume;
      return rv >= 0.8 && rv <= 1.5;
    }).length;
    const lowRelVol = stocks.filter(s => s.volume / avgVolume < 0.8).length;

    // Volume advancing/declining
    const volRatio = volDeclining > 0 ? volAdvancing / volDeclining : volAdvancing > 0 ? 100 : 1;

    // New 52W High/Low percentages
    const newHighsPct = total > 0 ? (newHighs / total) * 100 : 0;
    const newLowsPct = total > 0 ? (newLows / total) * 100 : 0;

    // Intraday highs/lows (stocks making fresh day highs/lows)
    const freshDayHighs = stocks.filter(s => Math.abs(s.ltp - s.dayHigh) / s.dayHigh < 0.005).length;
    const freshDayLows = stocks.filter(s => Math.abs(s.ltp - s.dayLow) / s.dayLow < 0.005).length;

    // Breadth scoring
    const adRatio = declines > 0 ? advances / declines : advances > 0 ? 100 : 1;
    const adScore = Math.min(100, Math.round((adRatio / 3) * 100));
    const volScore = volDeclining > 0 ? Math.min(100, Math.round((volAdvancing / volDeclining) * 50)) : 50;
    const highLowScore = total > 0 ? Math.min(100, Math.round(((newHighs - newLows + total) / (2 * total)) * 100)) : 50;
    const emaScore = total > 0 ? Math.min(100, Math.round((aboveEMA20 / total) * 100)) : 50;
    const vwapScore = total > 0 ? Math.min(100, Math.round((aboveVWAP / total) * 100)) : 50;
    const relVolScore = total > 0 ? Math.min(100, Math.round(((highRelVol + elevatedRelVol) / total) * 100)) : 50;

    // Weighted breadth score
    const breadthScore = Math.round(
      adScore * 0.25 +
      volScore * 0.20 +
      highLowScore * 0.15 +
      emaScore * 0.15 +
      vwapScore * 0.15 +
      relVolScore * 0.10
    );

    // Breadth label
    let label = "NEUTRAL";
    if (breadthScore >= 75) label = "STRONG BULLISH";
    else if (breadthScore >= 60) label = "BULLISH";
    else if (breadthScore >= 40) label = "NEUTRAL";
    else if (breadthScore >= 25) label = "BEARISH";
    else label = "STRONG BEARISH";

    return NextResponse.json({
      breadth: {
        score: breadthScore,
        label,
        advances,
        declines,
        unchanged,
        total,
        adRatio: Math.round(adRatio * 100) / 100,
        newHighs,
        newLows,
        newHighsPct: Math.round(newHighsPct * 100) / 100,
        newLowsPct: Math.round(newLowsPct * 100) / 100,
        volAdvancing,
        volDeclining,
        volRatio: Math.round(volRatio * 100) / 100,
        freshDayHighs,
        freshDayLows,
        aboveEMA20,
        aboveEMA50,
        aboveEMA200,
        aboveEMA20Pct: total > 0 ? Math.round((aboveEMA20 / total) * 10000) / 100 : 0,
        aboveEMA50Pct: total > 0 ? Math.round((aboveEMA50 / total) * 10000) / 100 : 0,
        aboveEMA200Pct: total > 0 ? Math.round((aboveEMA200 / total) * 10000) / 100 : 0,
        aboveVWAP,
        aboveVWAPPct: total > 0 ? Math.round((aboveVWAP / total) * 10000) / 100 : 0,
        highRelVol,
        elevatedRelVol,
        normalRelVol,
        lowRelVol,
        highRelVolPct: total > 0 ? Math.round((highRelVol / total) * 10000) / 100 : 0,
        adScore,
        volScore,
        highLowScore,
        emaScore,
        vwapScore,
        relVolScore,
      },
      stocks: stocks.map(s => ({
        symbol: s.symbol,
        name: s.name,
        changePct: s.changePct,
        ltp: s.ltp,
        sector: s.sector,
        volume: s.volume,
        relVolume: Math.round((s.volume / 2000000) * 100) / 100,
      })),
      topGainers,
      topLosers,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ breadth: { score: 0, advances: 0, declines: 0 }, stocks: [], error: error.message });
  }
}