// ═══════════════════════════════════════════════════════════════════════════
// Canonical Cash/Futures Engine — BUY / SELL / NO_TRADE
// For: equity, index futures, stock futures, MCX commodities
//
// Candidate construction is data-only (v2 §3 / never fabricate):
//  · entry = real spot from the shared AgentContext snapshot
//  · SL/TP = snapshot structure (supports/resistances/swings/pdh-pdl)
//  · timestamps / sources / market hours come from the snapshot + session clock
//  · missing structure or spot → NO_TRADE with an honest reason
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AgentResearchOutput, GrokDecision, AgentContext,
} from './agent-contract';
import { isTradeActive } from '../active-trade-lock';
import { validateCandidateTrade, type TradeCandidate } from '../trade-validator-gate';
import { deriveUnderlyingLevels } from './underlying-levels';

// ─── Cash/Futures Engine Decision ─────────────────────────────────────────

export interface CashFuturesDecision {
  action: 'BUY' | 'SELL' | 'NO_TRADE';
  candidate?: TradeCandidate;
  reasons: string[];
  risks: string[];
  confidence: number;
  grade: string;
}

export type CashBuildResult =
  | { ok: true; candidate: TradeCandidate }
  | { ok: false; reason: string };

const MCX_SYMBOLS = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMIC'];

function getExchange(symbol: string): string {
  if (symbol === 'SENSEX' || symbol === 'BANKEX') return 'BSE';
  if (MCX_SYMBOLS.includes(symbol)) return 'MCX';
  return 'NSE';
}

function providerSource(raw: any): string | undefined {
  const s = raw?.source;
  return typeof s === 'string' && s.length > 0 ? s.toUpperCase() : undefined;
}

// ─── Candidate builder (pure — no validation side effects) ───────────────

export function buildCashCandidate(
  symbol: string,
  grokDecision: GrokDecision,
  _agentOutputs: AgentResearchOutput[],
  ctx?: AgentContext
): CashBuildResult {
  if (!ctx) {
    return { ok: false, reason: 'Snapshot context unavailable — no market data for candidate' };
  }

  const direction = grokDecision.direction === 'BUY' || grokDecision.direction === 'SELL'
    ? grokDecision.direction
    : undefined;
  if (!direction) {
    return { ok: false, reason: `Invalid direction for cash/futures: ${grokDecision.direction}` };
  }

  const levels = deriveUnderlyingLevels(ctx, direction === 'BUY');
  if (!levels.ok) {
    return { ok: false, reason: levels.reason };
  }

  const isMCX = MCX_SYMBOLS.includes(symbol);
  const instrument: TradeCandidate['instrument'] = isMCX ? 'FUTURES' : 'EQUITY';
  const h = (ctx.rawContext || {}) as any;
  const iso = ctx.fetchedAtIso || ctx.dataTimestamp || undefined;
  const vix = Number(ctx.vix) > 0 ? Number(ctx.vix) : undefined;

  const risk = Math.abs(levels.entry - levels.stopLoss);
  const reward = Math.abs(levels.target1 - levels.entry);
  const riskReward = risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0;

  const candidate: TradeCandidate = {
    symbol,
    exchange: getExchange(symbol) as TradeCandidate['exchange'],
    instrument,
    direction,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    target1: levels.target1,
    target2: levels.target2,
    strategy: 'AGENT_SYSTEM',
    score: grokDecision.consensusConfidence,
    spot: ctx.spot,
    ...(vix !== undefined ? { vix } : {}),
    ...(iso ? { dataTimestamp: iso, snapshotTimestamp: iso } : {}),
    ...(providerSource(h.spot) ? { dataSource: providerSource(h.spot) } : {}),
    signalSource: 'GROK_SUPERVISOR',
    ...(riskReward > 0 ? { riskReward } : {}),
    // marketOpen is intentionally NOT set here: the pipeline registration
    // gate owns the session clock (engines are pure level builders).
  };

  return { ok: true, candidate };
}

// ─── Main Cash/Futures Engine ─────────────────────────────────────────────

