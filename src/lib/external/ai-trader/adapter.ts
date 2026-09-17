// ═══════════════════════════════════════════════════════════════════════════
// AI-Trader Adapter — Main orchestrator for external agent integration
// ═══════════════════════════════════════════════════════════════════════════

import { AITraderClient } from './client';
import { normalizeSignal } from './normalizer';
import { validateExternalSignal } from './validator';
import { isDuplicateSignal, cacheSignal } from './cache';
import { registerAgent, getAgentByName, createSignal, validateSignal, emitEvent } from '@/lib/agents/registry';
import type { AITraderConfig } from './types';
import type { Agent } from '@/lib/agents/types';

let client: AITraderClient | null = null;
let registeredExternalAgents = new Map<string, Agent>();

export function initAITraderAdapter(config: Partial<AITraderConfig> = {}): void {
  client = new AITraderClient(config);
  console.log(`[AI-Trader] Adapter initialized: ${config.baseUrl || 'http://localhost:8001'}`);
}

export function isAITraderConnected(): boolean {
  return client?.isConnected() || false;
}

export async function syncExternalAgents(): Promise<Agent[]> {
  if (!client) return [];

  try {
    const heartbeats = await client.getHeartbeats();
    const synced: Agent[] = [];

    for (const hb of heartbeats) {
      let agent = getAgentByName(hb.agent_name);
      if (!agent) {
        agent = registerAgent({
          name: hb.agent_name,
          type: 'EXTERNAL_AGENT',
          version: '0.1',
          description: `External agent: ${hb.agent_name}`,
          metadata: { source: 'AI_TRADER' },
        });
      }
      synced.push(agent);
      registeredExternalAgents.set(hb.agent_name, agent);
    }

    return synced;
  } catch (error) {
    console.error('[AI-Trader] Failed to sync agents:', error);
    return [];
  }
}

export async function ingestExternalSignals(): Promise<{
  ingested: number;
  rejected: number;
  duplicate: number;
}> {
  if (!client) return { ingested: 0, rejected: 0, duplicate: 0 };

  let ingested = 0;
  let rejected = 0;
  let duplicate = 0;

  try {
    const signals = await client.getSignals(100);

    for (const extSignal of signals) {
      // Check duplicate
      if (isDuplicateSignal(extSignal)) {
        duplicate++;
        continue;
      }

      // Find or register agent
      let agent = registeredExternalAgents.get(extSignal.agent_name);
      if (!agent) {
        agent = registerAgent({
          name: extSignal.agent_name,
          type: 'EXTERNAL_AGENT',
          version: extSignal.version || '0.1',
          description: `External agent: ${extSignal.agent_name}`,
          metadata: { source: 'AI_TRADER' },
        });
        registeredExternalAgents.set(extSignal.agent_name, agent);
      }

      // Normalize
      const normalized = normalizeSignal(extSignal, agent.id);

      // Validate
      const validation = validateExternalSignal(normalized);

      if (!validation.valid) {
        console.log(`[AI-Trader] Signal rejected:`, validation.reasons);
        rejected++;
        emitEvent('EXTERNAL_SIGNAL_REJECTED', agent.id, {
          signalId: extSignal.id,
          reasons: validation.reasons,
        });
        continue;
      }

      // Create signal in registry
      const signal = createSignal({
        agentId: agent.id,
        market: normalized.market,
        exchange: normalized.exchange,
        underlying: normalized.underlying,
        signalType: 'EXTERNAL',
        direction: normalized.direction,
        optionType: normalized.optionType || undefined,
        strike: normalized.strike || undefined,
        expiry: normalized.expiry || undefined,
        entryPrice: normalized.entryPrice || undefined,
        stopLoss: normalized.stopLoss || undefined,
        target1: normalized.target1 || undefined,
        target2: normalized.target2 || undefined,
        confidence: normalized.confidence,
        thesis: normalized.thesis,
        evidence: normalized.evidence,
        dataSource: 'EXTERNAL_AGENT',
        dataFreshness: 'SNAPSHOT',
      });

      // Cache as ingested
      cacheSignal(extSignal);
      ingested++;

      emitEvent('EXTERNAL_SIGNAL_RECEIVED', agent.id, {
        signalId: signal.id,
        direction: normalized.direction,
      });

      console.log(`[AI-Trader] Signal ingested: ${normalized.direction} ${normalized.underlying} @ ${normalized.strike} (confidence: ${normalized.confidence})`);
    }
  } catch (error) {
    console.error('[AI-Trader] Failed to ingest signals:', error);
  }

  return { ingested, rejected, duplicate };
}

export function getExternalAgentStats(): {
  totalAgents: number;
  connected: boolean;
} {
  return {
    totalAgents: registeredExternalAgents.size,
    connected: client?.isConnected() || false,
  };
}
