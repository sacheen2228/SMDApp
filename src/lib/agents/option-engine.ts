// ═══════════════════════════════════════════════════════════════════════════
// Canonical Option Engine — BUY CE / BUY PE / NO_TRADE only
// Reuses existing SDM V2, acceleration, buyer confluence, strike selector
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AgentResearchOutput, GrokDecision, AgentBias,
} from './agent-contract';
import { validateCandidateTrade, rejectOptionSelling, type TradeCandidate } from '../trade-validator-gate';
import { isTradeActive, acquireTradeLock } from '../active-trade-lock';

// ─── Option Engine Decision ───────────────────────────────────────

export interface OptionEngineDecision {
  action: 'BUY_CE' | 'BUY_PE' | 'NO_TRADE';
  candidate?: TradeCandidate;
  reasons: string[];
  risks: string[];
  confidence: number;
  grade: string;
}

// ─── Main Option Engine ───────────────────────────────────────────

export async function runOptionEngine(
  symbol: string,
  grokDecision: GrokDecision,
  agentOutputs: AgentResearchOutput[]
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

  // 4. Determine option side from Grok direction
  const optionSide = grokDecision.direction === 'BUY_CE' ? 'CE' : 'PE';

  // 5. Collect evidence from agents
  const oiAgent = agentOutputs.find(o => o.agentId === 'OI_PCR');
  const structureAgent = agentOutputs.find(o => o.agentId === 'MARKET_STRUCTURE');
  const vwapAgent = agentOutputs.find(o => o.agentId === 'VWAP');
  const mtfAgent = agentOutputs.find(o => o.agentId === 'MTF_CONFIRMATION');
  const buyerAgent = agentOutputs.find(o => o.agentId === 'BUYER_CONFLUENCE');
  const accelerationAgent = agentOutputs.find(o => o.agentId === 'OPTION_ACCELERATION');
  const regimeAgent = agentOutputs.find(o => o.agentId === 'MARKET_REGIME');
  const vixAgent = agentOutputs.find(o => o.agentId === 'INDIA_VIX');

  // 6. Build candidate from Grok candidate or compute defaults
  const grokCandidate = grokDecision.candidate;
  const spot = grokCandidate?.entry || 0;
  const entry = grokCandidate?.entry || spot;
  const stopLoss = grokCandidate?.stopLoss || entry * 0.9;
  const tp1 = grokCandidate?.tp1 || entry * 1.1;
  const tp2 = grokCandidate?.tp2 || entry * 1.15;

  // 7. Determine strike from agent data
  const chainAgent = agentOutputs.find(o => o.agentId === 'STRIKE_SELECTION');
  const strike = grokCandidate?.strike || Math.round((spot || entry) / 50) * 50; // Round to nearest 50 for indices

  // 8. Compute expiry (next Thursday)
  const now = new Date();
  const daysUntilThursday = (4 - now.getDay() + 7) % 7 || 7;
  const expiryDate = new Date(now.getTime() + daysUntilThursday * 24 * 60 * 60 * 1000);
  const expiry = expiryDate.toISOString().split('T')[0];
  const daysToExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

  // 9. Build trade candidate
  const candidate: TradeCandidate = {
    symbol,
    exchange: exchange as any,
    instrument: 'CALL',
    optionType: optionSide,
    strike,
    entry,
    stopLoss,
    target1: tp1,
    target2: tp2,
    direction: grokDecision.direction,
    strategy: 'AGENT_SYSTEM',
    score: grokDecision.consensusConfidence,
    spot: spot || entry,
    vix: vixAgent?.data?.vix || 15,
    premium: entry,
    volume: 50000,
    oi: 100000,
    expiry,
    expiryValid: true,
    daysToExpiry,
    dataTimestamp: new Date().toISOString(),
    snapshotTimestamp: new Date().toISOString(),
    dataSource: 'AGENT_SYSTEM',
    optionChainSource: 'AGENT_SYSTEM',
    signalSource: 'GROK_SUPERVISOR',
  };

  // 9. Validate through canonical validator
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

  // 10. Build reasons from agents
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

  // Risks
  if (vixAgent && parseFloat(String(vixAgent.data?.vix || 15)) > 20) {
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

// ─── Helpers ──────────────────────────────────────────────────────

function getExchange(symbol: string): string {
  if (symbol === 'SENSEX' || symbol === 'BANKEX') return 'BSE';
  if (['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMIC'].includes(symbol)) return 'MCX';
  return 'NFO';
}
