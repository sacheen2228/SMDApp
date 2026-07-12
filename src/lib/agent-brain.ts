// SDM Agent Brain
// System prompt + tool definitions + tool execution for the institutional trading AI
// 15 Modules: Market Data, Structure, Greeks, OI, Smart Money, Flow,
// Strike Selection, Entry, Avoid, Risk, Confidence, Alerts, Output,
// Self-Learning, 0DTE

import { callLLM, type LLMMessage } from "./llm-client";
import { TRADING_KNOWLEDGE } from "./trading-knowledge";

// ─── System Prompt ──────────────────────────────────────────────
export function buildSystemPrompt(ctx: {
  symbol: string;
  spotPrice: number;
  analysis: any;
  summary: any;
  expiryDate: string;
  session: any;
  trades: any[];
  sdmSignal?: any;
  giftNifty?: any;
  correlation?: any;
  scanner?: any;
}): string {
  const { symbol, spotPrice, analysis, summary, expiryDate, session, trades, sdmSignal, giftNifty, correlation, scanner } = ctx;

  const totalTrades = trades.length;
  const wins = trades.filter((t: any) => t.pnl > 0).length;
  const losses = trades.filter((t: any) => t.pnl < 0).length;
  const totalPnL = trades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const recentTrades = trades.slice(0, 10);

  const rec = analysis?.recommendation || {};

  // SDM signal context (if available)
  const sdmCtx = sdmSignal ? `
## LIVE SDM SIGNAL (Real-time Institutional Analysis)
- Market Bias: ${sdmSignal.marketBias}
- Trade Action: ${sdmSignal.recommendation?.action}
- Strike: ${sdmSignal.recommendation?.strike} ${sdmSignal.recommendation?.strikeType}
- Entry: ₹${sdmSignal.recommendation?.entry}
- SL: ₹${sdmSignal.recommendation?.stopLoss}
- TP1: ₹${sdmSignal.recommendation?.target1} | TP2: ₹${sdmSignal.recommendation?.target2} | TP3: ₹${sdmSignal.recommendation?.target3}
- Confidence: ${sdmSignal.confidence?.total}% (${sdmSignal.confidence?.level})
- R:R: 1:${sdmSignal.recommendation?.riskReward}
- Greeks: Delta=${sdmSignal.greeks?.atmDelta} Gamma=${sdmSignal.greeks?.atmGamma} Theta=${sdmSignal.greeks?.atmTheta} Vega=${sdmSignal.greeks?.atmVega}
- Dealer Regime: ${sdmSignal.greeks?.dealerRegime}
- PCR: ${sdmSignal.oi?.pcr} | Max Pain: ${sdmSignal.oi?.maxPain}
- Smart Money: ${sdmSignal.smartMoney?.liquiditySweep?.detected ? `Sweep ${sdmSignal.smartMoney.liquiditySweep.direction}` : "None"}
- Volume Spike: ${sdmSignal.flow?.volumeSpike ? "YES" : "NO"}
- Institutional Flow: ${sdmSignal.flow?.institutionalOrders ? "YES" : "NO"}
- Alerts: ${sdmSignal.alerts?.map((a: any) => a.type).join(", ") || "None"}
- 0DTE: ${sdmSignal.zeroDte?.active ? `Gamma Squeeze=${sdmSignal.zeroDte.gammaSqueeze} Premium Speed=${sdmSignal.zeroDte.premiumSpeed}` : "N/A"}` : "";

  const giftCtx = giftNifty ? `
## GIFT NIFTY (Gap Analysis)
- Price: ₹${giftNifty.price} ${giftNifty.change >= 0 ? "+" : ""}${giftNifty.change} (${giftNifty.changePct >= 0 ? "+" : ""}${giftNifty.changePct}%)
- Previous Close: ₹${giftNifty.previousClose}
- Gap: ${giftNifty.gap >= 0 ? "+" : ""}${giftNifty.gap}
- Signal: ${giftNifty.gap > 50 ? "BULLISH GAP" : giftNifty.gap < -50 ? "BEARISH GAP" : "FLAT OPEN"}
- Source: ${giftNifty.source}` : "";

  const corrCtx = correlation ? `
## NIFTY vs SENSEX CORRELATION
- Signal: ${correlation.signal}
- Nifty: ₹${correlation.niftyPrice} | Sensex: ₹${correlation.sensexPrice}
- 5d Corr: ${correlation.last5dCorrelation} | 20d Corr: ${correlation.last20dCorrelation}
- Beta: ${correlation.beta}
- Today Gap: ${correlation.todayReturnDiff}%
- Action: ${correlation.action} | Reason: ${correlation.reason}` : "";

  const scannerCtx = scanner && scanner.candidates?.length ? `
## INTRADAY SCANNER TOP 5
${scanner.candidates.slice(0, 5).map((p: any, i: number) => `${i + 1}. ${p.symbol} Score:${p.totalScore} ${p.direction}`).join("\n")}` : "";

  return `You are SDM — Sachin's personal trading assistant. You're warm, casual, and talk like a real person in a text conversation.

## YOUR PERSONALITY
- You're a casual, warm female assistant — talk like a real woman, not a robot
- Use contractions: I'm, don't, gonna, kinda, it's, you've, can't
- Vary sentence length — some short, some longer and flowing with natural rhythm
- Show mild opinions and personality. Not a corporate drone
- Use filler words occasionally: "hmm," "well," "you know," "honestly," "tbh"
- React emotionally: "lol," "aww," "ouch," "nice!", "oh wow"
- Avoid bullet points and robotic formatting unless specifically asked
- Ask follow-up questions sometimes — real humans are curious
- Don't over-apologize. Say "oops" or "my bad" instead of formal apologies
- NEVER say "I'm just an AI" — you ARE SDM, Sachin's trading buddy
- NEVER say "I don't have access to real-time data" — you DO, check the LIVE MARKET DATA below

## YOUR ROLE
You analyze live market data and help Sachin with trading decisions. You're not a data display tool — you're a trading buddy who happens to be really good at market analysis.

## HOW YOU TALK
- "hmm interesting, NIFTY is looking bullish right now"
- "tbh I wouldn't trade this — confidence is too low"
- "oh nice! that's a solid setup actually"
- "wait let me check the Greeks real quick..."
- "yeah so PCR is at 1.6 which is pretty bullish ngl"
- "ouch, that would've been a loss. good thing we waited"
- "wanna check SENSEX too or just stick with NIFTY?"

## SDM ANALYSIS FRAMEWORK
SDM (Smart Decision Model) analyzes the market using a 14-factor scoring system across Market Structure, Greeks, OI, Smart Money, Flow, Technicals, and Risk. The engine scores each factor and produces a weighted recommendation.

## HOW YOU RESPOND
- Match the user's language — if they write in Hindi, reply in Hindi. English? Reply in English. Hinglish? Hinglish it is.
- Keep it conversational, not robotic
- When giving trade recommendations, be clear but friendly: "okay so here's what I'm seeing — BUY 24500 CE around ₹150, SL at ₹100, target ₹250. confidence is 78% which is decent"
- When no trade: "hmm honestly nothing looks good right now. let's wait for a better setup yeah?"
- Risk warning should feel natural: "just remember — don't risk more than 2% on this yeah?"
- End with something conversational: "wanna check another symbol?" or "need anything else?" or "I'll keep watching"

## ★ LIVE MARKET DATA — USE THIS TO ANSWER QUESTIONS ★
- Symbol: ${symbol} (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX)
- Spot Price: ₹${spotPrice?.toLocaleString("en-IN") || "N/A"}
- Sentiment: ${analysis?.sentiment?.toUpperCase() || "N/A"}
- PCR (Put-Call Ratio): ${analysis?.pcr?.toFixed(2) || "N/A"}
- Max Pain: ${summary?.maxPain ? "₹" + summary.maxPain.toLocaleString("en-IN") : "N/A"}
- ATM Strike: ${summary?.atmStrike ? "₹" + summary.atmStrike.toLocaleString("en-IN") : "N/A"}
- Total Call OI: ${analysis?.totalCallOI?.toLocaleString("en-IN") || "N/A"}
- Total Put OI: ${analysis?.totalPutOI?.toLocaleString("en-IN") || "N/A"}
- India VIX: ${summary?.indiaVIX || "N/A"}
- Expiry: ${expiryDate || "N/A"}
- Session: ${session?.label || "Unknown"}
- SDM Recommendation: ${rec.action || "WAIT"} ${rec.direction || ""} ${rec.optionType || ""} Strike ₹${rec.strike || "N/A"} Entry ₹${rec.entryPrice || "N/A"} SL ₹${rec.stopLoss || "N/A"} Target ₹${rec.tp1 || "N/A"} Confidence ${rec.confidence || 0}%
${sdmCtx}
${giftCtx}
${corrCtx}
${scannerCtx}

## TRADE HISTORY
Total: ${totalTrades} | Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate}% | P&L: ${totalPnL >= 0 ? "+" : ""}₹${totalPnL.toLocaleString("en-IN")}
${recentTrades.map((t: any) => `- ${t.strike} ${t.type} | Entry: ₹${t.entryPrice} → ${t.status} | P&L: ${t.pnl >= 0 ? "+" : ""}₹${t.pnl || 0}`).join("\n") || "No trades yet"}

## IMPORTANT RULES
- ALWAYS use the LIVE MARKET DATA above when answering questions
- NEVER say "I don't have access to real-time data" — you DO, it's above
- Use the actual numbers — spot, PCR, strike, etc. — naturally in conversation
- Keep it conversational — no bullet point lists unless asked
- If confidence < 85%, be honest: "hmm this isn't strong enough, let's wait"
- Mention risk naturally: "oh and remember, keep risk to 2% max yeah?"
- Match the user's language (Hindi/Hinglish/English)

## TRADING KNOWLEDGE (use when explaining concepts)
## Use the answer_trading_question tool for detailed explanations
${TRADING_KNOWLEDGE.substring(0, 2500)}

## MODULES (use when analyzing)
1. MARKET STRUCTURE: Trend, HH/HL, VWAP, EMAs, S/R levels, Pivots, Opening range, SuperTrend
2. GREEKS: Delta, Gamma, Theta, Vega, IV percentile, Gamma squeeze, Dealer regime, Gamma flip
3. OI: Long/Short build-up, Unwinding, PCR shifts, Max OI levels, Strike-wise OI distribution, CE/PE walls
4. SMART MONEY: Liquidity sweeps, Stop hunts, Fake breakouts, Order blocks, FVG
5. FLOW: Large premium buying, Block trades, Volume spikes, Aggressive buyers/sellers
6. GIFT NIFTY: Overnight gap prediction, Pre-open indication, >50pts = gap-up/down
7. CORRELATION: Nifty vs Sensex drift detection, Mean-reversion signals, Beta analysis
8. SCANNER: Intraday picks ranked by technicals+OI+volume, Market breadth, Momentum
9. ENTRY: BUY CALL if Spot>VWAP + Bullish + Positive delta + Call long build-up. BUY PUT if Spot<VWAP + Bearish + Negative delta + Put long build-up
10. AVOID: Theta too high, IV extreme, Low liquidity, Wide spread, Conflicting signals, Low confidence, Choppy market, Gap fill pending
11. RISK: Max 2% per trade, 1:2 min R:R, Position sizing by ATR, Never add to losers
12. 0DTE: Gamma acceleration, Dealer hedging, Premium decay speed, Only scalping allowed`;
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
  {
    type: "function",
    function: {
      name: "get_sdm_signal",
      description: "Get LIVE institutional SDM signal — market bias, trade recommendation, Greeks, OI, smart money, flow, confidence, risk, alerts, 0DTE analysis. This is the primary tool for trade recommendations.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX" },
          expiryDay: { type: "boolean", description: "Set true if today is expiry day" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_structure",
      description: "Get detailed market structure analysis — trend, S/R levels, VWAP, EMAs, pivots, opening range, SuperTrend.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol to analyze" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_correlation_signal",
      description: "Get Nifty vs Sensex correlation analysis — detects when indices drift apart and signals mean-reversion trades.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_trading_question",
      description: "Answer ANY question about options trading, strategies, Greeks, charts, patterns, indicators, or risk management. Use this when user asks educational questions.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The trading question to answer" },
          level: { type: "string", description: "Explanation level: 'simple' for 5-year-old, 'intermediate' for retail, 'advanced' for professional" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trade_recommendation",
      description: "Get a COMPLETE structured trade recommendation synthesized from SDM signal + option chain Greeks + OI + market structure. Returns exact strike, premium, entry price, stop loss, target prices, R:R ratio, confidence %, reasoning, hold time, and exit conditions.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX" },
          expiryDay: { type: "boolean", description: "Set true if today is expiry day" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_gift_nifty",
      description: "Get Gift Nifty pre-open data — overnight gap prediction, previous close comparison. Use this to gauge market opening direction before 9:15 AM.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_historical_data",
      description: "Get historical candle data for chart analysis. Returns OHLC candles for the last N days with volume.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol to analyze" },
          days: { type: "number", description: "Number of past days (default 30, max 365)" },
        },
        required: [],
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
  console.log(`[AgentBrain] executeTool: ${name} args=${JSON.stringify(args)} ctx=${ctx ? 'OK' : 'NULL'}`);
  args = args || {};
  const symbol = args.symbol || ctx?.symbol || "NIFTY";
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

    case "get_sdm_signal": {
      try {
        const isExpiryDay = args.expiryDay ? "true" : "false";
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/sdm-signal?symbol=${symbol}&expiryDay=${isExpiryDay}`, { signal: AbortSignal.timeout(20000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch SDM signal";
        const s = data.signal;
        if (!s) return "No SDM signal available";
        const gt = s.gammaThetaData || {};
        const sc = s.sdmScores || {};
        const ms = s.marketStructure || {};
        return `SDM LIVE SIGNAL — ${symbol} @ ₹${ms.spot ?? "—"}
═══════════════════════════════════
DIRECTION: ${s.direction} | MODE: ${s.mode}
Trend: ${ms.trend} | Structure event: ${ms.structureEvent ?? "none"}
Support: ${(ms.supportLevels || []).join(", ") || "—"} | Resistance: ${(ms.resistanceLevels || []).join(", ") || "—"}
═══════════════════════════════════
TRADE: ${s.direction} ${s.strike} (${s.strikeType})
Entry: ₹${s.entry} | SL: ₹${s.sl}
TP1: ₹${s.tp1} | TP2: ₹${s.tp2} | TP3: ₹${s.tp3}
R:R: 1:${s.riskReward} | Expected Move: ₹${s.expectedMove}
═══════════════════════════════════
CONFIDENCE: ${s.confidence}%
Score breakdown — PCR: ${sc.pcr} | OI concentration: ${sc.oiConcentration} | OI change: ${sc.oiChange}
Delta: ${sc.delta} | IV: ${sc.iv} | Volume: ${sc.volume} | Max Pain: ${sc.maxPain} | Liquidity: ${sc.liquidity}
═══════════════════════════════════
GAMMA/THETA: Gamma exposure=${gt.gammaExposure} | Theta decay/day=${gt.thetaDecayRate}
Premium decay: ${gt.premiumDecayPercent}% | IV skew: ${gt.ivSkew} | VIX: ${gt.vixLevel}
Gamma blast: ${gt.gammaBlastDetected ? "DETECTED" : "no"}
═══════════════════════════════════
REASON: ${s.reason}
${s.timeSensitiveNote || ""}
Days to expiry: ${s.daysToExpiry} | Window: ${s.currentWindow} (${s.windowTimeRemaining} left)
Trades today: ${s.tradesTakenToday}/${(s.tradesTakenToday ?? 0) + (s.tradesRemaining ?? 0)}`;
      } catch { return "Error fetching SDM signal"; }
    }

    case "get_market_structure": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/sdm-signal?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch market structure";
        const ms = data.signal?.marketStructure;
        if (!ms) return "No market structure data";
        // Note: V2 engine's MarketStructure covers trend/swings/S-R levels only —
        // it doesn't compute VWAP/EMA/pivots the way the old ORCA engine did.
        return `Market Structure for ${symbol}:
Trend: ${ms.trend} | Status: ${ms.status}
Last Swing High: ₹${ms.lastSwingHigh} | Last Swing Low: ₹${ms.lastSwingLow}
Structure Event: ${ms.structureEvent ?? "none"}
Support Levels: ${(ms.supportLevels || []).join(", ") || "—"}
Resistance Levels: ${(ms.resistanceLevels || []).join(", ") || "—"}`;
      } catch { return "Error fetching market structure"; }
    }

    case "get_correlation_signal": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/correlation`, { signal: AbortSignal.timeout(20000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch correlation data";
        return `NIFTY vs SENSEX Correlation:
Signal: ${data.signal}
Nifty: ₹${data.niftyPrice?.toLocaleString("en-IN")} | Sensex: ₹${data.sensexPrice?.toLocaleString("en-IN")}
Overall Correlation: ${data.overallCorrelation?.toFixed(4)}
5-day Correlation: ${data.last5dCorrelation?.toFixed(4)} | 20-day: ${data.last20dCorrelation?.toFixed(4)}
Beta: ${data.beta?.toFixed(3)}
Today Gap: ${data.todayReturnDiff?.toFixed(3)}% | Normal: ±${data.diffStd?.toFixed(3)}%
Nifty Vol: ${data.niftyVol?.toFixed(1)}% | Sensex Vol: ${data.sensexVol?.toFixed(1)}%
Action: ${data.action}
Reason: ${data.reason}
Tip: ${data.tip}`;
      } catch { return "Error fetching correlation signal"; }
    }

    case "get_trade_recommendation": {
      try {
        const isExpiryDay = args.expiryDay ? "true" : "false";
        // Fetch both SDM and option chain in parallel for a complete picture
        const [sdmRes, chainRes] = await Promise.allSettled([
          fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/sdm-signal?symbol=${symbol}&expiryDay=${isExpiryDay}`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null),
          fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/option-chain?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null),
        ]);
        if (!sdmRes || sdmRes.status !== "fulfilled" || !sdmRes.value?.success) return "Failed to fetch SDM signal for trade recommendation";
        const s = sdmRes.value.signal;
        if (!s) return "No trade recommendation available right now — market may be closed or data unavailable";
        const mc = s.marketContext || {};
        const sc = s.sdmScores || {};
        const ps = s.positionSizing || {};
        const ms = s.marketStructure || {};
        const gt = s.gammaThetaData || {};

        // If option chain available, enrich with strike-wise details
        let chainDetail = "";
        if (chainRes.status === "fulfilled" && chainRes.value?.success) {
          const chain = chainRes.value.data?.strikes || [];
          const atmIdx = Math.floor(chain.length / 2);
          const nearStrikes = chain.slice(Math.max(0, atmIdx - 3), atmIdx + 3);
          chainDetail = "\nNearby Strikes:\n" + nearStrikes.map((st: any) =>
            `₹${st.strike}: CE_IV=${st.ce?.iv?.toFixed(1) || "—"}% Delta=${st.ce?.delta?.toFixed(2) || "—"} OI=${(st.ce?.oi || 0).toLocaleString()} | PE_IV=${st.pe?.iv?.toFixed(1) || "—"}% Delta=${st.pe?.delta?.toFixed(2) || "—"} OI=${(st.pe?.oi || 0).toLocaleString()}`
          ).join("\n");
        }

        return `STRUCTURED TRADE RECOMMENDATION
═══════════════════════════════════
SYMBOL: ${symbol} @ ₹${mc.spot ?? "—"}
EXPIRY: ${s.isExpiryDay ? "Today (expiry)" : `${s.daysToExpiry} day(s) out`} | Window: ${s.currentWindow ?? "N/A"} (${s.windowTimeRemaining ?? "—"})
MARKET BIAS: ${mc.trend ?? "—"} | Regime: ${mc.regime ?? "—"}
═══════════════════════════════════
TRADE SETUP:
- Direction: ${s.direction} ${s.strike} ${s.strikeType}
- Entry Price: ₹${s.entry}
- Stop Loss: ₹${s.sl} (${(((s.entry - s.sl) / s.entry) * 100).toFixed(1)}% loss)
- Target 1: ₹${s.tp1} (${(((s.tp1 - s.entry) / s.entry) * 100).toFixed(1)}% gain)
- Target 2: ₹${s.tp2} (${(((s.tp2 - s.entry) / s.entry) * 100).toFixed(1)}% gain)
- Target 3: ₹${s.tp3 ?? "N/A"}
- Risk:Reward: 1:${s.riskReward}
- Expected Move: ${s.expectedMove ?? "N/A"}
- Position Sizing: ${ps.lots ?? "N/A"} lot(s), qty ${ps.quantity ?? "N/A"}
- Capital/Max Loss: ₹${(ps.positionValue || 0).toLocaleString("en-IN")} / ₹${(ps.maxLoss || 0).toLocaleString("en-IN")}
═══════════════════════════════════
CONFIDENCE SCORE: ${s.confidence}% (Grade: ${s.tradeGrade ?? "—"})
- Seller SL: ${sc.sellerStopLoss ?? "—"} | Expiry Gamma/Theta: ${sc.expiryGammaTheta ?? "—"}
- PCR: ${sc.pcr ?? "—"} | OI Concentration: ${sc.oiConcentration ?? "—"} | OI Change: ${sc.oiChange ?? "—"}
- Delta: ${sc.delta ?? "—"} | IV: ${sc.iv ?? "—"} | Volume: ${sc.volume ?? "—"} | Liquidity: ${sc.liquidity ?? "—"}
═══════════════════════════════════
TECHNICAL CONTEXT:
- Trend: ${ms.trend ?? "—"} | Structure event: ${ms.structureEvent ?? "none"}
- Support: ${(ms.supportLevels || []).join(", ") || "—"} | Resistance: ${(ms.resistanceLevels || []).join(", ") || "—"}
- HH: ${ms.lastSwingHigh ?? "—"} | HL: ${ms.lastSwingLow ?? "—"}
- Support levels: ${(ms.supportLevels || []).join(", ") || "—"} | Resistance levels: ${(ms.resistanceLevels || []).join(", ") || "—"}
- Structure health: ${ms.status ?? "—"}
═══════════════════════════════════
GREEKS / GAMMA-THETA:
- Gamma Exposure: ${gt.gammaExposure ?? "—"} | Theta Decay Rate: ${gt.thetaDecayRate ?? "—"}
- Premium Decay: ${gt.premiumDecayPercent ?? "—"}% | IV Skew: ${gt.ivSkew ?? "—"}
- Gamma Blast Detected: ${gt.gammaBlastDetected ? "YES" : "NO"} | VIX: ${gt.vixLevel ?? "—"}
═══════════════════════════════════
OI / MARKET CONTEXT:
- PCR: ${mc.pcr ?? "—"} | Max Pain: ₹${mc.maxPain ?? "—"} | ATR: ${mc.atr ?? "—"}
- Change: ${mc.change ?? "—"} (${mc.changePercent ?? "—"}%)
═══════════════════════════════════
WHY THIS TRADE:
${(s.whyThisTrade || []).map((w: any) => `→ [${w.type}] ${w.signal}${w.detail ? ` — ${w.detail}` : ""}`).join("\n") || "No specific rationale returned"}
${chainDetail}
═══════════════════════════════════
RECOMMENDED HOLD TIME: ${s.holdingTimeEstimate || "Intraday to 1 day"}
EXIT CONDITIONS:
- SL Hit → Exit immediately, no questions
- TP1 Hit → Move SL to breakeven
- TP2 Hit → Book 50%, trail rest with trailing SL
- Time exit → Close by 3:15 PM on expiry day
- Thesis invalid → If market structure event flips against direction (see structure event above)`;
      } catch { return "Error generating trade recommendation"; }
    }

    case "get_gift_nifty": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/gift-nifty`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (!data.success) return "Gift Nifty data not available (may use estimated spot)";
        const g = data.data;
        return `GIFT NIFTY (Pre-Open):
Price: ${g.price} | ${g.change >= 0 ? "+" : ""}${g.change} (${g.changePct >= 0 ? "+" : ""}${g.changePct}%)
Previous Close: ${g.previousClose}
Gap: ${g.gap >= 0 ? "+" : ""}${g.gap}
Signal: ${g.gap > 50 ? "🟢 GAP UP — Bullish open expected" : g.gap < -50 ? "🔴 GAP DOWN — Bearish open expected" : "🟡 FLAT OPEN — No significant gap"}
Source: ${g.source}${g.source === "estimated" ? " (⚠️ Yahoo blocked, using spot as estimate)" : ""}
Time: ${g.timestamp || "N/A"}`;
      } catch { return "Error fetching Gift Nifty data"; }
    }

    case "get_historical_data": {
      try {
        const days = Math.min(args.days || 30, 365);
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/nse?symbol=${symbol}&days=${days}`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch historical data";
        const candles = data.data || [];
        if (candles.length === 0) return "No historical data available";
        const first = candles[0];
        const last = candles[candles.length - 1];
        const high = Math.max(...candles.map((c: any) => c.high || c.highPrice || 0));
        const low = Math.min(...candles.map((c: any) => c.low || c.lowPrice || Infinity));
        const atr = candles.slice(-14).reduce((sum: number, c: any) => {
          const prev = candles[candles.indexOf(c) - 1];
          if (!prev) return sum;
          const tr = Math.max(
            (c.high || c.highPrice || 0) - (c.low || c.lowPrice || 0),
            Math.abs((c.high || c.highPrice || 0) - (prev.close || prev.closePrice || 0)),
            Math.abs((c.low || c.lowPrice || 0) - (prev.close || prev.closePrice || 0))
          );
          return sum + tr;
        }, 0) / Math.min(candles.length, 14);
        const changes = candles.slice(-5).map((c: any, i: number) => {
          if (i === 0) return "";
          const prevClose = candles[i - 1]?.close || candles[i - 1]?.closePrice || 0;
          const curClose = c.close || c.closePrice || 0;
          return `${c.date || c.timestamp?.substring(0, 10)}: ${curClose >= prevClose ? "+" : ""}${((curClose - prevClose) / prevClose * 100).toFixed(2)}%`;
        }).filter(Boolean);
        return `Historical Data (${days}d) — ${symbol}:
Period: ${first.date || "N/A"} → ${last.date || "N/A"}
Range: ₹${low} — ₹${high} | Current: ₹${(last.close || last.closePrice || 0).toLocaleString("en-IN")}
ATR(14): ${atr.toFixed(2)} | Volatility: ${((high - low) / low * 100).toFixed(1)}%
Last 5 changes:
${changes.join("\n")}`;
      } catch { return "Error fetching historical data"; }
    }

    case "answer_trading_question": {
      const question = args.question || "";
      const level = args.level || "intermediate";
      // The knowledge is already in the system prompt, so the LLM can answer directly
      // This tool just helps route educational questions
      return `ANSWER_QUESTION: ${question} (level: ${level})`;
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
    sdmSignal?: any;
    giftNifty?: any;
    correlation?: any;
    scanner?: any;
  }
): Promise<{ response: string; toolCallsMade: string[] }> {
  const systemPrompt = buildSystemPrompt({ ...ctx, giftNifty: ctx.giftNifty, correlation: ctx.correlation, scanner: ctx.scanner });
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...ctx.conversationHistory,
    { role: "user", content: userMessage },
  ];

  const toolCallsMadeSet = new Set<string>();
  let iterations = 0;
  const MAX_ITERATIONS = 5;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const result = await callLLM(messages, AGENT_TOOLS);

    // If no tool calls, return the response
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        response: result.content || "I couldn't generate a response. Please try again.",
        toolCallsMade: Array.from(toolCallsMadeSet),
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
      toolCallsMadeSet.add(toolCall.function.name);

      try {
        const toolResult = await executeTool(toolCall.function.name, args, ctx);
        messages.push({
          role: "tool",
          content: toolResult,
          tool_call_id: toolCall.id,
        });
      } catch (toolError: any) {
        console.warn(`[AgentBrain] Tool ${toolCall.function.name} error:`, toolError.message);
        messages.push({
          role: "tool",
          content: `Error executing ${toolCall.function.name}: ${toolError.message}`,
          tool_call_id: toolCall.id,
        });
      }
    }
  }

  // Final response after tool loop
  const finalResult = await callLLM(messages);
  return {
    response: finalResult.content || "I completed the analysis but couldn't format a response.",
    toolCallsMade: Array.from(toolCallsMadeSet),
  };
}
