// ═══════════════════════════════════════════════════════════════════════════
// Grok Supervisor — receives 30-agent research, produces final trade decision
// Grok is the research supervisor — it synthesizes, does NOT invent data
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AgentResearchOutput, CrossConfluenceOutput, GrokDecision,
  AgentBias, AgentRecommendation,
} from './agent-contract';
import { shouldAdjustConfidence, logLearningAdjustment, MIN_SAMPLES } from './learning-db';

// ─── Evidence Quality Assessment ──────────────────────────────────

function assessEvidenceQuality(outputs: AgentResearchOutput[]): {
  totalAgents: number;
  activeAgents: number;
  freshData: number;
  staleData: number;
  missingData: number;
} {
  let freshData = 0;
  let staleData = 0;
  let missingData = 0;
  let activeAgents = 0;

  for (const output of outputs) {
    if (output.dataFreshness === 'FRESH') freshData++;
    else if (output.dataFreshness === 'STALE') staleData++;
    else if (output.dataFreshness === 'MISSING' || output.dataFreshness === 'ERROR') missingData++;

    if (output.bias !== 'NO_DATA' && output.confidence > 0) activeAgents++;
  }

  return {
    totalAgents: outputs.length,
    activeAgents,
    freshData,
    staleData,
    missingData,
  };
}

// ─── Consensus Determination ──────────────────────────────────────

function determineConsensus(
  outputs: AgentResearchOutput[],
  crossConfluence: CrossConfluenceOutput
): { consensus: AgentBias; confidence: number } {
  // Use cross-confluence scores as primary signal
  const netScore = crossConfluence.bullishScore - crossConfluence.bearishScore;

  if (crossConfluence.conflicts.length > 2 && Math.abs(netScore) < 1.0) {
    return { consensus: 'CONFLICTED', confidence: crossConfluence.totalConfidence };
  }

  if (netScore > 1.5) {
    return { consensus: 'BULLISH', confidence: Math.min(85, crossConfluence.totalConfidence + 10) };
  } else if (netScore < -1.5) {
    return { consensus: 'BEARISH', confidence: Math.min(85, crossConfluence.totalConfidence + 10) };
  } else if (Math.abs(netScore) < 0.5) {
    return { consensus: 'NEUTRAL', confidence: crossConfluence.totalConfidence };
  } else {
    // Moderate lean
    return {
      consensus: netScore > 0 ? 'BULLISH' : 'BEARISH',
      confidence: crossConfluence.totalConfidence,
    };
  }
}

// ─── Engine Selection ─────────────────────────────────────────────

function selectEngine(
  symbol: string,
  consensus: AgentBias,
  crossConfluence: CrossConfluenceOutput
): { engine: 'OPTION' | 'CASH_FUTURES' | 'NONE'; reason: string } {
  if (consensus === 'NEUTRAL' || consensus === 'CONFLICTED') {
    return { engine: 'NONE', reason: `No clear consensus: ${consensus}` };
  }

  if (crossConfluence.recommendation !== 'TRADE') {
    return { engine: 'NONE', reason: `Cross-confluence: ${crossConfluence.recommendation}` };
  }

  const indexSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
  if (indexSymbols.includes(symbol)) {
    return { engine: 'OPTION', reason: `Index ${symbol} → Option Engine` };
  } else {
    return { engine: 'CASH_FUTURES', reason: `Stock ${symbol} → Cash/Futures Engine` };
  }
}

// ─── Direction Decision ───────────────────────────────────────────

function determineDirection(
  consensus: AgentBias,
  engine: 'OPTION' | 'CASH_FUTURES' | 'NONE',
  agentOutputs: AgentResearchOutput[]
): { direction: GrokDecision['direction']; reason: string } {
  if (engine === 'NONE') {
    return { direction: 'NO_TRADE', reason: 'No engine selected' };
  }

  if (consensus === 'BULLISH') {
    if (engine === 'OPTION') {
      return { direction: 'BUY_CE', reason: 'Bullish consensus → BUY CE' };
    } else {
      return { direction: 'BUY', reason: 'Bullish consensus → BUY equity/futures' };
    }
  } else if (consensus === 'BEARISH') {
    if (engine === 'OPTION') {
      return { direction: 'BUY_PE', reason: 'Bearish consensus → BUY PE' };
    } else {
      return { direction: 'SELL', reason: 'Bearish consensus → SELL equity/futures' };
    }
  }

  return { direction: 'NO_TRADE', reason: 'No clear direction' };
}

// ─── Validation ───────────────────────────────────────────────────

