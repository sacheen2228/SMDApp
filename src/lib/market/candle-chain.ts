// Candle multi-source fallback chain (LIVE CAPTURE ONLY — never reachable from
// backtest/evaluation paths; enforced by tests/candle-chain.test.ts import scan).
//
// Chains (per design):
//   indices (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY): Breeze → MO → NSE index chart
//   stocks:                                          Breeze → MO
//
// Rules (non-negotiable):
//   - First success wins. Failures are recorded (session-health + result.failures)
//     and the chain CONTINUES — an expired session must not stop data continuity.
//   - No substitution: a failed source is never "replaced" by a different
//     timeframe or instrument. MO is daily-only → intraday requests record
//     SOURCE_UNAVAILABLE for MO (capability skip), not daily bars.
//   - NSE chart is index-only (hard allowlist below) — stock symbols must never
//     reach it (recorded as SOURCE_UNAVAILABLE, source not called).
//   - Session classification: Breeze auth failures → SESSION_EXPIRED (alert via
//     session-health, single owner). MO session expiry → TOTP auto-recovery
//     attempt, then SESSION_EXPIRED if still dead. NSE failures are NEVER
//     SESSION_EXPIRED (no token auth — availability/block only).
import { getIntradayCandles } from "@/lib/breeze-historical";
import { getNSEIndexChart, type NSEChartPoint } from "@/lib/nse-api";
import { getMOCandles, moSupportsInterval } from "@/lib/motilal/candles";
import { autoLogin as moAutoLogin } from "@/lib/motilal/auth";
import {
  classifySourceError,
  reportSessionFailure,
  reportSessionRecovery,
  type FailureKind,
} from "@/lib/session-health";
import type { Candle } from "@/lib/market/canonical";

export type CandleSourceName = "breeze" | "mo" | "nse";

export interface CandleChainFailure {
  source: CandleSourceName;
  kind: FailureKind;
  detail: string;
}

export interface CandleChainResult {
  candles: Candle[];
  source: CandleSourceName | "none";
  intervalLabel: string; // actual spacing of returned candles (never mislabeled)
  degraded: string | null; // e.g. NSE close-only points (no OHLC/volume)
  failures: CandleChainFailure[]; // every source that failed, in chain order
}

// ── NSE index allowlist (index-only endpoint; SENSEX/BANKEX are BSE) ──
export const NSE_INDEX_MAP: Record<string, string> = {
  NIFTY: "NIFTY 50",
  NIFTY50: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY FINANCIAL SERVICES",
  MIDCPNIFTY: "NIFTY MIDCAP SELECT",
};
// Symbols explicitly known NOT to be served (clear detail for status surfaces).
const NSE_INDEX_UNSUPPORTED: Record<string, string> = {
  SENSEX: "SENSEX is a BSE index — NSE chart endpoint does not serve it",
  BANKEX: "BANKEX is a BSE index — NSE chart endpoint does not serve it",
};

// ── Injectable sources (tests replace these; production uses defaults) ──
export interface CandleSourceFns {
  breeze: (symbol: string, date: string, interval: string) => Promise<{ candles: any[]; warning?: string }>;
  mo: (symbol: string, date: string, interval: string) => Promise<any[]>;
  nse: (symbol: string, date: string, interval: string) => Promise<NSEChartPoint[]>;
}

const defaultSources: CandleSourceFns = {
  breeze: (symbol, date, interval) =>
    getIntradayCandles(symbol, date, interval as "1minute" | "5minute" | "15minute"),
  mo: (symbol, _date, interval) => getMOCandles(symbol),
  nse: (symbol) => {
    const idx = NSE_INDEX_MAP[symbol.toUpperCase()];
    return getNSEIndexChart(idx);
  },
};

let sources: CandleSourceFns = defaultSources;
// MO TOTP auto-recovery seam (tests inject; production calls motilal autoLogin).
let moRecoveryFn: (() => Promise<boolean>) | null = null;

async function attemptMORecovery(): Promise<boolean> {
  if (moRecoveryFn) return moRecoveryFn();
  return await moAutoLogin();
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10);
}

function errMsg(e: any): string {
  return String(e?.message || e);
}

function toCandles(raw: any[]): Candle[] {
  const out: Candle[] = [];
  for (const c of raw ?? []) {
    const ts = c.timestamp ?? c.time ?? c.datetime ?? c.date;
    if (ts == null) continue;
    const close = Number(c.close ?? c.c ?? 0);
    const open = Number(c.open ?? c.o ?? close);
    const high = Number(c.high ?? c.h ?? open);
    const low = Number(c.low ?? c.l ?? open);
    if (!open && !high && !low && !close) continue;
    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;
    out.push({
      timestamp: isNaN(d.getTime()) ? String(ts) : d.toISOString(),
      open, high, low, close,
      volume: Number(c.volume ?? c.v ?? 0) || 0,
    });
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}

// Derive the REAL spacing of the series so stored candles are never labeled with
// a timeframe they don't have (e.g. NSE 5-min points must not become "1minute").
function deriveIntervalLabel(candles: Candle[], requested: string): string {
  if (moSupportsInterval(requested)) return "1day";
  if (candles.length < 2) return requested;
  const deltas: number[] = [];
  const limit = Math.min(candles.length, 41);
  for (let i = 1; i < limit; i++) {
    deltas.push(Date.parse(candles[i].timestamp) - Date.parse(candles[i - 1].timestamp));
  }
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)];
  if (!isFinite(med) || med <= 0) return requested;
  if (med <= 90_000) return "1minute";
  if (med <= 6 * 60_000) return "5minute";
  if (med <= 16 * 60_000) return "15minute";
  return "60minute";
}

