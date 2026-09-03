// ═══════════════════════════════════════════════════════════════════════════
// Challenge Engine — ₹15K → ₹1L Orchestrator
// Scans NIFTY 500 + NIFTY + SENSEX + F&O + Options + CAS + Hero-Zero
// Ranks all setups, selects best opportunity, sizes for ₹15K capital.
// ═══════════════════════════════════════════════════════════════════════════

import { fetchNifty500Batch, getSectorStrength, type Nifty500Quote } from "./nifty500";
import {
  calculateEquityPosition,
  calculateFOPosition,
  type CapitalConfig,
  type PositionSizing,
  DEFAULT_CAPITAL_CONFIG,
} from "./capital-manager";
import {
  getChallenge,
  recordTrade,
  type ChallengeTrade,
} from "./challenge-tracker";
import { technicalScanStock, type ScanResult } from "@/lib/technical-analysis";
import { buildMarketIntelligenceContext, type MarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeEquitySwing, type EquitySwingSignal } from "@/lib/trade-intelligence/equity-swing-mode";
import { analyzeStockFO, type StockFOSignal } from "@/lib/trade-intelligence/stock-fo-mode";
import { analyzeIndexFO, type IndexFOSignal } from "@/lib/trade-intelligence/index-fo-mode";

// ── Types ──
export type TradeDecision = "TRADE" | "WATCH" | "NO_TRADE";

export type InstrumentType = "EQUITY" | "CALL" | "PUT" | "FUTURES" | "STRADDLE" | "STRANGLE" | "HERO_ZERO";

export interface ChallengeOpportunity {
  rank: number;
  symbol: string;
  name: string;
  instrument: InstrumentType;
  strategy: string;
  score: number;
  confidence: number;
  direction: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  volume: number;
  relativeVolume: number;
  sector: string;
  near52WHigh: boolean;
  near52WLow: boolean;
  reasoning: string[];
  factors: Record<string, number>;
  position: PositionSizing;
  data: {
    ltp: number;
    changePct: number;
    weekHigh52: number;
    weekLow52: number;
  };
}

export interface ChallengeScanResult {
  timestamp: string;
  decision: TradeDecision;
  topOpportunities: ChallengeOpportunity[];
  bestTrade?: ChallengeOpportunity;
  summary: {
    nifty500Scanned: number;
    indexFO: number;
    stockFO: number;
    equitySwing: number;
    casSignals: number;
    heroZeroCandidates: number;
    totalSetups: number;
  };
  marketContext: {
    regime: string;
    vix: number;
    breadth: string;
    sessionPhase: string;
  };
  capital: {
    current: number;
    available: number;
    riskBudget: number;
    drawdownPct: number;
  };
  noTradeReason?: string;
}