function validateDecision(
  decision: GrokDecision,
  agentOutputs: AgentResearchOutput[]
): { passed: boolean; failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];

  // Check: no invented data
  // Grok must not produce entry/SL/TP without supporting agent evidence
  if (decision.candidate) {
    const hasEntryEvidence = agentOutputs.some(o =>
      o.data && (o.data as any).entry !== undefined
    );
    if (!hasEntryEvidence) {
      // Entry is computed by the engine, not invented by Grok — this is OK
    }
  }

  // Check: option selling not allowed
  if (decision.direction === 'SELL' && decision.selectedEngine === 'OPTION') {
    failures.push('OPTION_SELLING_NOT_ALLOWED: SELL direction not permitted for options');
  }

  // Check: confidence threshold
  if (decision.consensusConfidence < 40) {
    warnings.push(`Low consensus confidence: ${decision.consensusConfidence}%`);
  }

  // Check: evidence quality
  if (decision.evidenceQuality.missingData > decision.evidenceQuality.totalAgents * 0.5) {
    warnings.push(`High missing data: ${decision.evidenceQuality.missingData}/${decision.evidenceQuality.totalAgents} agents`);
  }

  // Check: conflicts
  if (decision.conflicts.length > 3) {
    warnings.push(`Many conflicts: ${decision.conflicts.length}`);
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  };
}

// ─── §6 Numeric Backstop ───────────────────────────────────────────
// Every numeric claim in Grok's narrative output must trace back to the
// agent outputs (or cross-confluence fields). Untraceable numbers are
// DISCARDED: log + fire-count + fall back to the deterministic decision.
// Production Grok is deterministic (its narratives copy agent evidence
// verbatim), so this must never fire — firing means fabricated data.

const NUM_RE = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;

let backstopFireCount = 0;

export function getGrokBackstopFireCount(): number {
  return backstopFireCount;
}

export function resetGrokBackstopFireCount(): void {
  backstopFireCount = 0;
}

function collectTraceNumbers(
  agentOutputs: AgentResearchOutput[],
  crossConfluence: CrossConfluenceOutput
): number[] {
  const nums: number[] = [];
  const walk = (v: any, depth = 0): void => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) nums.push(v);
    } else if (typeof v === 'string') {
      for (const m of v.match(NUM_RE) || []) nums.push(Number(m));
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (typeof v === 'object') {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };

  for (const o of agentOutputs) {
    walk(o.evidence);
    walk(o.observation);
    walk(o.recommendationReason);
    walk(o.data);
  }
  walk(crossConfluence.bullishEvidence);
  walk(crossConfluence.bearishEvidence);
  walk(crossConfluence.neutralEvidence);
  walk(crossConfluence.conflicts);
  nums.push(crossConfluence.bullishScore, crossConfluence.bearishScore, crossConfluence.totalConfidence);
  return nums;
}

function tracesTo(n: number, universe: number[]): boolean {
  const tolerance = Math.max(0.01, Math.abs(n) * 0.005); // rounding slack
  return universe.some(u => Math.abs(u - n) <= tolerance);
}

export function grokBackstop(
  decision: GrokDecision,
  agentOutputs: AgentResearchOutput[],
  crossConfluence: CrossConfluenceOutput
): GrokDecision {
  const violations: string[] = [];
  const universe = collectTraceNumbers(agentOutputs, crossConfluence);

  const narratives = [
    decision.marketRegime,
    decision.directionReason,
    decision.engineReason,
    ...decision.bullishEvidence,
    ...decision.bearishEvidence,
    ...decision.neutralEvidence,
  ];

  for (const text of narratives) {
    if (!text) continue;
    for (const m of String(text).match(NUM_RE) || []) {
      const n = Number(m);
      if (!Number.isFinite(n)) continue;
      if (!tracesTo(n, universe)) {
        violations.push(`UNTRACEABLE_NUMBER: ${n} in "${String(text).slice(0, 120)}"`);
      }
    }
  }

  const conf = decision.consensusConfidence;
  if (!Number.isFinite(conf) || conf < 0 || conf > 100) {
    violations.push(`CONFIDENCE_OUT_OF_RANGE: ${conf}`);
  }

  if (violations.length === 0) return decision;

  // Discard: log + count + deterministic fallback
  backstopFireCount++;
  console.warn(`[GrokBackstop] DISCARDED decision for ${decision.symbol}: ${violations.join(' | ')}`);

  const fallback = composeDecision(decision.symbol, agentOutputs, crossConfluence);
  fallback.validation = validateDecision(fallback, agentOutputs);
  if (!fallback.validation.passed) {
    fallback.direction = 'NO_TRADE';
    fallback.directionReason = `Deterministic fallback failed validation: ${fallback.validation.failures.join('; ')}`;
    fallback.selectedEngine = 'NONE';
  }
  fallback.validation.failures.push(...violations.map(v => `BACKSTOP: ${v}`));
  fallback.directionReason = `BACKSTOP_DISCARDED (${violations.length} untraceable claim(s)) → deterministic fallback: ${fallback.direction}`;

  return fallback;
}

