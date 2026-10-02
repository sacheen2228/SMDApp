// SDM Agent Brain
// System prompt + tool definitions + tool execution for the institutional trading AI
// 15 Modules: Market Data, Structure, Greeks, OI, Smart Money, Flow,
// Strike Selection, Entry, Avoid, Risk, Confidence, Alerts, Output,
// Self-Learning, 0DTE

import { callLLM, type LLMMessage } from "./llm-client";
import { TRADING_KNOWLEDGE } from "./trading-knowledge";
import { buildSessionStatusReport, applyBreezeSession } from "./session-health";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const execFileP = promisify(execFile);

// Resolve a playbook script across dev/standalone layouts.
function resolvePlaybookScript(scriptName: string): string | null {
  const rel = path.join("skills", "option-buying-playbook", "scripts", scriptName);
  const candidates = [
    path.join(process.cwd(), rel),
    path.join(process.cwd(), "..", "..", rel),
    path.join("/home/sachin/Desktop/SMDApp", rel),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

// Resolve the playbook SKILL ROOT across dev/standalone layouts.
function resolvePlaybookRoot(): string | null {
  const rel = path.join("skills", "option-buying-playbook");
  const candidates = [
    path.join(process.cwd(), rel),
    path.join(process.cwd(), "..", "..", rel),
    path.join("/home/sachin/Desktop/SMDApp", rel),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c; } catch { /* keep looking */ }
  }
  return null;
}

// ─── System Prompt ──────────────────────────────────────────────
export function buildSystemPrompt(ctx: {
  symbol: string;
  spotPrice: number;
  analysis: any;
  summary: any;
  expiryDate: string;
  session: any;
  trades: any[];
  conversationHistory?: any[];
  sdmSignal?: any;
  giftNifty?: any;
  correlation?: any;
  scanner?: any;
  apiBase?: string;
  extraContext?: string;
  dashboardContext?: string;
  [key: string]: any;
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

  const extraCtx = ctx.extraContext ? `
## PRE-FETCHED MARKET CONTEXT (free NSE/BSE/Yahoo)
${ctx.extraContext}` : "";
  const dashCtx = ctx.dashboardContext ? `
## DASHBOARD SNAPSHOT
${ctx.dashboardContext}` : "";

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

## OPTION BUYING PLAYBOOK (apply whenever you propose buying a CE/PE)
Educational framework, not financial advice — say that in one line. Most retail option buyers lose money (theta decay + IV crush), so discipline beats conviction:
- **Layers first**: only propose a buy when at least 3-4 independent layers agree (flow FII/DII, structure HH/HL + BOS, levels/OI walls, Greeks/IV, entry trigger). Conflicting layers → "skip" is the correct answer. "No trade" is a valid and frequent output.
- **Levels**: trade only at marked levels (prev day H/L, swing points, VWAP, round numbers, highest Call/Put OI walls) — never mid-range.
- **Stop lives on the underlying**, then convert to premium: premium risk ≈ points risked × delta. Buffer the stop (or require a candle close) — stop-hunts at obvious levels are common. Never widen a stop after entry.
- **Size**: (capital × risk%) ÷ (premium stop per lot). Risk 1% per trade, 2% max. If one lot exceeds the risk budget → tighter setup or cheaper instrument, never bigger risk. Never average down a losing option. Stop after 2-3 consecutive losses.
- **Entry quality**: delta ~0.45-0.65, sane IV percentile (never buy into pre-event IV spikes), enough days to expiry, liquid strike, reward:risk ≥ 1:2. Avoid the first 10-15 minutes. Intraday time stop: exit if no move in 20-30 minutes.
- **Always calculate the strike**: for "which strike / ATM or ITM or OTM / how many lots" run the strike_selector tool — it re-prices every strike at your target and stop (theta + IV shift) and ranks only strikes that pass: option R:R ≥ 1.5 (underlying R:R overstates it), theta cost within budget, break-even vs VIX-based expected move, lots ≥ 1 inside the risk budget. If nothing passes → skip / tighten the stop / spread — never loosen the gates. Check the target against the VIX expected move before believing it.
- **Honest data limits**: OI cannot reveal buyer vs writer (rising Put OI may be put buying) — infer from price behaviour; FII/DII + participant data is end-of-day → next-day bias only, not an intraday trigger; max pain has weak predictive value; PCR trend matters more than the level.
- Full skill with reference docs lives at skills/option-buying-playbook/ (scoring checklists, Greeks, OI levels, VIX/strike selection, math & formulas, hedging strategies, journal template) — run the read_playbook tool to open SKILL.md or any references/*.md for deep scoring, formula, checklist or hedge requests; strike math goes through strike_selector, hedging comparisons through hedge_calculator.
- Hedging ("hedge / reduce loss / lock profit / debit spread / portfolio hedge"): run hedge_calculator (mode=spread for one CE/PE, mode=portfolio for an index-put hedge) and read references/hedging-strategies.md via read_playbook. Warn every time: buy leg first, exit both legs together, never leave a short leg naked, verify margin/costs/lot size with the broker — a hedge lowers theta/vega/break-even at the cost of capped profit, never free money.

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
${extraCtx}
${dashCtx}

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

## CROSS-TAB INTELLIGENCE (Hermes Agent — data is pre-fetched based on your query)
The LIVE MARKET DATA below includes data fetched specifically for this question.
You have access to tools for deeper analysis. Use them when the pre-fetched data isn't enough.
- **Options/Strikes/Premium**: get_option_chain, get_options_edge, get_atm_straddle
- **Institutional/FII/DII**: get_institutional_positioning, get_fii_dii
- **Market Health/Regime**: get_market_regime, get_market_breadth, get_vix
- **Expiry/CAS**: get_cas_analysis, get_expiry_liquidity
- **Risk/Portfolio**: get_risk_status, get_portfolio, get_challenge_status
- **Memory/Learning**: search_memory, get_memory_summary, record_trade_memory
- **Trade Analysis**: get_trade_post_mortem, get_agent_analytics
- **Trade Signals**: get_sdm_signal, get_unified_ranking, get_trade_tracking
- **Most Active**: get_most_active_contracts (where institutional money is flowing)
- **Hermes Pro**: hermes_pro_analysis (full deterministic pipeline), hermes_tool_registry (tool metadata)

Always call multiple tools when you need deeper analysis. Cross-reference data for stronger signals.
If a tool you need isn't available, use the pre-fetched data in the LIVE MARKET DATA section.

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
12. 0DTE: Gamma acceleration, Dealer hedging, Premium decay speed, Only scalping allowed
13. MEMORY: Search past trades, record new ones, learn from patterns — use search_memory and record_trade_memory tools
14. POST-MORTEM: After a trade closes, analyze what went right/wrong — use get_trade_post_mortem tool

## TRADE DECISION FRAMEWORK (use when recommending trades)
When user asks "what trade should I take" or similar, follow this EXACTLY:

### Step 1: Read the LIVE MARKET DATA section above
- Spot price, PCR, Max Pain, ATM strike, VIX
- Support levels (PE OI walls) — where price is protected from falling
- Resistance levels (CE OI walls) — where price is protected from rising
- OI Movers — which strikes are seeing biggest position building
- Most Active Contracts — where institutional money is flowing

### Step 2: Determine Direction
- PCR > 1.2 + Spot > Max Pain + FII buying = BULLISH → BUY CALL
- PCR < 0.8 + Spot < Max Pain + FII selling = BEARISH → BUY PUT
- PCR 0.8-1.2 + Spot near Max Pain = RANGE-BOUND → WAIT (CE/PE BUY ONLY — no selling)
- Conflicting signals = NO TRADE

### Step 3: Select Strike
- For BUY CALL: Pick strike near support (high PE OI) or ATM
- For BUY PUT: Pick strike near resistance (high CE OI) or ATM
- Avoid strikes with very low OI (< 10K) — poor liquidity
- Prefer strikes with OI building in your direction (CE buildup for calls, PE buildup for puts)

### Step 4: Entry/SL/TP
- Entry: Current LTP or limit order at support/resistance
- SL: 30-50% of premium (max 2% of capital)
- TP1: 1:1 R:R, TP2: 1:2 R:R, TP3: 1:3 R:R
- Only recommend if R:R >= 1:2

### Step 5: Risk Check
- Max 1% capital per trade
- Check VIX: if > 20, reduce position size by 50%
- Check regime: if CHOPPY, reduce position size by 50%
- Never recommend if confidence < 65%

### Output Format
When recommending a trade, ALWAYS output:
"🎯 TRADE SIGNAL: BUY [STRIKE] [CE/PE]
Entry: ₹[price] | SL: ₹[price] | TP1: ₹[price] | TP2: ₹[price] | TP3: ₹[price]
R:R: 1:[ratio] | Confidence: [X]%
Why: [1-2 line reason using OI/PCR/support/resistance data]
Risk: [position size warning]"`;
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
      name: "strike_selector",
      description: "Calculate the exact option strike to buy. Re-prices every strike at the target and stop (theta + IV shift), applies gates (option R:R >= 1.5, theta cost, break-even vs VIX expected move, risk budget), sizes lots and ranks strikes. Use for: which strike to buy, ATM vs ITM vs OTM, how many lots, which expiry — and before proposing any CE/PE.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["call", "put"], description: "Option side to buy" },
          target: { type: "number", description: "Underlying target price" },
          stop: { type: "number", description: "Underlying stop price" },
          days: { type: "number", description: "Calendar days to expiry" },
          spot: { type: "number", description: "Spot price (default: live context spot)" },
          vix: { type: "number", description: "India VIX or ATM IV in percent (default: live context VIX)" },
          capital: { type: "number", description: "Capital in ₹ (default 200000)" },
          riskPct: { type: "number", description: "Risk % per trade (default 1)" },
          lotSize: { type: "number", description: "Lot size (default: known index lots; REQUIRED for stocks)" },
          holdDays: { type: "number", description: "Expected holding time in days (default 0.25 ~ intraday)" },
          ivShift: { type: "number", description: "Assumed IV change at exit in vol points (e.g. -2 for crush)" },
          chain: { type: "string", description: 'Live premiums "strike:premium,..." to calibrate IV per strike' },
        },
        required: ["direction", "target", "stop", "days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_playbook",
      description: "Read the Option Buying Playbook skill files — SKILL.md and references/*.md (scoring checklists, Greeks, OI levels, VIX & strike selection, math & formulas, trade setups, hedging strategies, participant data, journal template). Use for deep scoring, formula, checklist, hedge or 'what does the playbook say' requests. Omit file to list what's available.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path inside skills/option-buying-playbook — e.g. 'SKILL.md' or 'references/math-and-formulas.md'. Omit to list files." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hedge_calculator",
      description: "Compare a naked long CE/PE with vertical debit spreads (net debit, max loss, R:R, lots, upside given up) or size a portfolio index-put hedge — Black-Scholes repricing from the option buying playbook. Use for hedge / reduce loss / lock profit / debit spread / portfolio hedge requests.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["spread", "portfolio"], description: "spread = hedge one CE/PE position; portfolio = index-put hedge on a stock portfolio" },
          spot: { type: "number", description: "spread mode: underlying spot price" },
          vix: { type: "number", description: "India VIX (or ATM IV)" },
          days: { type: "number", description: "Days to expiry of the long option" },
          direction: { type: "string", enum: ["call", "put"], description: "spread mode: which option is held" },
          longStrike: { type: "number", description: "spread mode: strike of the long option being hedged" },
          longPremium: { type: "number", description: "spread mode: entry premium of the long option (if known)" },
          shortChain: { type: "string", description: "spread mode: short-leg candidates as strike:premium,... e.g. '25200:160,25250:130'" },
          target: { type: "number", description: "spread mode: target on the underlying" },
          stop: { type: "number", description: "spread mode: stop on the underlying" },
          holdDays: { type: "number", description: "Expected hold in days (default 1)" },
          capital: { type: "number", description: "Capital in ₹ (default 200000)" },
          riskPct: { type: "number", description: "Risk % per trade (default 1)" },
          lotSize: { type: "number", description: "Lot size — inferred from symbol if omitted" },
          value: { type: "number", description: "portfolio mode: portfolio value in ₹" },
          beta: { type: "number", description: "portfolio mode: portfolio beta (default 1)" },
          index: { type: "number", description: "portfolio mode: index spot level" },
          hedgeRatio: { type: "number", description: "portfolio mode: fraction to hedge, 0-1 (default 0.5)" },
          putPremium: { type: "number", description: "portfolio mode: ATM put premium in ₹" },
          maxWidth: { type: "number", description: "spread mode: max spread width in points" },
          minRR: { type: "number", description: "spread mode: minimum R:R to rank" },
        },
        required: ["mode"],
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
  {
    type: "function",
    function: {
      name: "get_unified_ranking",
      description: "Get the UNIFIED TRADE RANKING — scans ALL modes (Index F&O, Stock F&O, Equity Swing) and returns the strongest setups ranked by conviction score (0-100). Use this when user asks 'what should I trade now' or 'best trades'.",
      parameters: {
        type: "object",
        properties: {
          forceRefresh: { type: "boolean", description: "Force fresh data fetch (default false)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_index_fo",
      description: "Analyze Index F&O — NIFTY, BANKNIFTY, SENSEX for directional/index options trades. Returns signals with direction (LONG/SHORT/CALL/PUT/NO_TRADE), confidence, entry/SL/TP.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Index: NIFTY, BANKNIFTY, SENSEX (optional, defaults to all)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_fo",
      description: "Analyze Stock F&O — scans F&O stocks for the strongest futures/options setup. Returns top stocks with direction, confidence, entry/SL/TP.",
      parameters: {
        type: "object",
        properties: {
          maxStocks: { type: "number", description: "Max stocks to scan (default 10)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_equity_swing",
      description: "Analyze Equity Swing — scans NSE cash stocks for multi-day swing opportunities (breakout, pullback, trend continuation, accumulation). Returns buy zone, SL, targets, holding period.",
      parameters: {
        type: "object",
        properties: {
          maxStocks: { type: "number", description: "Max stocks to scan (default 10)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trade_tracking",
      description: "Get active tracked trades — shows all high-conviction setups being monitored with live P&L, MFE/MAE, stage (WATCH→SETUP→TRIGGERED→ACTIVE→TP1→TP2→STOPPED).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  // ═══════════════════════════════════════════════════════════
  // PHASE 2: NEW SMD TOOLS — Hermes Agent Integration
  // ═══════════════════════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_cas_analysis",
      description: "Get CAS (Close Auction Session) straddle analysis — IBTR range, VWAP reference, banknifty CAS state. Critical for expiry day trading.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, SENSEX" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_institutional_positioning",
      description: "Get institutional positioning — FIIs, DIIs, MF, retail, smart vs dumb money detection, trend analysis. For understanding who is doing what.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, SENSEX" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fii_dii",
      description: "Get FII and DII cash market flows with trend analysis. Shows net buying/selling by foreign and domestic institutions.",
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
      name: "get_options_edge",
      description: "Get Options Edge — dynamic delta, premium melt, gamma projection, trade card for a given strike. Best for single-strike deep analysis.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, SENSEX" },
          strike: { type: "number", description: "Strike price to analyze" },
          side: { type: "string", enum: ["CE", "PE"], description: "Option side" },
        },
        required: ["symbol", "strike", "side"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_expiry_liquidity",
      description: "Get Expiry Liquidity analysis — CAS dislocation, futures basis, IV velocity, OI classification, gamma pressure. Full expiry intelligence.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, SENSEX" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_regime",
      description: "Get market regime — trending/ranging/volatile/breakout, with bias and confidence. For understanding current market behavior.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, SENSEX" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_breadth",
      description: "Get market breadth — advance/decline, sector participation, new highs/lows. For understanding market health.",
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
      name: "get_vix",
      description: "Get India VIX — current level, percentile, trend. Critical for volatility regime assessment.",
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
      name: "get_atm_straddle",
      description: "Get ATM straddle — premium, IV, expected range. For understanding market expectations.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol: NIFTY, BANKNIFTY, FINNIFTY, SENSEX" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_risk_status",
      description: "Get risk engine status — current exposure, drawdown, capital usage, open positions. For risk-aware decisions.",
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
      name: "get_portfolio",
      description: "Get current portfolio — open positions, P&L, holdings. For understanding current exposure.",
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
      name: "get_challenge_status",
      description: "Get challenge engine status — active challenges, win/loss, performance. For tracking structured trading experiments.",
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
      name: "get_trade_post_mortem",
      description: "Analyze a completed trade — what went right/wrong, entry/exit quality, improvements. Use after a trade closes.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol traded" },
          strategy: { type: "string", description: "Strategy used" },
          entryPrice: { type: "number", description: "Entry price" },
          exitPrice: { type: "number", description: "Exit price" },
          pnl: { type: "number", description: "P&L in INR" },
          notes: { type: "string", description: "Any notes about the trade" },
        },
        required: ["symbol", "strategy", "entryPrice", "exitPrice", "pnl"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Search agent memory — past trades, setups, predictions, patterns. For learning from history.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (e.g. 'BANKNIFTY CE breakout', 'pullback trades')" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory_summary",
      description: "Get agent memory summary — best setups, win rates, recent trades, preferences. For quick memory overview.",
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
      name: "record_trade_memory",
      description: "Record a trade to memory — pattern, setup, outcome. For learning from each trade.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol traded" },
          strategy: { type: "string", description: "Strategy used" },
          setup: { type: "string", description: "Setup description (e.g. 'pullback to VWAP', 'breakout above resistance')" },
          entryPrice: { type: "number", description: "Entry price" },
          exitPrice: { type: "number", description: "Exit price (0 if still open)" },
          pnl: { type: "number", description: "P&L in INR (0 if still open)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for filtering" },
        },
        required: ["symbol", "strategy", "setup", "entryPrice"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_analytics",
      description: "Get agent performance analytics — tool usage, LLM call stats, error rates. For monitoring agent health.",
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
      name: "send_telegram_signal",
      description: "Send a trade signal to Telegram. Use this when you want to push a trade recommendation to the user's phone.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol (NIFTY, BANKNIFTY, SENSEX, etc.)" },
          action: { type: "string", description: "BUY only — option selling is not allowed" },
          strike: { type: "number", description: "Strike price" },
          optionType: { type: "string", description: "CE or PE" },
          confidence: { type: "number", description: "Confidence percentage" },
          entry: { type: "number", description: "Entry price" },
          stopLoss: { type: "number", description: "Stop loss price" },
          target1: { type: "number", description: "Target 1 price" },
          target2: { type: "number", description: "Target 2 price" },
        },
        required: ["symbol", "action", "strike", "optionType", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_all_instruments",
      description: "Scan ALL instruments (NIFTY, BANKNIFTY, SENSEX, FINNIFTY, MIDCPNIFTY, Stock F&O, Equity Swing, MCX Commodity) for high-accuracy trades. Returns top setups sorted by confidence.",
      parameters: {
        type: "object",
        properties: {
          minConfidence: { type: "number", description: "Minimum confidence threshold (default 70)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mcx_data",
      description: "Get MCX commodity data — CRUDEOIL, GOLD, SILVER, NATURALGAS. Shows live quotes, option chain, scanner.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "MCX symbol (CRUDEOIL, GOLD, SILVER, NATURALGAS)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "morning_scan",
      description: "Run the morning signal generator — scans ALL instruments and sends high-accuracy trades to Telegram. Use at market open.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  // ── Debugging / Reverse Engineering Tools ──
  {
    type: "function",
    function: {
      name: "diagnose_data_source",
      description: "Diagnose which data sources are alive/dead. Checks Breeze, NSE, Yahoo, Motilal, MCX APIs. Returns status, response times, error rates. Use when data is missing or stale.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Specific source to test: breeze, nse, yahoo, motilal, mcx, or 'all'" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trace_data_flow",
      description: "Trace data flow from source → processing → output. Finds where data breaks in the pipeline. Use when a feature shows stale/missing data.",
      parameters: {
        type: "object",
        properties: {
          feature: { type: "string", description: "Feature to trace: option_chain, scanner, sdm_signal, mcx, morning_scan, intraday, heatmap, fii_dii" },
        },
        required: ["feature"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "test_api_endpoint",
      description: "Test any API endpoint with custom params. Returns raw response, status code, headers, timing. Use to debug failing APIs.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to test (e.g., /api/option-chain?symbol=NIFTY or external URL)" },
          method: { type: "string", description: "HTTP method: GET or POST (default GET)" },
          body: { type: "string", description: "JSON body for POST requests" },
        },
        required: ["url"],
      },
    },
  },
  // ── Session health (single-owner session-expiry system) ──
  {
    type: "function",
    function: {
      name: "check_session_tokens",
      description: "Check LIVE validity of data-source sessions (Breeze, Motilal, NSE). Probes each source in real time (never cached) and includes recorded failure episodes from the session-health system with remedies. Use when data is missing/stale, after auth errors, or when the user asks about sessions/tokens.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "breeze, mo, nse, or all (default all)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_breeze_session",
      description: "Set/refresh the ICICI Breeze API session token after the user completes browser OTP login. Validates it live, persists the session, and clears the session-expired episode. Use ONLY when the user supplies a fresh token.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string", description: "Breeze apiSession token from https://api.icicidirect.com/apiuser/login?api_key=..." },
        },
        required: ["token"],
      },
    },
  },
  // ── Hermes Pro Tools ─────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "hermes_pro_analysis",
      description: "Run Hermes Pro deterministic analysis — full market intelligence pipeline. Returns scored trade candidate with regime, OI, gamma, flow, strike selection, validation, and risk. Use for complete trade decisions. NEVER returns fabricated data.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Instrument: NIFTY, BANKNIFTY, FINNIFTY, SENSEX, MIDCPNIFTY" },
          mode: { type: "string", description: "Analysis mode: TRADE (full pipeline), RESEARCH (data only), QUICK (fast scan)", enum: ["TRADE", "RESEARCH", "QUICK"] },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hermes_tool_registry",
      description: "Query Hermes Pro tool registry — list available tools, their freshness requirements, reliability scores. Use to understand what data sources are available and how fresh they need to be.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Filter by category: MARKET_DATA, OPTIONS, VOLATILITY, STRUCTURE, FLOW, RISK, MEMORY, ALL" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_most_active_contracts",
      description: "Get NSE Most Active F&O Contracts — top contracts by volume, futures, options, calls, puts, OI. Shows where institutional money is flowing. Use when asked about most active, volume leaders, or where money is going.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter: contracts, futures, options, calls, puts, oi (default: contracts)" },
        },
        required: [],
      },
    },
  },
];

// ─── Tool Router — pre-select relevant tools per query ──────────────
// Free LLM models can't reliably choose from 36 tools. This router
// selects 8-12 relevant tools per query so the LLM always sees them.

interface ToolRouterEntry {
  tools: string[];
  keywords: RegExp;
}

const TOOL_ROUTER: ToolRouterEntry[] = [
  // Institutional / FII / DII
  { tools: ["get_fii_dii", "get_institutional_positioning", "get_sdm_signal"], keywords: /fii|dii|institution|foreign|domestic|fund.?flow|smart.?money/i },
  // Market regime / breadth / VIX
  { tools: ["get_market_regime", "get_market_breadth", "get_vix", "get_market_structure"], keywords: /regime|breadth|vix|volatil|trend|range|breakout|market.?health/i },
  // Expiry / CAS
  { tools: ["get_cas_analysis", "get_expiry_liquidity", "get_atm_straddle"], keywords: /cas|expiry|straddle|ibtr|auction|dislocat|gamma.?pressur|iv.?veloc/i },
  // Options edge / Greeks deep
  { tools: ["get_options_edge", "get_option_chain", "get_atm_straddle"], keywords: /edge|greeks?|delta|gamma|theta|vega|melt|iv.?skew|premium.?melt/i },
  // Risk / Portfolio
  { tools: ["get_risk_status", "get_portfolio", "get_challenge_status"], keywords: /risk|portfolio|position|p&l|exposure|drawdown|challenge|open.?trade/i },
  // Memory / Learning
  { tools: ["search_memory", "get_memory_summary", "record_trade_memory"], keywords: /memory|past.?trade|setup|pattern|learn|history|record|prediction/i },
  // Trade post-mortem
  { tools: ["get_trade_post_mortem", "search_memory"], keywords: /post.?mortem|review|what.?went|analyze.?trade|close.?trade|exit.?quality/i },
  // News
  { tools: ["get_news_sentiment"], keywords: /news|sentiment|headline|media|current.?event/i },
  // Gift Nifty / Gap
  { tools: ["get_gift_nifty"], keywords: /gift|gap|overnight|pre.?market|open/i },
  // Correlation
  { tools: ["get_correlation_signal"], keywords: /correlat|nifty.*sensex|sensex.*nifty|drift|beta/i },
  // Scanner / Breakout / All instruments
  { tools: ["get_scanner_picks", "get_breakout_signals", "scan_all_instruments"], keywords: /scan|breakout|momentum|pick|stock|intraday|signal|all.?instrument|every|everything|all.?trade|commodity|mcx/i },
  // Backtest
  { tools: ["get_backtest_results"], keywords: /backtest|historical|past.?performance|win.?rate/i },
  // Trade recommendation / best trade / send signal
  { tools: ["get_sdm_signal", "get_unified_ranking", "get_index_fo", "get_trade_tracking", "send_telegram_signal"], keywords: /trade|recommend|best|entry|sl|target|buy|sell|call|put|option|ce |pe |position|straddle|strangle|zero.?hero|hero.?zero|what.?should|which|where|when|send.*telegram|push.*signal|alert.*phone/i },
  // MCX / Commodity
  { tools: ["get_mcx_data", "scan_all_instruments"], keywords: /mcx|commodity|crude|gold|silver|natural.?gas|energy|precious/i },
  // Morning scan
  { tools: ["morning_scan", "scan_all_instruments"], keywords: /morning|daily|today|pre.?market|open|start.*day/i },
  // Agent analytics
  { tools: ["get_agent_analytics"], keywords: /analytics|agent.?health|tool.?usage|performance|llm.?call/i },
  // Hermes Pro analysis
  { tools: ["hermes_pro_analysis", "hermes_tool_registry"], keywords: /hermes|pro.?analysis|full.?analysis|trade.?decision|deterministic|scoring|regime.?analysis|complete.?analysis/i },
  // Most Active / Volume / Money flow
  { tools: ["get_most_active_contracts", "get_scanner_picks", "get_fii_dii"], keywords: /most.?active|volume.?leader|where.?money|money.?flow|institutional.?flow|big.?volume|active.?contract|fno.?data| derivatives.?data/i },
  // Debugging / Reverse engineering
  { tools: ["diagnose_data_source", "trace_data_flow", "test_api_endpoint"], keywords: /diagnos|debug|data.?source|api.?fail|not.?fetch|missing|stale|broken|test.?api|check.?api|trace|reverse|engineer|why.*not.*work|what.*wrong/i },
  // Strike selection (option buying playbook)
  { tools: ["strike_selector", "get_option_chain", "get_vix"], keywords: /strike|itm|otm|which (call|put|ce|pe)|how many lots|lot size|entry strike|buy.*expir|expir.*buy|expected move|break-?even|atm or/i },
  // Playbook reference docs (checklists, formulas, deep scoring — read the skill files)
  { tools: ["read_playbook"], keywords: /checklist|playbook|formula|black.?scholes|greeks? (explain|detail|meaning)|reference doc|setup scor|journal template|vix regime|read (the )?(skill|doc)|maths? (and|&) formulas/i },
  // Hedging (playbook hedge calculator + hedging reference)
  { tools: ["hedge_calculator", "read_playbook", "get_vix"], keywords: /\bhedge|hedges|hedging|reduce (my )?(loss|risk)|protect (profit|position|my)|lock (in )?(profit|gains)|profit protect|debit spread|portfolio hedge|index put hedge|butterfly|calendar spread/i },
  // Session health (tokens, auth, expiry)
  { tools: ["check_session_tokens", "set_breeze_session"], keywords: /session|token|login|expir|totp|otp|re-?auth|breeze.*auth|auth.*breeze|set.*session/i },
];

// Core tools always included
const CORE_TOOLS = ["get_sdm_signal", "get_option_chain", "get_market_structure", "get_news_sentiment"];

export function selectToolsForQuery(message: string): any[] {
  const msgLower = message.toLowerCase();
  const selectedNames = new Set<string>(CORE_TOOLS);

  for (const entry of TOOL_ROUTER) {
    const re = entry.keywords;
    if (re.test(msgLower)) {
      for (const t of entry.tools) selectedNames.add(t);
    }
  }

  // If query is very generic, add ranking + trade tools
  if (selectedNames.size <= 4) {
    selectedNames.add("get_unified_ranking");
    selectedNames.add("get_scanner_picks");
    selectedNames.add("get_trade_tracking");
  }

  // Always include at least 8 tools, never more than 14
  const allToolNames = AGENT_TOOLS.map((t: any) => t.function.name);
  for (const name of allToolNames) {
    if (selectedNames.size >= 14) break;
    selectedNames.add(name);
  }

  const filtered = AGENT_TOOLS.filter((t: any) => selectedNames.has(t.function.name));
  console.log(`[ToolRouter] Query: "${message.substring(0, 60)}" → ${filtered.length} tools: ${filtered.map((t: any) => t.function.name).join(", ")}`);
  return filtered;
}

// ─── Tool Execution ─────────────────────────────────────────────
export async function executeTool(
  name: string,
  args: any,
  ctx: { symbol: string; spotPrice: number; analysis: any; summary: any; apiBase?: string }
): Promise<string> {
  console.log(`[AgentBrain] executeTool: ${name} args=${JSON.stringify(args)} ctx=${ctx ? 'OK' : 'NULL'}`);
  args = args || {};
  const symbol = args.symbol || ctx?.symbol || "NIFTY";
  const BASE = ctx?.apiBase || process.env.NEXT_PUBLIC_BASE_URL || "";
  switch (name) {
    case "get_option_chain": {
      try {
        const res = await fetch(`${BASE}/api/option-chain?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch option chain";
        const chain = data.data?.strikes || [];
        const summary = data.data?.summary || {};
        const topOI = chain
          .sort((a: any, b: any) => (b.ce?.oi || 0) - (a.ce?.oi || 0))
          .slice(0, 10)
          .map((s: any) => `₹${s.strike}: CE_OI=${(s.ce?.oi || 0).toLocaleString("en-IN")} PE_OI=${(s.pe?.oi || 0).toLocaleString("en-IN")} CE_LTP=${s.ce?.ltp || 0} PE_LTP=${s.pe?.ltp || 0}`);
        return `Option Chain for ${symbol}:\nSpot: ₹${data.data?.spotPrice}\nPCR: ${(summary.pcr ?? data.data?.pcr)?.toFixed(2) ?? "N/A"}\nMax Pain: ₹${summary.maxPain}\nATM: ₹${summary.atmStrike}\nTop OI Strikes:\n${topOI.join("\n")}`;
      } catch { return "Error fetching option chain"; }
    }

    case "get_backtest_results": {
      try {
        const days = args.days || 30;
        const end = new Date().toISOString().split("T")[0];
        const start = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
        const res = await fetch(`${BASE}/api/backtest?symbol=${symbol}&startDate=${start}&endDate=${end}`, { signal: AbortSignal.timeout(20000) });
        const data = await res.json();
        if (!data.success) return "Failed to run backtest";
        const p = data.data.performance;
        return `Backtest Results (${days} days):\nTotal Trades: ${p.totalTrades} | Win Rate: ${p.winRate}% | P&L: ${p.totalPnL >= 0 ? "+" : ""}₹${p.totalPnL.toLocaleString("en-IN")}\nProfit Factor: ${p.profitFactor} | Sharpe: ${p.sharpeRatio} | Max Drawdown: ₹${p.maxDrawdown.toLocaleString("en-IN")}\nBest Day: ${p.bestDay.date} (+₹${p.bestDay.pnl.toLocaleString("en-IN")}) | Worst Day: ${p.worstDay.date} (₹${p.worstDay.pnl.toLocaleString("en-IN")})\nExpectancy: ₹${p.expectancy.toLocaleString("en-IN")}/trade | Avg Hold: ${p.avgHoldBars * 5}min\nGrade Distribution: ${JSON.stringify(p.gradeDistribution)}`;
      } catch { return "Error running backtest"; }
    }

    case "get_scanner_picks": {
      try {
        const res = await fetch(`${BASE}/api/scanner?symbol=${symbol}`, { signal: AbortSignal.timeout(45000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch scanner";
        const picks = (data.data?.candidates || []).slice(0, 10);
        if (picks.length === 0) return "No scanner picks available right now";
        return `Scanner Top 10:\n${picks.map((p: any, i: number) => `${i + 1}. ${p.symbol} | Score: ${p.totalScore ?? p.unifiedScore} | Technicals: ${p.technicalScore ?? "—"} | OI: ${p.optionsScore ?? "—"} | ${p.direction ?? p.engineDirection ?? "—"}`).join("\n")}`;
      } catch { return "Error fetching scanner"; }
    }

    case "get_news_sentiment": {
      try {
        const res = await fetch(`${BASE}/api/news`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch news";
        const market = data.data || {};
        const articles = (market.articles || []).slice(0, 8);
        const x = market.x;
        const xLine = !x
          ? "X Buzz: N/A"
          : x.available
            ? `X Buzz: ${x.label} (Score: ${x.score}/100, ${x.tweetCount} posts)` +
              (x.samples?.length ? `\nTop X posts:\n${x.samples.slice(0, 3).map((t: any) => `- [${t.label}] ${t.author ? t.author + " " : ""}${t.text?.substring(0, 90)}`).join("\n")}` : "")
            : `X Buzz: unavailable (${x.reason || "no data"})`;
        return `Market Sentiment: ${market.label || "N/A"} (Score: ${market.overall ?? 0}/100)\nBullish: ${(market.topBullish || []).map((s: any) => s.symbol).join(", ") || "N/A"}\nBearish: ${(market.topBearish || []).map((s: any) => s.symbol).join(", ") || "N/A"}\n${xLine}\nLatest:\n${articles.map((a: any) => `- [${a.sentiment > 0 ? "+" : a.sentiment < 0 ? "-" : "="}] ${a.title?.substring(0, 60)}`).join("\n")}`;
      } catch { return "Error fetching news"; }
    }

    case "get_breakout_signals": {
      try {
        const res = await fetch(`${BASE}/api/breakout?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) });
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
        const res = await fetch(`${BASE}/api/trade-journal?symbol=${symbol}`, { signal: AbortSignal.timeout(10000) });
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
        const res = await fetch(`${BASE}/api/sdm-signal?symbol=${symbol}&expiryDay=${isExpiryDay}`, { signal: AbortSignal.timeout(25000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch SDM signal";
        const s = data.signal;
        if (!s) return "No SDM signal available";
        const gt = s.gammaThetaData || {};
        const sc = s.sdmScores || {};
        const mc = s.marketContext || {};
        return `SDM LIVE SIGNAL — ${symbol} @ ₹${mc.spot ?? "—"}
═══════════════════════════════════
DIRECTION: ${s.direction} | MODE: ${s.mode}
Trend: ${mc.trend ?? "—"} | Regime: ${s.marketRegime ?? mc.regime ?? "—"}
Support: — | Resistance: — (V2 signal has no S/R levels)
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
        const res = await fetch(`${BASE}/api/sdm-signal?symbol=${symbol}`, { signal: AbortSignal.timeout(25000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch market structure";
        const s = data.signal || {};
        const ms = s.marketStructure;
        if (!ms) {
          // V2 signal has no structure block — render what it does have (marketContext).
          const mc = s.marketContext || {};
          if (!mc.trend) return "No market structure data";
          return `Market Structure for ${symbol} (V2 context):
Trend: ${mc.trend} | Regime: ${s.marketRegime ?? mc.regime ?? "—"}
PCR: ${mc.pcr ?? "—"} | Max Pain: ₹${mc.maxPain ?? "—"} | VIX: ${mc.vix ?? "—"} | Spot: ₹${mc.spot ?? "—"}
Note: V2 engine reports trend/PCR/maxPain only — swing and S-R levels not computed`;
        }
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
        const res = await fetch(`${BASE}/api/correlation`, { signal: AbortSignal.timeout(20000) });
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
          fetch(`${BASE}/api/sdm-signal?symbol=${symbol}&expiryDay=${isExpiryDay}`, { signal: AbortSignal.timeout(25000) }).then(r => r.json()).catch(() => null),
          fetch(`${BASE}/api/option-chain?symbol=${symbol}`, { signal: AbortSignal.timeout(20000) }).then(r => r.json()).catch(() => null),
        ]);
        if (!sdmRes || sdmRes.status !== "fulfilled" || !sdmRes.value?.success) return "Failed to fetch SDM signal for trade recommendation";
        const s = sdmRes.value.signal;
        if (!s) return "No trade recommendation available right now — market may be closed or data unavailable";
        const mc = s.marketContext || {};
        const sc = s.sdmScores || {};
        const ps = s.positionSizing || {};
        const ms = s.marketStructure || {};
        const gt = s.gammaThetaData || {};
        const pct = (a: any, b: any) => (a > 0 && b != null) ? (((b - a) / a) * 100).toFixed(1) : "—";

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
- Stop Loss: ${s.entry > 0 ? `₹${s.sl} (${pct(s.entry, s.sl)}% loss)` : `₹${s.sl} (entry not set — WAIT mode)`}
- Target 1: ${s.entry > 0 ? `₹${s.tp1} (${pct(s.entry, s.tp1)}% gain)` : `₹${s.tp1}`}
- Target 2: ${s.entry > 0 ? `₹${s.tp2} (${pct(s.entry, s.tp2)}% gain)` : `₹${s.tp2}`}
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
        const res = await fetch(`${BASE}/api/gift-nifty`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (!data.success) return "Gift Nifty data not available (may use estimated spot)";
        const g = data.data || data;
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
        const res = await fetch(`${BASE}/api/nse?type=historical&symbol=${symbol}&days=${days}`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch historical data";
        const candles = data.data || [];
        if (candles.length === 0) return "No historical data available";
        const first = candles[0];
        const last = candles[candles.length - 1];
        const high = Math.max(...candles.map((c: any) => c.high || c.highPrice || 0));
        const low = Math.min(...candles.map((c: any) => c.low || c.lowPrice || Infinity));
        const atr = candles.slice(-14).reduce((sum: number, c: any, idx: number) => {
          const prev = candles[idx - 1];
          if (!prev) return sum;
          const tr = Math.max(
            (c.high || c.highPrice || 0) - (c.low || c.lowPrice || 0),
            Math.abs((c.high || c.highPrice || 0) - (prev.close || prev.closePrice || 0)),
            Math.abs((c.low || c.lowPrice || 0) - (prev.close || prev.closePrice || 0))
          );
          return sum + tr;
        }, 0) / Math.min(candles.length, 14);
        const changes = candles.slice(-5).map((c: any, i: number, arr: any[]) => {
          if (i === 0) return "";
          const prevClose = arr[i - 1]?.close || arr[i - 1]?.closePrice || 0;
          const curClose = c.close || c.closePrice || 0;
          if (!prevClose) return "";
          return `${c.date || String(c.timestamp || "").substring(0, 10)}: ${curClose >= prevClose ? "+" : ""}${((curClose - prevClose) / prevClose * 100).toFixed(2)}%`;
        }).filter(Boolean);
        const src = data.source || "nse";
        return `Historical Data (${days}d, source: ${src}) — ${symbol}:
Period: ${first.date || "N/A"} → ${last.date || "N/A"}
Range: ₹${low} — ₹${high} | Current: ₹${(last.close || last.closePrice || 0).toLocaleString("en-IN")}
ATR(14): ${atr.toFixed(2)} | Volatility: ${low > 0 ? ((high - low) / low * 100).toFixed(1) : "0"}%
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

    case "get_unified_ranking": {
      try {
        const forceRefresh = args.forceRefresh || false;
        const res = await fetch(`${BASE}/api/trade-intelligence?action=ranking&force=${forceRefresh}`, { signal: AbortSignal.timeout(40000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch unified ranking";
        const r = data.data;
        const hc = r.highConvictionSetups || [];
        const watch = r.watchSetups || [];
        const noTrade = r.noTrade;
        if (noTrade) return `NO HIGH-CONVICTION TRADES FOUND\n\nScanned ${r.summary.totalScanned} setups across Index F&O (${r.summary.indexFOCount}), Stock F&O (${r.summary.stockFOCount}), and Equity Swing (${r.summary.equitySwingCount}).\n\nReason: ${r.noTradeReason}\n\nAvg Score: ${r.summary.avgScore}/100 | Best Mode: ${r.summary.bestMode} | Data: ${r.dataQuality}`;
        let output = `UNIFIED TRADE RANKING — ${new Date().toLocaleTimeString("en-IN")}\nSession: ${r.sessionPhase} | Data: ${r.dataQuality}\n\n`;
        if (hc.length > 0) {
          output += `HIGH-CONVICTION SETUPS:\n`;
          hc.forEach((s: any, i: number) => {
            output += `${i + 1}. ${s.symbol} (${s.mode}) — ${s.score}/100 ${s.conviction === "EXTREME" ? "🔥" : ""}\n   Direction: ${s.direction} | Entry: ₹${s.entry} | SL: ₹${s.stopLoss} | TP1: ₹${s.target1} | TP2: ₹${s.target2}\n   R:R: 1:${s.riskReward?.toFixed(1)} | Holding: ${s.holdingPeriod} | Instrument: ${s.recommendedInstrument}\n   Why: ${s.reasoning.slice(0, 3).join("; ")}\n\n`;
          });
        }
        if (watch.length > 0) {
          output += `WATCH LIST:\n`;
          watch.slice(0, 5).forEach((s: any, i: number) => {
            output += `${i + 1}. ${s.symbol} (${s.mode}) — ${s.score}/100 | ${s.direction} | ${s.recommendedInstrument}\n`;
          });
        }
        return output;
      } catch { return "Error fetching unified ranking"; }
    }

    case "get_index_fo": {
      try {
        const res = await fetch(`${BASE}/api/trade-intelligence?action=index-fo`, { signal: AbortSignal.timeout(40000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch Index F&O analysis";
        const signals = data.data.signals || [];
        if (signals.length === 0) return "No Index F&O signals available";
        return `INDEX F&O ANALYSIS:\n\n${signals.map((s: any) => `${s.symbol}: ${s.direction} (${s.confidence}% confidence)\n  Entry: ₹${s.entry} | SL: ₹${s.stopLoss} | TP1: ₹${s.target1} | TP2: ₹${s.target2}\n  R:R: 1:${s.riskReward?.toFixed(1)} | Instrument: ${s.recommendedInstrument}\n  Factors: PCR=${s.factors.oiAnalysis} Futures=${s.factors.futuresPositioning} Regime=${s.factors.regimeAlignment} Breadth=${s.factors.breadthConfirmation}\n  Why: ${s.reasoning.slice(0, 3).join("; ")}`).join("\n\n")}`;
      } catch { return "Error fetching Index F&O analysis"; }
    }

    case "get_stock_fo": {
      try {
        const maxStocks = args.maxStocks || 10;
        const res = await fetch(`${BASE}/api/trade-intelligence?action=stock-fo`, { signal: AbortSignal.timeout(40000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch Stock F&O analysis";
        const signals = data.data.signals || [];
        if (signals.length === 0) return "No Stock F&O signals available";
        return `STOCK F&O ANALYSIS (Top ${maxStocks}):\n\n${signals.slice(0, maxStocks).map((s: any, i: number) => `${i + 1}. ${s.symbol} (${s.sector}) — ${s.direction} (${s.confidence}%)\n   Entry: ₹${s.entry} | SL: ₹${s.stopLoss} | TP1: ₹${s.target1} | TP2: ₹${s.target2}\n   Instrument: ${s.recommendedInstrument} | R:R: 1:${s.riskReward?.toFixed(1)}\n   Why: ${s.reasoning.slice(0, 2).join("; ")}`).join("\n\n")}`;
      } catch { return "Error fetching Stock F&O analysis"; }
    }

    case "get_equity_swing": {
      try {
        const maxStocks = args.maxStocks || 10;
        const res = await fetch(`${BASE}/api/trade-intelligence?action=equity-swing`, { signal: AbortSignal.timeout(40000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch Equity Swing analysis";
        const signals = data.data.signals || [];
        if (signals.length === 0) return "No Equity Swing signals available";
        return `EQUITY SWING ANALYSIS (Top ${maxStocks}):\n\n${signals.slice(0, maxStocks).map((s: any, i: number) => `${i + 1}. ${s.symbol} (${s.sector}) — ${s.direction} (${s.confidence}%)\n   Setup: ${s.setup.type} — ${s.setup.description}\n   Entry: ₹${s.entry} | SL: ₹${s.stopLoss} | TP1: ₹${s.target1} | TP2: ₹${s.target2}\n   R:R: 1:${s.riskReward?.toFixed(1)} | Holding: ${s.holdingPeriod} | Move: ${s.expectedMove}\n   Why: ${s.reasoning.slice(0, 2).join("; ")}`).join("\n\n")}`;
      } catch { return "Error fetching Equity Swing analysis"; }
    }

    case "get_trade_tracking": {
      try {
        const res = await fetch(`${BASE}/api/trade-intelligence?action=trades`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch trade tracking";
        const trades = data.data.trades || [];
        const stats = data.data.stats || {};
        if (trades.length === 0) return `No active tracked trades.\nStats: Total tracked: ${stats.total} | Avg Score: ${stats.avgScore}`;
        return `ACTIVE TRACKED TRADES (${trades.length}):\n\n${trades.map((t: any) => `${t.symbol} (${t.mode}) — ${t.stage} | Score: ${t.score}\n  Direction: ${t.direction} | Entry: ₹${t.entry} | Current: ₹${t.currentPrice}\n  P&L: ${t.unrealizedPnL >= 0 ? "+" : ""}₹${t.unrealizedPnL.toFixed(0)} (${t.unrealizedPnLPercent >= 0 ? "+" : ""}${t.unrealizedPnLPercent.toFixed(1)}%)\n  MFE: ₹${t.mfe.toFixed(0)} | MAE: ₹${t.mae.toFixed(0)} | R:R: 1:${t.riskReward?.toFixed(1)}\n  Created: ${new Date(t.createdAt).toLocaleTimeString("en-IN")}`).join("\n\n")}\n\nStats: Active: ${stats.active} | Total: ${stats.total} | Avg Score: ${stats.avgScore}`;
      } catch { return "Error fetching trade tracking"; }
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: NEW SMD TOOL EXECUTION — Hermes Agent Integration
    // ═══════════════════════════════════════════════════════════

    case "get_cas_analysis": {
      try {
        const res = await fetch(BASE + "/api/cas-straddle?symbol=" + symbol, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success && !data.signal) return "Failed to fetch CAS analysis";
        const sig = data.signal || {};
        return "CAS Analysis for " + symbol + ":\nStrategy: " + (sig.strategy || "N/A") + " | Trade Quality: " + (sig.tradeQuality ?? "N/A") + "/100\nConfidence: " + (sig.confidence ?? 0) + "%\nReasoning:\n" + ((sig.reasoning || []).map((r: string) => "- " + r).join("\n") || "- N/A");
      } catch { return "Error fetching CAS analysis"; }
    }

    case "get_institutional_positioning": {
      try {
        const res = await fetch(BASE + "/api/institutional-greeks?symbol=" + symbol, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success && !data.data) return "Failed to fetch institutional positioning";
        const d = data.data || {};
        const m = d.metrics || {};
        // Wall fields are objects {strike, type, acceleration, ...} on the live API
        const w = (v: any) => typeof v === "object" && v !== null
          ? `₹${v.strike ?? "?"} (${v.type ?? "?"}, accel ${v.acceleration ?? "?"})`
          : v != null ? `₹${v}` : "N/A";
        return "Institutional Positioning for " + symbol + ":\nRegime: " + (d.regime || "N/A") + " | Session: " + (d.sessionPhase || "N/A") +
          "\nDealer Wall: " + w(d.dealerWallStrike) + " | Institutional Strike: " + w(d.institutionalStrike) + " | Trap Risk: " + w(d.trapRiskStrike) +
          "\nAvg Accel: " + (m.avgAcceleration ?? "N/A") + " | Max Accel: " + (m.maxAcceleration ?? "N/A") + " | Velocity: " + (m.avgVelocity ?? "N/A") +
          "\nPCR: " + (m.pcr ?? "N/A") + " | VIX: " + (m.vix ?? "N/A") + " | Spot: ₹" + (d.spot ?? "N/A") + (d.stale ? "\n⚠️ STALE DATA" : "");
      } catch { return "Error fetching institutional positioning"; }
    }

    case "get_fii_dii": {
      try {
        const res = await fetch(BASE + "/api/fii-dii", { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success && data.fiiNet == null) return "Failed to fetch FII/DII data";
        const latest = data.latest || data;
        const fii = latest.fiiNet;
        const dii = latest.diiNet;
        const fiiBias = latest.fiiBias || (typeof fii === "number" ? (fii >= 0 ? "BUYING" : "SELLING") : "N/A");
        const diiBias = latest.diiBias || (typeof dii === "number" ? (dii >= 0 ? "BUYING" : "SELLING") : "N/A");
        return "FII/DII Cash Flows:\nFII: " + (fii >= 0 ? "+" : "") + "₹" + fii + "Cr (" + fiiBias + ")\nDII: " + (dii >= 0 ? "+" : "") + "₹" + dii + "Cr (" + diiBias + ")\nDate: " + (latest.date || "N/A") +
          "\nFII 5-day avg: ₹" + (data.fiiNet5dAvg ?? "N/A") + "Cr | DII 5-day avg: ₹" + (data.diiNet5dAvg ?? "N/A") + "Cr";
      } catch { return "Error fetching FII/DII data"; }
    }

    case "get_options_edge": {
      try {
        const { strike, side } = args;
        if (!strike || !side) return "Missing required params: strike, side (CE/PE)";
        const res = await fetch(BASE + "/api/options-edge?symbol=" + symbol + "&strike=" + strike + "&side=" + side, { signal: AbortSignal.timeout(20000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch options edge";
        const rows = data.data?.strikeAnalyses || [];
        const row = rows.find((r: any) => String(r.strike) === String(strike)) || rows[0];
        if (!row) return "No options edge data for this strike";
        const leg = String(side).toUpperCase() === "PE" ? row.pe : row.ce;
        if (!leg) return "No " + side + " leg data for strike " + row.strike;
        // premiumMeltScore is {score, level, …} on the live API (number on older shapes)
        const melt = typeof leg.premiumMeltScore === "object" && leg.premiumMeltScore !== null
          ? `${leg.premiumMeltScore.score} (${leg.premiumMeltScore.level})`
          : leg.premiumMeltScore ?? "N/A";
        return "Options Edge: " + symbol + " ₹" + row.strike + " " + String(side).toUpperCase() + " (spot ₹" + (data.data?.spot ?? "N/A") + ")" +
          "\nLTP: ₹" + (leg.ltp ?? "N/A") + " | Delta: " + (leg.delta?.toFixed(4) ?? "N/A") + " | Gamma: " + (leg.gamma?.toFixed(4) ?? "N/A") +
          "\nIV: " + (leg.iv != null ? leg.iv + "%" : "N/A") + " | Theta: " + (leg.theta ?? "N/A") +
          "\nOI: " + (leg.oi != null ? leg.oi.toLocaleString("en-IN") : "N/A") + " | Melt Score: " + melt +
          "\nExp. Premium Move: " + (leg.expectedPremiumMove != null ? "₹" + leg.expectedPremiumMove : "N/A") + " | IV State: " + (leg.ivState || "N/A") + " | Velocity: " + (leg.premiumVelocity ?? "N/A") +
          "\nDecision: " + (data.data?.tradeDecision?.action || "N/A");
      } catch { return "Error fetching options edge"; }
    }

    case "get_expiry_liquidity": {
      try {
        const res = await fetch(BASE + "/api/expiry-liquidity?symbol=" + symbol, { signal: AbortSignal.timeout(20000) });
        const data = await res.json();
        if (!data.success && !data.data) return "Failed to fetch expiry liquidity";
        const d = data.data || {};
        const of = d.optionFlow || {};
        return "Expiry Liquidity for " + symbol + ":" +
          "\nDirection: " + (d.direction ?? "—") + " | Expiry Score: " + (d.expiryScore ?? "—") + " | Bull: " + (d.bullishScore ?? "—") + " | Bear: " + (d.bearishScore ?? "—") +
          "\nCAS: " + (d.casActive ? "ACTIVE" : "inactive") + " | Reference: ₹" + (d.casReferencePrice ?? "—") + " | Dislocation: " + (d.casDislocationPct ?? "—") + "%" +
          "\nFutures: ₹" + (d.futuresPrice ?? "—") + (d.futuresConfirmed ? " (confirmed)" : " (unconfirmed)") +
          "\nATM: ₹" + (d.atmStrike ?? "—") + " | Option Flow: call " + (of.callMomentum ?? "—") + " / put " + (of.putMomentum ?? "—") + " / net " + (of.netFlow ?? "—") +
          (d.isExpiryDay ? "\n⚠️ EXPIRY DAY" : "");
      } catch { return "Error fetching expiry liquidity"; }
    }

    case "get_market_regime": {
      try {
        const res = await fetch(BASE + "/api/market/regime?symbol=" + symbol, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success && !data.regime) return "Failed to fetch market regime";
        // factors is an object map ({indexTrend: -26, breadth: -40, …}) on the live route
        const factors = Array.isArray(data.factors)
          ? data.factors.join(", ")
          : data.factors && typeof data.factors === "object"
            ? Object.entries(data.factors).map(([k, v]) => `${k}=${v}`).join(", ")
            : null;
        return "Market Regime for " + symbol + ":\nRegime: " + (data.regime || "N/A") + " | Bias: " + (data.bias || "N/A") + "\nConfidence: " + (data.confidence || 0) + "% | Factors: " + (factors || "N/A");
      } catch { return "Error fetching market regime"; }
    }

    case "get_market_breadth": {
      try {
        const res = await fetch(BASE + "/api/market/breadth", { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success && !data.breadth) return "Failed to fetch market breadth";
        const b = data.breadth || data.data || {};
        return "Market Breadth:\nScore: " + (b.score ?? "N/A") + (b.label ? " (" + b.label + ")" : "") + "\nAdvances: " + (b.advances || 0) + " | Declines: " + (b.declines || 0) + " | Unchanged: " + (b.unchanged || 0) + "\nA/D Ratio: " + (b.adRatio || "N/A") + " | New Highs: " + (b.newHighs || 0) + " | New Lows: " + (b.newLows || 0);
      } catch { return "Error fetching market breadth"; }
    }

    case "get_vix": {
      // Free NSE VIX first (no Breeze), then Yahoo India VIX
      try {
        const res = await fetch(BASE + "/api/nse?type=vix", { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const vix = Number(data?.data?.value || 0);
        if (data.success && vix > 0) {
          return "India VIX: " + vix + "\nSource: " + (data.source || "nse") +
            "\nRegime: " + (vix > 25 ? "HIGH VOLATILITY" : vix > 15 ? "NORMAL" : "LOW VOLATILITY") +
            "\nPercentile: " + (vix > 30 ? "EXTREME" : vix > 20 ? "ELEVATED" : vix > 12 ? "NORMAL" : "LOW");
        }
      } catch {}
      try {
        const res = await fetch(BASE + "/api/option-chain?symbol=NIFTY", { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        const vix = data.data?.summary?.indiaVIX || data.data?.indiaVIX || 0;
        if (!vix) return "India VIX unavailable (NSE + option-chain both failed)";
        return "India VIX: " + vix + "\nRegime: " + (vix > 25 ? "HIGH VOLATILITY" : vix > 15 ? "NORMAL" : "LOW VOLATILITY") + "\nPercentile: " + (vix > 30 ? "EXTREME" : vix > 20 ? "ELEVATED" : vix > 12 ? "NORMAL" : "LOW");
      } catch { return "Error fetching VIX"; }
    }

    case "get_atm_straddle": {
      try {
        const res = await fetch(BASE + "/api/atm-straddle?symbol=" + symbol, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success && !data.range) return "Failed to fetch ATM straddle";
        const s = data.range || data.data || {};
        const combined = typeof s.combinedPremium === "number" ? Math.round(s.combinedPremium * 100) / 100 : (s.combinedPremium ?? s.premium ?? "N/A");
        return "ATM Straddle for " + symbol + ":\nStrike: ₹" + (s.atmStrike ?? s.strike ?? "N/A") + " | Combined Premium: ₹" + combined +
          "\nCE: ₹" + (s.cePremium ?? "N/A") + " | PE: ₹" + (s.pePremium ?? "N/A") +
          "\nIV: " + (s.iv ?? "N/A") + " | PCR: " + (s.pcr ?? "N/A") + " | Max Pain: ₹" + (s.maxPain ?? "N/A") +
          "\nExpected Move: ₹" + (s.expectedMove ?? "N/A") + " (" + (s.expectedMovePct ?? "N/A") + "%)";
      } catch { return "Error fetching ATM straddle"; }
    }

    case "get_risk_status": {
      try {
        const res = await fetch(BASE + "/api/trade-journal", { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const trades = data.trades || data || [];
        const open = Array.isArray(trades) ? trades.filter((t: any) => t.status === "OPEN") : [];
        const totalPnL = open.reduce((s: number, t: any) => s + (t.currentPnL || 0), 0);
        return "Risk Status:\nOpen positions: " + open.length + "\nUnrealized P&L: " + (totalPnL >= 0 ? "+" : "") + "₹" + totalPnL.toFixed(0) + "\nCapital at risk: " + (open.length > 0 ? "ACTIVE" : "NONE");
      } catch { return "Error fetching risk status"; }
    }

    case "get_portfolio": {
      try {
        const res = await fetch(BASE + "/api/trade-journal", { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const trades = data.trades || data || [];
        const open = Array.isArray(trades) ? trades.filter((t: any) => t.status === "OPEN") : [];
        if (open.length === 0) return "No open positions.";
        const portfolioLines = open.map((t: any) => t.symbol + " " + (t.side || t.direction || "") + " — Entry: ₹" + (t.entryPrice || t.entry || "N/A") + " | Current: ₹" + (t.currentPrice || "N/A") + " | P&L: ₹" + (t.currentPnL || 0).toFixed(0)).join("\n");
        return "Portfolio (" + open.length + " open):\n" + portfolioLines;
      } catch { return "Error fetching portfolio"; }
    }

    case "get_challenge_status": {
      try {
        const res = await fetch(BASE + "/api/challenge", { signal: AbortSignal.timeout(25000) });
        const data = await res.json();
        if (!data.success && !data.challenge) return "Failed to fetch challenge status";
        const c = data.challenge || data.data || {};
        return "Challenge #" + (c.number ?? "N/A") + " (" + (c.status || "N/A") + "):" +
          "\nCapital: ₹" + (c.currentCapital ?? 0).toLocaleString("en-IN") + " / ₹" + (c.startingCapital ?? 0).toLocaleString("en-IN") + " (" + (c.progressLabel || (c.progressPct ?? 0) + "%") + ")" +
          "\nTrades: " + (c.totalTrades ?? 0) + " | Wins: " + (c.winCount ?? 0) + " | Losses: " + (c.lossCount ?? 0) +
          "\nWin Rate: " + (c.winRate ?? "N/A") + "%" + (c.targetCapital ? " | Target: ₹" + c.targetCapital.toLocaleString("en-IN") : "");
      } catch { return "Error fetching challenge status"; }
    }

    case "get_trade_post_mortem": {
      const { strategy, entryPrice, exitPrice, pnl, notes } = args;
      const rMultiple = entryPrice && exitPrice && args.sl ? Math.abs(exitPrice - entryPrice) / Math.abs(entryPrice - args.sl) : 0;
      const quality = pnl > 0 ? "WINNING" : pnl < 0 ? "LOSING" : "BREAKEVEN";
      return "Trade Post-Mortem: " + symbol + " " + strategy + "\nEntry: ₹" + entryPrice + " → Exit: ₹" + exitPrice + "\nP&L: " + (pnl >= 0 ? "+" : "") + "₹" + pnl.toFixed(0) + " (" + quality + ")\nR-Multiple: " + (rMultiple > 0 ? rMultiple.toFixed(2) + "R" : "N/A") + "\nNotes: " + (notes || "None") + "\n\nKey Learnings:\n- Entry quality: " + (entryPrice ? "Executed" : "Missing data") + "\n- Exit quality: " + (exitPrice ? "Executed" : "Still open") + "\n- Risk management: " + (pnl >= 0 ? "Positive outcome" : "Review stop loss placement");
    }

    case "search_memory": {
      try {
        const { searchTradePatterns, getBestSetups, getPredictionAccuracy } = await import("./agent-memory");
        const { query } = args;
        if (!query) return "Missing required param: query";
        const patterns = searchTradePatterns(query, 10);
        const setups = getBestSetups(undefined, 1);
        const accuracy = getPredictionAccuracy();
        const parts: string[] = [];
        parts.push("Memory Search: \"" + query + "\"");
        if (patterns.length > 0) {
          const matchLines = patterns.map(function(p) { return "- " + p.symbol + " " + p.strategy + " " + p.setup + " " + (p.exit?.pnl ? (p.exit.pnl > 0 ? "+" : "") + "₹" + p.exit.pnl.toFixed(0) : "open"); }).join("\n");
          parts.push("\nMatching trades (" + patterns.length + "):\n" + matchLines);
        } else {
          parts.push("\nNo matching trades found in memory.");
        }
        if (setups.length > 0) {
          parts.push("\nBest setup: " + setups[0].setup + " on " + setups[0].symbol + " — " + (setups[0].winRate * 100).toFixed(0) + "% WR");
        }
        parts.push("\nPrediction accuracy: " + accuracy.total + " predictions, " + (accuracy.accuracy * 100).toFixed(0) + "% accuracy");
        return parts.join("\n");
      } catch { return "Error searching memory"; }
    }

    case "get_memory_summary": {
      try {
        const { getMemorySummary } = await import("./agent-memory");
        return getMemorySummary();
      } catch { return "Error fetching memory summary"; }
    }

    case "record_trade_memory": {
      try {
        const { recordTrade } = await import("./agent-memory");
        const { strategy, setup, entryPrice, exitPrice, pnl, tags } = args;
        if (!strategy || !setup || !entryPrice) return "Missing required params: strategy, setup, entryPrice";
        recordTrade({
          symbol,
          strategy,
          setup,
          entry: { price: entryPrice, time: new Date().toISOString() },
          exit: exitPrice ? { price: exitPrice, time: new Date().toISOString(), pnl: pnl || 0 } : undefined,
          tags: tags || [],
          confidence: 0.5,
        });
        return "Trade recorded to memory: " + symbol + " " + strategy + " — " + setup;
      } catch { return "Error recording trade to memory"; }
    }

    case "get_agent_analytics": {
      try {
        const { getToolCallStats, getLLMCallStats, getErrorStats } = await import("./agent-logger");
        const tools = getToolCallStats();
        const llm = getLLMCallStats();
        const errors = getErrorStats();
        const topToolsStr = tools.topTools.slice(0, 5).map(function(t) { return t.name + "(" + t.count + ")"; }).join(", ");
        return "Agent Analytics:\nTool calls: " + tools.totalCalls + " (" + (tools.successRate * 100).toFixed(1) + "% success, avg " + tools.avgDurationMs.toFixed(0) + "ms)\nLLM calls: " + llm.totalCalls + " (" + llm.totalInputTokens + " in / " + llm.totalOutputTokens + " out tokens)\nErrors: " + errors.total + "\nTop tools: " + topToolsStr;
      } catch { return "Error fetching agent analytics"; }
    }

    case "send_telegram_signal": {
      try {
        const { sendTradeAlert } = await import("./telegram");
        const { action, strike, optionType, confidence, entry, stopLoss, target1, target2 } = args;
        if (!action || !strike || !optionType) return "Missing required params: action, strike, optionType";
        const sent = await sendTradeAlert({
          symbol,
          action,
          strike: Number(strike),
          type: optionType,
          confidence: Number(confidence) || 75,
          entry: entry ? Number(entry) : undefined,
          stopLoss: stopLoss ? Number(stopLoss) : undefined,
          target1: target1 ? Number(target1) : undefined,
          target2: target2 ? Number(target2) : undefined,
          source: "Hermes Agent",
          instrument: optionType === 'PE' ? 'PUT' : 'CALL',
        });
        return sent ? `Signal sent to Telegram: ${symbol} ${action} ${strike} ${optionType} (${confidence}%)` : "Failed to send signal — check Telegram config or dedup";
      } catch { return "Error sending Telegram signal"; }
    }

    case "scan_all_instruments": {
      try {
        const minConf = args.minConfidence || 70;
        const BASE2 = ctx?.apiBase || "";
        const [todayRes, mcxRes] = await Promise.allSettled([
          fetch(BASE2 + "/api/today-trades", { signal: AbortSignal.timeout(30000) }).then(r => r.json()),
          fetch(BASE2 + "/api/mcx?mode=scanner", { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null),
        ]);
        const lines: string[] = [];
        if (todayRes.status === "fulfilled" && todayRes.value?.success) {
          const top = (todayRes.value.top || []).filter((s: any) => s.probability >= minConf);
          lines.push(`NIFTY/SENSEX/Stock F&O — ${top.length} setups (≥${minConf}%):`);
          top.slice(0, 10).forEach((s: any, i: number) => {
            const emoji = s.direction?.includes("BUY") || s.direction === "LONG" ? "🟢" : "🔴";
            lines.push(`${i + 1}. ${emoji} ${s.symbol} ${s.instrument || s.type} — ${s.direction} | ${s.probability}% | Entry ₹${s.entry?.toFixed(0)} | SL ₹${s.stopLoss?.toFixed(0)} | T1 ₹${s.tp1?.toFixed(0)}`);
          });
        } else {
          lines.push("NIFTY/SENSEX/Stock F&O — data unavailable");
        }
        if (mcxRes.status === "fulfilled" && mcxRes.value) {
          const best = mcxRes.value?.bestTrade || mcxRes.value?.data?.bestTrade;
          if (best && (best.confidence || 0) >= minConf) {
            lines.push(`\nMCX Commodity:`);
            lines.push(`${best.symbol} — ${best.direction} | ${best.confidence}% | Entry ₹${best.entry} | SL ₹${best.stopLoss}`);
          }
        }
        return lines.join("\n") || "No high-accuracy setups found across any instrument";
      } catch { return "Error scanning instruments"; }
    }

    case "get_mcx_data": {
      try {
        const mcxSym = args.symbol || "CRUDEOIL";
        const res = await fetch(BASE + "/api/mcx?symbol=" + mcxSym, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        if (!data.success) return "Failed to fetch MCX data for " + mcxSym;
        const q = data.data?.quote || data.data || {};
        return "MCX " + mcxSym + ":\nLTP: ₹" + (q.ltp || q.lastPrice || "N/A") + "\nChange: " + (q.change || 0) + " (" + (q.changePct || 0) + "%)\nDay High: ₹" + (q.dayHigh || "N/A") + " | Day Low: ₹" + (q.dayLow || "N/A") + "\nVolume: " + (q.volume || 0).toLocaleString("en-IN") + "\nSource: " + (q.source || "MOAPI");
      } catch { return "Error fetching MCX data"; }
    }

    case "morning_scan": {
      try {
        const { runMorningSignalFlow } = await import("./morningSignalGenerator");
        const { sendTelegramMessage } = await import("./telegram");
        const result = await runMorningSignalFlow(async (text) => {
          return sendTelegramMessage(text);
        });
        return "Morning Scan Complete:\nSignals Found: " + result.signalsFound + "\nSignals Sent: " + result.signalsSent + "\nDigest Sent: " + result.digestSent + "\nInstruments: " + (result.instruments || []).join(", ");
      } catch { return "Error running morning scan"; }
    }

    // ── Debugging Tools ──
    case "diagnose_data_source": {
      const src = (args.source || "all").toLowerCase();
      const results: string[] = [];
      const tests: Array<{ name: string; url: string; timeout: number }> = [];

      if (src === "all" || src === "breeze") {
        tests.push({ name: "ICICI Breeze Option Chain", url: `${BASE}/api/option-chain?symbol=NIFTY`, timeout: 10000 });
      }
      if (src === "all" || src === "yahoo") {
        tests.push({ name: "Yahoo Finance (NIFTY spot)", url: "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSI?range=1d&interval=1d", timeout: 8000 });
      }
      if (src === "all" || src === "motilal") {
        tests.push({ name: "Motilal Oswal API", url: `${BASE}/api/mcx`, timeout: 10000 });
      }
      if (src === "all" || src === "mcx") {
        tests.push({ name: "MCX Data", url: `${BASE}/api/mcx`, timeout: 10000 });
      }
      if (src === "all" || src === "nse") {
        tests.push({ name: "NSE API (FII/DII)", url: `${BASE}/api/fii-dii`, timeout: 10000 });
      }

      for (const test of tests) {
        const start = Date.now();
        try {
          const res = await fetch(test.url, { signal: AbortSignal.timeout(test.timeout), headers: { "User-Agent": "Mozilla/5.0" } });
          const ms = Date.now() - start;
          const ok = res.ok;
          let detail = "";
          if (ok) {
            try { const j = await res.json(); detail = j.success ? "OK" : j.error || "Response received"; } catch { detail = "Non-JSON response"; }
          } else { detail = `HTTP ${res.status}`; }
          results.push(`${ok ? "✅" : "⚠️"} ${test.name}: ${detail} (${ms}ms)`);
        } catch (e: any) {
          results.push(`❌ ${test.name}: FAILED — ${e.message} (${Date.now() - start}ms)`);
        }
      }
      return `Data Source Diagnosis:\n${results.join("\n")}`;
    }

    case "check_session_tokens": {
      // Read-only live session status (probes each source for real) +
      // recorded session-health episodes incl. candle-chain failures.
      const report = await buildSessionStatusReport(String(args.source || "all"));
      return JSON.stringify(report, null, 2);
    }

    case "set_breeze_session": {
      const token = String(args.token || "").trim();
      if (!token) {
        return JSON.stringify({ success: false, error: "token required — pass { token: '<apiSession>' }" });
      }
      const res = await applyBreezeSession(token);
      return JSON.stringify(res, null, 2);
    }

    case "trace_data_flow": {
      const feature = (args.feature || "").toLowerCase();
      const traces: string[] = [];

      const traceStep = async (step: string, fn: () => Promise<any>) => {
        const start = Date.now();
        try {
          const result = await fn();
          const ms = Date.now() - start;
          const status = result ? `OK (${JSON.stringify(result).length} bytes)` : "EMPTY/NULL";
          traces.push(`✅ Step ${traces.length + 1}: ${step} → ${status} [${ms}ms]`);
          return result;
        } catch (e: any) {
          const ms = Date.now() - start;
          traces.push(`❌ Step ${traces.length + 1}: ${step} → FAILED: ${e.message} [${ms}ms]`);
          return null;
        }
      };

      if (feature === "option_chain") {
        await traceStep("Fetch from Breeze/NSE", async () => {
          const res = await fetch(`${BASE}/api/option-chain?symbol=NIFTY`, { signal: AbortSignal.timeout(15000) });
          return await res.json();
        });
      } else if (feature === "sdm_signal") {
        await traceStep("Fetch SDM Signal", async () => {
          const res = await fetch(`${BASE}/api/sdm-signal?symbol=NIFTY`, { signal: AbortSignal.timeout(15000) });
          return await res.json();
        });
      } else if (feature === "mcx") {
        await traceStep("Fetch MCX Data", async () => {
          const res = await fetch(`${BASE}/api/mcx`, { signal: AbortSignal.timeout(15000) });
          return await res.json();
        });
      } else if (feature === "scanner") {
        await traceStep("Run Intraday Scanner", async () => {
          const res = await fetch(`${BASE}/api/scanner`, { signal: AbortSignal.timeout(20000) });
          return await res.json();
        });
      } else if (feature === "fii_dii") {
        await traceStep("Fetch FII/DII Data", async () => {
          const res = await fetch(`${BASE}/api/fii-dii`, { signal: AbortSignal.timeout(10000) });
          return await res.json();
        });
      } else if (feature === "morning_scan") {
        traces.push("ℹ️ Morning scan runs via cron at 9:20 AM IST. Use 'morning_scan' tool to trigger manually.");
      } else if (feature === "intraday") {
        await traceStep("Fetch Intraday Scan", async () => {
          const res = await fetch(`${BASE}/api/intraday-scan`, { signal: AbortSignal.timeout(20000) });
          return await res.json();
        });
      } else if (feature === "heatmap") {
        await traceStep("Fetch Market Heatmap", async () => {
          const res = await fetch(`${BASE}/api/market/heatmap`, { signal: AbortSignal.timeout(15000) });
          return await res.json();
        });
      } else {
        traces.push(`Unknown feature: ${feature}. Available: option_chain, sdm_signal, mcx, scanner, fii_dii, morning_scan, intraday, heatmap`);
      }

      return `Data Flow Trace — ${feature}:\n${traces.join("\n")}`;
    }

    case "test_api_endpoint": {
      const url = args.url || "";
      const method = (args.method || "GET").toUpperCase();
      const body = args.body || null;

      if (!url) return "Error: URL is required";

      const start = Date.now();
      try {
        const fetchOpts: any = {
          method,
          signal: AbortSignal.timeout(15000),
          headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/json" },
        };
        if (method === "POST" && body) {
          fetchOpts.body = body;
        }

        const res = await fetch(url, fetchOpts);
        const ms = Date.now() - start;
        const contentType = res.headers.get("content-type") || "unknown";
        let bodyPreview = "";
        try {
          const text = await res.text();
          bodyPreview = text.substring(0, 500);
          if (text.length > 500) bodyPreview += `... (${text.length} total bytes)`;
        } catch { bodyPreview = "(could not read body)"; }

        return `API Test Result:
URL: ${url}
Method: ${method}
Status: ${res.status} ${res.statusText}
Time: ${ms}ms
Content-Type: ${contentType}
Body Preview: ${bodyPreview}`;
      } catch (e: any) {
        return `API Test FAILED:
URL: ${url}
Method: ${method}
Error: ${e.message}
Time: ${Date.now() - start}ms`;
      }
    }

    // ── Hermes Pro Tools ──────────────────────────────────────────────
    case "hermes_pro_analysis": {
      try {
        const { hermesProFormatted } = await import("./hermes/agent");
        const mode = args.mode || "TRADE";
        // Relative fetches fail server-side — always give Hermes an absolute base
        const apiBase = (ctx.apiBase as string) || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
        const result = await hermesProFormatted(symbol, { symbol, mode: mode as any, apiBase });
        return result;
      } catch (err: any) {
        return `Hermes Pro analysis failed: ${err.message}. Falling back to standard analysis.`;
      }
    }

    case "hermes_tool_registry": {
      try {
        const { HERMES_TOOLS, getToolsByCategory } = await import("./hermes/tool-registry");
        const category = args.category || "ALL";
        const tools = category === "ALL" ? HERMES_TOOLS : getToolsByCategory(category);
        if (!tools || tools.length === 0) return `No tools found for category: ${category}`;
        const lines = tools.map((t: any) =>
          `• ${t.name}: ${t.description} (reliability: ${(t.reliability * 100).toFixed(0)}%, freshness: ${t.freshnessMaxAge / 1000}s)`
        );
        return `Hermes Tool Registry (${tools.length} tools):\n${lines.join("\n")}`;
      } catch (err: any) {
        return `Failed to query Hermes tool registry: ${err.message}`;
      }
    }

    case "get_most_active_contracts": {
      try {
        const type = args.type || "contracts";
        const res = await fetch(`${BASE}/api/market/most-active`, { signal: AbortSignal.timeout(10000) });
        const json = await res.json();
        if (!json.success) return "Failed to fetch most active contracts";
        const d = json.data;

        const fmt = (items: any[]) => items.map((c: any, i: number) =>
          `${i + 1}. ${c.underlying} ${c.instrument || ""} ${c.optionType || ""} ${c.strikePrice || ""} | LTP: ₹${c.lastPrice} | Chg: ${c.pChange >= 0 ? "+" : ""}${c.pChange?.toFixed(2)}% | Vol: ${(c.numberOfContractsTraded || 0).toLocaleString("en-IN")} | OI: ${(c.openInterest || 0).toLocaleString("en-IN")}`
        ).join("\n");

        const parts: string[] = [];
        parts.push(`Most Active F&O Contracts (${d.marketStatus || "unknown"} market)`);
        parts.push(`Fetched: ${new Date(d.fetchedAt).toLocaleString("en-IN")}`);

        if (type === "contracts" || type === "all") {
          parts.push(`\nTOP CONTRACTS BY VOLUME:\n${fmt(d.contracts?.data || []) || "No data"}`);
        }
        if (type === "futures" || type === "all") {
          parts.push(`\nTOP FUTURES:\n${fmt(d.futures?.data || []) || "No data"}`);
        }
        if (type === "calls" || type === "all") {
          parts.push(`\nTOP INDEX CALLS:\n${fmt(d.callsIndex?.data || []) || "No data"}`);
        }
        if (type === "puts" || type === "all") {
          parts.push(`\nTOP INDEX PUTS:\n${fmt(d.putsIndex?.data || []) || "No data"}`);
        }
        if (type === "oi" || type === "all") {
          parts.push(`\nTOP BY OI:\n${fmt(d.oi?.data || []) || "No data"}`);
        }

        return parts.join("\n");
      } catch (err: any) {
        return `Error fetching most active contracts: ${err.message}`;
      }
    }

    case "strike_selector": {
      try {
        const dir = String(args.direction || "").toLowerCase();
        const spot = Number(args.spot || ctx?.spotPrice || 0);
        const vix = Number(args.vix || ctx?.summary?.indiaVIX || 0);
        const days = Number(args.days || 0);
        const target = Number(args.target || 0);
        const stop = Number(args.stop || 0);
        const holdDays = Number(args.holdDays ?? 0.25);

        const missing: string[] = [];
        if (!(spot > 0)) missing.push("--spot");
        if (!(vix > 0)) missing.push("--vix (India VIX)");
        if (!(days > 0)) missing.push("--days");
        if (!(target > 0)) missing.push("--target");
        if (!(stop > 0)) missing.push("--stop");
        if (dir !== "call" && dir !== "put") missing.push("--direction (call|put)");

        const LOT_SIZES: Record<string, number> = { NIFTY: 75, BANKNIFTY: 35, FINNIFTY: 65, MIDCPNIFTY: 140, SENSEX: 20 };
        let lotSize = Number(args.lotSize || 0);
        if (!lotSize) {
          const sym = String(symbol || "").toUpperCase();
          lotSize = LOT_SIZES[sym] || 0;
          if (!lotSize) missing.push(`--lot-size (no known lot size for ${sym})`);
        }
        if (missing.length) {
          return `Strike selector needs: ${missing.join(", ")}. Ask Sachin for the missing values — never guess them.`;
        }

        const script = resolvePlaybookScript("strike_selector.py");
        if (!script) {
          return "Strike selector script not found (skills/option-buying-playbook/scripts/strike_selector.py)";
        }

        const argv = [
          script,
          "--spot", String(spot), "--vix", String(vix), "--days", String(days),
          "--direction", dir, "--target", String(target), "--stop", String(stop),
          "--capital", String(Number(args.capital || 200000)),
          "--risk-pct", String(Number(args.riskPct || 1)),
          "--lot-size", String(lotSize),
          "--hold-days", String(holdDays),
          "--json",
        ];
        if (args.ivShift != null && args.ivShift !== "") argv.push("--iv-shift", String(Number(args.ivShift)));
        if (args.chain) argv.push("--chain", String(args.chain));

        const { stdout } = await execFileP("python3", argv, { timeout: 15000, maxBuffer: 1024 * 1024 });
        const d = JSON.parse(stdout);
        const lines: string[] = [];
        lines.push(`Strike selector (${dir.toUpperCase()}, spot ₹${spot}, VIX ${vix}, ${days}d to expiry, hold ${holdDays}d)`);
        lines.push(`Expected move: ${d.expected_move_points} pts (${d.expected_move_pct}%) | Underlying R:R: ${d.underlying_reward_risk} | Risk budget: ₹${d.risk_budget_rupees}`);
        const rec = d.recommendation;
        if (!rec) {
          lines.push(`NO strike passes the gates → ${d.note || "SKIP / tighten the stop / consider a spread."}`);
          if (Array.isArray(d.warnings) && d.warnings.length) lines.push(`Warnings: ${d.warnings.join("; ")}`);
          return lines.join("\n");
        }
        lines.push(`Recommended strike: ${rec.strike} ${rec.type} | Entry premium ₹${rec.entry} (IV ${rec.iv_pct}%)`);
        lines.push(`Premium stop ₹${rec.price_at_stop} → target ₹${rec.price_at_target} | Option R:R ${rec.reward_risk} | Delta ${rec.delta}`);
        lines.push(`Lots: ${rec.lots} × ₹${rec.capital_per_lot_premium}/lot premium | Risk/lot ₹${rec.risk_per_lot} | Break-even at exit ${rec.hold_be_points} pts (${rec.be_pct_of_exp_move}% of exp move)`);
        lines.push(`Theta cost over hold: ₹${rec.theta_hold_cost} (${rec.theta_pct_of_premium}% of premium)`);
        const rejected = ((d.all_candidates || []) as any[])
          .filter((c) => !c.passes)
          .slice(0, 3)
          .map((c) => `${c.strike}: failed ${Object.entries(c.gates || {}).filter(([, v]) => !v).map(([k]) => k).join(",") || "gates"}`);
        if (rejected.length) lines.push(`Rejected: ${rejected.join(" | ")}`);
        if (Array.isArray(d.warnings) && d.warnings.length) lines.push(`Warnings: ${d.warnings.join("; ")}`);
        return lines.join("\n");
      } catch (err: any) {
        const errOut = String(err?.stderr || err?.message || err);
        if (/required:/.test(errOut)) {
          return `Strike selector input error: ${errOut.split("\n").pop()}`;
        }
        return `Strike selector failed: ${String(errOut).slice(0, 200)}`;
      }
    }

    case "hedge_calculator": {
      try {
        const mode = String(args.mode || "").toLowerCase() === "portfolio" ? "portfolio" : "spread";
        const script = resolvePlaybookScript("hedge_calculator.py");
        if (!script) return "Hedge calculator script not found (skills/option-buying-playbook/scripts/hedge_calculator.py)";
        const LOT_SIZES: Record<string, number> = { NIFTY: 75, BANKNIFTY: 35, FINNIFTY: 65, MIDCPNIFTY: 140, SENSEX: 20 };
        const num = (v: any): number | null => {
          if (v == null || v === "") return null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        const missing: string[] = [];
        const argv = [script, mode];

        if (mode === "spread") {
          const spot = num(args.spot);
          const vix = num(args.vix);
          const days = num(args.days);
          const dir = String(args.direction || "").toLowerCase();
          const longStrike = num(args.longStrike);
          const target = num(args.target);
          const stop = num(args.stop);
          if (spot == null) missing.push("--spot");
          if (vix == null) missing.push("--vix");
          if (days == null) missing.push("--days");
          if (dir !== "call" && dir !== "put") missing.push("--direction (call|put)");
          if (longStrike == null) missing.push("--long-strike");
          if (target == null) missing.push("--target");
          if (stop == null) missing.push("--stop");
          let lotSize = num(args.lotSize) || 0;
          if (!lotSize) {
            lotSize = LOT_SIZES[String(symbol || "").toUpperCase()] || 0;
            if (!lotSize) missing.push(`--lot-size (no known lot size for ${symbol})`);
          }
          if (missing.length) {
            return `Hedge calculator needs: ${missing.join(", ")}. Ask Sachin for the missing values — never guess them.`;
          }
          argv.push(
            "--spot", String(spot), "--vix", String(vix), "--days", String(days),
            "--direction", dir, "--long-strike", String(longStrike),
            "--target", String(target), "--stop", String(stop),
            "--hold-days", String(num(args.holdDays) ?? 1),
            "--capital", String(num(args.capital) ?? 200000),
            "--risk-pct", String(num(args.riskPct) ?? 1),
            "--lot-size", String(lotSize),
            "--json"
          );
          if (num(args.longPremium) != null) argv.push("--long-premium", String(num(args.longPremium)));
          if (args.shortChain) argv.push("--short-chain", String(args.shortChain));
          if (num(args.maxWidth) != null) argv.push("--max-width", String(num(args.maxWidth)));
          if (num(args.minRR) != null) argv.push("--min-rr", String(num(args.minRR)));

          const { stdout } = await execFileP("python3", argv, { timeout: 15000, maxBuffer: 1024 * 1024 });
          const d = JSON.parse(stdout);
          const lines: string[] = [];
          lines.push(`Hedge compare — ${dir.toUpperCase()} long ${longStrike} (spot ₹${spot}, VIX ${vix}, ${days}d to expiry)`);
          const n = d.naked || {};
          lines.push(`Naked long: entry ₹${n.entry} | max loss ₹${n.max_loss_per_lot}/lot | R:R ${n.rr} | theta ₹${n.theta_day}/day | max profit ${n.max_profit}`);
          const spreads = (d.spreads || []) as any[];
          if (!spreads.length) lines.push(d.note || "No spread candidates — supply shortChain (short-leg premiums like '25200:160,25250:130') or widen maxWidth.");
          for (const s of spreads.slice(0, 4)) {
            lines.push(`short ${s.short_strike} (width ${s.width_pts}): net debit ₹${s.net_debit} (saves ${s.premium_saved_pct}% premium) | max loss ₹${s.max_loss_per_lot}/lot | max profit ₹${s.max_profit_per_unit}/unit | exp R:R ${s.rr_at_expiry} | exit R:R ${s.rr_at_exit} @ target | BE ${s.breakeven_expiry} | lots by stop-risk ${s.lots_by_stop_risk}${s.target_beyond_short_strike ? " | target beyond short strike — upside capped before your target" : ""}`);
          }
          if (spreads.length > 4) lines.push(`… ${spreads.length - 4} more widths not shown`);
          const best = [...spreads].sort((a: any, b: any) => (b.rr_at_exit || 0) - (a.rr_at_exit || 0))[0];
          if (best) lines.push(`Best by exit R:R → short ${best.short_strike} (net debit ₹${best.net_debit}, max loss ₹${best.max_loss_per_lot}/lot, exit R:R ${best.rr_at_exit})`);
          lines.push(`Always: buy leg first, exit BOTH legs together, never leave a short leg naked, verify margin/costs/lot size with the broker. Butterflies, calendars, profit lock-in and the decision table: read references/hedging-strategies.md via read_playbook.`);
          return lines.join("\n");
        }

        // portfolio mode — index-put hedge for a stock portfolio
        const value = num(args.value);
        const index = num(args.index);
        if (value == null) missing.push("--value (portfolio ₹)");
        if (index == null) missing.push("--index (spot level)");
        let lotSize = num(args.lotSize) || LOT_SIZES[String(symbol || "").toUpperCase()] || 0;
        if (missing.length) {
          return `Hedge calculator needs: ${missing.join(", ")} (portfolio mode). Ask Sachin for the missing values — never guess them.`;
        }
        argv.push("--value", String(value), "--index", String(index), "--json");
        if (lotSize) argv.push("--lot-size", String(lotSize));
        if (num(args.beta) != null) argv.push("--beta", String(num(args.beta)));
        if (num(args.hedgeRatio) != null) argv.push("--hedge-ratio", String(num(args.hedgeRatio)));
        if (num(args.putPremium) != null) argv.push("--put-premium", String(num(args.putPremium)));
        if (num(args.vix) != null) argv.push("--vix", String(num(args.vix)));
        if (num(args.days) != null) argv.push("--days", String(num(args.days)));

        const { stdout } = await execFileP("python3", argv, { timeout: 15000, maxBuffer: 1024 * 1024 });
        const d = JSON.parse(stdout);
        return [
          `Portfolio index-put hedge — value ₹${value}, index ${index}`,
          `Hedge notional ₹${d.hedge_notional} | lots: ${d.lots} (exact ${d.lots_exact}) | est cost ₹${d.est_cost} (${d.est_cost_pct_of_portfolio}% of portfolio)`,
          `Verify margin/costs/lot size with the broker. Ratio guidance, expiry choice and the naked-vs-hedge decision table: read references/hedging-strategies.md via read_playbook.`,
        ].join("\n");
      } catch (err: any) {
        const errOut = String(err?.stdout || err?.stderr || err?.message || err);
        if (/required|usage:/i.test(errOut)) {
          return `Hedge calculator input error: ${errOut.split("\n").filter((l: string) => l.trim()).slice(-2).join(" ")}`;
        }
        return `Hedge calculator failed: ${String(errOut).slice(0, 200)}`;
      }
    }

    case "read_playbook": {
      try {
        const root = resolvePlaybookRoot();
        if (!root) return "Playbook not found (skills/option-buying-playbook missing).";
        // Exact allowlist built from the real directory: SKILL.md + references/*.md only.
        const allowed: string[] = ["SKILL.md"];
        try {
          const refDir = path.join(root, "references");
          if (fs.existsSync(refDir)) {
            for (const f of fs.readdirSync(refDir)) if (f.endsWith(".md")) allowed.push(`references/${f}`);
          }
        } catch { /* keep base entry */ }
        const list = `Available files (use file= one of these):\n- ${allowed.join("\n- ")}`;
        const want = String(args.file || "")
          .trim()
          .replace(/\\/g, "/")
          .replace(/^\.\//, "")
          .replace(/^skills\/option-buying-playbook\//, "");
        if (!want) return list;
        if (want.includes("..") || want.startsWith("/") || !want.endsWith(".md")) {
          return `Reading "${want}" is not allowed. ${list}`;
        }
        if (!allowed.includes(want)) return `No such file: ${want}. ${list}`;
        let content = fs.readFileSync(path.join(root, want), "utf8");
        const CAP = 8000;
        if (content.length > CAP) content = content.slice(0, CAP) + "\n…[truncated — ask for a specific section]";
        return `# ${want}\n${content}`;
      } catch (e: any) {
        return `Playbook read failed: ${e?.message || e}`;
      }
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
    apiBase?: string;
    extraContext?: string;
    dashboardContext?: string;
    [key: string]: any;
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
    const result = await callLLM(messages, selectToolsForQuery(userMessage));

    // If no tool calls, return the response
    if (!result.toolCalls || result.toolCalls.length === 0) {
      const responseText = result.content || "I couldn't generate a response. Please try again.";
      console.log(`[Agent Brain] Model response (no tools): ${responseText.substring(0, 100)}... (${responseText.length} chars)`);
      return {
        response: responseText,
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
        const toolResult = await executeTool(toolCall.function.name, args, { ...ctx, apiBase: ctx.apiBase });
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