export async function runCashFuturesEngine(
  symbol: string,
  grokDecision: GrokDecision,
  agentOutputs: AgentResearchOutput[],
  ctx?: AgentContext
): Promise<CashFuturesDecision> {
  const reasons: string[] = [];
  const risks: string[] = [];

  // 1. Check if Grok wants to trade
  if (grokDecision.direction === 'NO_TRADE' || grokDecision.selectedEngine !== 'CASH_FUTURES') {
    return {
      action: 'NO_TRADE',
      reasons: ['Grok decided NO_TRADE or routed to wrong engine'],
      risks: [],
      confidence: 0,
      grade: 'F',
    };
  }

  // 2. Determine direction — SELL is allowed for equity/futures
  const direction = grokDecision.direction === 'BUY' ? 'BUY' :
                    grokDecision.direction === 'SELL' ? 'SELL' : undefined;

  if (!direction) {
    return {
      action: 'NO_TRADE',
      reasons: [`Invalid direction for cash/futures: ${grokDecision.direction}`],
      risks: [],
      confidence: 0,
      grade: 'F',
    };
  }

  // 3. Check active trade lock
  const exchange = getExchange(symbol);
  const activeLock = isTradeActive(symbol, exchange);
  if (activeLock) {
    return {
      action: 'NO_TRADE',
      reasons: [`Active trade exists: ${activeLock.tradeId} (${activeLock.status})`],
      risks: [],
      confidence: 0,
      grade: 'F',
    };
  }

  // 4. Build candidate from the shared snapshot — real data only
  const built = buildCashCandidate(symbol, grokDecision, agentOutputs, ctx);
  if (!built.ok) {
    return {
      action: 'NO_TRADE',
      reasons: [built.reason],
      risks: [],
      confidence: 0,
      grade: 'F',
    };
  }
  const candidate = built.candidate;

  // 5. Validate through canonical validator (freshness, market hours, …)
  const validation = validateCandidateTrade(candidate);
  if (!validation.valid) {
    return {
      action: 'NO_TRADE',
      reasons: validation.reasons,
      risks: [],
      confidence: 0,
      grade: 'F',
    };
  }

  // 6. Collect evidence
  const regimeAgent = agentOutputs.find(o => o.agentId === 'MARKET_REGIME');
  const structureAgent = agentOutputs.find(o => o.agentId === 'MARKET_STRUCTURE');
  const momentumAgent = agentOutputs.find(o => o.agentId === 'MOMENTUM');
  const volumeAgent = agentOutputs.find(o => o.agentId === 'VOLUME');
  const breakoutAgent = agentOutputs.find(o => o.agentId === 'BREAKOUT');
  const fiiAgent = agentOutputs.find(o => o.agentId === 'FII_DII');

  const isMCX = MCX_SYMBOLS.includes(symbol);

  if (regimeAgent) reasons.push(`Regime: ${regimeAgent.observation}`);
  if (structureAgent) reasons.push(`Structure: ${structureAgent.observation}`);
  if (momentumAgent) reasons.push(`Momentum: ${momentumAgent.observation}`);
  if (volumeAgent) reasons.push(`Volume: ${volumeAgent.observation}`);
  if (breakoutAgent) reasons.push(`Breakout: ${breakoutAgent.observation}`);
  if (fiiAgent) reasons.push(`FII/DII: ${fiiAgent.observation}`);

  // 8. Risks
  if (isMCX) risks.push('MCX carries higher volatility');
  if (direction === 'SELL') risks.push('Short selling — unlimited loss potential');
  agentOutputs.forEach(o => o.riskFlags.forEach(r => risks.push(r)));

  // 9. Grade
  const confidence = grokDecision.consensusConfidence;
  const grade = confidence >= 75 ? 'A' : confidence >= 60 ? 'B' : confidence >= 45 ? 'C' : 'D';

  return {
    action: direction,
    candidate,
    reasons: [...new Set(reasons)],
    risks: [...new Set(risks)].slice(0, 5),
    confidence,
    grade,
  };
}
