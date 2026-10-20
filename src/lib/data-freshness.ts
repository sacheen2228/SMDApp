// Card-level data provenance for the dashboard.
//
// Every card in the UI must answer three questions:
//   1. WHERE did the number come from?      → `source` / `sourceLabel`
//   2. HOW OLD is it?                       → `providerTimestamp` / `ageMs` / `ageLabel`
//   3. Is it actually available?            → `status` (AVAILABLE | STALE | UNAVAILABLE)
//
// The rule this module enforces: a value is only "LIVE" when the PROVIDER
// says so (its own trade timestamp) AND the exchange is printing. A 200 OK
// response is not proof of liveness — the exchange happily serves yesterday's
// close on a holiday, and a cached row can be any age.
//
// This sits on top of `api-freshness.ts` (the generic provider classifier) and
// adds the card envelope + the exchange market clock used by every route.

import { classifyFreshness, type FreshnessLevel } from "./api-freshness";

export type CardStatus = "AVAILABLE" | "STALE" | "UNAVAILABLE";

export interface CardMeta {
  /** AVAILABLE = real data, fresh enough to present. STALE = real but old. */
  status: CardStatus;
  /** Provider id ("nse", "moneycontrol", "breeze", "none", …). */
  source: string;
  /** Human label for the badge ("NSE India", "Moneycontrol", …). */
  sourceLabel: string;
  /** The provider's OWN timestamp (ISO). null when the feed carries none. */
  providerTimestamp: string | null;
  /** When this server collected the payload (ISO). */
  collectedAt: string;
  /** Age of the provider data in ms. null when the provider carries no timestamp. */
  ageMs: number | null;
  /** Human age ("22h ago", "45s ago", "unknown"). */
  ageLabel: string;
  /** True when the data is older than its TTL (or the market is closed). */
  stale: boolean;
  /** Why the data is unavailable / stale. Absent when everything is fine. */
  reason?: string;
}

export const SOURCE_LABELS: Record<string, string> = {
  nse: "NSE India",
  "nse-india": "NSE India",
  nseapi: "NSE India",
  bse: "BSE",
  "bse-api": "BSE",
  moneycontrol: "Moneycontrol",
  mc: "Moneycontrol",
  breeze: "Breeze",
  "icici-breeze": "Breeze",
  mo: "Motilal Oswal",
  "motilal-api": "Motilal Oswal",
  mrchartist: "MrChartist",
  none: "no source",
};

/** Age buckets used across the dashboard badges. */
export function formatAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Build the card envelope.
 *
 * `providerTimestamp` MUST be the provider's own trade/publication time. Pass
 * null when the feed carries none — the card then reports `ageMs: null` and
 * can never claim LIVE (an undated payload is undated).
 *
 * `ttlMs` is the age at which the value stops being "fresh". The default
 * (90s) matches a quote feed; pass a bigger TTL for slower feeds (daily
 * FII/DII, for instance).
 */
export function buildCardMeta(opts: {
  source: string;
  providerTimestamp?: Date | string | null;
  collectedAt?: Date;
  ttlMs?: number;
  /** Set false to force STALE (e.g. the exchange is closed). */
  live?: boolean;
  reason?: string;
  /** Override the computed freshness label. */
  freshness?: FreshnessLevel;
}): CardMeta {
  const source = opts.source || "none";
  const collectedAt = opts.collectedAt ?? new Date();
  const ttl = opts.ttlMs ?? 90_000;
  const label = SOURCE_LABELS[source] || SOURCE_LABELS[source.toLowerCase()] || source;

  let providerTimestamp: string | null = null;
  let ageMs: number | null = null;
  if (opts.providerTimestamp) {
    const d =
      opts.providerTimestamp instanceof Date
        ? opts.providerTimestamp
        : new Date(opts.providerTimestamp);
    if (!Number.isNaN(d.getTime())) {
      providerTimestamp = d.toISOString();
      ageMs = Math.max(0, Date.now() - d.getTime());
    }
  }

  const freshness: FreshnessLevel =
    opts.freshness ?? (ageMs == null ? "FRESH" : classifyFreshness(ageMs, "default"));
  const withinTtl = ageMs != null && ageMs <= ttl;
  const stale = opts.live === false ? true : ageMs == null ? true : !withinTtl;

  return {
    status: stale ? "STALE" : "AVAILABLE",
    source,
    sourceLabel: label,
    providerTimestamp,
    collectedAt: collectedAt.toISOString(),
    ageMs,
    ageLabel: formatAge(ageMs),
    stale,
    reason: opts.reason,
  };
}

