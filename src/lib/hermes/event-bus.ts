// Hermes Event Bus — restart-safe, Prisma-persisted
// In-process EventEmitter for runtime events + Prisma persistence for restart recovery
// Critical events (TRADE_CREATED, TP_HIT, SL_HIT, etc.) are persisted before emission

import { EventEmitter } from 'events';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

// ─── Event Types ──────────────────────────────────────────────────
export type HermesEventType =
  // Trade lifecycle
  | 'TRADE_CREATED'
  | 'TRADE_ENTERED'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'SL_HIT'
  | 'TRAILING_SL_UPDATED'
  | 'THESIS_INVALIDATED'
  | 'TIME_EXIT'
  | 'EXPIRY_EXIT'
  | 'TRADE_CLOSED'
  // Provider
  | 'PROVIDER_FAILURE'
  | 'PROVIDER_RECOVERY'
  // Market
  | 'MARKET_REGIME_CHANGE'
  | 'DATA_STALE'
  | 'DATA_RECOVERED'
  | 'VIX_STATE_CHANGE'
  | 'OI_GAMMA_STATE_CHANGE'
  // System
  | 'HEALTH_CHECK'
  | 'HEALTH_DEGRADED'
  | 'HEALTH_RECOVERED'
  | 'SCHEDULER_TICK'
  | 'SESSION_CHANGE'
  // Challenge
  | 'CHALLENGE_MILESTONE'
  | 'CHALLENGE_DRAWDOWN'
  | 'CHALLENGE_UPDATE'
  // Paper
  | 'PAPER_ENGINE_STARTED'
  | 'PAPER_ENGINE_STOPPED'
  | 'NO_TRADE_OBSERVED'
  // Telegram
  | 'TELEGRAM_SENT'
  | 'TELEGRAM_FAILED'
  | 'TELEGRAM_RETRY';

// Events that MUST be persisted (trade-critical)
const CRITICAL_EVENTS = new Set<HermesEventType>([
  'TRADE_CREATED', 'TRADE_ENTERED', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT',
  'SL_HIT', 'TRAILING_SL_UPDATED', 'THESIS_INVALIDATED', 'TIME_EXIT',
  'EXPIRY_EXIT', 'TRADE_CLOSED', 'CHALLENGE_MILESTONE', 'CHALLENGE_DRAWDOWN',
]);

// ─── Event Payload ────────────────────────────────────────────────
export interface HermesEvent {
  eventId: string;
  eventType: HermesEventType;
  symbol?: string;
  tradeId?: string;
  payload: Record<string, any>;
  timestamp: string;
  delivered: boolean;
  deliveredAt?: string;
  retryCount: number;
  lastError?: string;
}

// ─── Listener Type ────────────────────────────────────────────────
export type HermesEventListener = (event: HermesEvent) => void | Promise<void>;

// ─── Singleton ────────────────────────────────────────────────────
let busInstance: HermesEventBus | null = null;

