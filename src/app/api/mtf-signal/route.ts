// API Route — MTF (Multi-Timeframe) Signal Confirmation
// Fetches 15M + 5M candles from the REAL candle chain (Breeze → MO → NSE),
// computes indicators, and returns a composite BUY_CE/BUY_PE/WAIT signal.
// Called by the Hermes agent via the get_mtf_signal tool.
//
// 2026-10-20: this route used the legacy historical-data path (Yahoo-era wrapper +
// its own Breeze session), which returned 0 bars whenever the Breeze session was
// down — the card rendered empty. It now uses the canonical chain, which degrades
// to NSE index candles and reports the degradation instead of showing nothing.

import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";

    // Real candle chain: Breeze → MO → NSE (index-only, current session).
    // The candle chain may only be imported by market/capture.ts (architecture
    // rule: evaluation modules stay isolated from live capture) — read through it.
    const { getLiveCandles } = await import("@/lib/market/capture");

    const [res5m, res15m] = await Promise.all([
      getLiveCandles(symbol, "5m"),
      getLiveCandles(symbol, "15m"),
    ]);

    const candles5m = res5m.candles || [];
    const candles15m = res15m.candles || [];
    const dataSource = { "5m": res5m.source, "15m": res15m.source };
    const degraded = [res5m.degraded, res15m.degraded].filter(Boolean) as string[];

    if (candles5m.length < 10) {
      return NextResponse.json({
        success: false,
        error: `Insufficient candle data for ${symbol} — need at least 10 5M candles, got ${candles5m.length}`,
        dataAvailability: { "5m": candles5m.length, "15m": candles15m.length },
        dataSource,
        failures: [...res5m.failures, ...res15m.failures],
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
      dataSource,
      degraded: degraded.length ? degraded : null,
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
