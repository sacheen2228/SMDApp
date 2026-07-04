// Breakout Strategy API Endpoint
// Runs candlestick breakout + fakeout detection engine

import { NextRequest, NextResponse } from "next/server";
import { CandlestickBreakoutIndia, type BreakoutSignal } from "@/lib/candlestick-breakout";
import { generateOptionChain } from "@/lib/option-chain-data";

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

    // Get market data from option chain
    const chainData = generateOptionChain(symbol);
    const spotPrice = chainData.spotPrice || 24000;
    const summary = chainData.summary || {};
    const vix = summary.indiaVIX || 15;

    // Run strategy simulation
    const strategy = getStrategy();
    const signal = strategy.simulateFromMarketData(spotPrice, vix);

    // Get current S/R levels
    const levels = strategy.sr.getAllLevels();

    // Get recent signals history (last 10)
    const recentSignals: BreakoutSignal[] = [];

    // Generate a few more simulated signals for the UI
    for (let i = 0; i < 5; i++) {
      const tempStrategy = new CandlestickBreakoutIndia({
        min_break_pct: 0.003,
        volume_mult: 1.5,
        min_confidence: 60,
        rr_target: 1.5,
      });
      const tempSignal = tempStrategy.simulateFromMarketData(
        spotPrice * (1 + (Math.random() - 0.5) * 0.01),
        vix
      );
      if (tempSignal) {
        recentSignals.push(tempSignal);
      }
    }

    // Add the main signal if valid
    if (signal) {
      recentSignals.unshift(signal);
    }

    // Strategy stats
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
