// Telegram Queue — unified delivery with dedup, retry, exponential backoff
// Wraps existing telegram.ts sender. Does NOT replace it.
// Existing senders keep working. New events route through this queue.
// Never sends duplicate alerts after restart.

import { getEventBus, type HermesEvent, type HermesEventType } from './event-bus';

// ─── Queue Item ───────────────────────────────────────────────────
export interface QueueItem {
  eventId: string;
  text: string;
  priority: number; // 1=highest (SL), 10=lowest (info)
  retryCount: number;
  maxRetries: number;
  nextRetryAt: number;
  createdAt: string;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'RETRYING';
  error?: string;
}

// ─── Priority Map ─────────────────────────────────────────────────
const EVENT_PRIORITY: Partial<Record<HermesEventType, number>> = {
  SL_HIT: 1,
  TP1_HIT: 2,
  TP2_HIT: 3,
  TP3_HIT: 3,
  TRADE_CREATED: 4,
  TRADE_ENTERED: 4,
  THESIS_INVALIDATED: 5,
  TRAILING_SL_UPDATED: 5,
  TIME_EXIT: 6,
  EXPIRY_EXIT: 6,
  TRADE_CLOSED: 6,
  CHALLENGE_MILESTONE: 7,
  CHALLENGE_DRAWDOWN: 7,
  PROVIDER_FAILURE: 8,
  MARKET_REGIME_CHANGE: 9,
  HEALTH_DEGRADED: 9,
  PROVIDER_RECOVERY: 10,
  DATA_STALE: 10,
  HEALTH_RECOVERED: 10,
};

// ─── Singleton ────────────────────────────────────────────────────
let queueInstance: TelegramQueue | null = null;

export class TelegramQueue {
  private queue: QueueItem[] = [];
  private sentToday = new Set<string>(); // eventId dedup (restart-safe via Prisma)
  private processing = false;
  private processInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private sendFn: ((text: string) => Promise<boolean>) | null = null;

  constructor() {}

  async start(sendFn: (text: string) => Promise<boolean>): Promise<void> {
    if (this.started) return;
    this.sendFn = sendFn;
    this.started = true;

    // Restore dedup state from event bus (restart recovery)
    const bus = getEventBus();
    const recent = await bus.getRecentEvents(200);
    for (const evt of recent) {
      if (evt.delivered) {
        this.sentToday.add(evt.eventId);
      }
    }

    // Process queue every 3 seconds
    this.processInterval = setInterval(() => this.processQueue(), 3000);

    console.log('[TelegramQueue] Started — dedup state:', this.sentToday.size, 'entries restored');
  }

  async stop(): Promise<void> {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
    this.started = false;
    console.log('[TelegramQueue] Stopped');
  }

  // ─── Enqueue Message ──────────────────────────────────────────
  async enqueue(
    eventId: string,
    text: string,
    eventType?: HermesEventType,
    forceDedup = true
  ): Promise<boolean> {
    // Dedup: same eventId never sent twice
    if (forceDedup && this.sentToday.has(eventId)) {
      console.log('[TelegramQueue] Dedup —', eventId, 'already sent');
      return false;
    }

    const priority = eventType ? (EVENT_PRIORITY[eventType] ?? 10) : 10;

    const item: QueueItem = {
      eventId,
      text,
      priority,
      retryCount: 0,
      maxRetries: 3,
      nextRetryAt: Date.now(),
      createdAt: new Date().toISOString(),
      status: 'PENDING',
    };

    this.queue.push(item);
    this.queue.sort((a, b) => a.priority - b.priority);

    return true;
  }

