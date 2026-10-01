// ═══════════════════════════════════════════════════════════════════════════
// Cross-Confluence Engine — aggregates 30 agent outputs into unified analysis
// Does NOT simply count agents — understands relationships and conflicts
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AgentResearchOutput, CrossConfluenceOutput, AgentBias, AgentRecommendation,
} from './agent-contract';

// ─── Category Weights (how much each category matters) ─────────────

const CATEGORY_WEIGHTS: Record<string, number> = {
  MARKET: 1.2,
  FLOW: 0.8,
  CONTEXT: 0.6,
  VOLATILITY: 1.0,
  OPTIONS: 1.5,
  STRUCTURE: 1.3,
  SIGNALS: 1.1,
  RISK: 0.9,
  EQUITY: 1.0,
  MCX: 1.0,
};

// ─── Critical agents (higher impact on final decision) ────────────

const CRITICAL_AGENTS = new Set([
  'MARKET_REGIME', 'OI_PCR', 'OI_CLASSIFICATION', 'MARKET_STRUCTURE',
  'VWAP', 'VOLUME', 'MTF_CONFIRMATION', 'BUYER_CONFLUENCE',
]);

// ─── Conflict Detection ───────────────────────────────────────────

function detectConflicts(outputs: AgentResearchOutput[]): string[] {
  const conflicts: string[] = [];
  const biases = outputs.filter(o => o.bias !== 'NO_DATA' && o.confidence >= 40);

  const bullish = biases.filter(o => o.bias === 'BULLISH');
  const bearish = biases.filter(o => o.bias === 'BEARISH');

  // Direct bullish/bearish conflict
  if (bullish.length > 0 && bearish.length > 0) {
    const bullNames = bullish.map(o => o.agentName).join(', ');
    const bearNames = bearish.map(o => o.agentName).join(', ');
    conflicts.push(`BULLISH vs BEARISH conflict: [${bullNames}] vs [${bearNames}]`);
  }

  // Structure vs Momentum conflict
  const structure = outputs.find(o => o.agentId === 'MARKET_STRUCTURE');
  const momentum = outputs.find(o => o.agentId === 'MOMENTUM');
  if (structure && momentum && structure.bias !== momentum.bias && structure.bias !== 'NEUTRAL' && momentum.bias !== 'NEUTRAL') {
    conflicts.push(`Structure (${structure.bias}) conflicts with Momentum (${momentum.bias})`);
  }

  // VWAP vs OI conflict
  const vwap = outputs.find(o => o.agentId === 'VWAP');
  const oi = outputs.find(o => o.agentId === 'OI_PCR');
  if (vwap && oi && vwap.bias !== oi.bias && vwap.bias !== 'NEUTRAL' && oi.bias !== 'NEUTRAL') {
    conflicts.push(`VWAP (${vwap.bias}) conflicts with OI/PCR (${oi.bias})`);
  }

  // MTF vs Regime conflict
  const mtf = outputs.find(o => o.agentId === 'MTF_CONFIRMATION');
  const regime = outputs.find(o => o.agentId === 'MARKET_REGIME');
  if (mtf && regime && mtf.bias !== regime.bias && mtf.bias !== 'NEUTRAL' && regime.bias !== 'NEUTRAL') {
    conflicts.push(`MTF (${mtf.bias}) conflicts with Regime (${regime.bias})`);
  }

  return conflicts;
}

// ─── Score Aggregation ────────────────────────────────────────────

function aggregateScores(outputs: AgentResearchOutput[]): {
  bullishScore: number;
  bearishScore: number;
  totalConfidence: number;
  confluenceCount: number;
} {
  let bullishScore = 0;
  let bearishScore = 0;
  let totalConfidence = 0;
  let activeCount = 0;

  for (const output of outputs) {
    if (output.bias === 'NO_DATA' || output.dataFreshness === 'ERROR') continue;

    const weight = CATEGORY_WEIGHTS[output.category] || 1.0;
    const isCritical = CRITICAL_AGENTS.has(output.agentId);
    const agentWeight = isCritical ? 1.5 : 1.0;
    const finalWeight = weight * agentWeight;
    const confFactor = output.confidence / 100;

    if (output.bias === 'BULLISH') {
      bullishScore += finalWeight * confFactor;
    } else if (output.bias === 'BEARISH') {
      bearishScore += finalWeight * confFactor;
    }

    totalConfidence += output.confidence;
    activeCount++;
  }

  return {
    bullishScore: Math.round(bullishScore * 100) / 100,
    bearishScore: Math.round(bearishScore * 100) / 100,
    totalConfidence: activeCount > 0 ? Math.round(totalConfidence / activeCount) : 0,
    confluenceCount: activeCount,
  };
}

