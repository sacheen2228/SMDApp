// Telegram Queue — unified delivery with dedup, retry, exponential backoff
// Wraps existing telegram.ts sender. Does NOT replace it.
// Existing senders keep working. New events route through this queue.
// Never sends duplicate alerts after restart.

import { getEventBus, type HermesEvent, type HermesEventType } from './event-bus';
import { isTelegramSendWindow, msUntilTelegramSendWindow } from '../marketHours';
// The plan geometry (which way the trade pays out) comes from the SAME source
// the two live monitors use — the option letter lies, the levels do not.
import { planSide } from '../activeTradeTracker';

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

    // Restore dedup state from event bus (restart recovery).
    // Wrapped in try/catch so a bus failure never prevents the timer from
    // being created — the queue must always process.
    try {
      const bus = getEventBus();
      const recent = await bus.getRecentEvents(200);
      for (const evt of recent) {
        if (evt.delivered) {
          this.sentToday.add(evt.eventId);
        }
      }
    } catch (err: any) {
      console.warn(`[TelegramQueue] Failed to restore dedup state from event bus: ${err?.message || String(err)}`);
    }

    // Process queue every 3 seconds — always created, even if bus restore fails.
    this.processInterval = setInterval(() => this.processQueue().catch((err: any) => {
      console.error(`[TelegramQueue] processQueue cycle error: ${err?.message || String(err)}`);
    }), 3000);

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
      // Outside the send window: HOLD items as PENDING without burning retries.
      // Previously recovery events re-queued at 08:39 burned 3 retries in ~65s
      // and FAILED permanently before 09:10 ever opened.
      if (!isTelegramSendWindow()) {
        const waitMs = msUntilTelegramSendWindow();
        for (const item of this.queue) {
          if (item.status === 'RETRYING' || item.status === 'PENDING') {
            item.status = 'PENDING';
            item.nextRetryAt = Date.now() + Math.max(waitMs, 30_000);
          }
        }
        return;
      }

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

            // Mark in event bus — bookkeeping failure must NEVER send the
            // item into the retry path (that causes duplicate messages).
            try {
              const bus = getEventBus();
              await bus.markDelivered(item.eventId);
            } catch (err: any) {
              console.warn(`[TelegramQueue] markDelivered failed for ${item.eventId}: ${err?.message || String(err)}`);
            }

            // Remove from queue after short delay
            setTimeout(() => {
              this.queue = this.queue.filter((q) => q.eventId !== item.eventId);
            }, 30_000);
          } else {
            // Distinguish "outside window / suppressed" from real API failure:
            // do not count suppressed sends against maxRetries.
            if (!isTelegramSendWindow()) {
              item.status = 'PENDING';
              item.nextRetryAt = Date.now() + Math.max(msUntilTelegramSendWindow(), 30_000);
              continue;
            }
            throw new Error('Send returned false');
          }
        } catch (err: any) {
          item.retryCount++;
          item.error = err.message || 'unknown';
          // Wrap markFailed in try/catch so it cannot abort the rest of the cycle.
          try {
            const bus = getEventBus();
            await bus.markFailed(item.eventId, item.error);
          } catch (err2: any) {
            console.warn(`[TelegramQueue] markFailed failed for ${item.eventId}: ${err2?.message || String(err2)}`);
          }

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
/** Prices are tick-rounded for display (5.100000000000001 → 5.10).
 *  A MISSING value is an em dash — never a bare "-" that would read as "₹-". */
function fmtPx(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Money with the sign ALWAYS in front of the symbol: -₹12.50 / +₹12.50.
 *  "-" (no value) when the number is missing — never a bare "₹-". */
function fmtMoney(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const r = Math.round(n * 100) / 100;
  return `${r < 0 ? "-₹" : "+₹"}${Math.abs(r).toFixed(2)}`;
}

/** The number, or null when it is not a usable number. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is the plan MIRRORED (a bearish plan: the stop sits ABOVE the entry and the
 * targets BELOW it)?  The option letter lies (a bought PE has its stop BELOW
 * the entry) — the GEOMETRY does not, and it is the same rule the two live
 * monitors use (planSide in activeTradeTracker).  A mirrored plan stops when
 * the price RISES to the stop, so its exit is the HIGHER of trigger and stop.
 */
function isMirroredPlan(p: any, entry: number | null, sl: number | null): boolean {
  if (entry != null && sl != null && entry > 0 && sl > 0) return sl > entry;
  // No usable levels → ask the shared helper (it reads the target side first,
  // then the stop, then what the event declares).
  const side = planSide({ entry: entry ?? undefined, sl: sl ?? undefined, tp1: numOrNull(p?.tp1) ?? undefined, side: p?.direction });
  if (side === "SHORT") return true;
  const dir = String(p?.direction || "").toUpperCase();
  return dir.includes("PE") || dir.includes("PUT");
}
/**
 * The exit price of a stop: the STOP LEVEL, or worse when the price gapped
 * through it.  Never the entry — "SL HIT … Exit: ₹41.05" (the entry) was the
 * bug this replaces.
 */
function slExitPrice(p: any): number | null {
  const entry = numOrNull(p?.entry);
  const sl = numOrNull(p?.sl);
  let exit = numOrNull(p?.exit);
  if (exit == null) exit = sl;
  if (exit != null && sl != null && sl > 0) {
    exit = isMirroredPlan(p, entry, sl) ? Math.max(exit, sl) : Math.min(exit, sl);
  }
  return exit;
}

/**
 * The % move on the premium (per unit) for an event payload — signed by the
 * plan geometry.  Returns null when it cannot be computed honestly.
 */
function pnlPctFor(p: any, price: number | null): number | null {
  const entry = numOrNull(p?.entry);
  if (entry == null || entry <= 0 || price == null) return null;
  const move = price - entry;
  return (isMirroredPlan(p, entry, numOrNull(p?.sl)) ? -move : move) / entry * 100;
}

/** "P&L: -₹110.5 (20.0%)" — signed money + the per-unit % of the premium. */
function pnlLine(p: any, price: number | null): string {
  const money = fmtMoney(p?.pnl);
  const pct = pnlPctFor(p, price);
  return `P&L: ${money}${pct != null ? ` (${Math.abs(pct).toFixed(1)}%)` : ""}`;
}

/** "Net: -₹12.50" — always present, explicitly absent when there is no net. */
function netLine(p: any): string {
  return `Net: ${p?.netPnL !== null && p?.netPnL !== undefined ? fmtMoney(p.netPnL) : "-"}`;
}

export function getTelegramQueue(): TelegramQueue {
  if (!queueInstance) {
    queueInstance = new TelegramQueue();
  }
  return queueInstance;
}

// ─── Format Events for Telegram ───────────────────────────────────
export function formatEventForTelegram(event: HermesEvent): string {
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
        `Entry: ₹${fmtPx(p.entry)}`,
        `SL: ₹${fmtPx(p.sl)}`,
        `TP1: ₹${fmtPx(p.tp1)} | TP2: ₹${fmtPx(p.tp2)}`,
        `Extended: ₹${fmtPx(p.extendedTarget)}`,
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
        `Entry: ₹${fmtPx(p.entry)} → TP1: ₹${fmtPx(p.tp1)}`,
        `SL: ₹${fmtPx(p.sl)}`,
        `Current: ₹${fmtPx(p.current)}`,
        ``,
        `${pnlLine(p, numOrNull(p.current))} | ${netLine(p)}`,
        `Holding: ${p.holdingTime || '-'}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TP2_HIT':
      return [
        `🎯 <b>TP2 HIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${fmtPx(p.entry)} → TP2: ₹${fmtPx(p.tp2)}`,
        `SL: ₹${fmtPx(p.sl)}`,
        `TP1: ₹${fmtPx(p.tp1)}`,
        `Current: ₹${fmtPx(p.current)}`,
        ``,
        `${pnlLine(p, numOrNull(p.current))} | ${netLine(p)}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TP3_HIT':
      return [
        `🎯 <b>TP3 HIT — FULL EXIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${fmtPx(p.entry)} → TP3: ₹${fmtPx(p.tp3)}`,
        `SL: ₹${fmtPx(p.sl)}`,
        `TP1: ₹${fmtPx(p.tp1)} | TP2: ₹${fmtPx(p.tp2)}`,
        `Current: ₹${fmtPx(p.current)}`,
        ``,
        `${pnlLine(p, numOrNull(p.current))} | ${netLine(p)}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'SL_HIT': {
      const exit = slExitPrice(p);
      return [
        `🚨 <b>SL HIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${fmtPx(p.entry)} → SL: ₹${fmtPx(p.sl)}`,
        `Exit: ₹${fmtPx(exit)}`,
        p.tp1 || p.tp2 || p.tp3 ? `TP1: ₹${fmtPx(p.tp1)}${p.tp2 ? ` | TP2: ₹${fmtPx(p.tp2)}` : ''}${p.tp3 ? ` | TP3: ₹${fmtPx(p.tp3)}` : ''}` : '',
        ``,
        `${pnlLine(p, exit)} | ${netLine(p)}`,
        `Reason: ${p.exitReason || 'INITIAL_SL'}`,
        ``,
        `⏰ ${ts}`,
      ].filter(Boolean).join('\n');
    }

    case 'TRAILING_SL_UPDATED':
      return [
        `🔄 <b>TRAILING SL UPDATED</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Old SL: ₹${fmtPx(p.oldSL)} → New SL: ₹${fmtPx(p.newSL)}`,
        `Current: ₹${fmtPx(p.current)}`,
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
        `Entry: ₹${fmtPx(p.entry)} → Exit: ₹${fmtPx(p.exit)}`,
        `Holding: ${p.holdingTime || '-'}`,
        `${pnlLine(p, numOrNull(p.exit))} | ${netLine(p)}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'EXPIRY_EXIT':
      return [
        `⚠️ <b>EXPIRY EXIT</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Expiry: ${p.expiry || '-'}`,
        `Entry: ₹${fmtPx(p.entry)} → Exit: ₹${fmtPx(p.exit)}`,
        `${pnlLine(p, numOrNull(p.exit))} | ${netLine(p)}`,
        ``,
        `⏰ ${ts}`,
      ].join('\n');

    case 'TRADE_CLOSED':
      return [
        `✅ <b>TRADE CLOSED</b>`,
        ``,
        `<b>${event.symbol}</b> ${p.direction || ''}`,
        `Entry: ₹${fmtPx(p.entry)} → Exit: ₹${fmtPx(p.exit)}`,
        `${pnlLine(p, numOrNull(p.exit))} | ${netLine(p)}`,
        `MFE: ₹${fmtPx(p.mfe)} | MAE: ₹${fmtPx(p.mae)}`,
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
