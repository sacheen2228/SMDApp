// Real daily bars + derived technicals (EMA / daily VWAP) for the dashboard.
//
// Every "EMA participation" / "above VWAP" number the dashboard shows comes
// from the exchange's OWN daily history (`/api/historical/...` through the NSE
// client) — never from a previous close or a constant.
//
// The previous implementation faked these:
//   ema20 = prevClose + change * 0.3      (not an EMA at all)
//   ema50 = prevClose
//   ema200 = prevClose
//   vwap  = (high + low + ltp) / 3        (a typical price, not a VWAP)
// Those numbers drove the regime score, the breadth score and the opportunity
// scan — i.e. they were part of why the app fired the WRONG signals.
//
// Bars are cached (TTL) so a 50-symbol sweep stays inside one card refresh.

import { getNSEHistoricalData } from "./nse-api";
import { emaSeries, vwapSeries, type Candle } from "./tech-read";

export interface DailyBar extends Candle {
  /** The exchange's own VWAP for the session (NSE ships it on every row). */
  vwap?: number;
  /** Session date as published ("19-Oct-2026"). */
  sessionDate?: string;
}

const BAR_CACHE_TTL_MS = 15 * 60_000;
const barCache = new Map<string, { at: number; bars: DailyBar[] }>();

function normalizeNseBars(raw: any[]): DailyBar[] {
  const out: DailyBar[] = [];
  for (const b of raw || []) {
    const o = Number(b?.chOpeningPrice ?? b?.open);
    const h = Number(b?.chTradeHighPrice ?? b?.high);
    const l = Number(b?.chTradeLowPrice ?? b?.low);
    const c = Number(b?.chClosingPrice ?? b?.close);
    if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
    const stamp = String(b?.mtimestamp || b?.timestamp || "");
    const parsed = parseSessionDate(stamp);
    out.push({
      t: parsed ?? 0,
      o,
      h: Number.isFinite(h) ? h : c,
      l: Number.isFinite(l) ? l : c,
      c,
      v: Number(b?.chTotTradedQty ?? b?.volume ?? 0) || 0,
      vwap: Number.isFinite(Number(b?.vwap)) ? Number(b.vwap) : undefined,
      sessionDate: stamp || undefined,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** "19-Oct-2026" → epoch ms (IST midnight → UTC). */
export function parseSessionDate(raw: string): number | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const mon = months[m[2]];
  if (mon == null) return null;
  // The session close (15:30 IST) — the daily bar's own timestamp.
  return Date.UTC(Number(m[3]), mon, Number(m[1]), 15, 30) - 5.5 * 3600 * 1000;
}

/**
 * Real daily bars for one symbol (exchange history, cached 15 min).
 * Returns [] when the exchange has nothing for that symbol.
 */
export async function getDailyBars(
  symbol: string,
  lookbackDays = 400,
): Promise<DailyBar[]> {
  const sym = String(symbol || "").toUpperCase();
  const hit = barCache.get(sym);
  if (hit && Date.now() - hit.at < BAR_CACHE_TTL_MS) return hit.bars;
  try {
    const to = new Date();
    const from = new Date(to.getTime() - lookbackDays * 86_400_000);
    const raw: any = await getNSEHistoricalData(sym, from, to);
    const bars = normalizeNseBars(Array.isArray(raw) ? raw : []);
    if (bars.length) barCache.set(sym, { at: Date.now(), bars });
    return bars;
  } catch {
    return hit?.bars ?? [];
  }
}

export interface DailyTechnicals {
  symbol: string;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  vwap: number | null;
  /** Mean traded volume of the last 20 real sessions (the real RVOL base). */
  avgVolume20: number | null;
  /** Date of the newest bar (ISO) — the age of the newest input. */
  lastBarAt: string | null;
  bars: number;
}

/** EMA / daily-VWAP for one symbol from its real bars. null when unavailable. */
export function dailyTechnicals(symbol: string, bars: DailyBar[]): DailyTechnicals {
  const closes = bars.map((b) => b.c);
  const ema20 = emaSeries(closes, 20).at(-1) ?? null;
  const ema50 = emaSeries(closes, 50).at(-1) ?? null;
  const ema200 = emaSeries(closes, 200).at(-1) ?? null;
  // The exchange publishes a real VWAP per session — prefer it over a
  // locally-rolled one (the local one needs intraday volume, daily bars
  // only carry the session total).
  const exchangeVwap = bars.at(-1)?.vwap;
  const localVwap = vwapSeries(bars as Candle[]).at(-1) ?? null;
  const vwap = Number.isFinite(exchangeVwap as number)
    ? (exchangeVwap as number)
    : localVwap;
  const lastT = bars.at(-1)?.t ?? null;
  const recent = bars.slice(-20);
  const avgVolume20 = recent.length
    ? recent.reduce((s, b) => s + (b.v || 0), 0) / recent.length
    : null;
  return {
    symbol,
    ema20,
    ema50,
    ema200,
    vwap,
    avgVolume20: avgVolume20 && avgVolume20 > 0 ? avgVolume20 : null,
    lastBarAt: lastT ? new Date(lastT).toISOString() : null,
    bars: bars.length,
  };
}

export interface TechnicalSweep {
  /** symbol → technicals (only for symbols with real bars). */
  bySymbol: Map<string, DailyTechnicals>;
  /** How many symbols were requested / answered. */
  requested: number;
  covered: number;
  /** Newest bar across the sweep (ISO) — the age of the technical inputs. */
  newestBarAt: string | null;
  /** True when every requested symbol produced real bars. */
  complete: boolean;
}

/**
 * Daily technicals for a list of symbols. Bounded concurrency + deadline so a
 * card refresh never hangs; symbols without real bars are simply absent from
 * the result (the card reports the coverage).
 */
export async function sweepDailyTechnicals(
  symbols: string[],
  opts: { concurrency?: number; deadlineMs?: number } = {},
): Promise<TechnicalSweep> {
  const concurrency = opts.concurrency ?? 10;
  const deadline = Date.now() + (opts.deadlineMs ?? 12_000);
  const bySymbol = new Map<string, DailyTechnicals>();
  let newest = 0;

  for (let i = 0; i < symbols.length && Date.now() < deadline; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (sym) => {
        const bars = await getDailyBars(sym);
        if (bars.length < 20) return;
        const t = dailyTechnicals(sym, bars);
        bySymbol.set(sym, t);
        const ts = t.lastBarAt ? Date.parse(t.lastBarAt) : 0;
        if (ts > newest) newest = ts;
      }),
    );
  }

  return {
    bySymbol,
    requested: symbols.length,
    covered: bySymbol.size,
    newestBarAt: newest ? new Date(newest).toISOString() : null,
    complete: bySymbol.size === symbols.length,
  };
}

// ─── Indicator maths on REAL bars ─────────────────────────────────────
// The dashboard used to invent these: ema20 = prevClose + change*0.3,
// ema50 = ema200 = prevClose, vwap = (high+low+ltp)/3, rsi = a step function
// of changePct, macd = changePct * 0.5. All of them are computed here from
// the exchange's own bars.

/** Wilder's RSI. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD (12/26/9) on real closes. */
export function macd(
  closes: number[],
): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35) return null;
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const line: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = fast[i];
    const s = slow[i];
    line.push(f != null && s != null ? f - s : 0);
  }
  const signalSeries = emaSeries(line, 9);
  const macdValue = line.at(-1) ?? 0;
  const signalValue = signalSeries.at(-1) ?? 0;
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue };
}

