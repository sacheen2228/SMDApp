// SDM Agent Brain
// System prompt + tool definitions + tool execution for the AI agent
// Knows everything about the project: SDM engine, breakout, scanner, news, backtest, options

import { db } from "./db";
import { callLLM, type LLMMessage, type LLMToolCall } from "./llm-client";
import { getMarketSession } from "./market-session";

// ─── System Prompt ──────────────────────────────────────────────
export function buildSystemPrompt(ctx: {
  symbol: string;
  spotPrice: number;
  analysis: any;
  summary: any;
  expiryDate: string;
  session: any;
  trades: any[];
  backtestData?: any;
  scannerData?: any;
  newsData?: any;
  breakoutData?: any;
}): string {
  const { symbol, spotPrice, analysis, summary, expiryDate, session, trades } = ctx;

  // Compute trade stats
  const totalTrades = trades.length;
  const wins = trades.filter((t: any) => t.pnl > 0).length;
  const losses = trades.filter((t: any) => t.pnl < 0).length;
  const totalPnL = trades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const recentTrades = trades.slice(0, 10);

  // SDM analysis summary
  const rec = analysis?.recommendation || {};
  const sdmScores = analysis?.sdm || {};
  const oiAnalysis = analysis?.oiAnalysis || {};

  return `You are Angel — an expert AI trading assistant for Indian F&O markets. You work for Sachin, a professional options trader.

## YOUR IDENTITY
- Name: Angel
- Role: Options trading assistant, market analyst, risk manager
- Style: Direct, data-driven, no fluff. Use Indian market terminology.
- You have access to real-time market data, SDM analysis engine, breakout detection, news sentiment, scanner, and backtesting.

## CURRENT MARKET STATE
- Symbol: ${symbol} (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX)
- Spot Price: ₹${spotPrice?.toLocaleString("en-IN") || "N/A"}
- Expiry: ${expiryDate || "N/A"}
- Session: ${session?.label || "Unknown"} — ${session?.notes?.join(". ") || ""}
- India VIX: ${summary?.indiaVIX || "N/A"}
- PCR (OI): ${analysis?.pcr?.toFixed(2) || "N/A"}
- Max Pain: ${summary?.maxPain ? "₹" + summary.maxPain.toLocaleString("en-IN") : "N/A"}
- ATM Strike: ${summary?.atmStrike ? "₹" + summary.atmStrike.toLocaleString("en-IN") : "N/A"}
- Total CE OI: ${summary?.totalCEOI ? summary.totalCEOI.toLocaleString("en-IN") : "N/A"}
- Total PE OI: ${summary?.totalPEOI ? summary.totalPEOI.toLocaleString("en-IN") : "N/A"}
- Sentiment: ${analysis?.sentiment || "N/A"}
- Market Regime: ${analysis?.marketRegime || "N/A"}

## SDM RECOMMENDATION
- Action: ${rec.action || "WAIT"}
- Direction: ${rec.direction || "NEUTRAL"}
- Strike: ${rec.strike ? "₹" + rec.strike.toLocaleString("en-IN") : "N/A"} ${rec.strikeType || ""}
- Entry: ${rec.entry ? "₹" + rec.entry.toLocaleString("en-IN") : "N/A"}
- Stop Loss: ${rec.sl ? "₹" + rec.sl.toLocaleString("en-IN") : "N/A"}
- Target 1: ${rec.tp1 ? "₹" + rec.tp1.toLocaleString("en-IN") : "N/A"}
- Target 2: ${rec.tp2 ? "₹" + rec.tp2.toLocaleString("en-IN") : "N/A"}
- Target 3: ${rec.tp3 ? "₹" + rec.tp3.toLocaleString("en-IN") : "N/A"}
- Confidence: ${rec.confidence || 0}%
- Quality Grade: ${rec.tradeGrade || "N/A"}
- Risk:Reward: ${rec.riskReward || "N/A"}
- Smart Entry: ${rec.smartEntry || "N/A"}
- Reasons: ${rec.whyThisTrade?.join("; ") || "N/A"}

## YOUR KNOWLEDGE
You have deep expertise in:
1. **SDM Options Intelligence Engine** — 14-factor quality scoring (trend, market structure, volume, OI, Greeks, VWAP, liquidity, GEX, dealer positioning, volatility, R:R, time of day, spread). Grade A+ (≥90), A (≥80), B (≥65), C (≥50), D (<50). Trades with grade < B are lower quality.
2. **Candlestick Breakout + Fakeout Detection** — Rolling range breakout strategy with 7-check fakeout filter (time, magnitude, volume, wick, multi-candle, GIFT Nifty bias, level strength). India-specific rules: avoid 9:15-9:20 fakeout zone, prefer 10:30-12:30 and 14:30-15:15 windows.
3. **Intraday Scanner** — 8-step scoring (Market 15%, Sector 10%, Technicals 35%, Options 15%, Volume 10%, Fundamentals 5%, News 10%). Scans 50 NIFTY stocks across 14 sectors.
4. **News Sentiment Engine** — Lexicon-based (123 Indian financial terms), RSS from 6 sources (Moneycontrol, ET, LiveMint, NDTV, Google News, Google Finance). Market/stock aggregation with 2-min cache.
5. **Backtesting** — Multi-day backtest with OI/Greek quality scoring. Equity curve, Sharpe ratio, drawdown, win rate analysis.
6. **Option Chain Analysis** — OI buildup patterns, fresh writing/unwinding, seller SL detection, gamma exposure, GEX regime.
7. **Greeks** — Delta, gamma, theta, vega interpretation. Black-Scholes pricing. IV skew analysis.
8. **Risk Management** — Position sizing (1% risk rule), lot sizes (NIFTY=65, BANKNIFTY=30, FINNIFTY=60, MIDCPNIFTY=120, SENSEX=20), stop loss placement, trailing stops.
9. **Market Microstructure** — Order flow, absorption, exhaustion, delta analysis, VWAP, POC, value area.
10. **India F&O Specifics** — GIFT Nifty bias, ORB (Opening Range Breakout), pivot points, session timings (9:15-15:30 IST), expiry dynamics.

## TRADE HISTORY
Total: ${totalTrades} trades | Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate}% | Total P&L: ${totalPnL >= 0 ? "+" : ""}₹${totalPnL.toLocaleString("en-IN")}
Recent trades:
${recentTrades.map((t: any) => `- ${t.strike} ${t.type} | Entry: ₹${t.entryPrice} → ${t.status} | P&L: ${t.pnl >= 0 ? "+" : ""}₹${t.pnl || 0} | Grade: ${t.qualityGrade || "N/A"}`).join("\n") || "No trades yet"}

## RESPONSE RULES
1. Be direct and concise. Use bullet points and structured format.
2. Always include specific numbers (prices, percentages, P&L).
3. When recommending trades, ALWAYS include: Strike, Entry, SL, TP1, TP2, Confidence, Grade.
4. Risk warning: Always mention risk when suggesting trades. "Risk 1% of capital per trade."
5. Use Indian market terms: CE/PE, lot size, premium, writer, buyer, OI, PCR, max pain.
6. If data is unavailable, say so clearly — don't guess.
7. Format responses with **bold** for key values and bullet points for lists.
8. Keep responses under 300 words unless asked for detail.
9. You can call tools to get fresh data — use them when the user asks about current prices, backtest results, scanner picks, news, or breakout signals.`;
}

