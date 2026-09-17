// ═══════════════════════════════════════════════════════════════════════════
// AI-Trader Signal Normalizer — Convert external signals to SMDApp format
// ═══════════════════════════════════════════════════════════════════════════

import type { AITraderSignal } from './types';
import type { AgentSignal } from '@/lib/agents/types';

export function normalizeSignal(external: AITraderSignal, agentId: string): AgentSignal {
  // Reject selling signals
  if (external.action === 'SELL_CE' || external.action === 'SELL_PE') {
    throw new Error(`SELL signals not allowed in SMDApp: ${external.action}`);
  }

  // Determine option type from action
  let optionType: 'CE' | 'PE' | null = null;
  let direction: AgentSignal['direction'] = 'WAIT';
  if (external.action === 'BUY_CE') {
    optionType = 'CE';
    direction = 'BUY_CE';
  } else if (external.action === 'BUY_PE') {
    optionType = 'PE';
    direction = 'BUY_PE';
  } else if (external.action === 'EXIT') {
    direction = 'EXIT';
  }

  // Determine exchange
  const exchange = external.exchange || 'NSE';

  // Ensure CE/PE in thesis for buy signals
  let thesis = external.thesis;
  if (direction === 'BUY_CE' && !thesis.includes('CE')) {
    thesis = `[CE] ${thesis}`;
  } else if (direction === 'BUY_PE' && !thesis.includes('PE')) {
    thesis = `[PE] ${thesis}`;
  }

  return {
    id: `ext-${external.id}`,
    agentId,
    timestamp: external.timestamp || new Date().toISOString(),
    market: 'INDIA',
    exchange,
    underlying: external.symbol,
    signalType: 'EXTERNAL',
    direction,
    optionType,
    strike: external.strike || null,
    expiry: external.expiry || null,
    entryPrice: external.entry_price || null,
    stopLoss: external.stop_loss || null,
    target1: external.target1 || null,
    target2: external.target2 || null,
    confidence: Math.max(0, Math.min(1, external.confidence)),
    thesis,
    evidence: {
      priceStructure: external.evidence?.price_structure || null,
      vwap: external.evidence?.vwap || null,
      volume: external.evidence?.volume || null,
      callOI: external.evidence?.call_oi || null,
      putOI: external.evidence?.put_oi || null,
      oiMigration: external.evidence?.oi_migration || null,
      sellerMap: external.evidence?.seller_map || null,
      delta: external.evidence?.delta || null,
      gamma: external.evidence?.gamma || null,
      iv: external.evidence?.iv || null,
      vix: external.evidence?.vix || null,
      frvp: external.evidence?.frvp || null,
      poc: external.evidence?.poc || null,
      vah: external.evidence?.vah || null,
      val: external.evidence?.val || null,
      liquidity: external.evidence?.liquidity || null,
      absorption: external.evidence?.absorption || null,
      cas: external.evidence?.cas || null,
      breadth: external.evidence?.breadth || null,
      fiiDii: external.evidence?.fii_dii || null,
      global: external.evidence?.global || null,
      news: external.evidence?.news || null,
    },
    dataSource: external.source || 'EXTERNAL_AGENT',
    dataFreshness: 'SNAPSHOT',
    validationStatus: 'PENDING',
    executionStatus: 'NONE',
    lifecycle: 'CANDIDATE',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min
  };
}
