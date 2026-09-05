// Score Frozen at Entry — Unified Scoring Engine v2.0
// When a trade is ENTERED, the score, grade, hard gates, and weights are locked.
// The frozen snapshot is used for display and performance tracking — never re-computed.

import { type TradeDecision, type HardGateResult, type FactorScore, type FactorWeights, SCORING_VERSION } from "./unified-scoring-engine";

// ─── Frozen Score Record ───────────────────────────────────────────

export interface FrozenScore {
  // Identity
  tradeId: string;
  symbol: string;
  strategy: string;
  direction: string;

  // Frozen scoring data (captured at entry moment)
  score: number;
  grade: "A+" | "A" | "B" | "WATCH" | "NO_TRADE";
  scoreBreakdown: FactorScore[];
  hardGatesAtEntry: HardGateResult;
  weightsUsed: FactorWeights;
  scoringVersion: string;

  // Trade parameters (frozen at entry)
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  target3?: number;
  riskReward: number;
  lotSize?: number;
  quantity?: number;

  // Context at entry
  spotAtEntry: number;
  vixAtEntry?: number;
  pcrAtEntry?: number;
  regimeAtEntry?: string;
  marketStructureAtEntry?: string;
  mssBiasAtEntry?: string;
  supertrendDirectionAtEntry?: string;

  // Metadata
  frozenAt: number;         // timestamp when score was locked
  dataSource?: string;      // "BREEZE" | "NSE" | "YAHOO"
  dataLatencyMs?: number;
}

// ─── Frozen Score Store ────────────────────────────────────────────

const frozenScores: Map<string, FrozenScore> = new Map();

export function freezeScore(tradeId: string, decision: TradeDecision, context?: {
  spotAtEntry?: number;
  vixAtEntry?: number;
  pcrAtEntry?: number;
  regimeAtEntry?: string;
  marketStructureAtEntry?: string;
  mssBiasAtEntry?: string;
  supertrendDirectionAtEntry?: string;
  lotSize?: number;
  quantity?: number;
  dataSource?: string;
  dataLatencyMs?: number;
}): FrozenScore {
  const frozen: FrozenScore = {
    tradeId,
    symbol: decision.symbol,
    strategy: decision.strategy,
    direction: decision.direction,

    score: decision.score,
    grade: decision.grade,
    scoreBreakdown: [...decision.scoreBreakdown],
    hardGatesAtEntry: { ...decision.hardGateStatus },
    weightsUsed: { ...decision.weightsUsed },
    scoringVersion: decision.scoringVersion,

    entryPrice: decision.entry,
    stopLoss: decision.stopLoss,
    target1: decision.target1,
    target2: decision.target2,
    target3: decision.target3,
    riskReward: decision.riskReward,
    lotSize: context?.lotSize,
    quantity: context?.quantity,

    spotAtEntry: context?.spotAtEntry ?? decision.entry,
    vixAtEntry: context?.vixAtEntry,
    pcrAtEntry: context?.pcrAtEntry,
    regimeAtEntry: context?.regimeAtEntry,
    marketStructureAtEntry: context?.marketStructureAtEntry,
    mssBiasAtEntry: context?.mssBiasAtEntry,
    supertrendDirectionAtEntry: context?.supertrendDirectionAtEntry,

    frozenAt: Date.now(),
    dataSource: context?.dataSource,
    dataLatencyMs: context?.dataLatencyMs,
  };

  frozenScores.set(tradeId, frozen);
  return frozen;
}

export function getFrozenScore(tradeId: string): FrozenScore | undefined {
  return frozenScores.get(tradeId);
}

export function getAllFrozenScores(): FrozenScore[] {
  return Array.from(frozenScores.values());
}

export function getFrozenScoresByStrategy(strategy: string): FrozenScore[] {
  return getAllFrozenScores().filter(f => f.strategy === strategy);
}

export function getFrozenScoresBySymbol(symbol: string): FrozenScore[] {
  return getAllFrozenScores().filter(f => f.symbol === symbol);
}

export function removeFrozenScore(tradeId: string): boolean {
  return frozenScores.delete(tradeId);
}

// ─── Score Comparison (for backtest verification) ──────────────────

export interface ScoreComparison {
  tradeId: string;
  frozenScore: number;
  liveScore: number;          // what scoreTrade() would give now with current data
  scoreDelta: number;         // frozenScore - liveScore
  frozenGrade: string;
  liveGrade: string;
  gradeChanged: boolean;
  frozenSpot: number;
  currentSpot: number;
  spotDelta: number;
  interpretation: string;     // "score improved" / "score degraded" / "no change"
}

export function compareScoreAtEntry(
  tradeId: string,
  currentDecision: TradeDecision
): ScoreComparison | null {
  const frozen = frozenScores.get(tradeId);
  if (!frozen) return null;

  const scoreDelta = frozen.score - currentDecision.score;
  const gradeChanged = frozen.grade !== currentDecision.grade;
  const spotDelta = frozen.spotAtEntry - currentDecision.entry;

  let interpretation: string;
  if (Math.abs(scoreDelta) < 3) interpretation = "no change";
  else if (scoreDelta > 0) interpretation = `score degraded by ${Math.abs(scoreDelta)} pts since entry`;
  else interpretation = `score improved by ${Math.abs(scoreDelta)} pts since entry`;

  return {
    tradeId,
    frozenScore: frozen.score,
    liveScore: currentDecision.score,
    scoreDelta,
    frozenGrade: frozen.grade,
    liveGrade: currentDecision.grade,
    gradeChanged,
    frozenSpot: frozen.spotAtEntry,
    currentSpot: currentDecision.entry,
    spotDelta,
    interpretation,
  };
}

// ─── Display Helpers ───────────────────────────────────────────────

export function formatFrozenScore(frozen: FrozenScore): string {
  return `[${frozen.scoringVersion}] ${frozen.symbol} ${frozen.strategy} — Score ${frozen.score}/100 (${frozen.grade}) @ ₹${frozen.entryPrice} — frozen at ${new Date(frozen.frozenAt).toISOString()}`;
}

export function getScoreStability(frozen: FrozenScore, currentScore: number): "STABLE" | "DRIFTING" | "DIVERGED" {
  const delta = Math.abs(frozen.score - currentScore);
  if (delta < 5) return "STABLE";
  if (delta < 15) return "DRIFTING";
  return "DIVERGED";
}
