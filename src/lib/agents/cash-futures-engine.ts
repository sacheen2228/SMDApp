// ═══════════════════════════════════════════════════════════════════════════
// Canonical Cash/Futures Engine — BUY / SELL / NO_TRADE
// For: equity, index futures, stock futures, MCX commodities
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AgentResearchOutput, GrokDecision,
} from './agent-contract';
import { isTradeActive } from '../active-trade-lock';

// ─── Cash/Futures Engine Decision ─────────────────────────────────

export interface CashFuturesDecision {
  action: 'BUY' | 'SELL' | 'NO_TRADE';
  candidate?: {
    symbol: string;
    exchange: string;
    instrument: 'EQUITY' | 'FUTURES';
    direction: 'BUY' | 'SELL';
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    confidence: number;
    grade: string;
    reasons: string[];
    risks: string[];
  };
  reasons: string[];
  risks: string[];
  confidence: number;
  grade: string;
}

// ─── Main Cash/Futures Engine ─────────────────────────────────────

export async function runCashFuturesEngine(
  symbol: string,
  grokDecision: GrokDecision,
  agentOutputs: AgentResearchOutput[]
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

  // 4. Collect evidence
  const regimeAgent = agentOutputs.find(o => o.agentId === 'MARKET_REGIME');
  const structureAgent = agentOutputs.find(o => o.agentId === 'MARKET_STRUCTURE');
  const momentumAgent = agentOutputs.find(o => o.agentId === 'MOMENTUM');
  const volumeAgent = agentOutputs.find(o => o.agentId === 'VOLUME');
  const breakoutAgent = agentOutputs.find(o => o.agentId === 'BREAKOUT');
  const fiiAgent = agentOutputs.find(o => o.agentId === 'FII_DII');
  const btstAgent = agentOutputs.find(o => o.agentId === 'BTST');

  // 5. Determine instrument type
  const mcxSymbols = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMIC'];
  const isMCX = mcxSymbols.includes(symbol);
  const instrument = isMCX ? 'FUTURES' : 'EQUITY';

  // 6. Build candidate
  const spot = grokDecision.candidate?.entry || 0;
  const entry = grokDecision.candidate?.entry || spot;
  const stopLoss = grokDecision.candidate?.stopLoss ||
    (direction === 'BUY' ? entry * 0.97 : entry * 1.03);
  const tp1 = grokDecision.candidate?.tp1 ||
    (direction === 'BUY' ? entry * 1.03 : entry * 0.97);
  const tp2 = grokDecision.candidate?.tp2 ||
    (direction === 'BUY' ? entry * 1.05 : entry * 0.95);

  // 7. Build reasons
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
    candidate: {
      symbol,
      exchange,
      instrument,
      direction,
      entry,
      stopLoss,
      tp1,
      tp2,
      confidence,
      grade,
      reasons: [...new Set(reasons)],
      risks: [...new Set(risks)].slice(0, 5),
    },
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
  return 'NSE';
}