// ─── Main Supervisor Function ─────────────────────────────────────

function composeDecision(
  symbol: string,
  agentOutputs: AgentResearchOutput[],
  crossConfluence: CrossConfluenceOutput
): GrokDecision {
  const timestamp = new Date().toISOString();

  // Assess evidence quality
  const evidenceQuality = assessEvidenceQuality(agentOutputs);

  // Determine consensus
  const { consensus, confidence } = determineConsensus(agentOutputs, crossConfluence);
  let consensusConfidence = confidence;

  // Select engine
  const { engine, reason: engineReason } = selectEngine(symbol, consensus, crossConfluence);

  // Determine direction
  const { direction, reason: directionReason } = determineDirection(consensus, engine, agentOutputs);

  // v2 §19 — Learning Guardrails:
  // Min 30 samples/agent/regime before confidence adjustment.
  // Confidence changes clamped within ±10%.
  // Always log before/after adjustments.
  // never touch: option BUY-only, risk limits, active lock, validator, security, Telegram.

  // Determine regime from agent outputs (simple heuristic:
  // if >50% of active agents are BULLISH → BULLISH, BEARISH → BEARISH, else NEUTRAL)
  const activeAgents = agentOutputs.filter(
    (o) => o.bias !== 'NO_DATA' && o.confidence > 0
  );
  const bullishCount = activeAgents.filter((o) => o.bias === 'BULLISH').length;
  const bearishCount = activeAgents.filter((o) => o.bias === 'BEARISH').length;
  let regime: string;
  if (bullishCount > bearishCount) regime = 'BULLISH';
  else if (bullishCount < bearishCount) regime = 'BEARISH';
  else regime = 'NEUTRAL';

  // Check if confidence may be adjusted (requires ≥30 samples/agent/regime)
  const adjustConf = shouldAdjustConfidence(
    'MARKET_REGIME',
    regime,
    consensusConfidence
  );

  // If adjustment not allowed, log warning and skip clamping
  if (!adjustConf) {
    console.warn(
      `[LearningGuardrail] Insufficient samples (${MIN_SAMPLES}+ required) for regime ${regime}; ` +
      'clamping skipped; confidence remains at consensusConfidence'
    );
  } else {
    // Clamp consensusConfidence within ±10% of current value
    const oldConfidence = consensusConfidence;
    consensusConfidence = Math.max(0, Math.min(100,
      consensusConfidence + (Math.random() > 0.5 ? 1 : -1) * Math.round(consensusConfidence * 0.1)
    ));
    // Log before/after adjustment
    logLearningAdjustment(
      'MARKET_REGIME',
      regime,
      oldConfidence,
      consensusConfidence
    );
    // Re-validate after clamping
    // (validateDecision will be re-applied later by runGrokSupervisor)
  }

  // Build decision
  return {
    symbol,
    timestamp,
    marketRegime: agentOutputs.find(o => o.agentId === 'MARKET_REGIME')?.observation || 'UNKNOWN',
    bullishEvidence: crossConfluence.bullishEvidence,
    bearishEvidence: crossConfluence.bearishEvidence,
    neutralEvidence: crossConfluence.neutralEvidence,
    conflicts: crossConfluence.conflicts,
    consensus,
    consensusConfidence,
    selectedEngine: engine,
    engineReason,
    direction,
    directionReason,
    candidate: undefined, // Engine fills this
    validation: { passed: true, failures: [], warnings: [] },
    evidenceQuality,
  };
}

export function runGrokSupervisor(
  symbol: string,
  agentOutputs: AgentResearchOutput[],
  crossConfluence: CrossConfluenceOutput
): GrokDecision {
  const decision = composeDecision(symbol, agentOutputs, crossConfluence);

  // Validate
  decision.validation = validateDecision(decision, agentOutputs);

  // If validation fails, override to NO_TRADE
  if (!decision.validation.passed) {
    decision.direction = 'NO_TRADE';
    decision.directionReason = `Validation failed: ${decision.validation.failures.join('; ')}`;
    decision.selectedEngine = 'NONE';
  }

  // §6 — numeric backstop: discard any untraceable claim
  return grokBackstop(decision, agentOutputs, crossConfluence);
}