// Close-only points (no OHLC/volume) → flat bars, explicitly labeled degraded.
function pointsToCandles(points: NSEChartPoint[]): { candles: Candle[]; degraded: string | null } {
  const hasOhlc = points.some((p) => p.open != null && p.high != null && p.low != null);
  const candles = points.map((p) => ({
    timestamp: p.time,
    open: p.open ?? p.close,
    high: p.high ?? p.close,
    low: p.low ?? p.close,
    close: p.close,
    volume: p.volume ?? 0,
  }));
  return {
    candles,
    degraded: hasOhlc
      ? null
      : "NSE chart returned close-only line points — bars are flat (o=h=l=c), volume 0",
  };
}

// MO session expiry handling (autoLogin TOTP-first) lives inline in the chain
// above: recovery is attempted BEFORE any alert so a self-healed blip never pages.

/**
 * Fetch candles for (symbol, date, interval) with first-success-wins fallback.
 * Never throws; a total outage returns { source: "none", failures: [...] }.
 */
export async function fetchCandlesWithFallback(
  symbol: string,
  date: string,
  interval: string
): Promise<CandleChainResult> {
  const failures: CandleChainFailure[] = [];
  const normSymbol = symbol.toUpperCase();
  const note = (source: CandleSourceName, kind: FailureKind, detail: string) => {
    reportSessionFailure(source, kind, detail);
    failures.push({ source, kind, detail });
  };

  // ── 1. Breeze (never throws; auth failures arrive as warning text) ──
  try {
    const res = await sources.breeze(normSymbol, date, interval);
    const candles = toCandles(res.candles ?? []);
    if (candles.length) {
      reportSessionRecovery("breeze");
      return {
        candles,
        source: "breeze",
        intervalLabel: deriveIntervalLabel(candles, interval),
        degraded: null,
        failures,
      };
    }
    note("breeze", classifySourceError("breeze", res.warning || "empty result"), res.warning || "Breeze returned no candles");
  } catch (e) {
    const msg = errMsg(e);
    note("breeze", classifySourceError("breeze", msg), msg);
  }

  // ── 2. MO (daily-only capability; auth expiry → TOTP recovery + retry once) ──
  if (!moSupportsInterval(interval)) {
    note(
      "mo",
      "SOURCE_UNAVAILABLE",
      `MO OpenAPI has no intraday candle endpoint (EOD daily only) — requested ${interval}`
    );
  } else {
    try {
      let candles = await sources.mo(normSymbol, date, interval).then(toCandles);
      if (!candles.length) {
        note("mo", "NO_DATA", `MO EOD has no rows for ${normSymbol}`);
      } else {
        reportSessionRecovery("mo");
        return { candles, source: "mo", intervalLabel: deriveIntervalLabel(candles, interval), degraded: null, failures };
      }
    } catch (e) {
      const msg = errMsg(e);
      const kind = classifySourceError("mo", msg);
      if (kind === "SESSION_EXPIRED") {
        // Session expiry: attempt TOTP-first auto-recovery BEFORE alerting —
        // a self-healed blip must not page the user. Alert only if still dead.
        let recovered = false;
        try {
          recovered = await attemptMORecovery();
        } catch (e2) {
          console.error("[candle-chain] MO autoLogin threw:", errMsg(e2));
        }
        if (!recovered) {
          note("mo", "SESSION_EXPIRED", `${msg} (MO TOTP auto-recovery attempted and failed)`);
        } else {
          try {
            const candles = await sources.mo(normSymbol, date, interval).then(toCandles);
            if (candles.length) {
              reportSessionRecovery("mo");
              return { candles, source: "mo", intervalLabel: deriveIntervalLabel(candles, interval), degraded: null, failures };
            }
            note("mo", "NO_DATA", `MO EOD has no rows for ${normSymbol} after session recovery`);
          } catch (e2) {
            // Session recovered — a retry failure now is a fresh, non-auth issue.
            const m2 = errMsg(e2);
            note("mo", classifySourceError("mo", m2), m2);
          }
        }
      } else {
        note("mo", kind, msg);
      }
    }
  }

  // ── 3. NSE index chart (index-only, current session only) ──
  const idxName = NSE_INDEX_MAP[normSymbol];
  const unsupported = NSE_INDEX_UNSUPPORTED[normSymbol];
  if (unsupported) {
    note("nse", "SOURCE_UNAVAILABLE", unsupported);
  } else if (!idxName) {
    note("nse", "SOURCE_UNAVAILABLE", `NSE chart endpoint is index-only — ${normSymbol} not in allowlist`);
  } else if (!isToday(date)) {
    note("nse", "SOURCE_UNAVAILABLE", "NSE chart endpoint serves the current session only (no historical dates)");
  } else {
    try {
      const points = await sources.nse(normSymbol, date, interval);
      if (!points.length) {
        note("nse", "NO_DATA", "NSE chart grapthData is empty (outside trading hours or holiday)");
      } else {
        const { candles, degraded } = pointsToCandles(points);
        if (!candles.length) {
          note("nse", "NO_DATA", "NSE chart points unparsable");
        } else {
          reportSessionRecovery("nse");
          return {
            candles,
            source: "nse",
            intervalLabel: deriveIntervalLabel(candles, interval),
            degraded,
            failures,
          };
        }
      }
    } catch (e) {
      // classifySourceError("nse", ...) can NEVER return SESSION_EXPIRED (no token auth).
      note("nse", classifySourceError("nse", errMsg(e)), errMsg(e));
    }
  }

  return { candles: [], source: "none", intervalLabel: interval, degraded: null, failures };
}

// ── Test seams ──
export function __setCandleSourcesForTests(next: CandleSourceFns | null): void {
  sources = next ?? defaultSources;
}
export function __setMOTOTPRecoveryForTests(fn: (() => Promise<boolean>) | null): void {
  moRecoveryFn = fn;
}
