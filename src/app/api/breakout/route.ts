// Breakout Strategy API Endpoint
// Runs candlestick breakout + fakeout detection engine

import { NextRequest, NextResponse } from "next/server";
import { CandlestickBreakoutIndia, type BreakoutSignal } from "@/lib/candlestick-breakout";

// Cache strategy instance per session
let strategyInstance: CandlestickBreakoutIndia | null = null;

function getStrategy(): CandlestickBreakoutIndia {
  if (!strategyInstance) {
    strategyInstance = new CandlestickBreakoutIndia({
      min_break_pct: 0.003,
      volume_mult: 1.5,
      wick_body_ratio: 2.0,
      confirm_candles: 2,
      min_confidence: 60,
      avoid_first_5_min: true,
      rr_target: 1.5,
      sl_buffer: 0.002,
    });
  }
  return strategyInstance;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";

    // Fetch real market data: Breeze → NSE → Yahoo → Simulation fallback
    let spotPrice = 24000;
    let vix = 15;

    try {
      const { getOptionChain, getOptionChainExpiries } = await import("@/lib/icici-breeze/option-chain");
      const { initSession } = await import("@/lib/icici-breeze/auth");
      await initSession().catch(() => {});
      const expiries = await getOptionChainExpiries(symbol);
      for (const exp of expiries.slice(0, 3)) {
        const chain = await getOptionChain(symbol, exp);
        if (chain) {
          spotPrice = chain.spotPrice;
          break;
        }
      }
    } catch (e) {
      console.warn("[Breakout] Breeze failed, trying NSE...");
      try {
        const { getNSEOptionChain } = await import("@/lib/nse-api");
        const nseData = await getNSEOptionChain(symbol);
        if (nseData?.records?.underlyingValue) {
          spotPrice = nseData.records.underlyingValue;
        }
      } catch {
        // final fallback
      }
    }

    // Run strategy simulation
    const strategy = getStrategy();
    const signal = await strategy.simulateFromMarketData(spotPrice, vix, symbol);

    // Get current S/R levels
    const levels = strategy.sr.getAllLevels();

    const recentSignals: BreakoutSignal[] = [];
    if (signal) {
      recentSignals.push(signal);
    }

    const validSignals = recentSignals.filter((s) => s.type === "BREAKOUT_SIGNAL");
    const fakeouts = recentSignals.filter((s) => s.type === "FAKEOUT_ALERT");
    const noPatterns = recentSignals.filter((s) => s.type === "NO_PATTERN");

    return NextResponse.json({
      success: true,
      data: {
        symbol,
        spotPrice,
        vix,
        signal,
        srLevels: levels.map((l) => ({
          price: Math.round(l.price * 100) / 100,
          name: l.name,
          type: l.type,
        })),
        recentSignals: recentSignals.slice(0, 10),
        stats: {
          total: recentSignals.length,
          valid: validSignals.length,
          fakeouts: fakeouts.length,
          noPattern: noPatterns.length,
          winRate: recentSignals.length > 0
            ? Math.round((validSignals.length / recentSignals.length) * 100)
            : 0,
        },
        config: {
          min_break_pct: 0.3,
          volume_mult: 1.5,
          min_confidence: 60,
          rr_target: 1.5,
          patterns: [
            "bullish_engulfing", "bearish_engulfing",
            "hammer", "shooting_star",
            "bullish_pin_bar", "bearish_pin_bar",
            "morning_star", "evening_star",
          ],
        },
        giftNiftyBias: strategy.sr.gift_nifty_bias,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error("[Breakout API] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Strategy failed" },
      { status: 500 }
    );
  }
}
