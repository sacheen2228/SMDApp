// Phase 12 — outcome attachment (two-phase).
// PREDICTIONS are written first (PENDING_OUTCOME); outcomes attach later from
// REAL candles only. Never fabricates prices. Safe to re-run (idempotent).

import type { ShadowSession, ShadowOutcomes, OutcomeStatus } from "./types";
import { MAX_OUTCOME_ATTEMPTS } from "./types";
import {
  getShadowSession, setOutcomeStatus, listPendingOutcomes, getStudyDay,
} from "./storage";
import { computeOutcomes, type CandleBar } from "./outcomes";
import { isTradingDay, istMinutes, istDateISO } from "./calendar";

export interface AttachOutcomeOptions {
  tradeDate: string;
  symbol: string;
  /** Real candles — required to record. Missing → unavailable after max attempts. */
  candles?: CandleBar[];
  candleIntervalMin?: number;
  prevClose?: number | null;
  /** Force mark UNAVAILABLE (holiday / known no-data day after deadline). */
  forceUnavailable?: boolean;
  now?: Date;
  /** Max attempts before OUTCOME_UNAVAILABLE (default MAX_OUTCOME_ATTEMPTS). */
  maxAttempts?: number;
}

export interface AttachOutcomeResult {
  tradeDate: string;
  symbol: string;
  status: OutcomeStatus;
  attempts: number;
  outcomes: ShadowOutcomes | null;
  message: string;
}

/**
 * Attach outcomes for one shadow session.
 *
 * Status rules:
 * - candles present + labels computed → OUTCOME_RECORDED
 * - no candles yet, attempts < max, still same trading day → stay PENDING (increment attempts only on explicit call after deadline)
 * - no candles after max attempts OR forceUnavailable OR non-trading day after EOD → OUTCOME_UNAVAILABLE
 *
 * Look-ahead: only reads candles; never uses future data as features.
 */
