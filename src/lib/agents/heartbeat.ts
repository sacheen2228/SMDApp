// ═══════════════════════════════════════════════════════════════════════════
// Agent Heartbeat — Periodic heartbeat for all agents
// ═══════════════════════════════════════════════════════════════════════════

import { updateHeartbeat, getAllAgents, checkStaleHeartbeats } from './registry';
import type { AgentStatus } from './types';

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export function startHeartbeatMonitoring(intervalMs: number = 30000): void {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    try {
      // Check for stale heartbeats
      const stale = checkStaleHeartbeats(60000);
      if (stale.length > 0) {
        console.log(`[Heartbeat] ${stale.length} agents went offline:`,
          stale.map(a => a.name).join(', '));
      }
    } catch (error) {
      console.error('[Heartbeat] Error:', error);
    }
  }, intervalMs);

  console.log(`[Heartbeat] Monitoring started (interval: ${intervalMs}ms)`);
}

export function stopHeartbeatMonitoring(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[Heartbeat] Monitoring stopped');
  }
}

export function recordHeartbeat(
  agentId: string,
  params: {
    status?: AgentStatus;
    currentTask?: string;
    currentMarket?: string;
    currentUnderlying?: string;
    currentStrategy?: string;
    lastSuccessfulToolCall?: string;
    lastError?: string;
    latencyMs?: number;
    dataFreshness?: string;
  } = {}
): void {
  try {
    updateHeartbeat(agentId, {
      status: params.status || 'ACTIVE',
      currentTask: params.currentTask || null,
      currentMarket: params.currentMarket || null,
      currentUnderlying: params.currentUnderlying || null,
      currentStrategy: params.currentStrategy || null,
      lastSuccessfulToolCall: params.lastSuccessfulToolCall || null,
      lastError: params.lastError || null,
      latencyMs: params.latencyMs || 0,
      dataFreshness: params.dataFreshness || null,
    });
  } catch (error) {
    console.error(`[Heartbeat] Failed for agent ${agentId}:`, error);
  }
}

export function getAgentHealthSummary(): {
  healthy: number;
  degraded: number;
  unhealthy: number;
  total: number;
} {
  const agents = getAllAgents();
  return {
    healthy: agents.filter(a => a.healthStatus === 'HEALTHY').length,
    degraded: agents.filter(a => a.healthStatus === 'DEGRADED').length,
    unhealthy: agents.filter(a => a.healthStatus === 'UNHEALTHY').length,
    total: agents.length,
  };
}
