// ═══════════════════════════════════════════════════════════════════════════
// GET /api/agents/health — Agent system health status
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getSystemHealth, getAllAgents, getAllHeartbeats, isFeatureEnabled, checkStaleHeartbeats } from '@/lib/agents/registry';

export async function GET(req: NextRequest) {
  try {
    if (!isFeatureEnabled('AGENT_SYSTEM_ENABLED')) {
      return NextResponse.json({ error: 'Agent system disabled', enabled: false }, { status: 503 });
    }

    // Check for stale heartbeats
    checkStaleHeartbeats(60000);

    const health = getSystemHealth();
    const agents = getAllAgents().map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      status: a.status,
      healthStatus: a.healthStatus,
      lastHeartbeatAt: a.lastHeartbeatAt,
      version: a.version,
    }));

    const heartbeats = getAllHeartbeats().map(h => ({
      agentId: h.agentId,
      status: h.status,
      latencyMs: h.latencyMs,
      currentTask: h.currentTask,
      currentMarket: h.currentMarket,
      timestamp: h.timestamp,
    }));

    return NextResponse.json({
      enabled: true,
      systemHealth: health,
      agents,
      heartbeats,
      featureFlags: {
        AGENT_SYSTEM_ENABLED: isFeatureEnabled('AGENT_SYSTEM_ENABLED'),
        EXTERNAL_AGENT_ENABLED: isFeatureEnabled('EXTERNAL_AGENT_ENABLED'),
        AI_TRADER_ENABLED: isFeatureEnabled('AI_TRADER_ENABLED'),
        AGENT_WEBSOCKET_ENABLED: isFeatureEnabled('AGENT_WEBSOCKET_ENABLED'),
        AGENT_SIGNAL_FEED_ENABLED: isFeatureEnabled('AGENT_SIGNAL_FEED_ENABLED'),
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
