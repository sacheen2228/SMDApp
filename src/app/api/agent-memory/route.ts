// Agent Memory API — REST endpoint for Hermes Agent memory
// GET /api/agent-memory — get memory summary
// GET /api/agent-memory?action=trades — search trade patterns
// GET /api/agent-memory?action=setups — get best setups
// GET /api/agent-memory?action=predictions — get prediction accuracy
// GET /api/agent-memory?action=preferences — get user preferences
// GET /api/agent-memory?action=alerts — get alert history
// POST /api/agent-memory — record trade/memory
// PATCH /api/agent-memory — update preferences

import { NextRequest, NextResponse } from "next/server";
import {
  getMemorySummary,
  searchTradePatterns,
  getBestSetups,
  getPredictionAccuracy,
  getUserPreferences,
  updateUserPreferences,
  getAlertHistory,
  recordTrade,
  recordPrediction,
  recordAlert,
  acknowledgeAlert,
} from "@/lib/agent-memory";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") || "summary";
    const query = searchParams.get("q") || "";
    const symbol = searchParams.get("symbol") || undefined;
    const limit = parseInt(searchParams.get("limit") || "30");

    switch (action) {
      case "summary":
        return NextResponse.json({ success: true, data: getMemorySummary() });

      case "trades":
        return NextResponse.json({
          success: true,
          data: query
            ? searchTradePatterns(query, limit)
            : searchTradePatterns(symbol || "", limit),
        });

      case "setups":
        return NextResponse.json({
          success: true,
          data: getBestSetups(symbol, 3),
        });

      case "predictions":
        return NextResponse.json({
          success: true,
          data: getPredictionAccuracy(symbol),
        });

      case "preferences":
        return NextResponse.json({
          success: true,
          data: getUserPreferences(),
        });

      case "alerts":
        return NextResponse.json({
          success: true,
          data: getAlertHistory(undefined, limit),
        });

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type } = body;

    switch (type) {
      case "trade":
        recordTrade({
          symbol: body.symbol,
          strategy: body.strategy,
          setup: body.setup,
          entry: { price: body.entryPrice, time: new Date().toISOString() },
          exit: body.exitPrice
            ? { price: body.exitPrice, time: new Date().toISOString(), pnl: body.pnl || 0 }
            : undefined,
          tags: body.tags || [],
          confidence: body.confidence || 0.5,
        });
        return NextResponse.json({ success: true });

      case "prediction":
        recordPrediction({
          symbol: body.symbol,
          direction: body.direction,
          basis: body.basis,
          entryPrice: body.entryPrice,
          targetPrice: body.targetPrice,
          stopLoss: body.stopLoss,
        });
        return NextResponse.json({ success: true });

      case "alert":
        recordAlert({
          type: body.alertType,
          symbol: body.symbol,
          message: body.message,
          severity: body.severity || "INFO",
        });
        return NextResponse.json({ success: true });

      default:
        return NextResponse.json({ error: "Unknown type" }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { type } = body;

    if (type === "preferences") {
      updateUserPreferences(body);
      return NextResponse.json({ success: true });
    }

    if (type === "alert") {
      acknowledgeAlert(body.id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
