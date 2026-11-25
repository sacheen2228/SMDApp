// market/futures-flow.ts
// ONE futures-leg flow read shared by the Daily Derivatives card and the
// Grok agent snapshot.
//
// WHY THE FUTURES LEG: index SPOT candles carry no traded volume (Breeze index
// intraday → volume 0, NSE chart-databyindex → close-only), so the CVD proxy
// had nothing to sign. The nearest index FUTURES contract carries real traded
// volume AND per-bar open interest (verified live 2026-11-20: NIFTY
// 23-Nov-2026 NFO → 76 bars, 5,277,025 contracts, OI 8,725,015 → 8,528,845).
//
// HONEST LIMITS (carried by every consumer):
//   - Buy/sell attribution is CANDLE-SIGNED (up-bar volume = buy). There is no
//     aggressor-side tape for these indices, so CVD alone can NEVER falsify a
//     breakout — a breakout bar is positive CVD by construction.
//   - The genuine fake-breakout detector is futures RELATIVE VOLUME (breakout
//     bar vs its own prior average) together with ΔOI at the signal bar.
//   - MOAPI has no intraday futures series and no futures OI → the degraded
//     fallback is day volume only, never a CVD curve.
//   - SENSEX/BFO futures carry OI = 0 → ΔOI stays UNKNOWN (never a fake zero).
//
// Educational framework, not financial advice.

import { computeCandleCvdProxy, type CvdProxyResult } from "@/engines/orderflow/orderflow-engine";
import { getFuturesIntradayCandles, toIsoExpiryDate } from "@/lib/breeze-historical";
import { getOptionChainExpiries } from "@/lib/icici-breeze/option-chain";
import { calculateRelativeVolume } from "@/lib/volume-engine";
import type { Candle } from "@/lib/auction-types";
import { ddmmyyyyToIso, pickNearestFuturesExpiry } from "@/lib/index-futures-candles";
import { initSession, getBreezeClient, getSessionState } from "@/lib/icici-breeze/auth";

/** Index symbols with a live futures leg we can read. */
export const FUTURES_FLOW_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"] as const;

const MONTHS_SHORT: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const IST_OFFSET_MS = 5.5 * 3600_000;
const BAR_INTERVAL_MS = 5 * 60_000;
const FLOW_TTL_MS = 60_000;

/**
 * Parse a Breeze bar stamp ("20-Nov-2026 09:15:00") as IST wall-clock.
 * Never `new Date(str)` — that would resolve against the SERVER timezone.
 */
