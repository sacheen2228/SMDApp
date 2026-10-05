// ═══════════════════════════════════════════════════════════════════════════
// Canonical Option Engine — BUY CE / BUY PE / NO_TRADE only
// Reuses existing SDM V2, acceleration, buyer confluence, strike selector
//
// Candidate construction is data-only (v2 §3 / never fabricate):
//  · spot / strikes / premium / OI / VIX / expiry / timestamps / sources
//    all come from the shared AgentContext snapshot
//  · SL/TP come from snapshot structure re-priced to premium space via
//    greeks.spotToPremiumLevels (the production conversion used by
//    Today's Trade and the opportunities API)
//  · missing or untradeable data → NO_TRADE with an honest reason
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AgentResearchOutput, GrokDecision, AgentContext,
} from './agent-contract';
import { validateCandidateTrade, rejectOptionSelling, type TradeCandidate } from '../trade-validator-gate';
import { isTradeActive } from '../active-trade-lock';
import { deriveUnderlyingLevels } from './underlying-levels';
import { spotToPremiumLevels } from '../greeks';

// ─── Option Engine Decision ───────────────────────────────────────────────

export interface OptionEngineDecision {
  action: 'BUY_CE' | 'BUY_PE' | 'NO_TRADE';
  candidate?: TradeCandidate;
  reasons: string[];
  risks: string[];
  confidence: number;
  grade: string;
}

export type OptionBuildResult =
  | { ok: true; candidate: TradeCandidate }
  | { ok: false; reason: string };

function getExchange(symbol: string): string {
  if (symbol === 'SENSEX' || symbol === 'BANKEX') return 'BSE';
  if (['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMIC'].includes(symbol)) return 'MCX';
  return 'NFO';
}

function providerSource(raw: any): string | undefined {
  const s = raw?.source;
  return typeof s === 'string' && s.length > 0 ? s.toUpperCase() : undefined;
}

// ─── Candidate builder (pure — no validation side effects) ───────────────

export function buildOptionCandidate(
  symbol: string,
  grokDecision: GrokDecision,
  _agentOutputs: AgentResearchOutput[],
  ctx?: AgentContext
): OptionBuildResult {
  if (!ctx) {
    return { ok: false, reason: 'Snapshot context unavailable — no market data for candidate' };
  }

  const optionSide = grokDecision.direction === 'BUY_CE' ? 'CE'
    : grokDecision.direction === 'BUY_PE' ? 'PE'
    : undefined;
  if (!optionSide) {
    return { ok: false, reason: `Direction ${grokDecision.direction} is not an option buy` };
  }

  if (!(ctx.spot > 0)) {
    return { ok: false, reason: 'Spot unavailable from snapshot — no underlying entry' };
  }

  // Strike: Grok override → STRIKE_SELECTION agent → chain ATM. All real.
  const chain = (ctx.optionChain || {}) as any;
  const strikeSel = _agentOutputs.find(o => o.agentId === 'STRIKE_SELECTION');
  const strike = Number(
    grokDecision.candidate?.strike ??
    (strikeSel?.data as any)?.atmStrike ??
    chain.atmStrike ??
    0
  );
  if (!(strike > 0)) {
    return { ok: false, reason: 'Strike selection unavailable (no ATM/strike data in snapshot)' };
  }

  const row = (ctx.strikes || []).find((s: any) => Number(s?.strike) === strike) as any;
  if (!row) {
    return { ok: false, reason: `No option chain row for strike ${strike} — chain data unavailable` };
  }
  const leg = optionSide === 'CE' ? row.ce : row.pe;
  const premium = Number(leg?.ltp ?? 0);
  if (!(premium > 0)) {
    return { ok: false, reason: `${optionSide} premium unavailable for strike ${strike}` };
  }
  if (!ctx.expiry) {
    return { ok: false, reason: 'Expiry unavailable from chain snapshot' };
  }

  // SL/TP: stop lives on the underlying (structure), then re-priced to
  // premium space — Rule Set C stop floor applied by spotToPremiumLevels.
  const isCall = optionSide === 'CE';
  const levels = deriveUnderlyingLevels(ctx, isCall);
  if (!levels.ok) {
    return { ok: false, reason: levels.reason };
  }
  const conv = spotToPremiumLevels({
    spotEntry: levels.entry,
    spotStopLoss: levels.stopLoss,
    spotT1: levels.target1,
    spotT2: levels.target2,
    premium,
    strike,
    expiry: ctx.expiry,
    isCall,
  });
  if (!conv.ok) {
    return { ok: false, reason: `Premium level reprice failed: ${conv.reason}` };
  }

  const h = (ctx.rawContext || {}) as any;
  const iso = ctx.fetchedAtIso || ctx.dataTimestamp || undefined;
  const vix = Number(ctx.vix) > 0 ? Number(ctx.vix) : undefined;
  const iv = Number(leg?.iv) > 0 ? Number(leg.iv) : undefined;

  const candidate: TradeCandidate = {
    symbol,
    exchange: getExchange(symbol) as TradeCandidate['exchange'],
    instrument: isCall ? 'CALL' : 'PUT',
    optionType: optionSide,
    strike,
    entry: conv.entry,
    stopLoss: conv.stopLoss,
    target1: conv.target1,
    target2: conv.target2,
    direction: grokDecision.direction,
    strategy: 'AGENT_SYSTEM',
    score: grokDecision.consensusConfidence,
    spot: ctx.spot,
    premium: conv.entry,
    bid: typeof leg?.bid === 'number' ? leg.bid : null,
    ask: typeof leg?.ask === 'number' ? leg.ask : null,
    volume: Number(leg?.volume) || 0,
    oi: Number(leg?.oi) || 0,
    ...(iv !== undefined ? { iv } : {}),
    ...(vix !== undefined ? { vix } : {}),
    expiry: ctx.expiry,
    expiryValid: ctx.daysToExpiry >= 0,
    daysToExpiry: ctx.daysToExpiry,
    ...(iso ? { dataTimestamp: iso, snapshotTimestamp: iso } : {}),
    ...(providerSource(h.spot) ? { dataSource: providerSource(h.spot) } : {}),
    ...(providerSource(h.optionChain) ? { optionChainSource: providerSource(h.optionChain) } : {}),
    signalSource: 'GROK_SUPERVISOR',
    riskReward: conv.riskReward,
    // marketOpen is intentionally NOT set here: the pipeline registration
    // gate owns the session clock (engines are pure level builders; after-
    // hours runs still produce an observable would-be decision).
  };

  return { ok: true, candidate };
}

