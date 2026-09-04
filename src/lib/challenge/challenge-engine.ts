// ═══════════════════════════════════════════════════════════════════════════
// Challenge Engine — ₹15K → ₹1L Orchestrator
// FIXED: R:R variation, scanner counts, multi-factor scoring
// ═══════════════════════════════════════════════════════════════════════════

import { fetchNifty500Batch, getSectorStrength, type Nifty500Quote } from "./nifty500";
import {
  calculateEquityPosition,
  calculateFOPosition,
  type CapitalConfig,
  DEFAULT_CAPITAL_CONFIG,
} from "./capital-manager";
import {
  getChallenge,
  recordTrade,
} from "./challenge-tracker";
import { buildMarketIntelligenceContext, type MarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeEquitySwing } from "@/lib/trade-intelligence/equity-swing-mode";
import { analyzeStockFO } from "@/lib/trade-intelligence/stock-fo-mode";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";

// ── Types ──
export type TradeDecision = "TRADE" | "WATCH" | "NO_TRADE";
export type InstrumentType = "EQUITY" | "CALL" | "PUT" | "FUTURES" | "STRADDLE" | "STRANGLE" | "CAS" | "HERO_ZERO";

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
  position: any;
  data: { ltp: number; changePct: number; weekHigh52: number; weekLow52: number };
}

