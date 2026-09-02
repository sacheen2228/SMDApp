// ═══════════════════════════════════════════════════════════════════════════
// /api/trade-intelligence — Unified Trade Intelligence API
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { buildUnifiedRanking } from "@/lib/trade-intelligence/unified-ranking";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";
import { analyzeStockFO } from "@/lib/trade-intelligence/stock-fo-mode";
import { analyzeEquitySwing } from "@/lib/trade-intelligence/equity-swing-mode";
import {
  registerTrade,
  updateTrade,
  getActiveTrades,
  getAllTrades,
  getTrackingStats,
  cleanupTrades,
} from "@/lib/trade-intelligence/trade-tracker";

// ── GET /api/trade-intelligence ──
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "ranking";
    const mode = searchParams.get("mode"); // INDEX_FO, STOCK_FO, EQUITY_SWING
    const forceRefresh = searchParams.get("force") === "true";

    switch (action) {
      case "ranking": {
        // Full unified ranking
        const ctx = await buildMarketIntelligenceContext(forceRefresh);
        const ranking = await buildUnifiedRanking(ctx);
        return NextResponse.json({
          success: true,
          data: ranking,
        });
      }

      case "context": {
        // Just the market context
        const ctx = await buildMarketIntelligenceContext(forceRefresh);
        return NextResponse.json({
          success: true,
          data: ctx,
        });
      }

      case "index-fo": {
        const ctx = await buildMarketIntelligenceContext(forceRefresh);
        const signals = await analyzeIndexFO(ctx);
        return NextResponse.json({
          success: true,
          data: { signals, context: ctx },
        });
      }

      case "stock-fo": {
        const ctx = await buildMarketIntelligenceContext(forceRefresh);
        const signals = await analyzeStockFO(ctx);
        return NextResponse.json({
          success: true,
          data: { signals, context: ctx },
        });
      }

      case "equity-swing": {
        const ctx = await buildMarketIntelligenceContext(forceRefresh);
        const signals = await analyzeEquitySwing(ctx);
        return NextResponse.json({
          success: true,
          data: { signals, context: ctx },
        });
      }

      case "trades": {
        const trades = getActiveTrades();
        return NextResponse.json({
          success: true,
          data: { trades, stats: getTrackingStats() },
        });
      }

      case "all-trades": {
        const trades = getAllTrades();
        return NextResponse.json({
          success: true,
          data: { trades, stats: getTrackingStats() },
        });
      }

      case "stats": {
        return NextResponse.json({
          success: true,
          data: getTrackingStats(),
        });
      }

      case "cleanup": {
        const removed = cleanupTrades();
        return NextResponse.json({
          success: true,
          data: { removed, stats: getTrackingStats() },
        });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action. Use: ranking, context, index-fo, stock-fo, equity-swing, trades, stats" },
          { status: 400 }
        );
    }
  } catch (error: any) {
    console.error("Trade Intelligence API error:", error);
    return NextResponse.json(
      { error: error.message || "Internal error" },
      { status: 500 }
    );
  }
}

// ── POST /api/trade-intelligence ──
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, setup, tradeId, currentPrice, marketConditions } = body;

    switch (action) {
      case "register": {
        if (!setup) {
          return NextResponse.json({ error: "setup required" }, { status: 400 });
        }
        const trade = registerTrade(setup, currentPrice || setup.entry);
        return NextResponse.json({ success: true, data: trade });
      }

      case "update": {
        if (!tradeId || currentPrice === undefined) {
          return NextResponse.json({ error: "tradeId and currentPrice required" }, { status: 400 });
        }
        const trade = updateTrade(tradeId, currentPrice, marketConditions);
        if (!trade) {
          return NextResponse.json({ error: "Trade not found or inactive" }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: trade });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action. Use: register, update" },
          { status: 400 }
        );
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