export function attachOutcomesForSession(opts: AttachOutcomeOptions): AttachOutcomeResult {
  const { tradeDate, symbol } = opts;
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? MAX_OUTCOME_ATTEMPTS;
  const session = getShadowSession(tradeDate, symbol);

  if (!session) {
    return {
      tradeDate, symbol, status: "PENDING_OUTCOME", attempts: 0, outcomes: null,
      message: "no_shadow_session",
    };
  }

  const attempts = (session.outcomeAttempts ?? 0) + 1;
  const trading = isTradingDay(tradeDate);
  const day = getStudyDay(tradeDate, symbol);
  const prevClose =
    opts.prevClose ?? day?.cm?.previousClose ?? null;

  // Already final — idempotent no-op
  if (session.outcomeStatus === "OUTCOME_RECORDED") {
    return {
      tradeDate, symbol, status: "OUTCOME_RECORDED",
      attempts: session.outcomeAttempts ?? attempts,
      outcomes: session.outcomes,
      message: "already_recorded",
    };
  }
  if (session.outcomeStatus === "OUTCOME_UNAVAILABLE" && !opts.forceUnavailable) {
    // allow re-try if new candles appear and not forced
    if (!opts.candles?.length) {
      return {
        tradeDate, symbol, status: "OUTCOME_UNAVAILABLE",
        attempts: session.outcomeAttempts ?? attempts,
        outcomes: session.outcomes,
        message: "already_unavailable",
      };
    }
  }

  // Force unavailable only when there are no real prints to attach
  // (holiday after deadline, or explicit — never discard available candles)
  if ((opts.forceUnavailable || (!trading && istDateISO(now) > tradeDate)) && !(opts.candles?.length)) {
    setOutcomeStatus(tradeDate, symbol, "OUTCOME_UNAVAILABLE", {
      attempts,
      note: opts.forceUnavailable ? "forced_unavailable" : "non_trading_day",
    });
    return {
      tradeDate, symbol, status: "OUTCOME_UNAVAILABLE", attempts, outcomes: session.outcomes,
      message: "unavailable",
    };
  }

  const candles = opts.candles ?? [];
  if (candles.length > 0) {
    const outcomes = computeOutcomes({
      candles,
      intervalMin: opts.candleIntervalMin ?? 5,
      prevClose,
    });
    // Real prints → recorded (even if some horizons null — notes explain gaps)
    setOutcomeStatus(tradeDate, symbol, "OUTCOME_RECORDED", {
      outcomes,
      attempts,
      note: outcomes.notes.length ? `outcomes:${outcomes.notes.join(",")}` : "outcomes_attached",
    });
    return {
      tradeDate, symbol, status: "OUTCOME_RECORDED", attempts, outcomes,
      message: "recorded",
    };
  }

  // No candles yet
  const afterEod = istMinutes(now) >= 15 * 60 + 45; // after 15:45 IST
  const sameDay = istDateISO(now) === tradeDate;
  const pastDay = tradeDate < istDateISO(now);

  // Past session without prints → unavailable (idempotent)
  if (pastDay || (opts.forceUnavailable && afterEod)) {
    setOutcomeStatus(tradeDate, symbol, "OUTCOME_UNAVAILABLE", {
      attempts,
      note: pastDay ? "no_candles_after_session" : "forced_unavailable",
    });
    return {
      tradeDate, symbol, status: "OUTCOME_UNAVAILABLE", attempts, outcomes: null,
      message: "no_candles",
    };
  }

  if (attempts >= maxAttempts && afterEod && sameDay) {
    setOutcomeStatus(tradeDate, symbol, "OUTCOME_UNAVAILABLE", {
      attempts,
      note: `max_attempts_${maxAttempts}`,
    });
    return {
      tradeDate, symbol, status: "OUTCOME_UNAVAILABLE", attempts, outcomes: null,
      message: "max_attempts",
    };
  }

  // Still pending — record attempt count only (keep PENDING)
  setOutcomeStatus(tradeDate, symbol, "PENDING_OUTCOME", {
    attempts,
    note: "awaiting_candles",
  });
  return {
    tradeDate, symbol, status: "PENDING_OUTCOME", attempts, outcomes: null,
    message: "pending",
  };
}

/**
 * Batch attach for all PENDING sessions (cron entry point).
 * Idempotent: skips already RECORDED; only marks UNAVAILABLE when deadline rules fire.
 */
export function attachPendingOutcomes(opts: {
  candlesBySymbol?: Map<string, CandleBar[]> | Record<string, CandleBar[]>;
  tradeDate?: string;
  candleIntervalMin?: number;
  now?: Date;
  maxAttempts?: number;
} = {}): AttachOutcomeResult[] {
  const tradeDate = opts.tradeDate || istDateISO(opts.now);
  const pending = listPendingOutcomes({ limit: 500 }).filter((s) => s.tradeDate === tradeDate);
  const map = opts.candlesBySymbol instanceof Map
    ? opts.candlesBySymbol
    : new Map(Object.entries(opts.candlesBySymbol || {}));

  const results: AttachOutcomeResult[] = [];
  for (const s of pending) {
    results.push(
      attachOutcomesForSession({
        tradeDate: s.tradeDate,
        symbol: s.symbol,
        candles: map.get(s.symbol),
        candleIntervalMin: opts.candleIntervalMin,
        now: opts.now,
        maxAttempts: opts.maxAttempts,
      }),
    );
  }
  return results;
}

/**
 * What interval buckets we can honestly serve for an outcome run.
 * >30m (i.e. daily) is refused: there is no intraday daily source here and
 * substituting a different timeframe would fabricate the label.
 */
export function outcomeCandlePlan(intervalMin?: number): { bucketMin: number } | null {
  const n = Number(intervalMin);
  const bucketMin = Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
  if (bucketMin > 30) return null;
  return { bucketMin };
}