class HermesEventBus extends EventEmitter {
  private prisma: PrismaClient;
  private recentEvents = new Map<string, number>(); // eventId → timestamp
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor() {
    super();
    this.setMaxListeners(50);
    this.prisma = new PrismaClient();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Cleanup old dedup entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [id, ts] of this.recentEvents) {
        if (ts < cutoff) this.recentEvents.delete(id);
      }
    }, 5 * 60 * 1000);

    console.log('[EventBus] Started');
  }

  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.removeAllListeners();
    this.started = false;
    console.log('[EventBus] Stopped');
  }

  // ─── Emit Event (persist if critical, always dedup) ──────────
  async emit(eventType: HermesEventType, data: Record<string, any> = {}): Promise<string> {
    const eventId = this.buildEventId(eventType, data);

    // Dedup: same eventId within 1 second
    if (this.recentEvents.has(eventId)) {
      return eventId;
    }
    this.recentEvents.set(eventId, Date.now());

    const event: HermesEvent = {
      eventId,
      eventType,
      symbol: data.symbol,
      tradeId: data.tradeId,
      payload: data,
      timestamp: new Date().toISOString(),
      delivered: false,
      retryCount: 0,
    };

    // Persist critical events to Prisma
    if (CRITICAL_EVENTS.has(eventType)) {
      try {
        await this.prisma.hermesEvent.create({
          data: {
            eventId: event.eventId,
            eventType: event.eventType,
            symbol: event.symbol || null,
            tradeId: event.tradeId || null,
            payload: JSON.stringify(event.payload),
            delivered: false,
            retryCount: 0,
          },
        });
      } catch (err: any) {
        // Unique constraint violation = duplicate, ignore
        if (err?.code !== 'P2002') {
          console.error('[EventBus] Persist failed:', err.message);
        }
      }
    }

    // Emit to in-process listeners
    super.emit(eventType, event);
    super.emit('*', event); // wildcard for monitoring

    return eventId;
  }

  // ─── Mark Event Delivered ────────────────────────────────────
  async markDelivered(eventId: string): Promise<void> {
    try {
      await this.prisma.hermesEvent.update({
        where: { eventId },
        data: { delivered: true, deliveredAt: new Date() },
      });
    } catch {}
  }

  // ─── Mark Event Failed ───────────────────────────────────────
  async markFailed(eventId: string, error: string): Promise<void> {
    try {
      await this.prisma.hermesEvent.update({
        where: { eventId },
        data: { retryCount: { increment: 1 }, lastError: error },
      });
    } catch {}
  }

  // ─── Get Undelivered Critical Events (for restart recovery) ──
  async getUndeliveredEvents(limit = 50): Promise<HermesEvent[]> {
    try {
      const rows = await this.prisma.hermesEvent.findMany({
        where: { delivered: false, retryCount: { lt: 5 } },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        eventId: r.eventId,
        eventType: r.eventType as HermesEventType,
        symbol: r.symbol || undefined,
        tradeId: r.tradeId || undefined,
        payload: JSON.parse(r.payload),
        timestamp: r.createdAt.toISOString(),
        delivered: r.delivered,
        deliveredAt: r.deliveredAt?.toISOString(),
        retryCount: r.retryCount,
        lastError: r.lastError || undefined,
      }));
    } catch {
      return [];
    }
  }

  // ─── Get Recent Events ───────────────────────────────────────
  async getRecentEvents(limit = 20): Promise<HermesEvent[]> {
    try {
      const rows = await this.prisma.hermesEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return rows.map((r) => ({
        eventId: r.eventId,
        eventType: r.eventType as HermesEventType,
        symbol: r.symbol || undefined,
        tradeId: r.tradeId || undefined,
        payload: JSON.parse(r.payload),
        timestamp: r.createdAt.toISOString(),
        delivered: r.delivered,
        deliveredAt: r.deliveredAt?.toISOString(),
        retryCount: r.retryCount,
        lastError: r.lastError || undefined,
      }));
    } catch {
      return [];
    }
  }

  // ─── Rebuild State from Prisma (on restart) ──────────────────
  async getRecoveryState(): Promise<{
    undeliveredEvents: HermesEvent[];
    totalPersisted: number;
  }> {
    const undelivered = await this.getUndeliveredEvents(100);
    let totalPersisted = 0;
    try {
      totalPersisted = await this.prisma.hermesEvent.count();
    } catch {}
    return { undeliveredEvents: undelivered, totalPersisted };
  }

  // ─── Build Deterministic Event ID ────────────────────────────
  private buildEventId(type: HermesEventType, data: Record<string, any>): string {
    // Deterministic: same type + same tradeId + same symbol = same eventId
    const key = `${type}:${data.tradeId || ''}:${data.symbol || ''}:${data.strike || ''}:${data.optionType || ''}`;
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    return `${type}:${hash}`;
  }

  // ─── Health Check ────────────────────────────────────────────
  async healthCheck(): Promise<{ healthy: boolean; pendingEvents: number; totalEvents: number }> {
    let pendingEvents = 0;
    let totalEvents = 0;
    try {
      pendingEvents = await this.prisma.hermesEvent.count({ where: { delivered: false } });
      totalEvents = await this.prisma.hermesEvent.count();
    } catch {}
    return {
      healthy: pendingEvents < 100,
      pendingEvents,
      totalEvents,
    };
  }
}

// ─── Get Singleton ────────────────────────────────────────────────
export function getEventBus(): HermesEventBus {
  if (!busInstance) {
    busInstance = new HermesEventBus();
  }
  return busInstance;
}

// ─── Convenience Exports ──────────────────────────────────────────
export async function emitTradeCreated(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('TRADE_CREATED', { tradeId, symbol, ...data });
}

export async function emitTP1Hit(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('TP1_HIT', { tradeId, symbol, ...data });
}

export async function emitTP2Hit(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('TP2_HIT', { tradeId, symbol, ...data });
}

export async function emitSLHit(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('SL_HIT', { tradeId, symbol, ...data });
}

export async function emitTradeClosed(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('TRADE_CLOSED', { tradeId, symbol, ...data });
}

export async function emitTrailingSL(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('TRAILING_SL_UPDATED', { tradeId, symbol, ...data });
}

export async function emitThesisInvalidated(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('THESIS_INVALIDATED', { tradeId, symbol, ...data });
}

export async function emitTimeExit(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('TIME_EXIT', { tradeId, symbol, ...data });
}

export async function emitExpiryExit(tradeId: string, symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('EXPIRY_EXIT', { tradeId, symbol, ...data });
}

export async function emitProviderFailure(provider: string, error: string): Promise<string> {
  return getEventBus().emit('PROVIDER_FAILURE', { provider, error });
}

export async function emitProviderRecovery(provider: string): Promise<string> {
  return getEventBus().emit('PROVIDER_RECOVERY', { provider });
}

export async function emitMarketRegimeChange(symbol: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('MARKET_REGIME_CHANGE', { symbol, ...data });
}

export async function emitChallengeMilestone(data: Record<string, any>): Promise<string> {
  return getEventBus().emit('CHALLENGE_MILESTONE', data);
}

export async function emitChallengeDrawdown(data: Record<string, any>): Promise<string> {
  return getEventBus().emit('CHALLENGE_DRAWDOWN', data);
}

export async function emitHealthDegraded(component: string, data: Record<string, any>): Promise<string> {
  return getEventBus().emit('HEALTH_DEGRADED', { component, ...data });
}
