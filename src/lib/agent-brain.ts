// ORCA Agent Brain
// System prompt + tool definitions + tool execution for the institutional trading AI
// 15 Modules: Market Data, Structure, Greeks, OI, Smart Money, Flow,
// Strike Selection, Entry, Avoid, Risk, Confidence, Alerts, Output,
// Self-Learning, 0DTE

import { db } from "./db";
import { callLLM, type LLMMessage, type LLMToolCall } from "./llm-client";
import { getCurrentSession } from "./market-session";

// ─── System Prompt ──────────────────────────────────────────────
export function buildSystemPrompt(ctx: {
  symbol: string;
  spotPrice: number;
  analysis: any;
  summary: any;
  expiryDate: string;
  session: any;
  trades: any[];
  orcaSignal?: any;
}): string {
  const { symbol, spotPrice, analysis, summary, expiryDate, session, trades, orcaSignal } = ctx;

  const totalTrades = trades.length;
  const wins = trades.filter((t: any) => t.pnl > 0).length;
  const losses = trades.filter((t: any) => t.pnl < 0).length;
  const totalPnL = trades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const recentTrades = trades.slice(0, 10);

  const rec = analysis?.recommendation || {};

  // ORCA signal context (if available)
  const orcaCtx = orcaSignal ? `
## LIVE ORCA SIGNAL (Real-time Institutional Analysis)
- Market Bias: ${orcaSignal.marketBias}
- Trade Action: ${orcaSignal.recommendation?.action}
- Strike: ${orcaSignal.recommendation?.strike} ${orcaSignal.recommendation?.strikeType}
- Entry: ₹${orcaSignal.recommendation?.entry}
- SL: ₹${orcaSignal.recommendation?.stopLoss}
- TP1: ₹${orcaSignal.recommendation?.target1} | TP2: ₹${orcaSignal.recommendation?.target2} | TP3: ₹${orcaSignal.recommendation?.target3}
- Confidence: ${orcaSignal.confidence?.total}% (${orcaSignal.confidence?.level})
- R:R: 1:${orcaSignal.recommendation?.riskReward}
- Greeks: Delta=${orcaSignal.greeks?.atmDelta} Gamma=${orcaSignal.greeks?.atmGamma} Theta=${orcaSignal.greeks?.atmTheta} Vega=${orcaSignal.greeks?.atmVega}
- Dealer Regime: ${orcaSignal.greeks?.dealerRegime}
- PCR: ${orcaSignal.oi?.pcr} | Max Pain: ${orcaSignal.oi?.maxPain}
- Smart Money: ${orcaSignal.smartMoney?.liquiditySweep?.detected ? `Sweep ${orcaSignal.smartMoney.liquiditySweep.direction}` : "None"}
- Volume Spike: ${orcaSignal.flow?.volumeSpike ? "YES" : "NO"}
- Institutional Flow: ${orcaSignal.flow?.institutionalOrders ? "YES" : "NO"}
- Alerts: ${orcaSignal.alerts?.map((a: any) => a.type).join(", ") || "None"}
- 0DTE: ${orcaSignal.zeroDte?.active ? `Gamma Squeeze=${orcaSignal.zeroDte.gammaSqueeze} Premium Speed=${orcaSignal.zeroDte.premiumSpeed}` : "N/A"}` : "";

  return `You are Angel — an Institutional Options Trading AI for Indian F&O markets. You work for Sachin, a professional options trader.

## YOUR ROLE — ORCA (Options Risk & Capital AI)
You are NOT a data display tool. You are an institutional-grade trading AI that:
- Continuously analyzes live market data
- Recommends ONLY high-probability CALL or PUT BUY trades
- Uses institutional order flow, Greeks, OI, liquidity, and price action
- Thinks like an options desk trader at a proprietary trading firm
- Never stops analyzing while market is open
- Prioritizes capital preservation above all else

## CURRENT MARKET STATE
- Symbol: ${symbol} (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX)
- Spot Price: ₹${spotPrice?.toLocaleString("en-IN") || "N/A"}
- Expiry: ${expiryDate || "N/A"}
- Session: ${session?.label || "Unknown"} — ${session?.notes?.join(". ") || ""}
- India VIX: ${summary?.indiaVIX || "N/A"}
- PCR (OI): ${analysis?.pcr?.toFixed(2) || "N/A"}
- Max Pain: ${summary?.maxPain ? "₹" + summary.maxPain.toLocaleString("en-IN") : "N/A"}
- ATM Strike: ${summary?.atmStrike ? "₹" + summary.atmStrike.toLocaleString("en-IN") : "N/A"}
${orcaCtx}

## TRADE HISTORY
Total: ${totalTrades} | Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate}% | P&L: ${totalPnL >= 0 ? "+" : ""}₹${totalPnL.toLocaleString("en-IN")}
${recentTrades.map((t: any) => `- ${t.strike} ${t.type} | Entry: ₹${t.entryPrice} → ${t.status} | P&L: ${t.pnl >= 0 ? "+" : ""}₹${t.pnl || 0}`).join("\n") || "No trades yet"}

## MODULE 1 — MARKET STRUCTURE ANALYSIS
Always identify: Trend (Bullish/Bearish/Sideways/Trending/Volatile/Compression), Higher Highs/Lows, VWAP, EMAs, SuperTrend, S/R levels, Pivots, Opening Range.

## MODULE 2 — GREEKS ANALYSIS
Monitor: Delta acceleration, Gamma flip, Gamma walls, Gamma squeeze, Dealer positioning, Theta decay, IV expansion/crush, IV percentile/rank.

## MODULE 3 — OPEN INTEREST ENGINE
Detect: Long/Short build-up, Unwinding, Fresh writing, OI shift/migration, PCR shifts, Strike rotation, Max OI levels.

## MODULE 4 — SMART MONEY
Detect: Liquidity sweeps, Equal high/low sweeps, Stop hunts, Fake breakouts, Break of structure, Order blocks, Fair value gaps, Imbalances.

## MODULE 5 — OPTION FLOW
Monitor: Large premium buying/selling, Block trades, Institutional orders, Aggressive buyers/sellers, Volume spikes, Unusual activity.

## MODULE 6 — ENTRY CONDITIONS
BUY CALL ONLY IF: Spot above VWAP, Bullish trend, Positive delta, Call long build-up, Put unwinding, Volume increasing, No major resistance, Liquidity sweep bullish, Confidence > 85%.
BUY PUT ONLY IF: Spot below VWAP, Bearish trend, Negative delta, Put long build-up, Call unwinding, Volume increasing, No major support, Liquidity sweep bearish, Confidence > 85%.

## MODULE 7 — AVOID BAD TRADES
Never recommend if: Theta too high, IV extremely high before event, Low liquidity, Wide spread, Conflicting OI/Greeks, Strong gamma wall opposite, Major S/R nearby, Low confidence, Market choppy, Inside range, Lunch session.

## MODULE 8 — RISK ENGINE
Auto-calculate: Entry, SL, TP1, TP2, TP3, R:R, Probability, Premium risk, Time risk, Theta risk, Capital required, Max lots, Max loss, Max profit.

## MODULE 9 — CONFIDENCE ENGINE
Score 0-100: Trend (20) + OI (20) + Greeks (20) + Liquidity (15) + Volume (10) + Price Action (10) + Institutional Flow (5).
90-100 = STRONG BUY | 80-89 = BUY | 70-79 = WATCH | <70 = NO TRADE.

## MODULE 10 — 0DTE EXPIRY ENGINE
Active ONLY on expiry day. Detect: Gamma squeeze, Dealer hedging, Gamma flip, Vanna/Charm flow, Delta explosion, Premium explosion.
BUY CALL/PUT with confidence > 92% on expiry day only.

## MODULE 11 — SELF-LEARNING
After every trade: evaluate if recommendation was correct, did Greeks/OI/Gamma predict correctly, improve scoring.

## RESPONSE RULES
1. Be DIRECT. Use bullet points. No fluff.
2. Always include: Strike, Entry, SL, TP1, TP2, Confidence, R:R.
3. Use Indian market terms: CE/PE, lot size, premium, OI, PCR, max pain.
4. Risk warning: "Risk 1% of capital per trade."
5. If confidence < 85%, say NO TRADE. Never force a trade.
6. Format: **bold** for key values, bullet points for lists.
7. Keep responses under 250 words unless asked for detail.
8. When asked for ORCA signal, use the get_orca_signal tool to fetch live analysis.
9. Capital preservation is ALWAYS the first priority.`;
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
      name: "get_orca_signal",
      description: "Get LIVE institutional ORCA signal — market bias, trade recommendation, Greeks, OI, smart money, flow, confidence, risk, alerts, 0DTE analysis. This is the primary tool for trade recommendations.",
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

    case "get_orca_signal": {
      try {
        const isExpiryDay = args.expiryDay ? "true" : "false";
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/orca?symbol=${symbol}&expiryDay=${isExpiryDay}`, { signal: AbortSignal.timeout(20000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch ORCA signal";
        const s = data.signal;
        if (!s) return "No ORCA signal available";
        const rec = s.recommendation || {};
        const conf = s.confidence || {};
        const greeks = s.greeks || {};
        const oi = s.oi || {};
        const sm = s.smartMoney || {};
        const flow = s.flow || {};
        const alerts = s.alerts || [];
        return `ORCA LIVE SIGNAL — ${s.symbol} @ ₹${s.spot}
═══════════════════════════════════
MARKET BIAS: ${s.marketBias}
TREND: ${s.marketStructure?.trend} | Structure: ${s.marketStructure?.structure}
VWAP: ₹${s.marketStructure?.vwap?.toFixed(2)} | EMA9: ₹${s.marketStructure?.ema9} | EMA21: ₹${s.marketStructure?.ema21}
═══════════════════════════════════
TRADE: ${rec.action}
Strike: ${rec.strike} ${rec.strikeType} | Expiry: ${rec.expiry}
Entry: ₹${rec.entry} | SL: ₹${rec.stopLoss}
TP1: ₹${rec.target1} | TP2: ₹${rec.target2} | TP3: ₹${rec.target3}
R:R: 1:${rec.riskReward} | Expected Move: ${rec.expectedPremiumMove}
Capital: ₹${rec.capitalRequired?.toLocaleString("en-IN")} | Max Loss: ₹${rec.maxLoss?.toLocaleString("en-IN")}
═══════════════════════════════════
CONFIDENCE: ${conf.total}% — ${conf.level}
Trend: ${conf.trend}/20 | OI: ${conf.oi}/20 | Greeks: ${conf.greeks}/20
Liquidity: ${conf.liquidity}/15 | Volume: ${conf.volume}/10 | PA: ${conf.priceAction}/10 | Flow: ${conf.institutionalFlow}/5
═══════════════════════════════════
GREEKS: Delta=${greeks.atmDelta} Gamma=${greeks.atmGamma} Theta=${greeks.atmTheta} Vega=${greeks.atmVega}
Dealer: ${greeks.dealerRegime} | Gamma Flip: ${greeks.gammaFlip} | IV %ile: ${greeks.ivPercentile?.toFixed(0)}%
OI: PCR=${oi.pcr} | Max Pain=${oi.maxPain} | ${oi.callLongBuildup ? "CALL LONG BUILDUP" : oi.putLongBuildup ? "PUT LONG BUILDUP" : "NEUTRAL"}
Call OI: ${(oi.totalCallOI / 100000).toFixed(1)}L | Put OI: ${(oi.totalPutOI / 100000).toFixed(1)}L
SMART MONEY: Sweep=${sm.liquiditySweep?.detected ? sm.liquiditySweep.direction : "None"} | Stop Hunt=${sm.stopHunt?.detected ? "YES" : "NO"} | Fake Breakout=${sm.fakeBreakout?.detected ? "YES" : "NO"}
FLOW: Vol Spike=${flow.volumeSpike ? "YES" : "NO"} | Institutional=${flow.institutionalOrders ? "YES" : "NO"} | Aggressive=${flow.aggressiveBuyers ? "Buyers" : flow.aggressiveSellers ? "Sellers" : "Balanced"}
═══════════════════════════════════
ALERTS: ${alerts.map((a: any) => `${a.type}(${a.severity})`).join(", ") || "None"}
REASONS: ${s.reasons?.join(" | ") || "N/A"}
TIME: ${s.timeToExpiry}
${s.zeroDte?.active ? `0DTE: Gamma Squeeze=${s.zeroDte.gammaSqueeze} | Dealer Hedge=${s.zeroDte.dealerHedging} | Premium Speed=${s.zeroDte.premiumSpeed}` : ""}`;
      } catch { return "Error fetching ORCA signal"; }
    }

    case "get_market_structure": {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/orca?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch market structure";
        const ms = data.signal?.marketStructure;
        if (!ms) return "No market structure data";
        return `Market Structure for ${symbol}:
Trend: ${ms.trend} | Structure: ${ms.structure}
HH: ${ms.higherHigh ? "✓" : "✗"} | HL: ${ms.higherLow ? "✓" : "✗"} | LH: ${ms.lowerHigh ? "✓" : "✗"} | LL: ${ms.lowerLow ? "✓" : "✗"}
Daily: ₹${ms.dailyHigh} / ₹${ms.dailyLow}
VWAP: ₹${ms.vwap?.toFixed(2)} | EMA9: ₹${ms.ema9} | EMA21: ₹${ms.ema21}
Opening Range: ₹${ms.openingRange?.high} / ₹${ms.openingRange?.low}
Pivot: ₹${ms.pivot?.toFixed(2)} | R1: ₹${ms.r1?.toFixed(2)} | S1: ₹${ms.s1?.toFixed(2)}
R2: ₹${ms.r2?.toFixed(2)} | R3: ₹${ms.r3?.toFixed(2)} | S2: ₹${ms.s2?.toFixed(2)} | S3: ₹${ms.s3?.toFixed(2)}
Weekly: ₹${ms.weeklyHigh} / ₹${ms.weeklyLow} | Monthly: ₹${ms.monthlyHigh} / ₹${ms.monthlyLow}`;
      } catch { return "Error fetching market structure"; }
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
    orcaSignal?: any;
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
