// Breakout Strategy API Endpoint
// Runs the candlestick breakout + fakeout detection engine on REAL candles.
//
// Honesty notes (2026-10-20 audit):
//   • `spotPrice` defaulted to 24 000 — an invented NIFTY level that the
//     card rendered as the live spot (the real NIFTY was 22 888).
//   • `vix` defaulted to 15.
//   • `stats.winRate` was 0 when there were no signals, which reads as
//     "0% win rate" instead of "no signals".
// The engine only produces a signal from real intraday candles; when the
// candle feed is empty the route says so instead of showing an empty
// "0% win rate" card.

import { NextRequest, NextResponse } from "next/server";
import { CandlestickBreakoutIndia, type BreakoutSignal } from "@/lib/candlestick-breakout";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";
import { getNSEIndiaVIX, getNSEIndexQuote } from "@/lib/nse-api";
import { buildCardMeta, getMarketClock } from "@/lib/data-freshness";

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

    const warnings: string[] = [];

    // ── Spot (real) ───────────────────────────────────────────────────
    // Canonical chain (NSE → BSE → MO) first, then the free index quote.
    let spotPrice: number | null = null;
    let spotSource = "none";
    let chainAsOf: string | null = null;

    const chain = await Promise.race([
      fetchLiveOptionChain(symbol),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ]).catch(() => null);

    if (chain?.success && chain.data?.spotPrice) {
      spotPrice = chain.data.spotPrice;
      spotSource = chain.source;
      chainAsOf = chain.data.collectedAt ?? null;
    } else {
      const idx = await getNSEIndexQuote(symbol).catch(() => null);
      if (idx?.regularMarketPrice) {
        spotPrice = idx.regularMarketPrice;
        spotSource = "nse";
      }
      if (!chain?.success) {
        warnings.push(`Option chain unavailable (${chain?.error || "no provider answered"}).`);
      }
    }

    // ── VIX (real) ────────────────────────────────────────────────────
    const vixQuote = await getNSEIndiaVIX().catch(() => null);
    const vix: number | null = vixQuote && vixQuote.value > 0 ? vixQuote.value : null;
    if (vix == null) warnings.push("INDIA VIX unavailable.");

    if (spotPrice == null || spotPrice <= 0) {
      return NextResponse.json(
        {
          success: false,
          status: "UNAVAILABLE",
          error: `No exchange quote for ${symbol} — breakout analysis needs the real spot.`,
          warnings,
          timestamp: new Date().toISOString(),
        },
        { status: 503 },
      );
    }

    // Run the strategy on real candles (returns null when the candle feed
    // is empty — the engine never simulates).
    const strategy = getStrategy();
    const signal = await strategy.simulateFromMarketData(spotPrice, vix ?? 0, symbol);

    // Get current S/R levels
    const levels = strategy.sr.getAllLevels();

    const recentSignals: BreakoutSignal[] = [];
    if (signal) {
      recentSignals.push(signal);
    } else {
      warnings.push("No intraday candles available — no breakout/fakeout pattern could be evaluated.");
    }

    const validSignals = recentSignals.filter((s) => s.type === "BREAKOUT_SIGNAL");
    const fakeouts = recentSignals.filter((s) => s.type === "FAKEOUT_ALERT");
    const noPatterns = recentSignals.filter((s) => s.type === "NO_PATTERN");

    const clock = await getMarketClock();
    const meta = buildCardMeta({
      source: spotSource,
      providerTimestamp: chainAsOf ?? clock.tradeDate ?? null,
      ttlMs: 120_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    return NextResponse.json({
      success: true,
      status: meta.status,
      meta,
      data: {
        symbol,
        spotPrice,
        spotSource,
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
          // null (not 0) when there is no signal to grade.
          winRate: recentSignals.length > 0
            ? Math.round((validSignals.length / recentSignals.length) * 100)
            : null,
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
      },
      warnings,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[Breakout API] Error:", error);
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: error.message || "Strategy failed" },
      { status: 500 }
    );
  }
}