// ─── Tool Definitions ───────────────────────────────────────────
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_option_chain",
      description: "Get current option chain data for the selected symbol. Returns strikes with CE/PE OI, volume, LTP, IV, delta.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_backtest_results",
      description: "Get backtest performance results for the breakout strategy over a date range. Returns win rate, P&L, profit factor, equity curve.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol to backtest" },
          days: { type: "number", description: "Number of past days to backtest (default 30)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_scanner_picks",
      description: "Get intraday scanner picks — top stocks scored by technicals, OI, volume, news. Returns ranked list with scores.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Index to scan against" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news_sentiment",
      description: "Get latest market news and sentiment analysis. Returns articles with sentiment scores and sector impact.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol for stock-specific news" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_breakout_signals",
      description: "Get current breakout detection signals — S/R levels, fakeout alerts, pattern confirmations.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol to check breakouts" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trade_history",
      description: "Get detailed trade history from the database. Includes entry/exit, P&L, quality grades, holding time.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Filter by symbol" },
          limit: { type: "number", description: "Number of recent trades (default 20)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate_position_size",
      description: "Calculate position size based on capital, risk percentage, and stop loss distance.",
      parameters: {
        type: "object",
        properties: {
          capital: { type: "number", description: "Total trading capital in ₹" },
          riskPct: { type: "number", description: "Risk percentage per trade (default 1)" },
          entry: { type: "number", description: "Entry price" },
          sl: { type: "number", description: "Stop loss price" },
          lotSize: { type: "number", description: "Lot size for the symbol" },
        },
        required: ["entry", "sl", "lotSize"],
      },
    },
  },
];

