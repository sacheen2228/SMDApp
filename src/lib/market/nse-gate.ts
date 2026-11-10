// Shared NSE access gate.
//
// WHY: NSE blocks bursts with HTTP 403. Before this gate every module had its
// own cookie jar and retry loop, so one failing symbol was retried on every
// poll (the app logged 6,391 `GetQuoteApi 403` in a single session) and each
// retry burned a full timeout before the caller could fall back.
//
// WHAT it provides (one instance per process, shared by every route):
//   • one global rate limit  — NSE is never hit faster than minIntervalMs
//   • one concurrency cap    — at most maxConcurrent upstream calls in flight
//   • single flight per key  — identical concurrent requests share one call
//   • a 403 circuit          — after a streak, NSE is skipped for a cooldown
//   • a per-key negative cache — a failing key is not retried every poll
//   • a last-good snapshot   — the previous valid answer stays available
//
// HONESTY RULES:
//   • A blocked/failed call THROWS. It never returns cached data silently.
//   • `getSnapshot()` is explicit: the caller decides to serve it and must
//     label it stale (source CACHE / freshness STALE) — never "live".
//   • NSE has no token auth: a 403 is a block, never a session expiry.

import { providerHealth } from "@/lib/provider-health";

export interface NseGateConfig {
  /** Minimum spacing between two upstream NSE requests (ms). */
  minIntervalMs: number;
  /** Maximum number of upstream NSE requests in flight at once. */
  maxConcurrent: number;
  /** Consecutive 403s that open the global circuit. */
  blockThreshold: number;
  /** Base cooldown when the circuit opens (ms). Doubles per extra strike. */
  blockCooldownMs: number;
  /** Cooldown for one failing key (ms) — the negative cache. */
  keyCooldownMs: number;
  /** How long a last-good snapshot stays readable (ms). */
  snapshotTtlMs: number;
  /** Maximum number of retained snapshots. */
  maxSnapshots: number;
  /** Clock (injectable for tests). */
  now: () => number;
  /** Sleep (injectable for tests). */
  sleep: (ms: number) => Promise<void>;
}