/** Wilder's ATR from real bars. */
export function atr(bars: DailyBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const c = bars[i];
    const pc = bars[i - 1].c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }
  let value = sum / period;
  for (let i = period + 1; i < bars.length; i++) {
    const c = bars[i];
    const pc = bars[i - 1].c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    value = (value * (period - 1) + tr) / period;
  }
  return value;
}

/** Bollinger bands (20, 2σ) on real closes. */
export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { middle: number; upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((s, c) => s + c, 0) / period;
  const variance = window.reduce((s, c) => s + (c - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

/**
 * Build the indicator bundle the detection engines consume, from the real
 * daily bars + the real quote. Missing inputs stay null.
 */
export function buildIndicators(args: {
  quote: {
    ltp: number;
    prevClose: number;
    changePct: number;
    volume: number;
    dayHigh: number;
    dayLow: number;
    weekHigh52: number;
    weekLow52: number;
    sector?: string;
    sectorChangePct?: number;
    marketChangePct?: number;
  };
  bars: DailyBar[];
}): Record<string, any> {
  const { quote, bars } = args;
  const closes = bars.map((b) => b.c);
  const tech = dailyTechnicals(quote.ltp.toString(), bars);
  const rsiValue = rsi(closes, 14);
  const macdValue = macd(closes);
  const atrValue = atr(bars, 14);
  const bb = bollinger(closes, 20, 2);
  const avgVolume = tech.avgVolume20 ?? 0;
  const relVolume = avgVolume > 0 ? quote.volume / avgVolume : 1;

  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;
  const prevDayHigh = prevBar?.h ?? quote.dayHigh;
  const prevDayLow = prevBar?.l ?? quote.dayLow;

  return {
    ltp: quote.ltp,
    open: bars.at(-1)?.o ?? quote.ltp,
    high: quote.dayHigh,
    low: quote.dayLow,
    prevClose: quote.prevClose,
    changePct: quote.changePct,
    volume: quote.volume,
    avgVolume,
    relVolume,
    vwap: tech.vwap,
    ema20: tech.ema20,
    ema50: tech.ema50,
    ema200: tech.ema200,
    rsi: rsiValue,
    macd: macdValue ?? undefined,
    atr: atrValue ?? undefined,
    atrPct: atrValue != null && quote.ltp > 0 ? (atrValue / quote.ltp) * 100 : undefined,
    bbUpper: bb?.upper,
    bbLower: bb?.lower,
    bbMiddle: bb?.middle,
    dayHigh: quote.dayHigh,
    dayLow: quote.dayLow,
    weekHigh52: quote.weekHigh52,
    weekLow52: quote.weekLow52,
    prevDayHigh,
    prevDayLow,
    prevWeekHigh: Math.max(...bars.slice(-6, -1).map((b) => b.h)),
    prevWeekLow: Math.min(...bars.slice(-6, -1).map((b) => b.l)),
    sector: quote.sector,
    sectorChangePct: quote.sectorChangePct,
    marketChangePct: quote.marketChangePct,
  };
}
