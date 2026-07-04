// Agent API — AI-powered trading assistant with tools + conversation memory

import { NextRequest, NextResponse } from "next/server";
import { agentRespond, type AgentContext } from "@/lib/agent-engine";
import { agentRespondLLM } from "@/lib/agent-brain";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/market-session";
import type { LLMMessage } from "@/lib/llm-client";

// In-memory conversation store (per symbol, last 20 messages)
const conversationStore = new Map<string, LLMMessage[]>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, symbol, spotPrice, analysis, summary, gammaBlast, expiryDate, history } = body;

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

    // Get or create conversation history
    if (!conversationStore.has(sym)) {
      conversationStore.set(sym, []);
    }
    const conversationHistory = conversationStore.get(sym)!;

    // Add user message to history
    conversationHistory.push({ role: "user", content: message });

    // Keep only last 20 messages to avoid token limits
    while (conversationHistory.length > 20) {
      conversationHistory.shift();
    }

    // Try LLM first, fall back to pattern matching
    let response: string;
    let toolCallsMade: string[] = [];

    try {
      const llmResult = await agentRespondLLM(message, {
        symbol: sym,
        spotPrice: spotPrice || 0,
        analysis: analysis || null,
        summary: summary || null,
        expiryDate: expiryDate || "",
        session,
        trades,
        conversationHistory,
      });
      response = llmResult.response;
      toolCallsMade = llmResult.toolCallsMade;
    } catch (llmError: any) {
      // LLM failed — fall back to pattern matching
      console.warn("[Agent] LLM failed, using pattern matcher:", llmError.message);
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
      response = agentRespond(ctx, message);
    }

    // Add assistant response to history
    conversationHistory.push({ role: "assistant", content: response });

    return NextResponse.json({
      response,
      toolCallsMade,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Agent error" },
      { status: 500 }
    );
  }
}
