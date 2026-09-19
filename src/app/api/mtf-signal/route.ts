// API Route — MTF (Multi-Timeframe) Signal Confirmation
// Fetches 15M + 5M candles from Yahoo Finance, computes indicators,
// and returns composite BUY_CE/BUY_PE/WAIT signal.
// Called by Hermes agent via get_mtf_signal tool.

import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";

    // Fetch candles from Yahoo Finance (free, no auth needed)
    const { getHistoricalCandles } = await import("@/lib/historical-data");

    const [candles5mResult, candles15mResult] = await Promise.allSettled([
      getHistoricalCandles(symbol, "5m", 50),
      getHistoricalCandles(symbol, "15m", 50),
    ]);

    const candles5m = candles5mResult.status === "fulfilled" ? candles5mResult.value.candles || [] : [];
    const candles15m = candles15mResult.status === "fulfilled" ? candles15mResult.value.candles || [] : [];

    if (candles5m.length < 10) {
      return NextResponse.json({
        success: false,
        error: `Insufficient candle data for ${symbol} — need at least 10 5M candles, got ${candles5m.length}`,
        dataAvailability: { "5m": candles5m.length, "15m": candles15m.length },
      }, { status: 503 });
    }

    // Compute MTF indicators
    const { computeMTFIndicators } = await import("@/lib/mtf-indicator-engine");
    const { generateMTFSignal } = await import("@/lib/mtf-signal-engine");
    const { DEFAULT_INDICATOR_PARAMS } = await import("@/lib/mtf-config");

    const candlesByTF: Record<string, any[]> = {};
    if (candles15m.length > 0) candlesByTF["15m"] = candles15m;
    if (candles5m.length > 0) candlesByTF["5m"] = candles5m;
    if (candles5m.length > 0) candlesByTF["3m"] = candles5m; // Entry TF = 5M (closest to 3M)

    const indicators = computeMTFIndicators(candlesByTF, DEFAULT_INDICATOR_PARAMS, 20);
    const mtfSignal = generateMTFSignal(indicators.timeframes);

    return NextResponse.json({
      success: true,
      symbol,
      signal: {
        action: mtfSignal.action,
        compositeScore: mtfSignal.compositeScore,
        confidence: mtfSignal.confidence,
        direction: mtfSignal.direction,
        entry: mtfSignal.entry,
        reasons: mtfSignal.reasons,
        trend: mtfSignal.trend,
        dataQuality: mtfSignal.dataQuality,
      },
      indicators: indicators.timeframes,
      dataAvailability: indicators.dataAvailability,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[API] MTF signal error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "MTF signal computation failed" },
      { status: 500 }
    );
  }
}
