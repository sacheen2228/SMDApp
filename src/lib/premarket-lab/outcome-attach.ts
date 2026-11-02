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

/** Fetch candles for a symbol from the candle chain (real data only). */
export async function fetchCandlesForOutcome(
  symbol: string,
  tradeDate: string,
  intervalMin = 5,
): Promise<CandleBar[] | null> {
  try {
    const { fetchCandlesWithFallback } = await import("@/lib/market/candle-chain");
    const interval =
      intervalMin <= 5 ? "5minute" : intervalMin <= 15 ? "15minute" : intervalMin <= 30 ? "30minute" : "1day";
    const from = `${tradeDate}T00:00:00+05:30`;
    const to = `${tradeDate}T23:59:59+05:30`;
    const res: any = await fetchCandlesWithFallback(symbol, interval as any, { from, to } as any);
    const raw = res?.candles || res?.data || [];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map((c: any) => ({
      time: c.time ?? c.timestamp ?? c.date,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume ?? 0),
    })).filter((c: CandleBar) =>
      Number.isFinite(c.open) && Number.isFinite(c.close) &&
      Number.isFinite(c.high) && Number.isFinite(c.low),
    );
  } catch {
    return null;
  }
}

export type { ShadowSession };