  // ─── Process Queue ────────────────────────────────────────────
  private async processQueue(): Promise<void> {
    if (this.processing || !this.sendFn) return;
    this.processing = true;

    try {
      const now = Date.now();
      const ready = this.queue.filter(
        (item) => item.status === 'PENDING' || (item.status === 'RETRYING' && item.nextRetryAt <= now)
      );

      for (const item of ready.slice(0, 5)) { // max 5 per cycle
        try {
          item.status = 'RETRYING';
          const sent = await this.sendFn(item.text);

          if (sent) {
            item.status = 'SENT';
            this.sentToday.add(item.eventId);

            // Mark in event bus
            const bus = getEventBus();
            await bus.markDelivered(item.eventId);

            // Remove from queue after short delay
            setTimeout(() => {
              this.queue = this.queue.filter((q) => q.eventId !== item.eventId);
            }, 30_000);
          } else {
            throw new Error('Send returned false');
          }
        } catch (err: any) {
          item.retryCount++;
          item.error = err.message || 'unknown';
          const bus = getEventBus();
          await bus.markFailed(item.eventId, item.error);

          if (item.retryCount >= item.maxRetries) {
            item.status = 'FAILED';
            console.error('[TelegramQueue] FAILED after', item.maxRetries, 'retries:', item.eventId);
          } else {
            item.status = 'RETRYING';
            // Exponential backoff: 5s, 15s, 45s
            item.nextRetryAt = now + 5000 * Math.pow(3, item.retryCount);
            console.warn('[TelegramQueue] Retry', item.retryCount, '/', item.maxRetries, '—', item.eventId);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  // ─── Format + Enqueue (convenience) ──────────────────────────
  async sendEvent(event: HermesEvent): Promise<boolean> {
    const text = formatEventForTelegram(event);
    return this.enqueue(event.eventId, text, event.eventType);
  }

  // ─── Status ──────────────────────────────────────────────────
  getStatus(): {
    pending: number;
    retrying: number;
    failed: number;
    sentToday: number;
    queue: QueueItem[];
  } {
    return {
      pending: this.queue.filter((i) => i.status === 'PENDING').length,
      retrying: this.queue.filter((i) => i.status === 'RETRYING').length,
      failed: this.queue.filter((i) => i.status === 'FAILED').length,
      sentToday: this.sentToday.size,
      queue: [...this.queue],
    };
  }

  isRunning(): boolean {
    return this.started;
  }
}

// ─── Get Singleton ────────────────────────────────────────────────
export function getTelegramQueue(): TelegramQueue {
  if (!queueInstance) {
    queueInstance = new TelegramQueue();
  }
  return queueInstance;
}

// ─── Format Events for Telegram ───────────────────────────────────
function formatEventForTelegram(event: HermesEvent): string {
  const p = event.payload;
  const ts = new Date(event.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  switch (event.eventType) {
    case 'TRADE_CREATED':
      return [
        `🚀 <b>NEW PAPER TRADE</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Strike: ${p.strike || '-'} | Expiry: ${p.expiry || '-'}`,
        ``,
        `Entry: ₹${p.entry ?? '-'}`,
        `SL: ₹${p.sl ?? '-'}`,
        `TP1: ₹${p.tp1 ?? '-'} | TP2: ₹${p.tp2 ?? '-'}`,
        `Extended: ₹${p.extendedTarget ?? '-'}`,
        ``,
        `Actual RR: ${p.actualRR ?? '-'} | Net RR: ${p.netRR ?? '-'}`,
        `Quality: ${p.tradeQuality || '-'}`,
        `Score: ${p.score ?? '-'} | Grade: ${p.grade || '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TP1_HIT':
      return [
        `🎯 <b>TP1 HIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${p.entry ?? '-'} → TP1: ₹${p.tp1 ?? '-'}`,
        `Current: ₹${p.current ?? '-'}`,
        ``,
        `P&L: ${p.pnl ?? '-'} | Net: ${p.netPnL ?? '-'}`,
        `Holding: ${p.holdingTime || '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TP2_HIT':
      return [
        `🎯 <b>TP2 HIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${p.entry ?? '-'} → TP2: ₹${p.tp2 ?? '-'}`,
        `Current: ₹${p.current ?? '-'}`,
        ``,
        `P&L: ${p.pnl ?? '-'} | Net: ${p.netPnL ?? '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'SL_HIT':
      return [
        `🚨 <b>SL HIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${p.entry ?? '-'} → SL: ₹${p.sl ?? '-'}`,
        `Exit: ₹${p.exit ?? '-'}`,
        ``,
        `P&L: ${p.pnl ?? '-'} | Net: ${p.netPnL ?? '-'}`,
        `Reason: ${p.exitReason || 'INITIAL_SL'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TRAILING_SL_UPDATED':
      return [
        `🔄 <b>TRAILING SL UPDATED</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Old SL: ₹${p.oldSL ?? '-'} → New SL: ₹${p.newSL ?? '-'}`,
        `Current: ₹${p.current ?? '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'THESIS_INVALIDATED':
      return [
        `⚠️ <b>THESIS INVALIDATED</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Reason: ${p.reason || '-'}`,
        `Action: EXIT / PAPER EXIT`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TIME_EXIT':
      return [
        `⏰ <b>TIME EXIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${p.entry ?? '-'} → Exit: ₹${p.exit ?? '-'}`,
        `Holding: ${p.holdingTime || '-'}`,
        `P&L: ${p.pnl ?? '-'} | Net: ${p.netPnL ?? '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'EXPIRY_EXIT':
      return [
        `⚠️ <b>EXPIRY EXIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Expiry: ${p.expiry || '-'}`,
        `Entry: ₹${p.entry ?? '-'} → Exit: ₹${p.exit ?? '-'}`,
        `P&L: ${p.pnl ?? '-'} | Net: ${p.netPnL ?? '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TRADE_CLOSED':
      return [
        `✅ <b>TRADE CLOSED</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${p.entry ?? '-'} → Exit: ₹${p.exit ?? '-'}`,
        `P&L: ${p.pnl ?? '-'} | Net: ${p.netPnL ?? '-'}`,
        `MFE: ₹${p.mfe ?? '-'} | MAE: ₹${p.mae ?? '-'}`,
        `Exit Reason: ${p.exitReason || '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'CHALLENGE_MILESTONE':
      return [
        `🏆 <b>CHALLENGE MILESTONE</b>`,
        ``,
        `Challenge: ${p.challengeId || 'CHALLENGE_001'}`,
        `Capital: ₹${(p.currentCapital ?? 0).toLocaleString('en-IN')}`,
        `Target: ₹${(p.targetCapital ?? 0).toLocaleString('en-IN')}`,
        `Progress: ${p.progressPct ?? 0}%`,
        `P&L: ₹${(p.totalPnL ?? 0).toLocaleString('en-IN')}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'CHALLENGE_DRAWDOWN':
      return [
        `⚠️ <b>CHALLENGE DRAWDOWN ALERT</b>`,
        ``,
        `Challenge: ${p.challengeId || 'CHALLENGE_001'}`,
        `Capital: ₹${(p.currentCapital ?? 0).toLocaleString('en-IN')}`,
        `Drawdown: ${p.drawdownPct ?? 0}%`,
        `Max DD: ${p.maxDrawdownPct ?? 0}%`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'PROVIDER_FAILURE':
      return [
        `🚨 <b>DATA PROVIDER ALERT</b>`,
        ``,
        `Provider: ${p.provider || '-'}`,
        `Status: ${p.error || 'UNKNOWN'}`,
        `Fallback: ${p.fallback || 'none'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'MARKET_REGIME_CHANGE':
      return [
        `🔄 <b>REGIME CHANGE — ${event.symbol || '-'}</b>`,
        ``,
        `Previous: ${p.previous || '-'}`,
        `Current: ${p.current || '-'}`,
        `Confirmed by: ${p.confirmedBy || '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'DATA_STALE':
      return [
        `⚠️ <b>DATA STALE</b>`,
        ``,
        `Market: ${event.symbol || '-'}`,
        `Source: ${p.source || '-'}`,
        `Last Update: ${p.lastUpdate || '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    default:
      return `📢 <b>${event.eventType}</b>\n\n${JSON.stringify(p, null, 2)}\n\n⏰ ${ts}`;
  }
}
