// API Route — ORCA Backtest
// Run ORCA engine on historical data and return performance results

import { NextRequest, NextResponse } from "next/server";
import { runOrcaBacktest } from "@/lib/orca-backtest";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const days = parseInt(searchParams.get("days") || "30", 10);
    const capital = parseInt(searchParams.get("capital") || "1000000", 10);
    const riskPerTrade = parseFloat(searchParams.get("risk") || "1");
    const confidenceThreshold = parseInt(searchParams.get("confidence") || "70", 10);

    // Limit days to prevent timeout
    const maxDays = Math.min(days, 60);

    const result = await runOrcaBacktest({
      symbol,
      days: maxDays,
      capital,
      riskPerTrade,
      confidenceThreshold,
    });

    return NextResponse.json({
      success: true,
      result,
      lastUpdate: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[API] ORCA backtest error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "ORCA backtest failed" },
      { status: 500 }
    );
  }
}
