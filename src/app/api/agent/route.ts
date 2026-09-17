// Agent API — AI-powered trading assistant with tools + conversation memory
// Phase 2: Hermes Agent Integration — SMDContext + Memory + Logging
// Phase 3: Hermes Pro — deterministic trade orchestration layer

import { NextRequest, NextResponse } from "next/server";
import { agentRespond, type AgentContext } from "@/lib/agent-engine";
import { agentRespondLLM } from "@/lib/agent-brain";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/market-session";
import { sendTradeAlert } from "@/lib/telegram";
import { scoreTrade, type MarketDataInput, type StrategyProfile } from "@/lib/unified-scoring-engine";
import type { LLMMessage } from "@/lib/llm-client";
import { buildSMDContext, summarizeContext, type SMDContext } from "@/lib/smd-context";
import { recordTrade, getMemorySummary } from "@/lib/agent-memory";
import { logToolCall, logLLMCall, logAgentError, logConversation } from "@/lib/agent-logger";
import { fetchFiiDiiData } from "@/lib/fii-dii";
import { hermesPro, hermesProFormatted } from "@/lib/hermes/agent";
import type { HermesDecision } from "@/lib/hermes/types";

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
    const queryLower = message.toLowerCase();
    let detectedSymbol = sym;
    if (queryLower.includes("sensex")) detectedSymbol = "SENSEX";
    else if (queryLower.includes("banknifty") || queryLower.includes("bank nifty")) detectedSymbol = "BANKNIFTY";
    else if (queryLower.includes("finnifty") || queryLower.includes("fin nifty")) detectedSymbol = "FINNIFTY";
    else if (queryLower.includes("midcap") || queryLower.includes("mid cap")) detectedSymbol = "MIDCPNIFTY";
    else if (queryLower.includes("nifty")) detectedSymbol = "NIFTY";

    // Get or create conversation history
    const conversationHistory = getConversation(detectedSymbol);

    // Add user message to history
    conversationHistory.push({ role: "user", content: message });

    // Keep only last 20 messages to avoid token limits
    while (conversationHistory.length > MAX_MESSAGES) {
      conversationHistory.shift();
    }

    // ═══════════════════════════════════════════════════════════
    // EARLY EXIT: Direct FII/DII response (no LLM needed)
    // ═══════════════════════════════════════════════════════════
    if (/fii|dii|institution|fund.?flow|foreign.?institution|domestic.?institution/i.test(queryLower) && !/option|greek|strike|chain|premium|edge|greeks?/i.test(queryLower)) {
      try {
        const fiiResult = await fetchFiiDiiData();
        const f = fiiResult.latest;
        if (f && (f.fiiNet !== undefined || f.fiiBuy !== undefined)) {
          const trend = fiiResult.history?.length > 1 ? fiiResult.history.slice(0, 5) : [];
          const fiiTrend5d = trend.length > 0 ? trend.reduce((s: number, h: any) => s + (h.fiiNet || 0), 0) : 0;
          const diiTrend5d = trend.length > 0 ? trend.reduce((s: number, h: any) => s + (h.diiNet || 0), 0) : 0;
          let resp = `## FII/DII Cash Market Flows\n**Date:** ${f.date} | **Source:** ${f.source?.toUpperCase() || "NSE"}\n\n`;
          resp += `| Category | Net (₹ Cr) | Buy (₹ Cr) | Sell (₹ Cr) |\n|----------|-----------|-----------|------------|\n`;
          resp += `| **FII/FPI** | ${f.fiiNet >= 0 ? "+" : ""}${f.fiiNet.toFixed(2)} | ${f.fiiBuy.toFixed(2)} | ${f.fiiSell.toFixed(2)} |\n`;
          resp += `| **DII** | ${f.diiNet >= 0 ? "+" : ""}${f.diiNet.toFixed(2)} | ${f.diiBuy.toFixed(2)} | ${f.diiSell.toFixed(2)} |\n\n`;
          resp += `**5-Day Trend:** FII ${fiiTrend5d >= 0 ? "+" : ""}${fiiTrend5d.toFixed(1)} Cr | DII ${diiTrend5d >= 0 ? "+" : ""}${diiTrend5d.toFixed(1)} Cr\n`;
          resp += `**Bias:** ${f.fiiNet > 0 ? "FII buying" : "FII selling"} | ${f.diiNet > 0 ? "DII buying" : "DII selling"}\n`;

          if (fiiResult.participantOI) {
            const poi = fiiResult.participantOI;
            const fiiNetOI = (poi.fii.totalLong || 0) - (poi.fii.totalShort || 0);
            const diiNetOI = (poi.dii.totalLong || 0) - (poi.dii.totalShort || 0);
            const proNetOI = (poi.pro.totalLong || 0) - (poi.pro.totalShort || 0);
            const clientNetOI = (poi.client.totalLong || 0) - (poi.client.totalShort || 0);
            resp += `\n## Participant OI (F&O) — ${poi.date}\n`;
            resp += `| Participant | Bias | Index Long/Short | Stock Long/Short |\n|------------|------|-----------------|------------------|\n`;
            resp += `| **FII** | ${fiiNetOI > 0 ? "LONG" : "SHORT"} | ${poi.fii.indexLong.toLocaleString()} / ${poi.fii.indexShort.toLocaleString()} | ${poi.fii.stockLong.toLocaleString()} / ${poi.fii.stockShort.toLocaleString()} |\n`;
            resp += `| **DII** | ${diiNetOI > 0 ? "LONG" : "SHORT"} | ${poi.dii.indexLong.toLocaleString()} / ${poi.dii.indexShort.toLocaleString()} | ${poi.dii.stockLong.toLocaleString()} / ${poi.dii.stockShort.toLocaleString()} |\n`;
            resp += `| **Pro** | ${proNetOI > 0 ? "LONG" : "SHORT"} | ${poi.pro.indexLong.toLocaleString()} / ${poi.pro.indexShort.toLocaleString()} | ${poi.pro.stockLong.toLocaleString()} / ${poi.pro.stockShort.toLocaleString()} |\n`;
            resp += `| **Client** | ${clientNetOI > 0 ? "LONG" : "SHORT"} | ${poi.client.indexLong.toLocaleString()} / ${poi.client.indexShort.toLocaleString()} | ${poi.client.stockLong.toLocaleString()} / ${poi.client.stockShort.toLocaleString()} |\n`;

            if (fiiNetOI > 0 && diiNetOI > 0) resp += `\n**Both FII and DII are net LONG** — strong institutional conviction.`;
            else if (fiiNetOI < 0 && diiNetOI < 0) resp += `\n**Both FII and DII are net SHORT** — institutional hedging/protection mode.`;
            else if (fiiNetOI < 0 && diiNetOI > 0) resp += `\n**FII short, DII long** — FII hedging while DII absorbs. Watch for short covering rally.`;
            else if (fiiNetOI > 0 && diiNetOI < 0) resp += `\n**FII long, DII short** — DII profit-taking while FII accumulates.`;
          }

          conversationHistory.push({ role: "assistant", content: resp });
          return NextResponse.json({ response: resp, toolCallsMade: ["fii_dii_direct"] });
        }
      } catch {}
    }

    // EARLY EXIT: VIX data (direct, no LLM) — fetch from Yahoo Finance directly
    if (/vix|volatil/i.test(queryLower)) {
      try {
        const vixRes = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1d&range=1d", {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        const vixJson = await vixRes.json();
        const vix = vixJson?.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
        if (vix > 0) {
          const regime = vix > 25 ? "HIGH VOLATILITY" : vix > 15 ? "NORMAL" : "LOW VOLATILITY";
          const pctile = vix > 30 ? "EXTREME" : vix > 20 ? "ELEVATED" : vix > 12 ? "NORMAL" : "LOW";
          const resp = `## India VIX\n**VIX:** ${vix.toFixed(2)} | **Regime:** ${regime} | **Percentile:** ${pctile}\n\n${vix > 25 ? "⚠️ High volatility — options expensive, expect wider ranges." : vix < 12 ? "🟢 Low volatility — options cheap, potential for breakout move." : "📊 Normal volatility — standard trading conditions."}`;
          conversationHistory.push({ role: "assistant", content: resp });
          return NextResponse.json({ response: resp, toolCallsMade: ["vix_direct"] });
        }
      } catch {}
    }

    // EARLY EXIT: Market regime + breadth (direct, no LLM) — uses Yahoo Finance
    if (/regime|breadth|trend|range|market.?health|advance.?decline/i.test(queryLower)) {
      try {
        const [niftyRes, vixRes] = await Promise.allSettled([
          fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1d&range=5d", {
            headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000),
          }),
          fetch("https://query1.finance.yahoo.com/v8/finance/chart/^NSEI?interval=1d&range=5d", {
            headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000),
          }),
        ]);
        let resp = "## Market Intelligence\n";
        let hasData = false;
        if (niftyRes.status === "fulfilled" && niftyRes.value.ok) {
          const v = await niftyRes.value.json();
          const vix = v?.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
          if (vix > 0) {
            const regime = vix > 25 ? "HIGH VOLATILITY" : vix > 15 ? "NORMAL" : "LOW VOLATILITY";
            resp += `**VIX Regime:** ${vix.toFixed(2)} — ${regime}\n`;
            hasData = true;
          }
        }
        if (vixRes.status === "fulfilled" && vixRes.value.ok) {
          const n = await vixRes.value.json();
          const meta = n?.chart?.result?.[0]?.meta;
          if (meta) {
            const price = meta.regularMarketPrice || 0;
            const prevClose = meta.previousClose || meta.chartPreviousClose || 0;
            const change = price && prevClose ? ((price - prevClose) / prevClose * 100) : 0;
            resp += `**NIFTY 50:** ${price.toFixed(0)} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)\n`;
            resp += `**Trend:** ${change > 1 ? "BULLISH" : change < -1 ? "BEARISH" : "RANGE-BOUND"}\n`;
            hasData = true;
          }
        }
        if (hasData) {
          conversationHistory.push({ role: "assistant", content: resp });
          return NextResponse.json({ response: resp, toolCallsMade: ["regime_direct"] });
        }
      } catch {}
    }

    // EARLY EXIT: News sentiment (direct, no LLM) — uses Google News RSS
    if (/news|sentiment|headline/i.test(queryLower)) {
      try {
        const newsRes = await fetch(
          `https://news.google.com/rss/search?q=${encodeURIComponent(detectedSymbol + " stock market India")}&hl=en-IN&gl=IN&ceid=IN:en`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) }
        );
        const xml = await newsRes.text();
        const items = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/item>/g)].slice(0, 5);
        if (items.length > 0) {
          let resp = `## Market News — ${detectedSymbol}\n\n`;
          for (const m of items) {
            const title = m[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
            if (title) resp += `📰 **${title.slice(0, 100)}**\n`;
          }
          conversationHistory.push({ role: "assistant", content: resp });
          return NextResponse.json({ response: resp, toolCallsMade: ["news_direct"] });
        }
      } catch {}
    }

    // EARLY EXIT: Trade history / journal (direct, no LLM)
    if (/trade.?history|journal|position|my.?trade|open.?position/i.test(queryLower)) {
      try {
        const trades = await db.trade.findMany({ orderBy: { entryTime: "desc" }, take: 10 });
        if (trades.length > 0) {
          let resp = `## Trade Journal — Last ${trades.length} Trades\n\n`;
          resp += `| # | Symbol | Type | Entry | Exit | P&L | Status |\n|---|--------|------|-------|------|-----|--------|\n`;
          for (const t of trades) {
            const pnl = t.pnl ? `₹${t.pnl.toFixed(0)}` : "—";
            const status = t.status || "open";
            resp += `| ${t.id} | ${t.symbol} | ${t.tradeType || t.type || "?"} | ₹${t.entryPrice?.toFixed(0) || "?"} | ${t.exitPrice ? "₹" + t.exitPrice.toFixed(0) : "—"} | ${pnl} | ${status} |\n`;
          }
          const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
          resp += `\n**Total P&L:** ₹${totalPnl.toFixed(0)} | **Wins:** ${trades.filter(t => (t.pnl || 0) > 0).length}/${trades.length}`;
          conversationHistory.push({ role: "assistant", content: resp });
          return NextResponse.json({ response: resp, toolCallsMade: ["journal_direct"] });
        }
      } catch {}
    }

    // Try LLM first, fall back to pattern matching
    let response: string;

    // Fetch all data sources in parallel
    let sdmSignal: any = null;
    let giftNifty: any = null;
    let correlation: any = null;
    let scanner: any = null;
    let freshAnalysis = analysis || null;
    let freshSummary = summary || null;
    let freshSpotPrice = spotPrice || 0;

    const origin = new URL(req.url).origin;
    const [sdmResult, chainResult, giftResult, corrResult, scanResult] = await Promise.allSettled([
      fetch(`${origin}/api/sdm-signal?symbol=${detectedSymbol}`, { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(d => d.success ? d.signal : null)
        .catch(() => null),
      fetch(`${origin}/api/option-chain?symbol=${detectedSymbol}`, { signal: AbortSignal.timeout(10000) })
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
      fetch(`${origin}/api/gift-nifty`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.json())
        .then(d => d.success ? d.data : null)
        .catch(() => null),
      fetch(`${origin}/api/correlation`, { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(d => d.success ? d : null)
        .catch(() => null),
      fetch(`${origin}/api/scanner?symbol=${detectedSymbol}`, { signal: AbortSignal.timeout(30000) })
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

    // ═══════════════════════════════════════════════════════════
    // HERMES PRO: Deterministic trade orchestration
    // If Hermes produces a definitive trade decision, use it directly.
    // ═══════════════════════════════════════════════════════════
    let hermesDecision: HermesDecision | null = null;
    try {
      const hermesResult = await hermesPro(message, {
        symbol: detectedSymbol,
        spotPrice: freshSpotPrice,
        apiBase: origin,
      });
      hermesDecision = hermesResult;

      // If Hermes produced a definitive trade decision (not RESEARCH_ONLY), use it
      if (hermesResult.decision === "BUY_CE" || hermesResult.decision === "BUY_PE" || hermesResult.decision === "NO_TRADE") {
        const hermesResponse = hermesProFormatted(message, {
          symbol: detectedSymbol,
          spotPrice: freshSpotPrice,
          apiBase: origin,
        });

        // Store in conversation
        conversationHistory.push({ role: "assistant", content: hermesResponse });

        // Send Telegram alert for trade signals
        if ((hermesResult.decision === "BUY_CE" || hermesResult.decision === "BUY_PE") && hermesResult.candidate) {
          const c = hermesResult.candidate;
          sendTradeAlert({
            symbol: c.symbol,
            action: hermesResult.decision === "BUY_CE" ? "BUY CE" : "BUY PE",
            strike: c.strike,
            type: c.optionSide,
            confidence: c.confidence,
            entry: c.entry,
            stopLoss: c.stopLoss,
            target1: c.tp1,
            target2: c.tp2,
            source: "🤖 Hermes Pro",
          }).catch(() => {});
        }

        logConversation({
          conversationId: detectedSymbol,
          messageCount: conversationHistory.length,
          toolCallCount: hermesResult.toolsCalled.length,
          totalDurationMs: hermesResult.executionTimeMs,
          symbols: [detectedSymbol],
          actions: hermesResult.toolsCalled,
        });

        return NextResponse.json({
          response: hermesResponse,
          toolCallsMade: hermesResult.toolsCalled,
          hermesDecision,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (hermesError: any) {
      // Hermes failed — fall through to existing LLM flow
      console.warn("[Hermes Pro] Failed, falling through to LLM:", hermesError.message);
    }

    // Build context for LLM with dashboard data + FII/DII + participant OI
    let fiiDiiContext = "";
    try {
      const fiiResult = await fetchFiiDiiData();
      const f = fiiResult.latest;
      if (f && (f.fiiNet !== undefined || f.fiiBuy !== undefined)) {
        fiiDiiContext = `\nFII Cash: ${f.fiiNet >= 0 ? "+" : ""}${f.fiiNet} Cr (Buy: ₹${f.fiiBuy} Cr, Sell: ₹${f.fiiSell} Cr) | DII Cash: ${f.diiNet >= 0 ? "+" : ""}${f.diiNet} Cr (Buy: ₹${f.diiBuy} Cr, Sell: ₹${f.diiSell} Cr) | Date: ${f.date}`;
      }
      if (fiiResult.participantOI) {
        const poi = fiiResult.participantOI;
        const fiiNetOI = (poi.fii.totalLong || 0) - (poi.fii.totalShort || 0);
        const diiNetOI = (poi.dii.totalLong || 0) - (poi.dii.totalShort || 0);
        const proNetOI = (poi.pro.totalLong || 0) - (poi.pro.totalShort || 0);
        const clientNetOI = (poi.client.totalLong || 0) - (poi.client.totalShort || 0);
        fiiDiiContext += `\nParticipant OI (${poi.date}): FII=${fiiNetOI > 0 ? "LONG" : "SHORT"} DII=${diiNetOI > 0 ? "LONG" : "SHORT"} Pro=${proNetOI > 0 ? "LONG" : "SHORT"} Client=${clientNetOI > 0 ? "LONG" : "SHORT"}`;
      }
    } catch {}

    const dashboardContext = dashTrades.length > 0 ? `
=== DASHBOARD TRADES (${dashTrades.length} trades) ===
${dashTrades.map((t: any) => `#${t.rank || 0} ${t.instrument} ${t.direction} @ ${t.strike} | Entry: ${t.entry} | SL: ${t.sl} | TP1: ${t.tp1} | TP2: ${t.tp2} | TP3: ${t.tp3} | Grade: ${t.grade} | Score: ${t.score} | Moneyness: ${t.moneyness} | Reasons: ${t.reasons?.join(", ")}`).join("\n")}

=== OPTION CHAIN (${dashChainData?.length || 0} strikes) ===
${dashChainData?.slice(0, 10).map((r: any) => `${r.strike} | Call OI: ${r.callOI}K Chg: ${r.callChg} LTP: ${r.callLTP} Δ: ${r.callDelta} | Put OI: ${r.putOI}K Chg: ${r.putChg} LTP: ${r.putLTP} Δ: ${r.putDelta} | Signal: ${r.signal}`).join("\n") || "No chain data"}

=== MARKET CONTEXT ===
Spot: ${dashSpot} | ATM: ${dashAtm} | Expiry: ${dashExpiry || "Current Weekly"}
VIX: ${dashVix} | PCR: ${dashPcr} | Max Pain: ${dashMaxPain}
FII/DII: ${dashFii >= 0 ? "+" : ""}${dashFii} Cr / ${dashDii >= 0 ? "+" : ""}${dashDii} Cr${fiiDiiContext}
Support: ${dashSupport} | Resistance: ${dashResistance}

=== SIGNAL ===
${dashSignal ? `Bias: ${dashSignal.marketBias} | Action: ${dashSignal.recommendation?.action} | Confidence: ${dashSignal.confidence?.total || 0}% | Strike: ${dashSignal.recommendation?.strike} | Entry: ${dashSignal.recommendation?.entry} | SL: ${dashSignal.recommendation?.stopLoss} | TP1: ${dashSignal.recommendation?.target1} | TP2: ${dashSignal.recommendation?.target2} | TP3: ${dashSignal.recommendation?.target3} | Reasons: ${dashSignal.recommendation?.reasons?.join(", ")}` : "No signal available"}
` : "";

    // Compute unified score for agent context
    let unifiedScoreText = "";
    try {
      const direction = dashSignal?.marketBias === "BULLISH" ? "BULLISH" : dashSignal?.marketBias === "BEARISH" ? "BEARISH" : "NEUTRAL";
      if (direction !== "NEUTRAL" && dashSpot > 0) {
        const input: MarketDataInput = {
          symbol: detectedSymbol,
          strategy: "OPTIONS" as StrategyProfile,
          direction,
          spot: dashSpot,
          vix: dashVix || undefined,
          pcr: dashPcr || undefined,
          maxPain: dashMaxPain || undefined,
        };
        const decision = scoreTrade(input);
        unifiedScoreText = `\n=== UNIFIED SCORING ENGINE ===
Score: ${decision.score}/100 (${decision.grade})
Direction: ${decision.direction}
Hard Gates: ${decision.hardGateStatus.passed ? "ALL PASSED" : `FAILED: ${decision.hardGateStatus.failedGates.join(", ")}`}
Top Factors: ${decision.scoreBreakdown.filter(f => f.available && f.score >= 60).map(f => `${f.factor}=${f.score}`).join(", ")}
Decision: ${decision.decision}
Note: Score = setup quality (0-100), NOT probability.
`;
      }
    } catch {}

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Build SMDContext for cross-tab intelligence
    // ═══════════════════════════════════════════════════════════
    let smdContext: SMDContext | null = null;
    let smdContextText = "";
    try {
      smdContext = await buildSMDContext(detectedSymbol, origin);
      smdContextText = `\n=== SMD CROSS-TAB CONTEXT ===\n${summarizeContext(smdContext)}\n`;
    } catch (err: any) {
      console.warn("[Agent] SMDContext build failed:", err.message);
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Load memory summary for agent context
    // ═══════════════════════════════════════════════════════════
    let memoryText = "";
    try {
      memoryText = `\n=== AGENT MEMORY ===\n${getMemorySummary()}\n`;
    } catch {}

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Keyword-based pre-fetches (LLM won't call tools reliably)
    // Pre-fetch data based on query keywords and inject into context
    // ═══════════════════════════════════════════════════════════
    let extraContext = "";

    // Market regime / breadth
    if (/regime|breadth|trend|range|breakout|market.?health|advance.?decline/i.test(queryLower)) {
      try {
        const [regRes, brRes] = await Promise.allSettled([
          fetch(origin + "/api/market/regime?symbol=" + detectedSymbol, { signal: AbortSignal.timeout(8000) }),
          fetch(origin + "/api/market/breadth", { signal: AbortSignal.timeout(8000) }),
        ]);
        if (regRes.status === "fulfilled" && regRes.value.ok) {
          const r = await regRes.value.json();
          if (r.success) extraContext += `\n=== MARKET REGIME ===\nRegime: ${r.regime || "N/A"} | Bias: ${r.bias || "N/A"} | Confidence: ${r.confidence || 0}%\n`;
        }
        if (brRes.status === "fulfilled" && brRes.value.ok) {
          const b = await brRes.value.json();
          if (b.success) extraContext += `\n=== MARKET BREADTH ===\nAdvances: ${b.data?.advances || 0} | Declines: ${b.data?.declines || 0} | A/D Ratio: ${b.data?.adRatio || "N/A"}\n`;
        }
      } catch {}
    }

    // VIX
    if (/vix|volatil/i.test(queryLower)) {
      try {
        const vixRes = await fetch(origin + "/api/option-chain?symbol=NIFTY", { signal: AbortSignal.timeout(8000) });
        const vixData = await vixRes.json();
        const vix = vixData?.data?.summary?.indiaVIX || vixData?.data?.indiaVIX || 0;
        if (vix > 0) extraContext += `\n=== INDIA VIX ===\nVIX: ${vix} | Regime: ${vix > 25 ? "HIGH VOLATILITY" : vix > 15 ? "NORMAL" : "LOW VOLATILITY"} | Percentile: ${vix > 30 ? "EXTREME" : vix > 20 ? "ELEVATED" : vix > 12 ? "NORMAL" : "LOW"}\n`;
      } catch {}
    }

    // Expiry / CAS
    if (/cas|expiry|straddle|ibtr|auction|dislocat/i.test(queryLower)) {
      try {
        const casRes = await fetch(origin + "/api/market/regime?symbol=" + detectedSymbol, { signal: AbortSignal.timeout(8000) });
        const casData = await casRes.json();
        if (casData.success) extraContext += `\n=== CAS/EXPIRY ANALYSIS ===\nRegime: ${casData.regime || "N/A"} | Futures Basis: ${casData.futuresBasis ? "₹" + casData.futuresBasis.toFixed(2) : "N/A"} | Market: ${casData.marketCondition || "N/A"}\n`;
      } catch {}
    }

    // Risk / Portfolio
    if (/risk|portfolio|position|p&l|exposure|open.?trade/i.test(queryLower)) {
      try {
        const journalRes = await fetch(origin + "/api/trade-journal", { signal: AbortSignal.timeout(8000) });
        const journalData = await journalRes.json();
        const allTrades = journalData.trades || journalData || [];
        const open = Array.isArray(allTrades) ? allTrades.filter((t: any) => t.status === "OPEN") : [];
        const totalPnL = open.reduce((s: number, t: any) => s + (t.currentPnL || 0), 0);
        extraContext += `\n=== PORTFOLIO/RISK STATUS ===\nOpen positions: ${open.length}\nUnrealized P&L: ${totalPnL >= 0 ? "+" : ""}₹${totalPnL.toFixed(0)}\nCapital at risk: ${open.length > 0 ? "ACTIVE" : "NONE"}\n${open.map((t: any) => `- ${t.symbol} ${t.side || t.direction || ""} Entry: ₹${t.entryPrice || t.entry || "N/A"} P&L: ₹${(t.currentPnL || 0).toFixed(0)}`).join("\n")}\n`;
      } catch {}
    }

    // Memory / Past trades
    if (/memory|past.?trade|setup|pattern|learn|record|prediction/i.test(queryLower)) {
      try {
        const memRes = await fetch(origin + "/api/agent-memory", { signal: AbortSignal.timeout(8000) });
        const memData = await memRes.json();
        if (memData.success) extraContext += `\n=== AGENT MEMORY ===\n${memData.data}\n`;
      } catch {}
    }

    // ═══ DIRECT FII/DII RESPONSE (skip LLM — free models can't handle tools reliably)
    if (/fii|dii|institution|fund.?flow|foreign.?institution|domestic.?institution/i.test(queryLower) && !/option|greek|strike|chain|premium/i.test(queryLower)) {
      try {
        const fiiResult = await fetchFiiDiiData();
        const f = fiiResult.latest;
        if (f && (f.fiiNet !== undefined || f.fiiBuy !== undefined)) {
          const trend = fiiResult.history?.length > 1 ? fiiResult.history.slice(0, 5) : [];
          const fiiTrend5d = trend.length > 0 ? trend.reduce((s: number, h: any) => s + (h.fiiNet || 0), 0) : 0;
          const diiTrend5d = trend.length > 0 ? trend.reduce((s: number, h: any) => s + (h.diiNet || 0), 0) : 0;
          let resp = `## FII/DII Cash Market Flows\n**Date:** ${f.date} | **Source:** ${f.source?.toUpperCase() || "NSE"}\n\n`;
          resp += `| Category | Net (₹ Cr) | Buy (₹ Cr) | Sell (₹ Cr) |\n|----------|-----------|-----------|------------|\n`;
          resp += `| **FII/FPI** | ${f.fiiNet >= 0 ? "+" : ""}${f.fiiNet.toFixed(2)} | ${f.fiiBuy.toFixed(2)} | ${f.fiiSell.toFixed(2)} |\n`;
          resp += `| **DII** | ${f.diiNet >= 0 ? "+" : ""}${f.diiNet.toFixed(2)} | ${f.diiBuy.toFixed(2)} | ${f.diiSell.toFixed(2)} |\n\n`;
          resp += `**5-Day Trend:** FII ${fiiTrend5d >= 0 ? "+" : ""}${fiiTrend5d.toFixed(1)} Cr | DII ${diiTrend5d >= 0 ? "+" : ""}${diiTrend5d.toFixed(1)} Cr\n`;
          resp += `**Bias:** ${f.fiiNet > 0 ? "FII buying" : "FII selling"} | ${f.diiNet > 0 ? "DII buying" : "DII selling"}\n`;

          if (fiiResult.participantOI) {
            const poi = fiiResult.participantOI;
            const fiiNetOI = (poi.fii.totalLong || 0) - (poi.fii.totalShort || 0);
            const diiNetOI = (poi.dii.totalLong || 0) - (poi.dii.totalShort || 0);
            const proNetOI = (poi.pro.totalLong || 0) - (poi.pro.totalShort || 0);
            const clientNetOI = (poi.client.totalLong || 0) - (poi.client.totalShort || 0);
            resp += `\n## Participant OI (F&O) — ${poi.date}\n`;
            resp += `| Participant | Bias | Index Long/Short | Stock Long/Short |\n|------------|------|-----------------|------------------|\n`;
            resp += `| **FII** | ${fiiNetOI > 0 ? "🟢 LONG" : "🔴 SHORT"} | ${poi.fii.indexLong.toLocaleString()} / ${poi.fii.indexShort.toLocaleString()} | ${poi.fii.stockLong.toLocaleString()} / ${poi.fii.stockShort.toLocaleString()} |\n`;
            resp += `| **DII** | ${diiNetOI > 0 ? "🟢 LONG" : "🔴 SHORT"} | ${poi.dii.indexLong.toLocaleString()} / ${poi.dii.indexShort.toLocaleString()} | ${poi.dii.stockLong.toLocaleString()} / ${poi.dii.stockShort.toLocaleString()} |\n`;
            resp += `| **Pro** | ${proNetOI > 0 ? "🟢 LONG" : "🔴 SHORT"} | ${poi.pro.indexLong.toLocaleString()} / ${poi.pro.indexShort.toLocaleString()} | ${poi.pro.stockLong.toLocaleString()} / ${poi.pro.stockShort.toLocaleString()} |\n`;
            resp += `| **Client** | ${clientNetOI > 0 ? "🟢 LONG" : "🔴 SHORT"} | ${poi.client.indexLong.toLocaleString()} / ${poi.client.indexShort.toLocaleString()} | ${poi.client.stockLong.toLocaleString()} / ${poi.client.stockShort.toLocaleString()} |\n`;

            if (fiiNetOI > 0 && diiNetOI > 0) resp += `\n⚡ **Both FII and DII are net LONG** — strong institutional conviction.`;
            else if (fiiNetOI < 0 && diiNetOI < 0) resp += `\n⚠️ **Both FII and DII are net SHORT** — institutional hedging/protection mode.`;
            else if (fiiNetOI < 0 && diiNetOI > 0) resp += `\n📊 **FII short, DII long** — FII hedging while DII absorbs. Watch for short covering rally.`;
            else if (fiiNetOI > 0 && diiNetOI < 0) resp += `\n📊 **FII long, DII short** — DII profit-taking while FII accumulates.`;
          }

          // Store in conversation
          const conv = getConversation(detectedSymbol);
          conv.push({ role: "user", content: message });
          conv.push({ role: "assistant", content: resp });
          trimConversation(detectedSymbol);

          return NextResponse.json({ response: resp, toolCallsMade: ["fii_dii_direct"] });
        }
      } catch {}
    }

    const startTime = Date.now();
    let toolCallsMade: string[] = [];

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
        apiBase: origin,
        extraContext,
        // Dashboard data + SMD Context + Memory
        dashboardContext: dashboardContext + unifiedScoreText + smdContextText + memoryText,
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

      // Log LLM call
      logLLMCall({
        provider: "llm",
        model: "agent",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        toolCount: toolCallsMade.length,
        toolNames: toolCallsMade,
      });
    } catch (llmError: any) {
      // LLM failed — fall back to pattern matching
      console.warn("[Agent] LLM failed, using pattern matcher:", llmError.message);
      logAgentError({ context: "agentRespondLLM", error: llmError.message, stack: llmError.stack });
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

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Log conversation
    // ═══════════════════════════════════════════════════════════
    logConversation({
      conversationId: detectedSymbol,
      messageCount: conversationHistory.length,
      toolCallCount: toolCallsMade.length,
      totalDurationMs: Date.now() - startTime,
      symbols: [detectedSymbol],
      actions: toolCallsMade,
    });

    return NextResponse.json({
      response,
      toolCallsMade,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logAgentError({ context: "agent-api", error: error.message, stack: error.stack });
    return NextResponse.json(
      { error: error.message || "Agent error" },
      { status: 500 }
    );
  }
}