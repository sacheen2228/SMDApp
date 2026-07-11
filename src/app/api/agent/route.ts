// Agent API — AI-powered trading assistant with tools + conversation memory

import { NextRequest, NextResponse } from "next/server";
import { agentRespond, type AgentContext } from "@/lib/agent-engine";
import { agentRespondLLM } from "@/lib/agent-brain";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/market-session";
import { sendTradeAlert } from "@/lib/telegram";
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
    const { 
      message, 
      symbol, 
      spotPrice, 
      analysis, 
      summary, 
      gammaBlast, 
      expiryDate, 
      history,
      // Dashboard data
      dashboardTrades,
      dashboardChain,
      dashboardSignal,
      dashboardSpot,
      dashboardAtm,
      dashboardExpiry,
      dashboardVix,
      dashboardPcr,
      dashboardFii,
      dashboardDii,
      dashboardSupport,
      dashboardResistance,
      dashboardMaxPain,
      dashboardChainData,
    } = body;

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

    // Detect if user is asking about a different symbol than what page shows
    const msgLower = message.toLowerCase();
    let detectedSymbol = sym;
    if (msgLower.includes("sensex")) detectedSymbol = "SENSEX";
    else if (msgLower.includes("banknifty") || msgLower.includes("bank nifty")) detectedSymbol = "BANKNIFTY";
    else if (msgLower.includes("finnifty") || msgLower.includes("fin nifty")) detectedSymbol = "FINNIFTY";
    else if (msgLower.includes("midcap") || msgLower.includes("mid cap")) detectedSymbol = "MIDCPNIFTY";
    else if (msgLower.includes("nifty")) detectedSymbol = "NIFTY";

    // Get or create conversation history
    const conversationHistory = getConversation(detectedSymbol);

    // Add user message to history
    conversationHistory.push({ role: "user", content: message });

    // Keep only last 20 messages to avoid token limits
    while (conversationHistory.length > MAX_MESSAGES) {
      conversationHistory.shift();
    }

    // Try LLM first, fall back to pattern matching
    let response: string;
    let toolCallsMade: string[] = [];

    // Fetch all data sources in parallel
    let sdmSignal: any = null;
    let giftNifty: any = null;
    let correlation: any = null;
    let scanner: any = null;
    let freshAnalysis = analysis || null;
    let freshSummary = summary || null;
    let freshSpotPrice = spotPrice || 0;

    const [sdmResult, chainResult, giftResult, corrResult, scanResult] = await Promise.allSettled([
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/sdm-signal?symbol=${detectedSymbol}`, { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(d => d.success ? d.signal : null)
        .catch(() => null),
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/option-chain?symbol=${detectedSymbol}`, { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(d => {
          if (d.success && d.analysis) {
            const innerData = d.data?.data ? d.data : d;
            return {
              analysis: d.analysis,
              summary: innerData.summary || d.data?.summary || null,
              spotPrice: innerData.spotPrice || d.data?.spotPrice || innerData.summary?.spotPrice || 0,
            };
          }
          return null;
        })
        .catch(() => null),
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/gift-nifty`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.json())
        .then(d => d.success ? d.data : null)
        .catch(() => null),
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/correlation`, { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(d => d.success ? d : null)
        .catch(() => null),
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/scanner?symbol=${detectedSymbol}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.json())
        .then(d => d.success ? d.data : null)
        .catch(() => null),
    ]);

    if (sdmResult.status === "fulfilled" && sdmResult.value) sdmSignal = sdmResult.value;
    if (chainResult.status === "fulfilled" && chainResult.value) {
      freshAnalysis = chainResult.value.analysis;
      freshSummary = chainResult.value.summary || freshSummary;
      freshSpotPrice = chainResult.value.spotPrice || freshSpotPrice;
    }
    if (giftResult.status === "fulfilled" && giftResult.value) giftNifty = giftResult.value;
    if (corrResult.status === "fulfilled" && corrResult.value) correlation = corrResult.value;
    if (scanResult.status === "fulfilled" && scanResult.value) scanner = scanResult.value;

    // Use dashboard data if available (higher priority than fetched data)
    const dashTrades = dashboardTrades || [];
    const dashChain = dashboardChain || [];
    const dashSignal = dashboardSignal;
    const dashSpot = dashboardSpot || freshSpotPrice;
    const dashAtm = dashboardAtm;
    const dashExpiry = dashboardExpiry;
    const dashVix = dashboardVix;
    const dashPcr = dashboardPcr;
    const dashFii = dashboardFii;
    const dashDii = dashboardDii;
    const dashSupport = dashboardSupport;
    const dashResistance = dashboardResistance;
    const dashMaxPain = dashboardMaxPain;
    const dashChainData = dashboardChainData;

    // Build context for LLM with dashboard data
    const dashboardContext = dashTrades.length > 0 ? `
=== DASHBOARD TRADES (${dashTrades.length} trades) ===
${dashTrades.map((t: any) => `#${t.rank || 0} ${t.instrument} ${t.direction} @ ${t.strike} | Entry: ${t.entry} | SL: ${t.sl} | TP1: ${t.tp1} | TP2: ${t.tp2} | TP3: ${t.tp3} | Grade: ${t.grade} | Score: ${t.score} | Moneyness: ${t.moneyness} | Reasons: ${t.reasons?.join(", ")}`).join("\n")}

=== OPTION CHAIN (${dashChainData?.length || 0} strikes) ===
${dashChainData?.slice(0, 10).map((r: any) => `${r.strike} | Call OI: ${r.callOI}K Chg: ${r.callChg} LTP: ${r.callLTP} Δ: ${r.callDelta} | Put OI: ${r.putOI}K Chg: ${r.putChg} LTP: ${r.putLTP} Δ: ${r.putDelta} | Signal: ${r.signal}`).join("\n") || "No chain data"}

=== MARKET CONTEXT ===
Spot: ${dashSpot} | ATM: ${dashAtm} | Expiry: ${dashExpiry || "Current Weekly"}
VIX: ${dashVix} | PCR: ${dashPcr} | Max Pain: ${dashMaxPain}
FII: ${dashFii >= 0 ? "+" : ""}${dashFii} Cr | DII: ${dashDii >= 0 ? "+" : ""}${dashDii} Cr
Support: ${dashSupport} | Resistance: ${dashResistance}

=== SIGNAL ===
${dashSignal ? `Bias: ${dashSignal.marketBias} | Action: ${dashSignal.recommendation?.action} | Confidence: ${dashSignal.confidence?.total || 0}% | Strike: ${dashSignal.recommendation?.strike} | Entry: ${dashSignal.recommendation?.entry} | SL: ${dashSignal.recommendation?.stopLoss} | TP1: ${dashSignal.recommendation?.target1} | TP2: ${dashSignal.recommendation?.target2} | TP3: ${dashSignal.recommendation?.target3} | Reasons: ${dashSignal.recommendation?.reasons?.join(", ")}` : "No signal available"}
` : "";

    try {
      const llmResult = await agentRespondLLM(message, {
        symbol: detectedSymbol,
        spotPrice: freshSpotPrice,
        analysis: freshAnalysis,
        summary: freshSummary,
        expiryDate: expiryDate || "",
        session,
        trades,
        conversationHistory,
        sdmSignal,
        giftNifty,
        correlation,
        scanner,
        // Dashboard data
        dashboardContext,
        dashboardTrades: dashTrades,
        dashboardChain: dashChain,
        dashboardSignal: dashSignal,
        dashboardSpot: dashSpot,
        dashboardAtm: dashAtm,
        dashboardExpiry: dashExpiry,
        dashboardVix: dashVix,
        dashboardPcr: dashPcr,
        dashboardFii: dashFii,
        dashboardDii: dashDii,
        dashboardSupport: dashSupport,
        dashboardResistance: dashResistance,
        dashboardMaxPain: dashMaxPain,
        dashboardChainData: dashChainData,
      });
      response = llmResult.response;
      toolCallsMade = llmResult.toolCallsMade;
    } catch (llmError: any) {
      // LLM failed — fall back to pattern matching
      console.warn("[Agent] LLM failed, using pattern matcher:", llmError.message);
      const ctx: AgentContext = {
        symbol: detectedSymbol,
        spotPrice: freshSpotPrice,
        analysis: freshAnalysis,
        trades,
        session,
        summary: summary || null,
        gammaBlast: gammaBlast || null,
        expiryDate: expiryDate || "",
        correlation,
      };
      response = agentRespond(ctx, message);
    }

    // Send Telegram alert if agent generated a trade recommendation
    if (toolCallsMade.includes("get_trade_recommendation") && sdmSignal) {
      const signal = sdmSignal;
      const alertConf = typeof signal.confidence === "object" ? signal.confidence?.total ?? 0 : signal.confidence || 0;
      sendTradeAlert({
        symbol: signal.symbol || detectedSymbol,
        action: signal.action || signal.recommendation?.action || "HOLD",
        strike: signal.strike || signal.recommendation?.strike || freshSpotPrice,
        type: signal.optionType || signal.recommendation?.strikeType || "OPTION",
        confidence: alertConf,
        entry: signal.entry || signal.recommendation?.entry,
        stopLoss: signal.stopLoss || signal.recommendation?.stopLoss,
        target1: signal.target1 || signal.recommendation?.target1,
        target2: signal.target2 || signal.recommendation?.target2,
        source: "🤖 SDM Agent",
      }).catch(() => {});
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