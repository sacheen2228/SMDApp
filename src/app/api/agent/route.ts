// Agent API — AI-powered trading assistant with tools + conversation memory

import { NextRequest, NextResponse } from "next/server";
import { agentRespond, type AgentContext } from "@/lib/agent-engine";
import { agentRespondLLM } from "@/lib/agent-brain";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/market-session";
import type { LLMMessage } from "@/lib/llm-client";

// In-memory conversation store (per symbol, last 20 messages, max 50 symbols)
const conversationStore = new Map<string, { messages: LLMMessage[]; lastAccess: number }>();
const MAX_SYMBOLS = 50;
const MAX_MESSAGES = 20;

function getConversation(sym: string): LLMMessage[] {
  const now = Date.now();
  const existing = conversationStore.get(sym);
  if (existing) {
    existing.lastAccess = now;
    return existing.messages;
  }
  // Evict oldest if at capacity
  if (conversationStore.size >= MAX_SYMBOLS) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [key, val] of conversationStore) {
      if (val.lastAccess < oldestTime) {
        oldestTime = val.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) conversationStore.delete(oldestKey);
  }
  const messages: LLMMessage[] = [];
  conversationStore.set(sym, { messages, lastAccess: now });
  return messages;
}

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
    const conversationHistory = getConversation(sym);

    // Add user message to history
    conversationHistory.push({ role: "user", content: message });

    // Keep only last 20 messages to avoid token limits
    while (conversationHistory.length > MAX_MESSAGES) {
      conversationHistory.shift();
    }

    // Try LLM first, fall back to pattern matching
    let response: string;
    let toolCallsMade: string[] = [];

    // Fetch ORCA signal for context
    let orcaSignal: any = null;
    try {
      const orcaRes = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/orca?symbol=${sym}`, { signal: AbortSignal.timeout(15000) });
      const orcaData = await orcaRes.json();
      if (orcaData.success) orcaSignal = orcaData.signal;
    } catch {
      // ORCA fetch failed — continue without it
    }

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
        orcaSignal,
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
