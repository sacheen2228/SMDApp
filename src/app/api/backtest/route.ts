// Backtest API Endpoint
// Single-day: /api/backtest?symbol=NIFTY&date=2026-07-04
// Multi-day:  /api/backtest?symbol=NIFTY&startDate=2026-06-01&endDate=2026-07-04

import { NextRequest, NextResponse } from "next/server";
import { runMultiDayBacktest } from "@/lib/backtest-engine";
import { generateDayCandles } from "@/lib/historical-data";

// ─── Single Day Backtest (reuses multi-day engine) ──────────────
function runSingleDayBacktest(symbol: string, dateStr: string) {
  const result = runMultiDayBacktest(symbol, dateStr, dateStr);

  // Reformat to match single-day output format
  const dayResult = result.dailyResults[0];
  const trades = dayResult ? dayResult.trades : [];
  const wins = trades.filter((t: any) => t.status === "WIN").length;
  const losses = trades.filter((t: any) => t.status === "LOSS").length;
  const expired = trades.filter((t: any) => t.status === "EXPIRED").length;
  const totalPnL = trades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const winTrades = trades.filter((t: any) => t.pnl && t.pnl > 0);
  const lossTrades = trades.filter((t: any) => t.pnl && t.pnl < 0);
  const grossProfit = winTrades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(lossTrades.reduce((s: number, t: any) => s + (t.pnl || 0), 0));

  return {
    symbol,
    date: dateStr,
    totalCandles: 75,
    signalsFound: dayResult?.signals || 0,
    trades,
    summary: {
      total: trades.length,
      wins,
      losses,
      expired,
      winRate: trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0,
      totalPnL,
      avgPnL: trades.length > 0 ? Math.round(totalPnL / trades.length) : 0,
      maxWin: winTrades.length > 0 ? Math.max(...winTrades.map((t: any) => t.pnl || 0)) : 0,
      maxLoss: lossTrades.length > 0 ? Math.min(...lossTrades.map((t: any) => t.pnl || 0)) : 0,
      profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 999 : 0,
    },
    dayOHLC: dayResult?.dayOHLC || { open: 0, high: 0, low: 0, close: 0, change: 0, changePct: 0 },
    srLevels: [],
    candles: generateDayCandles(symbol, dateStr),
    timestamp: new Date().toISOString(),
  };
}

// ─── API Handler ────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const date = searchParams.get("date");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    // Multi-day mode
    if (startDate && endDate) {
      const result = runMultiDayBacktest(symbol, startDate, endDate);
      return NextResponse.json({ success: true, data: result, mode: "multi-day" });
    }

    // Single-day mode
    const dateStr = date || new Date().toISOString().split("T")[0];
    const result = runSingleDayBacktest(symbol, dateStr);
    return NextResponse.json({ success: true, data: result, mode: "single-day" });
  } catch (error: any) {
    console.error("[Backtest API] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Backtest failed" },
      { status: 500 }
    );
  }
}