export function parseIstBarMs(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const mon = MONTHS_SHORT[m[2].slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +(m[6] || 0)) - IST_OFFSET_MS;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** YYYY-MM-DD in IST — never toISOString() (UTC puts the day out by one). */
export function istDateStr(daysBack = 0, nowMs: number = Date.now()): string {
  return new Date(nowMs - daysBack * 86_400_000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export interface FuturesFlowVolumeRead {
  /** Volume of the last CLOSED bar. */
  current: number;
  /** Mean volume of the prior `lookback` bars (the current bar excluded). */
  average: number;
  /** current / average — the honest breakout-volume ratio. */
  ratio: number;
  percentile: number;
  barTime: number | string;
  barsUsed: number;
}

/**
 * Relative volume of the last CLOSED futures bar vs the prior lookback bars.
 * The still-forming bar is dropped (its volume is partial and would understate
 * the ratio). Returns null when there is not enough history — never a fake 1.0.
 */
export function futuresFlowRelativeVolume(
  candles: Array<{ time: number | string; volume?: number; open?: number; high?: number; low?: number; close?: number }>,
  opts: { lookback?: number; nowMs?: number; intervalMs?: number } = {}
): FuturesFlowVolumeRead | null {
  const list = (candles || []).filter((c) => c && Number.isFinite(Number(c.volume)));
  if (list.length < 6) return null;

  const nowMs = opts.nowMs ?? Date.now();
  const intervalMs = opts.intervalMs ?? BAR_INTERVAL_MS;
  const lookback = opts.lookback ?? 20;

  // Drop the trailing forming bar (start + interval is still in the future).
  let end = list.length;
  const last = list[list.length - 1];
  const lastMs = parseIstBarMs(last.time);
  if (lastMs != null && lastMs + intervalMs > nowMs) end = list.length - 1;
  if (end < 6) return null;

  const mapped: Candle[] = list.slice(0, end).map((c, i) => ({
    time: parseIstBarMs(c.time) ?? i,
    open: Number(c.open ?? 0),
    high: Number(c.high ?? 0),
    low: Number(c.low ?? 0),
    close: Number(c.close ?? 0),
    volume: Number(c.volume ?? 0),
  }));

  const idx = mapped.length - 1;
  const rel = calculateRelativeVolume(mapped, idx, { lookbackPeriod: lookback });
  if (!rel || rel.average <= 0) return null;

  return {
    current: rel.current,
    average: rel.average,
    ratio: rel.ratio,
    percentile: rel.percentile,
    barTime: list[end - 1].time,
    barsUsed: Math.min(lookback, idx),
  };
}

export interface FuturesFlowRead {
  symbol: string;
  available: boolean;
  source: string;
  contract?: string;
  bars: number;
  cvd?: CvdProxyResult;
  relativeVolume?: FuturesFlowVolumeRead;
  note?: string;
}

interface FlowCacheEntry {
  ts: number;
  read: FuturesFlowRead;
}
const flowCache = new Map<string, FlowCacheEntry>();

/**
 * Read the futures leg: CVD (candle-signed) + ΔOI + build-up + relative volume.
 * Best-effort — a failure returns an unavailable read with a reason, never a
 * fabricated zero.
 */
export async function readFuturesFlow(
  symbol: string,
  dateStr: string,
  opts: { interval?: "1minute" | "5minute"; ttlMs?: number } = {}
): Promise<FuturesFlowRead> {
  const sym = String(symbol || "").toUpperCase();
  const key = `${sym}:${dateStr}:${opts.interval ?? "5minute"}`;
  const hit = flowCache.get(key);
  if (hit && Date.now() - hit.ts < (opts.ttlMs ?? FLOW_TTL_MS)) return hit.read;

  let read: FuturesFlowRead = {
    symbol: sym,
    available: false,
    source: "none",
    bars: 0,
    note: "Futures flow read unavailable — no futures series for this symbol/session.",
  };

  if (!(FUTURES_FLOW_SYMBOLS as readonly string[]).includes(sym)) {
    read.note = `Futures flow is an index read — ${sym} has no futures leg here.`;
    flowCache.set(key, { ts: Date.now(), read });
    return read;
  }

  try {
    // Candidate expiries: SECURITY-MASTER FUT- contracts first. The option-
    // chain list mixes in weekly option expiries Breeze does not list as
    // futures (verified live 2026-11-25: 01/08/15-Dec return 0 rows while
    // FUT-NIFTY-29-Dec-2026 returns the real session series). Chain expiries
    // stay as fallback for symbols the master does not carry.
    const candidates: string[] = [];
    const pushIso = (iso: string | null | undefined) => {
      if (iso && !candidates.includes(iso)) candidates.push(iso);
    };
    try {
      const state = getSessionState();
      if (!state.authenticated) await initSession();
      const breeze = getBreezeClient();
      let masterLists: any[] = Array.isArray((breeze as any)?.stockScriptDictList)
        ? (breeze as any).stockScriptDictList
        : [];
      const hasFut = masterLists.some(
        (l) => l && typeof l === "object" && Object.keys(l).some((k) => k.startsWith("FUT-")),
      );
      if (!hasFut) {
        try { await (breeze as any).getStockScriptList(); } catch { /* keep what we have */ }
        masterLists = Array.isArray((breeze as any)?.stockScriptDictList)
          ? (breeze as any).stockScriptDictList
          : [];
      }
      // All listed FUT- contracts on/after today, nearest first.
      const prefix = `FUT-${sym}-`;
      const dayStart = (() => {
        const ist = new Date(Date.now() + 5.5 * 3600_000);
        return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3600_000;
      })();
      const masterIsos: string[] = [];
      for (const list of masterLists) {
        if (!list || typeof list !== "object") continue;
        for (const k of Object.keys(list)) {
          if (!k.startsWith(prefix)) continue;
          const iso = ddmmyyyyToIso(k.slice(prefix.length));
          if (!iso) continue;
          const ts = Date.parse(iso + "T00:00:00+05:30");
          if (Number.isNaN(ts) || ts < dayStart) continue;
          masterIsos.push(iso);
        }
      }
      masterIsos.sort((a, b) => Date.parse(a) - Date.parse(b));
      for (const iso of masterIsos) pushIso(iso);
      // Keep the shared picker as a belt-and-braces single-nearest read.
      pushIso(pickNearestFuturesExpiry(masterLists, sym));
    } catch { /* master unavailable → chain fallback below */ }
    for (const expiry of await getOptionChainExpiries(sym)) {
      pushIso(toIsoExpiryDate(expiry));
    }
    for (const iso of candidates) {
      const res = await getFuturesIntradayCandles(sym, iso, dateStr, opts.interval ?? "5minute");
      if (!res.candles.length) continue;

      const computed = computeCandleCvdProxy(
        res.candles.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          oi: c.oi,
        })),
        {
          windowBars: 3,
          mode: "FUTURES_CANDLE_SIGN",
          source: "breeze",
          contract: res.contract,
        }
      );
      if (!computed.available) continue;

      read = {
        symbol: sym,
        available: true,
        source: "breeze",
        contract: res.contract,
        bars: res.candles.length,
        cvd: computed,
        relativeVolume: futuresFlowRelativeVolume(res.candles as any) ?? undefined,
      };
      break;
    }
  } catch (e: any) {
    read.note = `Futures flow read failed: ${e?.message || e}`;
  }

  if (!read.available && !read.note) {
    read.note = "No futures series returned for this session — CVD/ΔOI unavailable.";
  }

  flowCache.set(key, { ts: Date.now(), read });
  return read;
}

/** Test hook — clears the 60s futures-flow cache. */
export function __resetFuturesFlowCache(): void {
  flowCache.clear();
}