// ─── Main Option Engine ───────────────────────────────────────────────────

export async function runOptionEngine(
  symbol: string,
  grokDecision: GrokDecision,
  agentOutputs: AgentResearchOutput[],
  ctx?: AgentContext
): Promise<OptionEngineDecision> {
  const reasons: string[] = [];
  const risks: string[] = [];

  // 1. Check if Grok wants to trade
  if (grokDecision.direction === 'NO_TRADE' || grokDecision.selectedEngine !== 'OPTION') {
    return {
      action: 'NO_TRADE',
      reasons: ['Grok decided NO_TRADE or routed to wrong engine'],
      risks: [],
      confidence: 0,
      grade: 'F',
    };
  }

  // 2. Enforce BUY-only rule — instrument-aware
  const rejectSell = rejectOptionSelling(grokDecision.direction, undefined, 'CALL');
  if (rejectSell) {
    return {
      action: 'NO_TRADE',
      reasons: [rejectSell],
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
  const built = buildOptionCandidate(symbol, grokDecision, agentOutputs, ctx);
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

  // 5. Validate through canonical validator (freshness, market hours, liquidity)
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

  // 6. Collect evidence for reasons
  const oiAgent = agentOutputs.find(o => o.agentId === 'OI_PCR');
  const structureAgent = agentOutputs.find(o => o.agentId === 'MARKET_STRUCTURE');
  const vwapAgent = agentOutputs.find(o => o.agentId === 'VWAP');
  const mtfAgent = agentOutputs.find(o => o.agentId === 'MTF_CONFIRMATION');
  const buyerAgent = agentOutputs.find(o => o.agentId === 'BUYER_CONFLUENCE');
  const accelerationAgent = agentOutputs.find(o => o.agentId === 'OPTION_ACCELERATION');
  const regimeAgent = agentOutputs.find(o => o.agentId === 'MARKET_REGIME');

  if (regimeAgent?.bias === 'BULLISH') reasons.push(`Regime: ${regimeAgent.observation}`);
  if (oiAgent?.bias === 'BULLISH') reasons.push(`OI: ${oiAgent.observation}`);
  if (structureAgent?.bias === 'BULLISH') reasons.push(`Structure: ${structureAgent.observation}`);
  if (vwapAgent?.bias === 'BULLISH') reasons.push(`VWAP: ${vwapAgent.observation}`);
  if (mtfAgent?.bias === 'BULLISH') reasons.push(`MTF: ${mtfAgent.observation}`);
  if (buyerAgent?.bias === 'BULLISH') reasons.push(`Buyer: ${buyerAgent.observation}`);
  if (accelerationAgent?.bias === 'BULLISH') reasons.push(`Acceleration: ${accelerationAgent.observation}`);

  // For PE (bearish)
  if (regimeAgent?.bias === 'BEARISH') reasons.push(`Regime: ${regimeAgent.observation}`);
  if (oiAgent?.bias === 'BEARISH') reasons.push(`OI: ${oiAgent.observation}`);
  if (structureAgent?.bias === 'BEARISH') reasons.push(`Structure: ${structureAgent.observation}`);
  if (vwapAgent?.bias === 'BEARISH') reasons.push(`VWAP: ${vwapAgent.observation}`);
  if (mtfAgent?.bias === 'BEARISH') reasons.push(`MTF: ${mtfAgent.observation}`);

  // Risks — real VIX only, never a fabricated fallback
  if (ctx && ctx.vix > 20) {
    risks.push('High VIX — expensive premiums');
  }
  risks.push('Option buying has theta decay risk');
  agentOutputs.forEach(o => o.riskFlags.forEach(r => risks.push(r)));

  // Grade
  const confidence = grokDecision.consensusConfidence;
  const grade = confidence >= 75 ? 'A' : confidence >= 60 ? 'B' : confidence >= 45 ? 'C' : 'D';

  return {
    action: grokDecision.direction as 'BUY_CE' | 'BUY_PE',
    candidate,
    reasons: [...new Set(reasons)],
    risks: [...new Set(risks)].slice(0, 5),
    confidence,
    grade,
  };
}
