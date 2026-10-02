// Voice Queue — priority, dedup, single-concurrency, timeout, cancellation, recovery.
// Voice must NEVER block trading (spec §19): synthesis runs here, asynchronously.

import type { VoiceEvent, VoiceEventType } from "./voiceFormatter";

export type VoicePriority = 1 | 2 | 3; // HIGH | MEDIUM | LOW

export interface VoiceJob {
  key: string;
  priority: VoicePriority;
  text: string;
  eventType: VoiceEventType;
  createdAt: number;
  deliver?: boolean; // deliver to Telegram after synthesis
}

export interface VoiceQueueOptions {
  synthesize: (job: VoiceJob) => Promise<{ audioPath?: string } | void>;
  timeoutMs?: number;    // per-job synth timeout (spec §19: skip slow voice)
  maxPending?: number;   // queue cap — overflow is dropped, not blocking
  onSynthesized?: (job: VoiceJob, result: { audioPath?: string }) => void;
  onFailed?: (job: VoiceJob, error: Error) => void;
}

// spec §16 priority table (unlisted events default MEDIUM; SYSTEM_ERROR HIGH)
const PRIORITY: Record<VoiceEventType, VoicePriority> = {
  SL_HIT: 1,
  TRADE_CONFIRMED: 1,
  ENTRY: 1,
  TP_HIT: 1,
  TRADE_SIGNAL: 1,
  SYSTEM_ERROR: 1,
  NEWS_ALERT: 2,
  MARKET_BRIEFING: 2,
  MARKET_OPEN: 2,
  MARKET_CLOSE: 2,
  STRONG_BULLISH: 2,
  STRONG_BEARISH: 2,
  VOLATILITY_ALERT: 2,
  SYSTEM_WARNING: 2,
  NO_TRADE: 3,
  WAIT: 3,
  SYSTEM_READY: 3,
  SYSTEM_START: 3,
};

export function voicePriority(type: VoiceEventType): VoicePriority {
  return PRIORITY[type] ?? 2;
}

/**
 * Deterministic dedup key (spec §17) — survives React re-renders, polling,
 * websocket reconnects, repeated scanner cycles.
 */
export function buildDedupKey(ev: VoiceEvent): string {
  const bucket = (ms: number, size: number) => Math.floor(ms / size);
  switch (ev.eventType) {
    case "TP_HIT":
      return `TP_HIT:${ev.tradeId || ev.symbol || "unknown"}:${ev.targetNumber ?? 1}`;
    case "SL_HIT":
      return `SL_HIT:${ev.tradeId || ev.symbol || "unknown"}`;
    case "TRADE_SIGNAL":
    case "TRADE_CONFIRMED":
    case "ENTRY": {
      const ts = bucket(ev.timestamp || 0, 5 * 60_000); // 5-min re-emit window
      return `${ev.eventType}:${ev.symbol || "?"}:${ev.strike ?? "-"}:${ev.optionType || ev.instrument || "-"}:${ts}`;
    }
    default: {
      const ts = bucket(ev.timestamp || 0, 5 * 60_000);
      return `${ev.eventType}:${ev.symbol || "global"}:${ts}`;
    }
  }
}

/** Dedup TTL per event class — trade outcomes won't re-speak same day, system noise expires. */
export function dedupTtlMs(type: VoiceEventType): number {
  switch (type) {
    case "SL_HIT":
    case "TP_HIT":
    case "TRADE_SIGNAL":
    case "TRADE_CONFIRMED":
    case "ENTRY":
      return 24 * 3_600_000;
    case "SYSTEM_START":
    case "SYSTEM_READY":
      return 4 * 3_600_000;
    default:
      return 15 * 60_000;
  }
}

export class VoiceQueue {
  private pending: VoiceJob[] = [];
  private keys = new Map<string, number>(); // key → expiry
  private running = false;
  private counters = { completed: 0, failed: 0, deduped: 0, dropped: 0, cancelled: 0 };
  private idleWaiters: Array<() => void> = [];
  private readonly synthesize: (job: VoiceJob) => Promise<{ audioPath?: string } | void>;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly onSynthesized?: (job: VoiceJob, result: { audioPath?: string }) => void;
  private readonly onFailed?: (job: VoiceJob, error: Error) => void;

  constructor(opts: VoiceQueueOptions) {
    this.synthesize = opts.synthesize;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxPending = opts.maxPending ?? 20;
    this.onSynthesized = opts.onSynthesized;
    this.onFailed = opts.onFailed;
  }

  enqueue(job: VoiceJob): "queued" | "deduped" | "dropped" {
    const now = Date.now();
    // purge expired keys
    for (const [k, exp] of this.keys) if (exp <= now) this.keys.delete(k);
    // dedup
    const exp = this.keys.get(job.key);
    if (exp && exp > now) {
      this.counters.deduped++;
      return "deduped";
    }
    this.keys.set(job.key, now + dedupTtlMs(job.eventType));
    // capacity — drop incoming (voice may be skipped, trading never waits)
    if (this.pending.length >= this.maxPending) {
      this.counters.dropped++;
      return "dropped";
    }
    // priority insert (stable: same priority keeps arrival order)
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].priority > job.priority) i--;
    this.pending.splice(i, 0, job);
    // start on microtask so a synchronous burst of enqueues is fully ordered first
    if (!this.running) void Promise.resolve().then(() => this.loop());
    return "queued";
  }

  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        try {
          const result = (await this.runOne(job)) ?? {};
          this.counters.completed++;
          try { this.onSynthesized?.(job, result); } catch {}
        } catch (err: any) {
          this.counters.failed++; // error recovery: queue continues
          try { this.onFailed?.(job, err instanceof Error ? err : new Error(String(err))); } catch {}
        }
      }
    } finally {
      this.running = false;
      if (this.pending.length > 0) void this.loop();
      else this.releaseIdle();
    }
  }

  private async runOne(job: VoiceJob): Promise<{ audioPath?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.synthesize(job),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`voice synth timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
      return result ?? {};
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Resolves when nothing pending/running (tests + status). */
  async drain(): Promise<void> {
    if (!this.running && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  cancelPending(): number {
    const n = this.pending.length;
    this.pending = [];
    this.counters.cancelled += n;
    if (!this.running) this.releaseIdle();
    return n;
  }

  status() {
    return { pending: this.pending.length, running: this.running, ...this.counters };
  }
}