const DEFAULTS: NseGateConfig = {
  minIntervalMs: 100,
  maxConcurrent: 8,
  blockThreshold: 3,
  blockCooldownMs: 60_000,
  keyCooldownMs: 300_000,
  snapshotTtlMs: 30 * 60_000,
  maxSnapshots: 250,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** HTTP 403 from NSE — a block/rate-limit, never an auth failure. */
export function isNseForbidden(err: any): boolean {
  if (!err) return false;
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
  if (status === 403) return true;
  const msg = String(err?.message ?? err).toLowerCase();
  return /\b403\b/.test(msg) || msg.includes("forbidden");
}

/**
 * A PROVIDER failure (block / network / server) — not a business outcome.
 *
 * Business errors (unknown symbol, expired contract, bad request) must NOT
 * poison the key: the option-chain route deliberately retries a failed
 * contract with another type, and a suppressed key would kill that fallback.
 */
export function isNseProviderFailure(err: any): boolean {
  if (!err) return false;
  if (isNseForbidden(err)) return true;
  const msg = String(err?.message ?? err).toLowerCase();
  if (/timeout|timed out|econn|enotfound|fetch failed|socket hang|network|unavailable|bad gateway|service unavailable|gateway timeout/.test(msg)) {
    return true;
  }
  if (/\b50[0-9]\b|\b502\b|\b503\b|\b504\b/.test(msg)) return true;
  return false;
}

export class NseBlockedError extends Error {
  readonly code = "NSE_BLOCKED";
  constructor(readonly retryAfterMs: number) {
    super(`NSE blocked after repeated 403 — retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s`);
    this.name = "NseBlockedError";
  }
}

export class NseSuppressedError extends Error {
  readonly code = "NSE_KEY_SUPPRESSED";
  constructor(readonly retryAfterMs: number, readonly reason: string) {
    super(`NSE request suppressed after an earlier failure — retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s (${reason})`);
    this.name = "NseSuppressedError";
  }
}

export interface NseGateState {
  blocked: boolean;
  blockedUntilMs: number;
  consecutive403: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  deduped: number;
  suppressed: number;
  activeRequests: number;
  snapshotCount: number;
  last403AtMs: number;
  lastSuccessAtMs: number;
}

interface Snapshot {
  data: any;
  fetchedAt: number;
}

export class NseGate {
  private readonly cfg: NseGateConfig;
  private inflight = new Map<string, Promise<any>>();
  private keyFailures = new Map<string, { until: number; reason: string }>();
  private keyStrikes = new Map<string, { count: number; until: number }>();
  private snapshots = new Map<string, Snapshot>();
  private nextSlotAt = 0;
  private active = 0;
  private waiters: Array<() => void> = [];
  private consecutive403 = 0;
  private blockedUntil = 0;
  private last403At = 0;
  private lastSuccessAt = 0;
  private totalRequests = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private deduped = 0;
  private suppressed = 0;

  constructor(config: Partial<NseGateConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Run an upstream NSE call under the gate. Identical keys share one call. */
  call<T>(key: string, fn: () => Promise<T>, opts: { snapshot?: boolean } = {}): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.deduped++;
      return existing as Promise<T>;
    }
    const promise = this.execute(key, fn, opts.snapshot !== false);
    this.inflight.set(key, promise);
    promise.then(
      () => this.inflight.delete(key),
      () => this.inflight.delete(key),
    );
    return promise;
  }

  /** Fetch JSON from an NSE URL under the gate. */
  async fetchJson<T>(
    url: string,
    opts: {
      key?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const key = opts.key ?? url;
    return this.call<T>(key, async () => {
      const res = await fetch(url, {
        headers: opts.headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      });
      if (!res.ok) {
        const err: any = new Error(`NSE ${url} ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    });
  }

  /** The last valid answer for a key (explicit — the caller must label it stale). */
  getSnapshot<T>(key: string): { data: T; fetchedAt: number; ageMs: number } | null {
    const snap = this.snapshots.get(key);
    if (!snap) return null;
    const ageMs = this.cfg.now() - snap.fetchedAt;
    if (ageMs > this.cfg.snapshotTtlMs) {
      this.snapshots.delete(key);
      return null;
    }
    return { data: snap.data as T, fetchedAt: snap.fetchedAt, ageMs };
  }

  getState(): NseGateState {
    const now = this.cfg.now();
    return {
      blocked: this.blockedUntil > now,
      blockedUntilMs: this.blockedUntil,
      consecutive403: this.consecutive403,
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      deduped: this.deduped,
      suppressed: this.suppressed,
      activeRequests: this.active,
      snapshotCount: this.snapshots.size,
      last403AtMs: this.last403At,
      lastSuccessAtMs: this.lastSuccessAt,
    };
  }

  reset(): void {
    this.inflight.clear();
    this.keyFailures.clear();
    this.keyStrikes.clear();
    this.snapshots.clear();
    this.nextSlotAt = 0;
    this.active = 0;
    this.waiters = [];
    this.consecutive403 = 0;
    this.blockedUntil = 0;
    this.last403At = 0;
    this.lastSuccessAt = 0;
    this.totalRequests = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.deduped = 0;
    this.suppressed = 0;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async execute<T>(key: string, fn: () => Promise<T>, keepSnapshot: boolean): Promise<T> {
    const now = this.cfg.now();
    if (this.blockedUntil > now) {
      this.suppressed++;
      throw new NseBlockedError(this.blockedUntil - now);
    }
    const keyFailure = this.keyFailures.get(key);
    if (keyFailure && keyFailure.until > now) {
      this.suppressed++;
      throw new NseSuppressedError(keyFailure.until - now, keyFailure.reason);
    }
    const strikes = this.keyStrikes.get(key);
    if (strikes && strikes.until > now) {
      this.suppressed++;
      throw new NseSuppressedError(strikes.until - now, "403");
    }

    this.totalRequests++;
    await this.acquire();
    const startedAt = this.cfg.now();
    try {
      const data = await fn();
      this.onSuccess(key, data, startedAt, keepSnapshot);
      return data;
    } catch (err) {
      this.onFailure(key, err);
      throw err;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.cfg.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    const now = this.cfg.now();
    if (now < this.nextSlotAt) {
      await this.cfg.sleep(this.nextSlotAt - now);
    }
    this.nextSlotAt = this.cfg.now() + this.cfg.minIntervalMs;
  }

  private release(): void {
    this.active--;
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  private onSuccess(key: string, data: any, startedAt: number, keepSnapshot = true): void {
    this.consecutive403 = 0;
    this.blockedUntil = 0;
    this.keyFailures.delete(key);
    this.keyStrikes.delete(key);
    this.lastSuccessAt = this.cfg.now();
    this.totalSuccesses++;
    if (keepSnapshot) {
      this.snapshots.set(key, { data, fetchedAt: this.cfg.now() });
      if (this.snapshots.size > this.cfg.maxSnapshots) {
        const oldest = this.snapshots.keys().next().value;
        if (oldest !== undefined) this.snapshots.delete(oldest);
      }
    }
    // A success proves NSE answers again — close the shared provider circuit.
    try {
      providerHealth.recordSuccess("nse", Math.max(0, this.cfg.now() - startedAt));
    } catch { /* health reporting must never break a fetch */ }
  }

  private onFailure(key: string, err: any): void {
    this.totalFailures++;
    const forbidden = isNseForbidden(err);
    if (forbidden) {
      this.consecutive403++;
      this.last403At = this.cfg.now();
      if (this.consecutive403 >= this.cfg.blockThreshold) {
        const over = Math.min(this.consecutive403 - this.cfg.blockThreshold, 4);
        this.blockedUntil = this.cfg.now() + this.cfg.blockCooldownMs * Math.pow(2, over);
      }
      // A 403 is a block, not an auth failure — record it as rate limiting so
      // the shared circuit reports "rate_limited", never "session expired".
      try {
        providerHealth.recordFailure("nse", "RATE_LIMIT", String(err?.message ?? err).slice(0, 200));
      } catch { /* ignore */ }
      // A key that keeps 403-ing is suppressed on its own after the same
      // threshold — one poisoned symbol must not be retried on every poll.
      const strikes = (this.keyStrikes.get(key)?.count ?? 0) + 1;
      this.keyStrikes.set(key, {
        count: strikes,
        until: strikes >= this.cfg.blockThreshold ? this.cfg.now() + this.cfg.blockCooldownMs : 0,
      });
      return;
    }
    // Other failures are per-key: suppress this key, but leave the global
    // circuit alone (one bad symbol must not disable NSE for everyone).
    // BUSINESS errors are not provider failures — they must stay retryable.
    if (!isNseProviderFailure(err)) return;
    this.keyFailures.set(key, { until: this.cfg.now() + this.cfg.keyCooldownMs, reason: "error" });
  }
}

// One instance per process — every route shares the same limits and circuits.
const g = globalThis as any;
export const nseGate: NseGate = g.__SMD_NSE_GATE__ ?? (g.__SMD_NSE_GATE__ = new NseGate());
