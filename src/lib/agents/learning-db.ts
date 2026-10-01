// ══════════════════════════════════════════════════════════════════════════
// Learning Database — records trade decisions, outcomes, agent performance
// Uses in-memory counter (no DB queries needed for guardrails) — §19 learning guardrails
// ══════════════════════════════════════════════════════════════════════════

import type {
  TradeDecisionRecord,
  AgentId,
  AgentBias,
} from './agent-contract';

// Global counter for learning guardrails — tracks (agentId, regime) → sample count
const learningSamples = new Map<string, number>();

// In-memory decision ledger: recordId → decision (+ outcome when closed)
const decisionRecords = new Map<string, TradeDecisionRecord>();

export const MIN_SAMPLES = 30;

/** Returns true if enough samples have been recorded for this agent/regime. */
export function shouldAdjustConfidence(
  agentId: string,
  regime: string,
  _currentConfidence?: number
): boolean {
  const key = `${agentId}:${regime}`;
  const count = learningSamples.get(key) || 0;
  return count >= MIN_SAMPLES;
}

/** Records a confidence adjustment event for this agent/regime. */
export function logLearningAdjustment(
  agentId: string,
  regime: string,
  _fromConfidence?: number,
  _toConfidence?: number
): void {
  const key = `${agentId}:${regime}`;
  learningSamples.set(key, (learningSamples.get(key) || 0) + 1);
}

// ─── Store Decision Record ────────────────────────────────────────

/** Stores a full trade decision snapshot (research + trade + entry context). */
export async function storeDecisionRecord(
  record: TradeDecisionRecord
): Promise<void> {
  decisionRecords.set(record.id, record);
}

/** Attaches the closed-trade outcome to a stored decision record. */
export async function updateOutcome(
  id: string,
  outcome: Partial<
    Pick<
      TradeDecisionRecord,
      | 'outcome'
      | 'exitPrice'
      | 'exitTime'
      | 'pnl'
      | 'mfe'
      | 'mae'
      | 'rMultiple'
      | 'agentPerformance'
    >
  >
): Promise<boolean> {
  const record = decisionRecords.get(id);
  if (!record) return false;
  Object.assign(record, outcome);
  return true;
}

// ─── Agent performance queries ────────────────────────────────────

export interface AgentPerformanceSummary {
  agentId: AgentId;
  samples: number;
  wins: number;
  losses: number;
  winRate: number;
  avgConfidence: number;
}

function agentVerdict(
  record: TradeDecisionRecord,
  agentId: string
): { correct: boolean; confidence: number } | null {
  const per = record.agentPerformance?.[agentId as AgentId];
  if (per) return { correct: per.wasCorrect, confidence: per.confidence };

  const output = record.agentOutputs?.find((o) => o.agentId === agentId);
  if (!output || !record.outcome) return null;
  if (record.outcome === 'BREAKEVEN' || record.outcome === 'CANCELLED') return null;

  const won = record.outcome === 'WIN';
  const bullish = output.bias === 'BULLISH';
  const bearish = output.bias === 'BEARISH';
  // Direction of the taken trade: BUY_CE/BUY = long, BUY_PE/SELL = short
  const long = /BUY/.test(record.direction) && !/PE/.test(record.direction);
  if (!bullish && !bearish) return null;
  const agentAgreesWithTrade = bullish === long;
  return {
    correct: agentAgreesWithTrade ? won : !won,
    confidence: output.confidence,
  };
}

/** Win/loss stats for one agent across all closed decision records. */
export function getAgentPerformance(
  agentId: string
): AgentPerformanceSummary {
  let samples = 0;
  let wins = 0;
  let losses = 0;
  let confSum = 0;

  for (const record of decisionRecords.values()) {
    const verdict = agentVerdict(record, agentId);
    if (!verdict) continue;
    samples++;
    confSum += verdict.confidence;
    if (verdict.correct) wins++;
    else losses++;
  }

  return {
    agentId: agentId as AgentId,
    samples,
    wins,
    losses,
    winRate: samples > 0 ? Math.round((wins / samples) * 100) : 0,
    avgConfidence: samples > 0 ? Math.round((confSum / samples) * 10) / 10 : 0,
  };
}

/** Win rate for one agent within a specific market regime. */
export function getWinRateByRegime(
  agentId: string,
  regime: string
): number {
  let samples = 0;
  let wins = 0;
  for (const record of decisionRecords.values()) {
    if (record.regime !== regime) continue;
    const verdict = agentVerdict(record, agentId);
    if (!verdict) continue;
    samples++;
    if (verdict.correct) wins++;
  }
  return samples > 0 ? Math.round((wins / samples) * 100) : 0;
}