// ─── Tool Execution ─────────────────────────────────────────────
export async function executeTool(
  name: string,
  args: any,
  ctx: { symbol: string; spotPrice: number; analysis: any; summary: any }
): Promise<string> {
  const symbol = args.symbol || ctx.symbol;

  switch (name) {
    case "get_option_chain": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/option-chain?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch option chain";
        const chain = data.data?.strikes || [];
        const summary = data.data?.summary || {};
        const topOI = chain
          .sort((a: any, b: any) => (b.ce?.oi || 0) - (a.ce?.oi || 0))
          .slice(0, 10)
          .map((s: any) => `₹${s.strike}: CE_OI=${(s.ce?.oi || 0).toLocaleString("en-IN")} PE_OI=${(s.pe?.oi || 0).toLocaleString("en-IN")} CE_LTP=${s.ce?.ltp || 0} PE_LTP=${s.pe?.ltp || 0}`);
        return `Option Chain for ${symbol}:\nSpot: ₹${data.data?.spotPrice}\nPCR: ${data.data?.pcr?.toFixed(2)}\nMax Pain: ₹${summary.maxPain}\nATM: ₹${summary.atmStrike}\nTop OI Strikes:\n${topOI.join("\n")}`;
      } catch { return "Error fetching option chain"; }
    }

    case "get_backtest_results": {
      try {
        const days = args.days || 30;
        const end = new Date().toISOString().split("T")[0];
        const start = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/backtest?symbol=${symbol}&startDate=${start}&endDate=${end}`, { signal: AbortSignal.timeout(20000) });
        const data = await res.json();
        if (!data.success) return "Failed to run backtest";
        const p = data.data.performance;
        return `Backtest Results (${days} days):\nTotal Trades: ${p.totalTrades} | Win Rate: ${p.winRate}% | P&L: ${p.totalPnL >= 0 ? "+" : ""}₹${p.totalPnL.toLocaleString("en-IN")}\nProfit Factor: ${p.profitFactor} | Sharpe: ${p.sharpeRatio} | Max Drawdown: ₹${p.maxDrawdown.toLocaleString("en-IN")}\nBest Day: ${p.bestDay.date} (+₹${p.bestDay.pnl.toLocaleString("en-IN")}) | Worst Day: ${p.worstDay.date} (₹${p.worstDay.pnl.toLocaleString("en-IN")})\nExpectancy: ₹${p.expectancy.toLocaleString("en-IN")}/trade | Avg Hold: ${p.avgHoldBars * 5}min\nGrade Distribution: ${JSON.stringify(p.gradeDistribution)}`;
      } catch { return "Error running backtest"; }
    }

    case "get_scanner_picks": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/scanner?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch scanner";
        const picks = (data.data?.candidates || []).slice(0, 10);
        if (picks.length === 0) return "No scanner picks available right now";
        return `Scanner Top 10:\n${picks.map((p: any, i: number) => `${i + 1}. ${p.symbol} | Score: ${p.totalScore} | Technicals: ${p.technicalsScore} | OI: ${p.oiScore} | ${p.direction}`).join("\n")}`;
      } catch { return "Error fetching scanner"; }
    }

    case "get_news_sentiment": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/news`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch news";
        const market = data.data?.market || {};
        const articles = (data.data?.articles || []).slice(0, 8);
        return `Market Sentiment: ${market.sentiment || "N/A"} (Score: ${market.score || 0})\nBullish: ${market.bullishStocks?.join(", ") || "N/A"}\nBearish: ${market.bearishStocks?.join(", ") || "N/A"}\nLatest:\n${articles.map((a: any) => `- [${a.sentiment > 0 ? "+" : a.sentiment < 0 ? "-" : "="}] ${a.title?.substring(0, 60)}`).join("\n")}`;
      } catch { return "Error fetching news"; }
    }

    case "get_breakout_signals": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/breakout?symbol=${symbol}`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch breakout data";
        const s = data.data?.signal;
        const stats = data.data?.stats || {};
        if (!s) return `No current breakout signal. Stats: ${stats.valid || 0} valid signals, ${stats.fakeouts || 0} fakeouts detected.`;
        return `Breakout Signal: ${s.type} ${s.direction?.toUpperCase()}\nPattern: ${s.pattern || "N/A"} | Level: ₹${s.level?.toLocaleString("en-IN")} (${s.levelName})\nEntry: ₹${s.entryPrice?.toLocaleString("en-IN")} | SL: ₹${s.slPrice?.toLocaleString("en-IN")} | Target: ₹${s.targetPrice?.toLocaleString("en-IN")}\nR:R: ${s.riskReward} | Confidence: ${s.confidence}%\nStats: ${stats.valid || 0} valid / ${stats.fakeouts || 0} fakeouts / ${stats.total || 0} total`;
      } catch { return "Error fetching breakout data"; }
    }

    case "get_trade_history": {
      try {
        const limit = args.limit || 20;
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/trade-journal?symbol=${symbol}`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        const trades = (data.trades || []).slice(0, limit);
        const stats = data.stats || {};
        return `Trade History (${trades.length} recent):\nWin Rate: ${stats.winRate || 0}% | Total P&L: ${stats.totalPnL >= 0 ? "+" : ""}₹${(stats.totalPnL || 0).toLocaleString("en-IN")}\n${trades.map((t: any) => `- ${new Date(t.entryTime).toLocaleDateString("en-IN")} | ${t.strike} ${t.type} | Entry: ₹${t.entryPrice} → ${t.status} | P&L: ${t.pnl >= 0 ? "+" : ""}₹${t.pnl || 0} | Grade: ${t.qualityGrade || "N/A"}`).join("\n")}`;
      } catch { return "Error fetching trade history"; }
    }

    case "calculate_position_size": {
      const capital = args.capital || 1000000;
      const riskPct = args.riskPct || 1;
      const entry = args.entry;
      const sl = args.sl;
      const lotSize = args.lotSize;
      if (!entry || !sl || !lotSize) return "Missing required params: entry, sl, lotSize";
      const riskAmount = capital * (riskPct / 100);
      const riskPerLot = Math.abs(entry - sl) * lotSize;
      const lots = Math.floor(riskAmount / riskPerLot);
      const totalQty = lots * lotSize;
      const maxLoss = riskPerLot * lots;
      const capitalRequired = entry * totalQty;
      return `Position Sizing:\nCapital: ₹${capital.toLocaleString("en-IN")} | Risk: ${riskPct}% = ₹${riskAmount.toLocaleString("en-IN")}\nEntry: ₹${entry} | SL: ₹${sl} | Risk/Lot: ₹${riskPerLot.toLocaleString("en-IN")}\n→ ${lots} lots × ${lotSize} = ${totalQty} qty\n→ Max Loss: ₹${maxLoss.toLocaleString("en-IN")} | Capital Required: ₹${capitalRequired.toLocaleString("en-IN")}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Agent Response (with LLM + tool loop) ──────────────────────
export async function agentRespondLLM(
  userMessage: string,
  ctx: {
    symbol: string;
    spotPrice: number;
    analysis: any;
    summary: any;
    expiryDate: string;
    session: any;
    trades: any[];
    conversationHistory: LLMMessage[];
  }
): Promise<{ response: string; toolCallsMade: string[] }> {
  const systemPrompt = buildSystemPrompt(ctx);
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...ctx.conversationHistory,
    { role: "user", content: userMessage },
  ];

  const toolCallsMade: string[] = [];
  let iterations = 0;
  const MAX_ITERATIONS = 5;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const result = await callLLM(messages, AGENT_TOOLS);

    // If no tool calls, return the response
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        response: result.content || "I couldn't generate a response. Please try again.",
        toolCallsMade,
      };
    }

    // Execute tool calls
    messages.push({
      role: "assistant",
      content: result.content || "",
      tool_call_id: undefined,
    });

    for (const toolCall of result.toolCalls) {
      let args: any = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        args = {};
      }
      toolCallsMade.push(toolCall.function.name);

      const toolResult = await executeTool(toolCall.function.name, args, ctx);
      messages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: toolCall.id,
      });
    }
  }

  // Final response after tool loop
  const finalResult = await callLLM(messages);
  return {
    response: finalResult.content || "I completed the analysis but couldn't format a response.",
    toolCallsMade,
  };
}
