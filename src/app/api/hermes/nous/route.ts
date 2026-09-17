// /api/hermes/nous — Operational control/status for Nous Orchestrator
// Exposes status, start/stop, session, heartbeat, Challenge #1, events, Telegram queue
// Does NOT expose broker execution

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import {
  getNousOrchestrator,
  startOrchestrator,
  stopOrchestrator,
  getOrchestratorState,
} from '@/lib/hermes/nous-orchestrator';
import { getEventBus } from '@/lib/hermes/event-bus';
import { getTelegramQueue } from '@/lib/hermes/telegram-queue';
import { getCurrentSession, formatSessionLabel } from '@/lib/hermes/scheduler';

const prisma = new PrismaClient();

// GET /api/hermes/nous — Status
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'status';

    switch (action) {
      case 'status': {
        const state = getOrchestratorState();
        const telegramStatus = getTelegramQueue().getStatus();
        const eventHealth = await getEventBus().healthCheck();

        // Check Prisma heartbeat for accurate orchestrator status
        let orchRunning = state.status === 'RUNNING';
        let prismaHeartbeat: string | null = null;
        try {
          const hb = await prisma.hermesEvent.findFirst({
            where: { eventId: 'HEARTBEAT' },
            orderBy: { createdAt: 'desc' },
          });
          if (hb) {
            prismaHeartbeat = hb.deliveredAt?.toISOString() || hb.createdAt.toISOString();
            const age = Date.now() - new Date(prismaHeartbeat).getTime();
            orchRunning = age < 60_000;
          }
        } catch {}

        return NextResponse.json({
          success: true,
          data: {
            orchestrator: {
              status: orchRunning ? 'RUNNING' : 'STOPPED',
              startedAt: state.startedAt?.toISOString(),
              lastHeartbeat: prismaHeartbeat || state.lastHeartbeat?.toISOString(),
              uptime: state.startedAt ? Date.now() - state.startedAt.getTime() : 0,
              errorCount: state.errorCount,
              lastError: state.lastError,
            },
            session: {
              current: state.currentSession,
              label: formatSessionLabel(state.currentSession),
              info: state.sessionInfo,
              activeMonitors: state.monitorsActive,
            },
            challenge: state.challengeState,
            telegram: {
              pending: telegramStatus.pending,
              retrying: telegramStatus.retrying,
              failed: telegramStatus.failed,
              sentToday: telegramStatus.sentToday,
              running: getTelegramQueue().isRunning(),
            },
            eventBus: eventHealth,
            providers: state.providerHealth,
            dataHealth: state.dataHealth,
            recentEvents: state.recentEvents.slice(0, 10),
          },
        });
      }

      case 'events': {
        const events = await getEventBus().getRecentEvents(50);
        return NextResponse.json({ success: true, data: { events } });
      }

      case 'challenge': {
        const state = getOrchestratorState();
        return NextResponse.json({ success: true, data: { challenge: state.challengeState } });
      }

      case 'health': {
        const eventHealth = await getEventBus().healthCheck();
        const telegramStatus = getTelegramQueue().getStatus();
        const state = getOrchestratorState();

        const checks: Record<string, string> = {
          orchestrator: state.status === 'RUNNING' ? 'HEALTHY' : 'DEGRADED',
          eventBus: eventHealth.healthy ? 'HEALTHY' : 'DEGRADED',
          telegram: getTelegramQueue().isRunning() ? 'HEALTHY' : 'DEGRADED',
          pendingEvents: eventHealth.pendingEvents < 50 ? 'HEALTHY' : 'DEGRADED',
        };

        const allHealthy = Object.values(checks).every(v => v === 'HEALTHY');
        const anyUnhealthy = Object.values(checks).some(v => v === 'UNHEALTHY');

        return NextResponse.json({
          success: true,
          data: {
            status: allHealthy ? 'HEALTHY' : anyUnhealthy ? 'UNHEALTHY' : 'DEGRADED',
            checks,
            pendingEvents: eventHealth.pendingEvents,
            totalEvents: eventHealth.totalEvents,
            telegramPending: telegramStatus.pending,
            lastHeartbeat: state.lastHeartbeat?.toISOString(),
          },
        });
      }

      default:
        return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// POST /api/hermes/nous — Control
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case 'start': {
        const state = getOrchestratorState();
        if (state.status === 'RUNNING') {
          return NextResponse.json({ success: true, message: 'Already running' });
        }
        await startOrchestrator();
        return NextResponse.json({ success: true, message: 'Orchestrator started' });
      }

      case 'stop': {
        await stopOrchestrator();
        return NextResponse.json({ success: true, message: 'Orchestrator stopped' });
      }

      case 'restart': {
        await stopOrchestrator();
        await new Promise(r => setTimeout(r, 2000));
        await startOrchestrator();
        return NextResponse.json({ success: true, message: 'Orchestrator restarted' });
      }

      case 'emit': {
        const { eventType, data } = body;
        if (!eventType) {
          return NextResponse.json({ success: false, error: 'eventType required' }, { status: 400 });
        }
        const eventId = await getEventBus().emit(eventType, data || {});
        return NextResponse.json({ success: true, data: { eventId } });
      }

      default:
        return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