/** The explicit "no data" envelope — never a zero, never a plausible number. */
export function unavailableMeta(reason: string, source = "none"): CardMeta {
  return {
    status: "UNAVAILABLE",
    source,
    sourceLabel: SOURCE_LABELS[source] || source,
    providerTimestamp: null,
    collectedAt: new Date().toISOString(),
    ageMs: null,
    ageLabel: "unavailable",
    stale: true,
    reason,
  };
}

/**
 * A number or null — never a silent zero.
 * Use `num()` for any value a feed may legitimately omit.
 */
export function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Round helper that keeps `null` null (never turns "missing" into 0). */
export function round(n: number | null | undefined, dp = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Percentage helper — null stays null. */
export function pct(part: number | null, whole: number | null, dp = 2): number | null {
  if (part == null || whole == null || whole === 0) return null;
  return round((part / whole) * 100, dp);
}

// ─── Exchange market clock ─────────────────────────────────────────────
// NSE publishes the Capital-Market state together with the trade date of the
// last session. On a holiday (or before the open) that date is OLDER than
// "now", which is exactly what makes a quote stale. This is the single place
// that decides whether "live" is truthful.

export interface MarketClock {
  /** "Open" | "Close" | "unknown" */
  marketState: string;
  isOpen: boolean;
  /** Last session's trade timestamp (ISO). null when the feed carries none. */
  tradeDate: string | null;
  /** Raw trade date as published ("19-Oct-2026 15:30"). */
  tradeDateLabel: string;
  /** Age of the last trade timestamp in ms. */
  tradeAgeMs: number | null;
  collectedAt: string;
  source: string;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse NSE's "19-Oct-2026 15:30" (IST) into an absolute timestamp. */
export function parseNseTradeDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const day = Number(m[1]);
  const mon = MONTHS[m[2].toLowerCase?.() ?? m[2]] ?? MONTHS[m[2]];
  if (mon == null) return null;
  const year = Number(m[3]);
  const hh = Number(m[4] ?? "15");
  const mm = Number(m[5] ?? "30");
  // IST = UTC+5:30 → subtract to get UTC
  const ms = Date.UTC(year, mon, day, hh, mm) - 5.5 * 3600 * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

let clockCache: { at: number; clock: MarketClock } | null = null;
const CLOCK_TTL_MS = 60_000;

/** NSE Capital-Market state + the trade date of the last session. */
export async function getMarketClock(force = false): Promise<MarketClock> {
  if (!force && clockCache && Date.now() - clockCache.at < CLOCK_TTL_MS) {
    return clockCache.clock;
  }
  const fallback: MarketClock = {
    marketState: "unknown",
    isOpen: false,
    tradeDate: null,
    tradeDateLabel: "",
    tradeAgeMs: null,
    collectedAt: new Date().toISOString(),
    source: "nse",
  };
  try {
    const res = await fetch("https://www.nseindia.com/api/marketStatus", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`marketStatus HTTP ${res.status}`);
    const json: any = await res.json();
    const cm = (json?.marketState || []).find((m: any) => m.market === "Capital Market");
    const state = String(cm?.marketStatus || "unknown");
    const tradeDate = parseNseTradeDate(cm?.tradeDate);
    const clock: MarketClock = {
      marketState: state,
      isOpen: state.toLowerCase() === "open",
      tradeDate: tradeDate ? tradeDate.toISOString() : null,
      tradeDateLabel: String(cm?.tradeDate || ""),
      tradeAgeMs: tradeDate ? Math.max(0, Date.now() - tradeDate.getTime()) : null,
      collectedAt: new Date().toISOString(),
      source: "nse",
    };
    clockCache = { at: Date.now(), clock };
    return clock;
  } catch {
    clockCache = { at: Date.now(), clock: fallback };
    return fallback;
  }
}

/**
 * Card meta for a feed whose provider timestamp is unknown.
 * NEVER claims LIVE — an undated payload is undated.
 */
export function undatedCardMeta(source: string, reason: string): CardMeta {
  const meta = unavailableMeta(reason, source);
  return meta;
}
