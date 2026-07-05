// Agent API — Pattern-matching trading assistant (no LLM needed)

import { NextRequest, NextResponse } from "next/server";
import { agentRespond, type AgentContext } from "@/lib/agent-engine";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/market-session";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, symbol, spotPrice, analysis, summary, gammaBlast, expiryDate } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    // Fetch trade journal from DB
    let trades: any[] = [];
    try {
      const dbTrades = await db.trade.findMany({
        orderBy: { entryTime: "desc" },
        take: 100,
      });
      trades = dbTrades;
    } catch {
      trades = [];
    }

    // Get market session
    const session = getCurrentSession();

    const sym = symbol || "NIFTY";

    // Use pattern matcher directly (fast, no LLM needed)
    const ctx: AgentContext = {
      symbol: sym,
      spotPrice: spotPrice || 0,
      analysis: analysis || null,
      trades,
      session,
      summary: summary || null,
      gammaBlast: gammaBlast || null,
      expiryDate: expiryDate || "",
    };

    const response = agentRespond(ctx, message);

    return NextResponse.json({
      response,
      toolCallsMade: [],
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Agent error" },
      { status: 500 }
    );
  }
}
