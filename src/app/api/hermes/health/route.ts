// ═══════════════════════════════════════════════════════════════════════════
// GET /api/hermes/health — Hermes Pro agent health
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getAgentByName, getHeartbeat, getPerformance } from '@/lib/agents/registry';

export async function GET(req: NextRequest) {
  try {
    const hermes = getAgentByName('HERMES');
    if (!hermes) {
      return NextResponse.json({
        status: 'NOT_REGISTERED',
        message: 'Hermes agent not yet registered',
      });
    }

    const heartbeat = getHeartbeat(hermes.id);
    const performance = getPerformance(hermes.id);

    return NextResponse.json({
      id: hermes.id,
      name: hermes.name,
      type: hermes.type,
      status: hermes.status,
      healthStatus: hermes.healthStatus,
      version: hermes.version,
      lastHeartbeatAt: hermes.lastHeartbeatAt,
      lastTaskAt: hermes.lastTaskAt,
      lastSignalAt: hermes.lastSignalAt,
      heartbeat: heartbeat ? {
        status: heartbeat.status,
        latencyMs: heartbeat.latencyMs,
        currentTask: heartbeat.currentTask,
        currentMarket: heartbeat.currentMarket,
        timestamp: heartbeat.timestamp,
      } : null,
      performance: performance ? {
        totalSignals: performance.totalSignals,
        validSignals: performance.validSignals,
        closedTrades: performance.closedTrades,
        winners: performance.winners,
        losers: performance.losers,
        averageR: performance.averageR,
      } : null,
      capabilities: hermes.capabilities,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