// ─── Main Cross-Confluence Function ───────────────────────────────

export function analyzeCrossConfluence(
  symbol: string,
  agentOutputs: AgentResearchOutput[]
): CrossConfluenceOutput {
  const timestamp = new Date().toISOString();

  // Categorize evidence
  const bullishEvidence: string[] = [];
  const bearishEvidence: string[] = [];
  const neutralEvidence: string[] = [];

  for (const output of agentOutputs) {
    if (output.bias === 'BULLISH') {
      bullishEvidence.push(`[${output.agentName}] ${output.observation}`);
      output.evidence.forEach(e => bullishEvidence.push(`  → ${e}`));
    } else if (output.bias === 'BEARISH') {
      bearishEvidence.push(`[${output.agentName}] ${output.observation}`);
      output.evidence.forEach(e => bearishEvidence.push(`  → ${e}`));
    } else {
      neutralEvidence.push(`[${output.agentName}] ${output.observation}`);
    }
  }

  // Detect conflicts
  const conflicts = detectConflicts(agentOutputs);

  // Aggregate scores
  const scores = aggregateScores(agentOutputs);

  // Determine recommendation
  let recommendation: AgentRecommendation = 'NO_TRADE';
  let recommendationReason = '';

  const netScore = scores.bullishScore - scores.bearishScore;
  const hasConflicts = conflicts.length > 0;

  if (hasConflicts && Math.abs(netScore) < 1.0) {
    recommendation = 'NO_TRADE';
    recommendationReason = `Conflicting signals (${conflicts.length} conflicts) with weak net score ${netScore.toFixed(2)}`;
  } else if (netScore > 1.5 && scores.totalConfidence >= 50) {
    recommendation = 'TRADE';
    recommendationReason = `Strong bullish confluence: score ${netScore.toFixed(2)}, confidence ${scores.totalConfidence}%`;
  } else if (netScore < -1.5 && scores.totalConfidence >= 50) {
    recommendation = 'TRADE';
    recommendationReason = `Strong bearish confluence: score ${netScore.toFixed(2)}, confidence ${scores.totalConfidence}%`;
  } else if (scores.totalConfidence < 40) {
    recommendation = 'WAIT';
    recommendationReason = `Low average confidence: ${scores.totalConfidence}%`;
  } else {
    recommendation = 'WAIT';
    recommendationReason = `Moderate signals: net score ${netScore.toFixed(2)}, confidence ${scores.totalConfidence}%`;
  }

  // Risk flags from all agents
  const riskFlags = agentOutputs.flatMap(o => o.riskFlags);

  // Determine route
  let routeToEngine: 'OPTION' | 'CASH_FUTURES' | 'NONE' = 'NONE';
  if (recommendation === 'TRADE') {
    const indexSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
    if (indexSymbols.includes(symbol)) {
      routeToEngine = 'OPTION';
    } else {
      routeToEngine = 'CASH_FUTURES';
    }
  }

  // Regime alignment
  const regimeAgent = agentOutputs.find(o => o.agentId === 'MARKET_REGIME');
  const regimeAlignment = !regimeAgent || regimeAgent.bias === 'NEUTRAL' || regimeAgent.bias === (netScore > 0 ? 'BULLISH' : 'BEARISH');

  return {
    symbol,
    timestamp,
    bullishEvidence,
    bearishEvidence,
    neutralEvidence,
    conflicts,
    bullishScore: scores.bullishScore,
    bearishScore: scores.bearishScore,
    totalConfidence: scores.totalConfidence,
    confluenceCount: scores.confluenceCount,
    regimeAlignment,
    recommendation,
    recommendationReason,
    riskFlags: [...new Set(riskFlags)], // deduplicate
    routeToEngine,
  };
}
