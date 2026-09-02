// ═══════════════════════════════════════════════════════════════════════════
// Unified Trade Ranking Engine
// Combines Index F&O, Stock F&O, and Equity Swing into a single ranked
// list with 0-100 scoring.
//
// Score bands:
//   0–59   No Trade
//   60–69  Watch
//   70–79  Strong
//   80–89  High Conviction
//   90+    Extreme Confirmation
// ═══════════════════════════════════════════════════════════════════════════

import type { MarketIntelligenceContext } from "./market-context";
import { analyzeIndexFO, type IndexFOSignal } from "./index-fo-mode";
import { analyzeStockFO, type StockFOSignal } from "./stock-fo-mode";
import { analyzeEquitySwing, type EquitySwingSignal } from "./equity-swing-mode";

// ── Types ──
export type TradeMode = "INDEX_FO" | "STOCK_FO" | "EQUITY_SWING";
export type ConvictionBand = "NO_TRADE" | "WATCH" | "STRONG" | "HIGH_CONVICTION" | "EXTREME";

export interface UnifiedTradeSetup {
  rank: number;
  symbol: string;
  name: string;
  mode: TradeMode;
  conviction: ConvictionBand;
  score: number; // 0-100
  confidence: number; // 0-100
  direction: string;
  reasoning: string[];
  factors: Record<string, number>;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  holdingPeriod: string;
  recommendedInstrument: string;
  maxRisk: string;
  invalidation: string;
  setupType: string;
}

export interface UnifiedRankingResult {
  timestamp: string;
  sessionPhase: string;
  dataQuality: string;
  highConvictionSetups: UnifiedTradeSetup[];
  watchSetups: UnifiedTradeSetup[];
  noTrade: boolean;
  noTradeReason: string;
  summary: {
    totalScanned: number;
    indexFOCount: number;
    stockFOCount: number;
    equitySwingCount: number;
    avgScore: number;
    bestMode: TradeMode;
  };
  byMode: {
    indexFO: IndexFOSignal[];
    stockFO: StockFOSignal[];
    equitySwing: EquitySwingSignal[];
  };
}

// ── Score band classification ──
function classifyConviction(score: number): ConvictionBand {
  if (score >= 90) return "EXTREME";
  if (score >= 80) return "HIGH_CONVICTION";
  if (score >= 70) return "STRONG";
  if (score >= 60) return "WATCH";
  return "NO_TRADE";
}

// ── Convert mode signals to unified format ──
function fromIndexFO(signal: IndexFOSignal, rank: number): UnifiedTradeSetup {
  return {
    rank,
    symbol: signal.symbol,
    name: signal.symbol,
    mode: "INDEX_FO",
    conviction: classifyConviction(signal.confidence),
    score: signal.confidence,
    confidence: signal.confidence,
    direction: signal.direction,
    reasoning: signal.reasoning,
    factors: signal.factors as unknown as Record<string, number>,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    riskReward: signal.riskReward,
    holdingPeriod: signal.holdingPeriod,
    recommendedInstrument: signal.recommendedInstrument,
    maxRisk: signal.maxRisk,
    invalidation: signal.invalidation,
    setupType: signal.direction,
  };
}

function fromStockFO(signal: StockFOSignal, rank: number): UnifiedTradeSetup {
  return {
    rank,
    symbol: signal.symbol,
    name: signal.name,
    mode: "STOCK_FO",
    conviction: classifyConviction(signal.confidence),
    score: signal.confidence,
    confidence: signal.confidence,
    direction: signal.direction,
    reasoning: signal.reasoning,
    factors: signal.factors as unknown as Record<string, number>,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    riskReward: signal.riskReward,
    holdingPeriod: signal.holdingPeriod,
    recommendedInstrument: signal.recommendedInstrument,
    maxRisk: signal.maxRisk,
    invalidation: signal.invalidation,
    setupType: signal.setupType,
  };
}

function fromEquitySwing(signal: EquitySwingSignal, rank: number): UnifiedTradeSetup {
  return {
    rank,
    symbol: signal.symbol,
    name: signal.name,
    mode: "EQUITY_SWING",
    conviction: classifyConviction(signal.confidence),
    score: signal.confidence,
    confidence: signal.confidence,
    direction: signal.direction,
    reasoning: signal.reasoning,
    factors: signal.factors as unknown as Record<string, number>,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    riskReward: signal.riskReward,
    holdingPeriod: signal.holdingPeriod,
    recommendedInstrument: signal.recommendedInstrument,
    maxRisk: signal.maxRisk,
    invalidation: signal.invalidation,
    setupType: signal.setup.type,
  };
}

// ── Main: Build unified ranking ──
export async function buildUnifiedRanking(
  ctx: MarketIntelligenceContext
): Promise<UnifiedRankingResult> {
  // Run all three modes in parallel
  const [indexFO, stockFO, equitySwing] = await Promise.all([
    analyzeIndexFO(ctx),
    analyzeStockFO(ctx),
    analyzeEquitySwing(ctx),
  ]);

  // Convert to unified format
  const allSetups: UnifiedTradeSetup[] = [
    ...indexFO.filter(s => s.direction !== "NO_TRADE").map((s, i) => fromIndexFO(s, 0)),
    ...stockFO.filter(s => s.direction !== "NO_TRADE").map((s, i) => fromStockFO(s, 0)),
    ...equitySwing.filter(s => s.direction !== "NO_TRADE").map((s, i) => fromEquitySwing(s, 0)),
  ];

  // Sort by score descending
  allSetups.sort((a, b) => b.score - a.score);

  // Assign ranks
  allSetups.forEach((s, i) => { s.rank = i + 1; });

  // Split into bands
  const highConviction = allSetups.filter(s =>
    s.conviction === "EXTREME" || s.conviction === "HIGH_CONVICTION"
  );
  const watch = allSetups.filter(s => s.conviction === "STRONG" || s.conviction === "WATCH");

  // Determine best mode
  const modeScores: Record<TradeMode, number> = { INDEX_FO: 0, STOCK_FO: 0, EQUITY_SWING: 0 };
  const modeCounts: Record<TradeMode, number> = { INDEX_FO: 0, STOCK_FO: 0, EQUITY_SWING: 0 };
  for (const s of allSetups) {
    modeScores[s.mode] += s.score;
    modeCounts[s.mode]++;
  }
  const bestMode = (Object.entries(modeScores) as [TradeMode, number][])
    .sort((a, b) => b[1] - a[1])[0][0];

  // Calculate average score
  const avgScore = allSetups.length > 0
    ? allSetups.reduce((sum, s) => sum + s.score, 0) / allSetups.length
    : 0;

  // No trade determination
  const noTrade = highConviction.length === 0 && watch.length === 0;
  const noTradeReason = noTrade
    ? "No setups meet minimum conviction threshold (60+). Market conditions unclear or data insufficient."
    : "";

  return {
    timestamp: new Date().toISOString(),
    sessionPhase: ctx.sessionPhase,
    dataQuality: ctx.dataQuality,
    highConvictionSetups: highConviction,
    watchSetups: watch,
    noTrade,
    noTradeReason,
    summary: {
      totalScanned: allSetups.length,
      indexFOCount: indexFO.length,
      stockFOCount: stockFO.length,
      equitySwingCount: equitySwing.length,
      avgScore: Math.round(avgScore),
      bestMode,
    },
    byMode: {
      indexFO,
      stockFO,
      equitySwing,
    },
  };
}
