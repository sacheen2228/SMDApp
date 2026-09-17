// ═══════════════════════════════════════════════════════════════════════════
// Agent Reputation — Track agent performance and reliability
// ═══════════════════════════════════════════════════════════════════════════

import { updatePerformance, getPerformance, getAllAgents } from './registry';
import type { AgentPerformance } from './types';

export function recordSignalOutcome(
  agentId: string,
  outcome: {
    valid: boolean;
    stale?: boolean;
    conflict?: boolean;
    tradeResult?: 'WIN' | 'LOSS' | 'BREAKEVEN';
    rMultiple?: number;
  }
): void {
  const current = getPerformance(agentId) || {
    agentId,
    period: new Date().toISOString().split('T')[0],
    totalSignals: 0,
    validSignals: 0,
    closedTrades: 0,
    winners: 0,
    losers: 0,
    totalR: 0,
    averageR: 0,
    maxDrawdown: 0,
    staleSignals: 0,
    invalidSignals: 0,
    conflicts: 0,
  };

  const update: Partial<AgentPerformance> = {
    totalSignals: current.totalSignals + 1,
    validSignals: current.validSignals + (outcome.valid ? 1 : 0),
    staleSignals: current.staleSignals + (outcome.stale ? 1 : 0),
    invalidSignals: current.invalidSignals + (!outcome.valid ? 1 : 0),
    conflicts: current.conflicts + (outcome.conflict ? 1 : 0),
  };

  if (outcome.tradeResult) {
    update.closedTrades = current.closedTrades + 1;
    if (outcome.tradeResult === 'WIN') {
      update.winners = current.winners + 1;
    } else if (outcome.tradeResult === 'LOSS') {
      update.losers = current.losers + 1;
    }
    if (outcome.rMultiple !== undefined) {
      update.totalR = current.totalR + outcome.rMultiple;
      update.averageR = (current.totalR + outcome.rMultiple) / (current.closedTrades + 1);
    }
  }

  updatePerformance(agentId, update);
}

export function getAgentReputation(agentId: string): {
  score: number;
  reliability: number;
  accuracy: number;
  totalSignals: number;
  totalTrades: number;
  winRate: number;
  averageR: number;
  rank: 'ROOKIE' | 'NOVICE' | 'INTERMEDIATE' | 'EXPERT' | 'MASTER';
} {
  const perf = getPerformance(agentId);
  if (!perf) {
    return {
      score: 0,
      reliability: 0,
      accuracy: 0,
      totalSignals: 0,
      totalTrades: 0,
      winRate: 0,
      averageR: 0,
      rank: 'ROOKIE',
    };
  }

  const reliability = perf.totalSignals > 0
    ? ((perf.totalSignals - perf.staleSignals - perf.invalidSignals) / perf.totalSignals) * 100
    : 0;
  const accuracy = perf.totalSignals > 0
    ? (perf.validSignals / perf.totalSignals) * 100
    : 0;
  const winRate = perf.closedTrades > 0
    ? (perf.winners / perf.closedTrades) * 100
    : 0;

  // Score: weighted combination
  const score = (
    reliability * 0.3 +
    accuracy * 0.3 +
    winRate * 0.2 +
    Math.min(perf.averageR * 20, 100) * 0.2
  );

  let rank: 'ROOKIE' | 'NOVICE' | 'INTERMEDIATE' | 'EXPERT' | 'MASTER' = 'ROOKIE';
  if (score >= 90) rank = 'MASTER';
  else if (score >= 75) rank = 'EXPERT';
  else if (score >= 60) rank = 'INTERMEDIATE';
  else if (score >= 40) rank = 'NOVICE';

  return {
    score: Math.round(score * 100) / 100,
    reliability: Math.round(reliability * 100) / 100,
    accuracy: Math.round(accuracy * 100) / 100,
    totalSignals: perf.totalSignals,
    totalTrades: perf.closedTrades,
    winRate: Math.round(winRate * 100) / 100,
    averageR: Math.round(perf.averageR * 100) / 100,
    rank,
  };
}

export function getLeaderboard(): Array<{
  agentId: string;
  name: string;
  rank: string;
  score: number;
  winRate: number;
  totalTrades: number;
}> {
  return getAllAgents()
    .map(agent => ({
      agentId: agent.id,
      name: agent.name,
      ...getAgentReputation(agent.id),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}