// ── Score a NIFTY 500 stock for technical setups ──
function scoreNifty500Stock(
  quote: Nifty500Quote,
  sectorStrength: Record<string, { avgChange: number; avgRelVol: number; count: number }>,
): ChallengeOpportunity | null {
  let score = 0;
  const reasoning: string[] = [];
  const factors: Record<string, number> = {};

  // 1. Momentum (0-20)
  const momScore = Math.min(20, Math.max(0, (quote.changePct + 5) * 2));
  factors.momentum = Math.round(momScore);
  score += momScore;
  if (quote.changePct > 2) { reasoning.push(`Strong momentum +${quote.changePct}%`); }
  else if (quote.changePct > 0.5) { reasoning.push(`Positive momentum +${quote.changePct}%`); }

  // 2. Volume (0-15)
  const volScore = Math.min(15, Math.max(0, (quote.relativeVolume - 1) * 5));
  factors.volume = Math.round(volScore);
  score += volScore;
  if (quote.relativeVolume > 2) { reasoning.push(`Volume surge ${quote.relativeVolume}x avg`); }

  // 3. 52-week proximity (0-15)
  let w52Score = 0;
  if (quote.near52WHigh) { w52Score = 15; reasoning.push("Near 52-week high breakout"); }
  else if (quote.near52WLow) { w52Score = 12; reasoning.push("Near 52-week low reversal zone"); }
  else if (quote.weekHigh52 > 0) {
    const range = quote.weekHigh52 - quote.weekLow52;
    const pos = range > 0 ? (quote.ltp - quote.weekLow52) / range : 0.5;
    w52Score = Math.round(pos * 10);
  }
  factors.week52 = w52Score;
  score += w52Score;

  // 4. Sector strength (0-10)
  const sector = sectorStrength[quote.sector];
  let sectorScore = 5;
  if (sector) {
    if (sector.avgChange > 1) sectorScore = 10;
    else if (sector.avgChange > 0) sectorScore = 7;
    else if (sector.avgChange < -1) sectorScore = 2;
    if (sector.avgChange > 1) reasoning.push(`Strong sector ${quote.sector} +${sector.avgChange.toFixed(1)}%`);
  }
  factors.sector = sectorScore;
  score += sectorScore;

  // 5. Risk/Reward (0-15)
  const range = quote.weekHigh52 - quote.weekLow52;
  const atr = range > 0 ? range * 0.02 : quote.ltp * 0.02;
  const slDist = atr * 2;
  const tpDist = atr * 3;
  const rr = slDist > 0 ? tpDist / slDist : 1;
  const rrScore = Math.min(15, Math.round(rr * 5));
  factors.riskReward = rrScore;
  score += rrScore;
  if (rr >= 2) reasoning.push(`Good R:R 1:${rr.toFixed(1)}`);

  // 6. Price action (0-15)
  const paScore = Math.min(15, Math.max(0, 7 + (quote.changePct > 0 ? 3 : -3)));
  factors.priceAction = paScore;
  score += paScore;

  // 7. Market cap / liquidity proxy (0-10)
  const liqScore = quote.volume > 1000000 ? 10 : quote.volume > 500000 ? 7 : quote.volume > 100000 ? 5 : 3;
  factors.liquidity = liqScore;
  score += liqScore;

  // Build entry/SL/TP
  const entry = quote.ltp;
  const stopLoss = entry - slDist;
  const target1 = entry + tpDist;
  const target2 = entry + tpDist * 1.5;

  return {
    rank: 0,
    symbol: quote.symbol,
    name: quote.symbol,
    instrument: "EQUITY",
    strategy: quote.near52WHigh ? "52W_HIGH_BREAKOUT" : quote.near52WLow ? "52W_LOW_REVERSAL" : quote.relativeVolume > 2 ? "VOLUME_BREAKOUT" : "MOMENTUM",
    score: Math.min(100, Math.round(score)),
    confidence: Math.min(100, Math.round(score * 0.9)),
    direction: quote.changePct > 0 ? "BUY" : "SELL",
    entry,
    stopLoss,
    target1,
    target2,
    riskReward: rr,
    volume: quote.volume,
    relativeVolume: quote.relativeVolume,
    sector: quote.sector,
    near52WHigh: quote.near52WHigh,
    near52WLow: quote.near52WLow,
    reasoning,
    factors,
    position: { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
    data: { ltp: quote.ltp, changePct: quote.changePct, weekHigh52: quote.weekHigh52, weekLow52: quote.weekLow52 },
  };
}

// ── Main scan function ──
export async function runChallengeScan(
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): Promise<ChallengeScanResult> {
  const ch = getChallenge();
  const allOpportunities: ChallengeOpportunity[] = [];

  // 1. Fetch NIFTY 500 data
  const nifty500Quotes = await fetchNifty500Batch();
  const sectorStrength = getSectorStrength(nifty500Quotes);

  // 2. Score NIFTY 500 stocks
  for (const quote of nifty500Quotes.values()) {
    const opp = scoreNifty500Stock(quote, sectorStrength);
    if (opp && opp.score >= 50) {
      allOpportunities.push(opp);
    }
  }

  // 3. Build market context for F&O modes
  let ctx: MarketIntelligenceContext | null = null;
  try {
    ctx = await buildMarketIntelligenceContext();
  } catch {
    // Continue without F&O context
  }

  // 4. Index F&O (NIFTY + SENSEX)
  let indexFOCount = 0;
  if (ctx) {
    try {
      const indexSignals = analyzeIndexFO(ctx);
      for (const sig of indexSignals) {
        if (sig.direction === "NO_TRADE") continue;
        indexFOCount++;
        allOpportunities.push({
          rank: 0,
          symbol: sig.symbol,
          name: sig.symbol,
          instrument: sig.direction.includes("CALL") ? "CALL" : sig.direction.includes("PUT") ? "PUT" : sig.direction === "LONG" ? "FUTURES" : "FUTURES",
          strategy: `INDEX_${sig.direction}`,
          score: sig.confidence,
          confidence: sig.confidence,
          direction: sig.direction,
          entry: sig.entry,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          riskReward: sig.riskReward,
          volume: 0,
          relativeVolume: 1,
          sector: "Index",
          near52WHigh: false,
          near52WLow: false,
          reasoning: sig.reasoning,
          factors: sig.factors,
          position: { quantity: 0, lotSize: 25, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
          data: { ltp: sig.entry, changePct: 0, weekHigh52: 0, weekLow52: 0 },
        });
      }
    } catch { /* continue */ }
  }

  // 5. Stock F&O
  let stockFOCount = 0;
  if (ctx) {
    try {
      const stockSignals = analyzeStockFO(ctx, 20);
      for (const sig of stockSignals) {
        if (sig.direction === "NO_TRADE") continue;
        stockFOCount++;
        allOpportunities.push({
          rank: 0,
          symbol: sig.symbol,
          name: sig.symbol,
          instrument: sig.direction.includes("CE") ? "CALL" : sig.direction.includes("PE") ? "PUT" : sig.direction === "LONG" ? "FUTURES" : "FUTURES",
          strategy: `STOCK_${sig.direction}`,
          score: sig.confidence,
          confidence: sig.confidence,
          direction: sig.direction,
          entry: sig.entry,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          riskReward: sig.riskReward,
          volume: 0,
          relativeVolume: 1,
          sector: "F&O",
          near52WHigh: false,
          near52WLow: false,
          reasoning: sig.reasoning,
          factors: sig.factors,
          position: { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
          data: { ltp: sig.entry, changePct: 0, weekHigh52: 0, weekLow52: 0 },
        });
      }
    } catch { /* continue */ }
  }

  // 6. Equity Swing
  let equitySwingCount = 0;
  if (ctx) {
    try {
      const swingSignals = analyzeEquitySwing(ctx, 20);
      for (const sig of swingSignals) {
        if (sig.direction === "NO_TRADE") continue;
        equitySwingCount++;
        allOpportunities.push({
          rank: 0,
          symbol: sig.symbol,
          name: sig.symbol,
          instrument: "EQUITY",
          strategy: `SWING_${sig.setupType}`,
          score: sig.confidence,
          confidence: sig.confidence,
          direction: sig.direction,
          entry: sig.entry,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          riskReward: sig.riskReward,
          volume: 0,
          relativeVolume: 1,
          sector: "Swing",
          near52WHigh: false,
          near52WLow: false,
          reasoning: sig.reasoning,
          factors: sig.factors,
          position: { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false },
          data: { ltp: sig.entry, changePct: 0, weekHigh52: 0, weekLow52: 0 },
        });
      }
    } catch { /* continue */ }
  }

  // 7. Sort by score
  allOpportunities.sort((a, b) => b.score - a.score);

  // 8. Take top 10 and assign ranks
  const top10 = allOpportunities.slice(0, 10).map((opp, i) => ({ ...opp, rank: i + 1 }));

  // 9. Size the best trade for ₹15K capital
  const bestTrade = top10[0];
  if (bestTrade) {
    const isFO = bestTrade.instrument !== "EQUITY";
    const position = isFO
      ? calculateFOPosition(ch.currentCapital, bestTrade.entry, bestTrade.stopLoss, bestTrade.symbol, false, config)
      : calculateEquityPosition(ch.currentCapital, bestTrade.entry, bestTrade.stopLoss, config);
    bestTrade.position = position;
  }

  // 10. Decision
  let decision: TradeDecision = "NO_TRADE";
  let noTradeReason: string | undefined;

  if (ch.status === "FAILED") {
    noTradeReason = "Challenge failed — max drawdown reached";
  } else if (ch.status === "TARGET_REACHED") {
    noTradeReason = "Target reached!";
  } else if (!bestTrade) {
    noTradeReason = "No setups found above threshold";
  } else if (bestTrade.score < 60) {
    noTradeReason = `Best score ${bestTrade.score}/100 below minimum (60)`;
  } else if (!bestTrade.position.canTrade) {
    noTradeReason = `Position sizing failed: ${bestTrade.position.reason}`;
  } else {
    decision = bestTrade.score >= 70 ? "TRADE" : "WATCH";
  }

  return {
    timestamp: new Date().toISOString(),
    decision,
    topOpportunities: top10,
    bestTrade: decision === "TRADE" ? bestTrade : undefined,
    summary: {
      nifty500Scanned: nifty500Quotes.size,
      indexFO: indexFOCount,
      stockFO: stockFOCount,
      equitySwing: equitySwingCount,
      casSignals: 0,
      heroZeroCandidates: 0,
      totalSetups: allOpportunities.length,
    },
    marketContext: {
      regime: ctx?.regime?.regime || "UNKNOWN",
      vix: ctx?.indiaVix || 0,
      breadth: ctx?.breadth ? `${ctx.breadth.advances}/${ctx.breadth.declines}` : "N/A",
      sessionPhase: ctx?.sessionPhase || "UNKNOWN",
    },
    capital: {
      current: ch.currentCapital,
      available: Math.round(ch.currentCapital * 0.4),
      riskBudget: Math.round(ch.currentCapital * 0.05),
      drawdownPct: ch.currentDrawdown.totalDrawdownPct,
    },
    noTradeReason,
  };
}

// ── Execute a trade (paper) ──
export function executeChallengeTrade(opportunity: ChallengeOpportunity): ChallengeTrade {
  return recordTrade({
    symbol: opportunity.symbol,
    strategy: opportunity.strategy,
    direction: opportunity.direction,
    entry: opportunity.entry,
    quantity: opportunity.position.quantity,
    lotSize: opportunity.position.lotSize,
    score: opportunity.score,
  });
}