/** 09:15 IST of a "YYYY-MM-DD" trade date, as epoch ms (timezone-independent math). */
export function sessionAnchorMs(tradeDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(tradeDate || "").trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 9, 15, 0) - (5 * 3600 + 30 * 60) * 1000;
}

/** Bar time → epoch ms. ISO/offset strings are absolute; naive ones are IST. */
export function parseBarTimeMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  const s = String(raw ?? "").trim().replace(" ", "T");
  if (!s) return null;
  const withOffset = /([Zz]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}+05:30`;
  const ms = Date.parse(withOffset);
  return Number.isFinite(ms) ? ms : null;
}

/** Rows (recorder `timestamp` ISO or Breeze `time` naive-IST) → numeric-time CandleBars. */
export function toCandleBars(rows: readonly any[] | null | undefined): CandleBar[] {
  const out: CandleBar[] = [];
  for (const r of rows || []) {
    if (!r || typeof r !== "object") continue;
    const t = parseBarTimeMs(r.time ?? r.timestamp ?? r.date);
    const open = Number(r.open), high = Number(r.high), low = Number(r.low), close = Number(r.close);
    if (t == null || ![open, high, low, close].every(Number.isFinite)) continue;
    const volume = Number(r.volume ?? 0);
    out.push({ time: t, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Aggregate finer bars into `bucketMin` buckets anchored at the session open
 * (09:15 IST). Bucket start = anchor + k*bucket, so `closeAtMinutes` in
 * outcomes.ts (minutes after open) lines up and never reads past the target.
 */
export function aggregateBars(bars: readonly CandleBar[], bucketMin: number, anchorMs: number): CandleBar[] {
  const bucketMs = Math.max(1, Math.floor(bucketMin)) * 60_000;
  const map = new Map<number, CandleBar>();
  for (const b of bars) {
    if (!Number.isFinite(b.time) || b.time < anchorMs) continue;
    const start = anchorMs + Math.floor((b.time - anchorMs) / bucketMs) * bucketMs;
    const ex = map.get(start);
    if (!ex) {
      map.set(start, { ...b, time: start });
      continue;
    }
    ex.high = Math.max(ex.high, b.high);
    ex.low = Math.min(ex.low, b.low);
    ex.close = b.close;
    ex.volume = (ex.volume ?? 0) + (b.volume ?? 0);
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/**
 * Real candles for an outcome evaluation, WITHOUT the live candle chain
 * (its failures mutate session-health/recorder state — forbidden here).
 *
 * 1. recorded session bars (recorder sidecar DB, 1m) — covers recorded days
 * 2. Breeze intraday history (5m) — covers days the recorder missed
 * Then aggregate up to the requested bucket. Never substitutes a timeframe.
 */
export async function fetchCandlesForOutcome(
  symbol: string,
  tradeDate: string,
  intervalMin = 5,
): Promise<CandleBar[] | null> {
  const plan = outcomeCandlePlan(intervalMin);
  if (!plan) return null;
  try {
    const anchorMs = sessionAnchorMs(tradeDate);
    if (!Number.isFinite(anchorMs)) return null;

    let sourceMin = 1;
    let bars: CandleBar[] = [];
    try {
      const { getSessionCandles } = await import("@/lib/market-history-client");
      bars = toCandleBars(await getSessionCandles(symbol, "1minute", tradeDate));
    } catch {
      bars = [];
    }

    if (!bars.length) {
      const { getIntradayCandles } = await import("@/lib/breeze-historical");
      const res = await getIntradayCandles(symbol, tradeDate, "5minute");
      bars = toCandleBars(res?.candles ?? []);
      sourceMin = 5;
    }

    if (!bars.length) return null;
    if (plan.bucketMin < sourceMin) return null; // cannot serve finer than the source
    return plan.bucketMin === sourceMin ? bars : aggregateBars(bars, plan.bucketMin, anchorMs);
  } catch {
    return null;
  }
}

export type { ShadowSession };