export interface ChallengeScanResult {
  timestamp: string;
  decision: TradeDecision;
  topOpportunities: ChallengeOpportunity[];
  bestTrade?: ChallengeOpportunity;
  summary: {
    nifty500Scanned: number;
    nifty500Valid: number;
    nifty500Candidates: number;
    indexFOAvailable: number;
    indexFOCandidates: number;
    stockFOAvailable: number;
    stockFOCandidates: number;
    equitySwingCandidates: number;
    casSignals: number;
    heroZeroCandidates: number;
    totalSetups: number;
    dataSource: "LIVE" | "PARTIAL" | "OFFLINE";
  };
  marketContext: {
    regime: string;
    vix: number;
    vixAvailable: boolean;
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

// ── Score a NIFTY 500 stock (FIXED: real R:R variation, multi-factor) ──
function scoreNifty500Stock(
  quote: Nifty500Quote,
  sectorStrength: Record<string, { avgChange: number; avgRelVol: number; count: number }>,
): ChallengeOpportunity | null {
  let score = 0;
  const reasoning: string[] = [];
  const factors: Record<string, number> = {};

  // 1. Momentum (0-20)
  const momScore = Math.min(20, Math.max(0, 10 + quote.changePct * 3));
  factors.momentum = Math.round(momScore);
  score += momScore;
  if (quote.changePct > 3) { reasoning.push(`Strong momentum +${quote.changePct.toFixed(1)}%`); }
  else if (quote.changePct > 1) { reasoning.push(`Positive momentum +${quote.changePct.toFixed(1)}%`); }
  else if (quote.changePct < -3) { reasoning.push(`Weak momentum ${quote.changePct.toFixed(1)}%`); }

  // 2. Volume (0-15)
  const volScore = Math.min(15, Math.max(0, (quote.relativeVolume - 0.5) * 4));
  factors.volume = Math.round(volScore);
  score += volScore;
  if (quote.relativeVolume > 3) { reasoning.push(`Volume surge ${quote.relativeVolume.toFixed(1)}x avg`); }
  else if (quote.relativeVolume > 2) { reasoning.push(`High volume ${quote.relativeVolume.toFixed(1)}x`); }

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
    if (sector.avgChange > 1.5) sectorScore = 10;
    else if (sector.avgChange > 0.5) sectorScore = 8;
    else if (sector.avgChange > 0) sectorScore = 6;
    else if (sector.avgChange > -0.5) sectorScore = 4;
    else if (sector.avgChange > -1.5) sectorScore = 3;
    else sectorScore = 1;
    if (sector.avgChange > 1) reasoning.push(`Strong sector ${quote.sector} +${sector.avgChange.toFixed(1)}%`);
  }
  factors.sector = sectorScore;
  score += sectorScore;

  // 5. Risk/Reward (0-15) — FIXED: real variation based on price position
  const range = quote.weekHigh52 - quote.weekLow52;
  const atrProxy = range > 0 ? range * 0.015 : quote.ltp * 0.015;
  // R:R varies based on where price is in the range
  const rangePos = range > 0 ? (quote.ltp - quote.weekLow52) / range : 0.5;
  // Near bottom of range = better R:R (more upside), near top = worse
  const rrBase = 1 + (1 - rangePos) * 3; // 1.0 to 4.0
  const slDist = atrProxy * 2;
  const tpDist = atrProxy * 2 * rrBase;
  const rr = slDist > 0 ? tpDist / slDist : 1;
  const rrScore = Math.min(15, Math.round(rr * 3));
  factors.riskReward = rrScore;
  score += rrScore;
  if (rr >= 2.5) reasoning.push(`Excellent R:R 1:${rr.toFixed(1)}`);
  else if (rr >= 1.5) reasoning.push(`Good R:R 1:${rr.toFixed(1)}`);

  // 6. Price action (0-15) — FIXED: more variation
  const paScore = Math.min(15, Math.max(0,
    quote.changePct > 3 ? 15 :
    quote.changePct > 2 ? 13 :
    quote.changePct > 1 ? 11 :
    quote.changePct > 0 ? 9 :
    quote.changePct > -1 ? 7 :
    quote.changePct > -2 ? 5 :
    quote.changePct > -3 ? 3 : 1
  ));
  factors.priceAction = paScore;
  score += paScore;

  // 7. Liquidity (0-10)
  const liqScore = quote.volume > 5000000 ? 10 : quote.volume > 1000000 ? 8 : quote.volume > 500000 ? 6 : quote.volume > 100000 ? 4 : 2;
  factors.liquidity = liqScore;
  score += liqScore;

  // Build entry/SL/TP with real R:R
  const entry = quote.ltp;
  const stopLoss = entry - slDist;
  const target1 = entry + tpDist;
  const target2 = entry + tpDist * 1.5;

  const finalScore = Math.min(100, Math.round(score));

  return {
    rank: 0,
    symbol: quote.symbol,
    name: quote.symbol,
    instrument: "EQUITY",
    strategy: quote.near52WHigh ? "52W_BREAKOUT" : quote.near52WLow ? "52W_REVERSAL" : quote.relativeVolume > 2.5 ? "VOLUME_BREAKOUT" : quote.changePct > 2 ? "MOMENTUM" : "TECHNICAL",
    score: finalScore,
    confidence: Math.min(100, Math.round(finalScore * 0.9)),
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

// ── Main scan function (FIXED: proper counts, data source tracking) ──
export async function runChallengeScan(
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): Promise<ChallengeScanResult> {
  const ch = getChallenge();
  const allOpportunities: ChallengeOpportunity[] = [];

  // 1. Fetch NIFTY 500 data
  const nifty500Quotes = await fetchNifty500Batch();
  const sectorStrength = getSectorStrength(nifty500Quotes);
  const nifty500Valid = nifty500Quotes.size;
  let nifty500Candidates = 0;

  // 2. Score NIFTY 500 stocks
  for (const quote of nifty500Quotes.values()) {
    const opp = scoreNifty500Stock(quote, sectorStrength);
    if (opp && opp.score >= 50) {
      allOpportunities.push(opp);
      nifty500Candidates++;
    }
  }

  // 3. Build market context
  let ctx: MarketIntelligenceContext | null = null;
  let dataSource: "LIVE" | "PARTIAL" | "OFFLINE" = "OFFLINE";
  try {
    ctx = await buildMarketIntelligenceContext();
    dataSource = ctx.dataQuality || "PARTIAL";
  } catch {}

  // 4. Index F&O (NIFTY + SENSEX)
  let indexFOAvailable = 0;
  let indexFOCandidates = 0;
  if (ctx) {
    try {
      const indexSignals = analyzeIndexFO(ctx);
      indexFOAvailable = indexSignals.length;
      for (const sig of indexSignals) {
        if (sig.direction === "NO_TRADE") continue;
        indexFOCandidates++;
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
    } catch {}
  }

  // 5. Stock F&O
  let stockFOAvailable = 0;
  let stockFOCandidates = 0;
  if (ctx) {
    try {
      const stockSignals = analyzeStockFO(ctx, 20);
      stockFOAvailable = stockSignals.length;
      for (const sig of stockSignals) {
        if (sig.direction === "NO_TRADE") continue;
        stockFOCandidates++;
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
    } catch {}
  }

  // 6. Equity Swing
  let equitySwingCandidates = 0;
  if (ctx) {
    try {
      const swingSignals = analyzeEquitySwing(ctx, 20);
      for (const sig of swingSignals) {
        if (sig.direction === "NO_TRADE") continue;
        equitySwingCandidates++;
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
    } catch {}
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
      nifty500Valid,
      nifty500Candidates,
      indexFOAvailable,
      indexFOCandidates,
      stockFOAvailable,
      stockFOCandidates,
      equitySwingCandidates,
      casSignals: 0,
      heroZeroCandidates: 0,
      totalSetups: allOpportunities.length,
      dataSource,
    },
    marketContext: {
      regime: ctx?.regime?.regime || "UNKNOWN",
      vix: ctx?.indiaVix || 0,
      vixAvailable: (ctx?.indiaVix ?? 0) > 0,
      breadth: ctx?.breadth ? `${ctx.breadth.advances}/${ctx.breadth.declines}` : "N/A",
      sessionPhase: ctx?.sessionPhase || "UNKNOWN",
    },
    capital: {
      current: ch.currentCapital,
      available: Math.round(ch.currentCapital * 0.5),
      riskBudget: Math.round(ch.currentCapital * 0.05),
      drawdownPct: ch.currentDrawdown.totalDrawdownPct,
    },
    noTradeReason,
  };
}

// ── Execute a trade (paper) ──
export function executeChallengeTrade(opportunity: ChallengeOpportunity) {
  return recordTrade({
    symbol: opportunity.symbol,
    strategy: opportunity.strategy,
    direction: opportunity.direction,
    entry: opportunity.entry,
    quantity: opportunity.position.quantity,
    lotSize: opportunity.position.lotSize,
    score: opportunity.score,
    stopLoss: opportunity.stopLoss,
    target: opportunity.target1,
  });
}
