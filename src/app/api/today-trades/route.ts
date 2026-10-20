// app/api/today-trades/route.ts
//
// "Today's Trade — Top 5" — Unified: Index F&O + Stock F&O + Equity Swing
// Scans ALL sectors and returns the strongest setups.

import { NextRequest, NextResponse } from "next/server";
import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";
import { analyzeStockFO } from "@/lib/trade-intelligence/stock-fo-mode";
import { analyzeEquitySwing } from "@/lib/trade-intelligence/equity-swing-mode";
import { buildCardMeta, getMarketClock } from "@/lib/data-freshness";

export async function GET(req: NextRequest) {
  try {
    const ctx = await buildMarketIntelligenceContext();

    // Run all three modes in parallel
    const [indexSignals, stockSignals, swingSignals] = await Promise.all([
      analyzeIndexFO(ctx),
      analyzeStockFO(ctx, 15),
      analyzeEquitySwing(ctx, 15),
    ]);

    // Combine into unified list
    const allCandidates = [
      ...indexSignals
        .filter(s => s.direction !== "NO_TRADE")
        .map(s => ({
          rank: 0,
          symbol: s.symbol,
          name: s.symbol,
          sector: "Index",
          type: "CE" as const,
          direction: s.direction,
          mode: "INDEX_FO" as const,
          entry: s.entry,
          stopLoss: s.stopLoss,
          tp1: s.target1,
          tp2: s.target2,
          // No third target from the engine — a made-up "TP3" (target2*1.1)
          // used to be shown as a real level.
          tp3: null,
          rr: s.riskReward,
          probability: s.confidence,
          stars: Math.round(s.confidence / 20),
          side: s.direction,
          holdingPeriod: s.holdingPeriod,
          instrument: s.recommendedInstrument,
          reasoning: s.reasoning,
          score: s.confidence,
          setupType: s.direction,
          premium: s.premium,
          strike: s.strike,
          expiry: s.expiry,
          spotEntry: s.spotEntry,
          spotStopLoss: s.spotStopLoss,
          spotTarget1: s.spotTarget1,
          spotTarget2: s.spotTarget2,
          premiumNote: s.premiumNote,
        })),
      ...stockSignals
        .filter(s => s.direction !== "NO_TRADE")
        .map(s => ({
          rank: 0,
          symbol: s.symbol,
          name: s.name,
          sector: s.sector,
          type: (s.direction === "BUY_CE" ? "CE" : s.direction === "BUY_PE" ? "PE" : "FUT") as "CE" | "PE" | "FUT",
          direction: s.direction,
          mode: "STOCK_FO" as const,
          entry: s.entry,
          stopLoss: s.stopLoss,
          tp1: s.target1,
          tp2: s.target2,
          tp3: null,
          rr: s.riskReward,
          probability: s.confidence,
          stars: Math.round(s.confidence / 20),
          side: s.direction,
          holdingPeriod: s.holdingPeriod,
          instrument: s.recommendedInstrument,
          reasoning: s.reasoning,
          score: s.confidence,
          setupType: s.setupType,
          premium: s.premium,
          strike: s.strike,
          expiry: s.expiry,
          spotEntry: s.spotEntry,
          spotStopLoss: s.spotStopLoss,
          spotTarget1: s.spotTarget1,
          spotTarget2: s.spotTarget2,
          premiumNote: s.premiumNote,
        })),
      ...swingSignals
        .filter(s => s.direction !== "NO_TRADE")
        .map(s => ({
          rank: 0,
          symbol: s.symbol,
          name: s.name,
          sector: s.sector,
          type: "EQ" as const,
          direction: s.direction,
          mode: "EQUITY_SWING" as const,
          entry: s.entry,
          stopLoss: s.stopLoss,
          tp1: s.target1,
          tp2: s.target2,
          tp3: null,
          rr: s.riskReward,
          probability: s.confidence,
          stars: Math.round(s.confidence / 20),
          side: s.direction,
          holdingPeriod: s.holdingPeriod,
          instrument: `${s.symbol} EQ`,
          reasoning: [...s.reasoning, `Setup: ${s.setup.type}`],
          score: s.confidence,
          setupType: s.setup.type,
          premium: null,
          strike: null,
          expiry: "",
          // Real ATR-based expected move from the engine (a string), when it
          // produced one.
          expectedMoveText: s.expectedMove ?? null,
        })),
    ];

    // Sort by score descending
    allCandidates.sort((a, b) => b.score - a.score);

    // Assign ranks
    allCandidates.forEach((c, i) => { c.rank = i + 1; });

    // Take top 5
    const top = allCandidates.slice(0, 5);

    const clock = await getMarketClock();
    const meta = buildCardMeta({
      source: "nse",
      providerTimestamp: clock.tradeDate,
      ttlMs: 15 * 60_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    return NextResponse.json({
      success: true,
      status: meta.status,
      meta,
      symbol: "ALL",
      // null (not 0) — there is no single expected move for "ALL".
      expectedMove: null,
      top,
      summary: {
        totalScanned: allCandidates.length,
        indexFO: indexSignals.filter(s => s.direction !== "NO_TRADE").length,
        stockFO: stockSignals.filter(s => s.direction !== "NO_TRADE").length,
        equitySwing: swingSignals.filter(s => s.direction !== "NO_TRADE").length,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "today-trades failed" }, { status: 500 });
  }
}
