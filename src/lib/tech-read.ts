// tech-read.ts
// CANONICAL technical-read engine for the trading brain.
// SuperTrend, EMA cross (+ chop filter), VWAP, market structure (HH/HL, BOS, CHoCH),
// liquidity (pools, equal highs/lows, sweeps, FVG) and the APPLY step:
// structureLayer / triggerLayer / suggestLevels + a signal backtest.
//
// Source of truth. src/lib/indicators.ts re-exports everything here (it keeps the
// legacy lightweight-charts overlay contract) so there is exactly ONE implementation.
//
// Educational framework, not financial advice. Indicators lag, whipsaw in chop and are
// confluence — never a standalone trigger.

import { getJSON, safeSymbol, enc, wilson, type Layer } from "./agent-brain-gate";

// ─────────────────────────────────────────────────────────────
// Candles
// ─────────────────────────────────────────────────────────────
export interface Candle { t: number; o: number; h: number; l: number; c: number; v?: number }

const num = (v: any): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const tMs = (v: any): number => {
  if (typeof v === "number") return v; // API returns ms epoch as-is
  const p = Date.parse(String(v));
  return Number.isFinite(p) ? p : NaN;
};

/** Tolerant normaliser (ADAPT keys). Accepts objects or [t,o,h,l,c,v] arrays. Sorted, de-duplicated. */
export function normalizeCandles(raw: any[]): Candle[] {
  const out: Candle[] = [];
  for (const r of raw || []) {
    const a = Array.isArray(r);
    const t = tMs(a ? r[0] : r.t ?? r.time ?? r.timestamp ?? r.datetime ?? r.date);
    const o = num(a ? r[1] : r.o ?? r.open ?? r.openPrice);
    const h = num(a ? r[2] : r.h ?? r.high ?? r.highPrice);
    const l = num(a ? r[3] : r.l ?? r.low ?? r.lowPrice);
    const c = num(a ? r[4] : r.c ?? r.close ?? r.closePrice);
    const v = num(a ? r[5] : r.v ?? r.volume);
    if (Number.isFinite(t) && o != null && h != null && l != null && c != null) out.push({ t, o, h, l, c, v });
  }
  out.sort((x, y) => x.t - y.t);
  return out.filter((x, i) => i === 0 || x.t !== out[i - 1].t);
}

const istDay = (ms: number) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);

/** Drop the still-forming last candle (signals must come from CLOSED candles). */
export function closedOnly(c: Candle[], nowMs = Date.now()): Candle[] {
  if (c.length < 3) return c;
  const iv = c[c.length - 1].t - c[c.length - 2].t;
  return iv > 0 && nowMs < c[c.length - 1].t + iv ? c.slice(0, -1) : c;
}

// ─────────────────────────────────────────────────────────────
// Core indicators
// ─────────────────────────────────────────────────────────────

/** EMA over a number series (engine form). Chart overlays use the Bar[] form below. */
export function emaSeries(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(values.length).fill(undefined);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period; // SMA seed
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** Wilder ATR series. */
export function atrSeries(c: Candle[], period = 10): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(c.length).fill(undefined);
  if (c.length <= period) return out;
  const tr = (i: number) => Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr(i);
  a /= period; out[period] = a;
  for (let i = period + 1; i < c.length; i++) { a = (a * (period - 1) + tr(i)) / period; out[i] = a; }
  return out;
}

export interface ST { line: (number | undefined)[]; dir: (1 | -1 | 0)[]; lastFlip?: number }

/** SuperTrend (default 10, 3). dir 1 = uptrend (line below price), -1 = downtrend. */
export function superTrend(c: Candle[], period = 10, mult = 3): ST {
  const n = c.length;
  const atr = atrSeries(c, period);
  const line: (number | undefined)[] = new Array(n).fill(undefined);
  const dir: (1 | -1 | 0)[] = new Array(n).fill(0);
  let fu = NaN, fl = NaN, d: 1 | -1 = 1, started = false, lastFlip: number | undefined;
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    if (a == null) continue;
    const hl2 = (c[i].h + c[i].l) / 2;
    const bu = hl2 + mult * a, bl = hl2 - mult * a;
    if (!started) { fu = bu; fl = bl; d = c[i].c >= hl2 ? 1 : -1; started = true; }
    else {
      const pc = c[i - 1].c;
      fu = bu < fu || pc > fu ? bu : fu;
      fl = bl > fl || pc < fl ? bl : fl;
      if (d === 1 && c[i].c < fl) { d = -1; lastFlip = i; }
      else if (d === -1 && c[i].c > fu) { d = 1; lastFlip = i; }
    }
    dir[i] = d; line[i] = d === 1 ? fl : fu;
  }
  return { line, dir, lastFlip };
}

/** Session VWAP (resets each IST day). Index SPOT candles usually have no volume → undefined; use futures candles. */
export function vwapSeries(c: Candle[]): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(c.length).fill(undefined);
  let day = "", pv = 0, vv = 0;
  for (let i = 0; i < c.length; i++) {
    const d = istDay(c[i].t);
    if (d !== day) { day = d; pv = 0; vv = 0; }
    const v = c[i].v ?? 0;
    pv += ((c[i].h + c[i].l + c[i].c) / 3) * v; vv += v;
    out[i] = vv > 0 ? pv / vv : undefined;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// EMA crossover state (with whipsaw guard — crossovers in chop are the classic loser)
// ─────────────────────────────────────────────────────────────
export interface EmaState {
  fast?: number; slow?: number; rel: "ABOVE" | "BELOW" | "UNKNOWN";
  lastCross?: "BULLISH" | "BEARISH"; barsSinceCross?: number;
  crossesLast30: number; chop: boolean; spreadAtr?: number; slowSlope: "UP" | "DOWN" | "FLAT";
}

export function emaCross(c: Candle[], fastP = 9, slowP = 21, atrP = 14): EmaState {
  const closes = c.map((x) => x.c);
  const f = emaSeries(closes, fastP), s = emaSeries(closes, slowP), a = atrSeries(c, atrP);
  const n = c.length - 1;
  const rel = (i: number) => (f[i] == null || s[i] == null ? 0 : f[i]! > s[i]! ? 1 : -1);
  let lastIdx = -1, lastDir = 0, crosses = 0;
  for (let i = slowP; i <= n; i++) {
    const r = rel(i), p = rel(i - 1);
    if (r !== 0 && p !== 0 && r !== p) { if (i >= n - 29) crosses++; lastIdx = i; lastDir = r; }
  }
  const spread = f[n] != null && s[n] != null && a[n] ? Math.abs(f[n]! - s[n]!) / a[n]! : undefined;
  const slopeRef = s[n - 3], slope = s[n] != null && slopeRef != null && a[n] ? (s[n]! - slopeRef) / a[n]! : 0;
  return {
    fast: f[n], slow: s[n], rel: rel(n) === 0 ? "UNKNOWN" : rel(n) === 1 ? "ABOVE" : "BELOW",
    lastCross: lastDir === 0 ? undefined : lastDir === 1 ? "BULLISH" : "BEARISH",
    barsSinceCross: lastIdx < 0 ? undefined : n - lastIdx,
    crossesLast30: crosses,
    chop: crosses >= 3 || (spread != null && spread < 0.25),
    spreadAtr: spread, slowSlope: slope > 0.05 ? "UP" : slope < -0.05 ? "DOWN" : "FLAT",
  };
}

// ─────────────────────────────────────────────────────────────
// Market structure: swings, trend (HH/HL vs LH/LL), BOS / CHoCH on candle CLOSES
// ─────────────────────────────────────────────────────────────
export interface Swing { i: number; price: number }

export function swings(c: Candle[], k = 2): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [], lows: Swing[] = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(c[i].h > c[i - j].h && c[i].h > c[i + j].h)) isH = false;
      if (!(c[i].l < c[i - j].l && c[i].l < c[i + j].l)) isL = false;
    }
    if (isH) highs.push({ i, price: c[i].h });
    if (isL) lows.push({ i, price: c[i].l });
  }
  return { highs, lows };
}

export interface Structure {
  trend: "UP" | "DOWN" | "RANGE"; lastHigh?: Swing; lastLow?: Swing;
  event?: "BOS_UP" | "BOS_DOWN" | "CHOCH_UP" | "CHOCH_DOWN"; eventBarsAgo?: number;
}

export function structure(c: Candle[], k = 2, lookback = 3): Structure {
  const { highs, lows } = swings(c, k);
  const h2 = highs.slice(-2), l2 = lows.slice(-2);
  let trend: Structure["trend"] = "RANGE";
  if (h2.length === 2 && l2.length === 2) {
    if (h2[1].price > h2[0].price && l2[1].price > l2[0].price) trend = "UP";
    else if (h2[1].price < h2[0].price && l2[1].price < l2[0].price) trend = "DOWN";
  }
  const lastHigh = highs[highs.length - 1], lastLow = lows[lows.length - 1];
  let event: Structure["event"]; let eventBarsAgo: number | undefined;
  const n = c.length - 1;
  for (let b = 0; b < lookback && n - b > 0; b++) {
    const idx = n - b;
    // a break counts only if the CLOSE is beyond a swing that formed before this candle
    const hh = [...highs].reverse().find((s) => s.i < idx - k);
    const ll = [...lows].reverse().find((s) => s.i < idx - k);
    if (hh && c[idx].c > hh.price && c[idx - 1].c <= hh.price) { event = trend === "UP" ? "BOS_UP" : "CHOCH_UP"; eventBarsAgo = b; break; }
    if (ll && c[idx].c < ll.price && c[idx - 1].c >= ll.price) { event = trend === "DOWN" ? "BOS_DOWN" : "CHOCH_DOWN"; eventBarsAgo = b; break; }
  }
  return { trend, lastHigh, lastLow, event, eventBarsAgo };
}

// ─────────────────────────────────────────────────────────────
// Liquidity: pools (where stops sit), sweeps (stop-hunt + reclaim), accepted breaks, FVG
// ─────────────────────────────────────────────────────────────
export interface Pool { price: number; kind: string; side: "above" | "below" }
export interface Sweep { kind: "SWEEP_LOW_RECLAIM" | "SWEEP_HIGH_REJECT"; level: number; poolKind: string; barsAgo: number; bias: "BULLISH" | "BEARISH" }
export interface Fvg { dir: "BULLISH" | "BEARISH"; lo: number; hi: number; barsAgo: number }

const ROUND_STEP: Record<string, number> = { NIFTY: 100, BANKNIFTY: 500, FINNIFTY: 100, MIDCPNIFTY: 100, SENSEX: 500 };

export function liquidityPools(c: Candle[], symbol: string, atrNow: number, k = 2): Pool[] {
  const spot = c[c.length - 1].c;
  const pools: Pool[] = [];
  const add = (price: number | undefined, kind: string) => {
    if (price == null || !Number.isFinite(price)) return;
    pools.push({ price, kind, side: price >= spot ? "above" : "below" });
  };
  // previous day / today H-L
  const today = istDay(c[c.length - 1].t);
  const prev = c.filter((x) => istDay(x.t) < today);
  const cur = c.filter((x) => istDay(x.t) === today);
  if (prev.length) {
    const pd = istDay(prev[prev.length - 1].t);
    const pdc = prev.filter((x) => istDay(x.t) === pd);
    add(Math.max(...pdc.map((x) => x.h)), "prev-day-high"); add(Math.min(...pdc.map((x) => x.l)), "prev-day-low");
  }
  if (cur.length > 3) { add(Math.max(...cur.slice(0, -1).map((x) => x.h)), "today-high"); add(Math.min(...cur.slice(0, -1).map((x) => x.l)), "today-low"); }
  // opening range (first 15 minutes ≈ first 3 x 5m or 1 x 15m candles — approximated by first 3 candles of today)
  if (cur.length >= 4) { const or = cur.slice(0, 3); add(Math.max(...or.map((x) => x.h)), "opening-range-high"); add(Math.min(...or.map((x) => x.l)), "opening-range-low"); }
  // equal highs / lows from swings (within 0.1 ATR) — resting stops
  const { highs, lows } = swings(c, k);
  const tol = 0.1 * atrNow;
  const eq = (arr: Swing[], kind: string) => {
    const recent = arr.slice(-8);
    for (let a = 0; a < recent.length; a++) for (let b = a + 1; b < recent.length; b++) {
      if (Math.abs(recent[a].price - recent[b].price) <= tol) add((recent[a].price + recent[b].price) / 2, kind);
    }
  };
  eq(highs, "equal-highs"); eq(lows, "equal-lows");
  // swing extremes + nearest round numbers
  add(highs[highs.length - 1]?.price, "swing-high"); add(lows[lows.length - 1]?.price, "swing-low");
  const rs = ROUND_STEP[symbol.toUpperCase()] ?? 100;
  add(Math.floor(spot / rs) * rs, "round-number"); add(Math.ceil(spot / rs) * rs, "round-number");
  // dedupe near-identical prices of the SAME kind (roles like round-number vs swing-high are distinct reads)
  const uniq: Pool[] = [];
  for (const p of pools.sort((x, y) => x.price - y.price)) if (!uniq.some((u) => Math.abs(u.price - p.price) <= tol && u.side === p.side && u.kind === p.kind)) uniq.push(p);
  return uniq;
}

/** Wick through a pool + CLOSE back inside = sweep (stop-hunt). Close beyond and holding = real break, not a sweep. */
export function detectSweeps(c: Candle[], pools: Pool[], atrNow: number, lookback = 3): Sweep[] {
  const out: Sweep[] = [];
  const n = c.length - 1;
  for (let b = 0; b < lookback && n - b >= 0; b++) {
    const x = c[n - b];
    // Sweep typing rules:
    //  - a BULLISH sweep can only come from a LOW-type pool (below price)
    //  - a BEARISH sweep can only come from a HIGH-type pool (above price)
    //  - an ambiguous OUTSIDE bar (pierces a pool on both sides) is ignored
    const piercesLow = pools.some((p) => p.side === "below" && x.l < p.price && p.price <= x.h);
    const piercesHigh = pools.some((p) => p.side === "above" && x.h > p.price && p.price >= x.l);
    if (piercesLow && piercesHigh) continue; // ambiguous outside bar — no sweep
    for (const p of pools) {
      if (p.side === "below") {
        // sell-side liquidity: low pierces the pool, closes back above
        if (x.l < p.price && x.c > p.price && p.price - x.l >= 0.15 * atrNow && p.price <= x.h) {
          out.push({ kind: "SWEEP_LOW_RECLAIM", level: p.price, poolKind: p.kind, barsAgo: b, bias: "BULLISH" });
        }
      } else {
        // buy-side liquidity: high pierces the pool, closes back below
        if (x.h > p.price && x.c < p.price && x.h - p.price >= 0.15 * atrNow && p.price >= x.l) {
          out.push({ kind: "SWEEP_HIGH_REJECT", level: p.price, poolKind: p.kind, barsAgo: b, bias: "BEARISH" });
        }
      }
    }
  }
  return out;
}

export function fairValueGaps(c: Candle[], maxBars = 30): Fvg[] {
  const out: Fvg[] = [];
  const n = c.length - 1;
  for (let i = Math.max(2, n - maxBars); i <= n; i++) {
    if (c[i].l > c[i - 2].h) out.push({ dir: "BULLISH", lo: c[i - 2].h, hi: c[i].l, barsAgo: n - i });
    if (c[i].h < c[i - 2].l) out.push({ dir: "BEARISH", lo: c[i].h, hi: c[i - 2].l, barsAgo: n - i });
  }
  // keep only unfilled, and only the earliest gap per imbalance (later overlapping gaps are continuations)
  const kept: Fvg[] = [];
  for (const g of out) {
    const after = c.slice(c.length - g.barsAgo);
    const filled = g.dir === "BULLISH" ? after.some((x) => x.l <= g.lo) : after.some((x) => x.h >= g.hi);
    if (filled) continue;
    if (kept.some((k) => k.dir === g.dir && k.lo <= g.hi && g.lo <= k.hi)) continue;
    kept.push(g);
  }
  return kept;
}

// ─────────────────────────────────────────────────────────────
// One technical read per timeframe
// ─────────────────────────────────────────────────────────────
export interface TfRead {
  tf: string; bars: number; close: number; atr: number;
  st: { dir: 1 | -1 | 0; line?: number; barsSinceFlip?: number };
  ema: EmaState; vwap?: number; vsVwap?: "ABOVE" | "BELOW" | "NA";
  structure: Structure; pools: Pool[]; sweeps: Sweep[]; fvg: Fvg[];
  warnings: string[];
}

export interface TechParams { stPeriod: number; stMult: number; emaFast: number; emaSlow: number }
export const DEFAULT_PARAMS: TechParams = { stPeriod: 10, stMult: 3, emaFast: 9, emaSlow: 21 };

export function analyzeTf(tf: string, candlesIn: Candle[], symbol: string, p: TechParams = DEFAULT_PARAMS, nowMs = Date.now()): TfRead | null {
  const c = closedOnly(candlesIn, nowMs);
  if (c.length < Math.max(p.emaSlow, p.stPeriod) + 10) return null;
  const a = atrSeries(c, 14); const atrNow = a[a.length - 1];
  if (!atrNow) return null;
  const st = superTrend(c, p.stPeriod, p.stMult);
  const n = c.length - 1;
  const vw = vwapSeries(c)[n];
  const em = emaCross(c, p.emaFast, p.emaSlow);
  const pools = liquidityPools(c, symbol, atrNow);
  const warnings: string[] = [];
  if (vw == null) warnings.push("no VWAP (index spot candles have no volume — use futures candles for VWAP)");
  if (em.chop) warnings.push(`EMA ${p.emaFast}/${p.emaSlow} chop: ${em.crossesLast30} crosses in 30 bars / spread ${em.spreadAtr?.toFixed(2)} ATR — crossovers unreliable here`);
  const flat = st.dir.slice(-12).some((d, i, arr) => i > 0 && d !== arr[i - 1]);
  if (flat) warnings.push("SuperTrend flipped within the last 12 bars — trend-following signals are whipsawing");
  return {
    tf, bars: c.length, close: c[n].c, atr: atrNow,
    st: { dir: st.dir[n], line: st.line[n], barsSinceFlip: st.lastFlip != null ? n - st.lastFlip : undefined },
    ema: em, vwap: vw, vsVwap: vw == null ? "NA" : c[n].c >= vw ? "ABOVE" : "BELOW",
    structure: structure(c), pools, sweeps: detectSweeps(c, pools, atrNow), fvg: fairValueGaps(c), warnings,
  };
}

// ─────────────────────────────────────────────────────────────
// APPLY: map indicators → gate layers (structure on the trend TF, trigger on the entry TF)
// ─────────────────────────────────────────────────────────────
export function structureLayer(r: TfRead, dir: "call" | "put"): Layer {
  const want = dir === "call" ? 1 : -1;
  const votes: string[] = []; let agree = 0, against = 0;
  const vote = (ok: boolean | null, label: string) => { if (ok === true) { agree++; votes.push("+" + label); } else if (ok === false) { against++; votes.push("-" + label); } };
  vote(r.st.dir === 0 ? null : r.st.dir === want, `SuperTrend ${r.st.dir === 1 ? "up" : r.st.dir === -1 ? "down" : "n/a"}`);
  if (r.ema.chop) votes.push("~EMA suppressed (chop)"); // unreliable when whipsawing — cannot count toward agreement
  else vote(r.ema.rel === "UNKNOWN" ? null : (r.ema.rel === "ABOVE") === (want === 1), `EMA ${r.ema.rel.toLowerCase()}`);
  vote(r.structure.trend === "RANGE" ? null : (r.structure.trend === "UP") === (want === 1), `structure ${r.structure.trend}`);
  if (r.structure.event === (want === 1 ? "CHOCH_DOWN" : "CHOCH_UP")) { against++; votes.push("-CHoCH against"); }
  if (r.structure.event === (want === 1 ? "BOS_UP" : "BOS_DOWN") || r.structure.event === (want === 1 ? "CHOCH_UP" : "CHOCH_DOWN")) { agree++; votes.push("+break in direction"); }
  const ev = `${r.tf}: ${votes.join(", ")}${r.ema.chop ? " | CHOP warning" : ""}`;
  if (agree >= 3 && against === 0) return { state: "agree", evidence: ev };
  if (against >= 2 && agree === 0) return { state: "against", evidence: ev };
  return { state: "neutral", evidence: ev };
}

export function triggerLayer(r: TfRead, dir: "call" | "put"): Layer {
  const want = dir === "call";
  const hits: string[] = []; const opp: string[] = [];
  const sw = r.sweeps.find((s) => s.bias === (want ? "BULLISH" : "BEARISH"));
  const swOpp = r.sweeps.find((s) => s.bias === (want ? "BEARISH" : "BULLISH"));
  if (sw) hits.push(`${sw.kind} at ${sw.level.toFixed(0)} (${sw.poolKind}) ${sw.barsAgo} bar(s) ago`);
  if (swOpp) opp.push(`${swOpp.kind} at ${swOpp.level.toFixed(0)}`);
  const crossFresh = r.ema.barsSinceCross != null && r.ema.barsSinceCross <= 3 && !r.ema.chop
    && (r.structure.trend === "RANGE" || (r.structure.trend === "UP") === want); // cross must be WITHIN the trend
  if (crossFresh && r.ema.lastCross === (want ? "BULLISH" : "BEARISH") && (r.vsVwap === "NA" || (r.vsVwap === "ABOVE") === want) && r.st.dir === (want ? 1 : -1)) hits.push(`fresh ${r.ema.lastCross} EMA cross + SuperTrend + VWAP side`);
  if (crossFresh && r.ema.lastCross === (want ? "BEARISH" : "BULLISH")) opp.push("fresh opposite EMA cross");
  if (r.structure.eventBarsAgo != null && r.structure.eventBarsAgo <= 2) {
    const e = r.structure.event;
    if (e === (want ? "BOS_UP" : "BOS_DOWN") || e === (want ? "CHOCH_UP" : "CHOCH_DOWN")) hits.push(`${e} on a closed candle`);
    if (e === (want ? "CHOCH_DOWN" : "CHOCH_UP") || e === (want ? "BOS_DOWN" : "BOS_UP")) opp.push(String(e));
  }
  const ev = `${r.tf}: ${hits.join("; ") || "no trigger"}${opp.length ? " | against: " + opp.join("; ") : ""}`;
  if (opp.length && !hits.length) return { state: "against", evidence: ev };
  if (hits.length && !opp.length) return { state: "agree", evidence: ev };
  return { state: "neutral", evidence: ev };
}

/** Stop on the UNDERLYING with a buffer (never at the exact obvious level), target = next opposing pool. */
export function suggestLevels(trend: TfRead, entry: TfRead, dir: "call" | "put") {
  const spot = entry.close, buf = 0.25 * entry.atr;
  const want = dir === "call";
  const cands: number[] = [];
  if (want) {
    if (trend.structure.lastLow) cands.push(trend.structure.lastLow.price - buf);
    if (trend.st.line != null && trend.st.dir === 1) cands.push(trend.st.line - buf);
    const sw = entry.sweeps.find((s) => s.bias === "BULLISH"); if (sw) cands.push(sw.level - 0.5 * entry.atr);
  } else {
    if (trend.structure.lastHigh) cands.push(trend.structure.lastHigh.price + buf);
    if (trend.st.line != null && trend.st.dir === -1) cands.push(trend.st.line + buf);
    const sw = entry.sweeps.find((s) => s.bias === "BEARISH"); if (sw) cands.push(sw.level + 0.5 * entry.atr);
  }
  const valid = cands.filter((x) => (want ? x < spot : x > spot));
  if (!valid.length) return null;
  // nearest valid structural stop, but not tighter than 0.5 ATR (noise)
  const stop = want ? Math.max(...valid.filter((x) => spot - x >= 0.5 * entry.atr), Math.min(...valid)) : Math.min(...valid.filter((x) => x - spot >= 0.5 * entry.atr), Math.max(...valid));
  const targets = (want ? trend.pools.filter((p) => p.price > spot + entry.atr) : trend.pools.filter((p) => p.price < spot - entry.atr))
    .sort((a, b) => (want ? a.price - b.price : b.price - a.price));
  const target = targets[0]?.price;
  const risk = Math.abs(spot - stop);
  return {
    spot, stop, riskPts: risk, target, targetKind: targets[0]?.kind,
    targetPts: target != null ? Math.abs(target - spot) : undefined,
    underlyingRR: target != null && risk > 0 ? Math.abs(target - spot) / risk : undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Backtest: did this indicator have ANY edge on this data? (underlying R-multiples, no costs/slippage)
// ─────────────────────────────────────────────────────────────
export type SignalName = "ema_cross" | "supertrend_flip" | "sweep_reclaim";

export function signalSeries(c: Candle[], name: SignalName, p: TechParams = DEFAULT_PARAMS): (1 | -1 | 0)[] {
  const n = c.length, sig: (1 | -1 | 0)[] = new Array(n).fill(0);
  if (name === "ema_cross") {
    const f = emaSeries(c.map((x) => x.c), p.emaFast), s = emaSeries(c.map((x) => x.c), p.emaSlow);
    for (let i = p.emaSlow + 1; i < n; i++) {
      if (f[i] == null || s[i] == null || f[i - 1] == null || s[i - 1] == null) continue;
      if (f[i - 1]! <= s[i - 1]! && f[i]! > s[i]!) sig[i] = 1;
      if (f[i - 1]! >= s[i - 1]! && f[i]! < s[i]!) sig[i] = -1;
    }
  } else if (name === "supertrend_flip") {
    const st = superTrend(c, p.stPeriod, p.stMult);
    for (let i = 1; i < n; i++) if (st.dir[i] !== 0 && st.dir[i - 1] !== 0 && st.dir[i] !== st.dir[i - 1]) sig[i] = st.dir[i];
  } else {
    const L = 20;
    for (let i = L; i < n; i++) {
      const lo = Math.min(...c.slice(i - L, i).map((x) => x.l)), hi = Math.max(...c.slice(i - L, i).map((x) => x.h));
      if (c[i].l < lo && c[i].c > lo) sig[i] = 1;
      else if (c[i].h > hi && c[i].c < hi) sig[i] = -1;
    }
  }
  return sig;
}

export interface BtResult {
  signal: string; trades: number; winRate: number; wrLo: number; wrHi: number; breakevenWR: number;
  avgR: number; expectancyR: number; maxLossStreak: number; verdict: string;
}

export function backtestSignal(
  c: Candle[], name: SignalName,
  o: { stopAtr?: number; rr?: number; maxHold?: number; params?: TechParams } = {}
): BtResult | null {
  const stopAtr = o.stopAtr ?? 1.5, rr = o.rr ?? 2, maxHold = o.maxHold ?? 24;
  if (c.length < 80) return null;
  const sig = signalSeries(c, name, o.params);
  const atr = atrSeries(c, 14);
  const Rs: number[] = [];
  let i = 40;
  while (i < c.length - 2) {
    const s = sig[i], a = atr[i];
    if (!s || !a) { i++; continue; }
    const entry = c[i + 1].o, risk = stopAtr * a;
    const stop = entry - s * risk, target = entry + s * rr * risk;
    const day0 = istDay(c[i + 1].t);
    let R: number | null = null, j = i + 1;
    for (; j <= Math.min(c.length - 1, i + maxHold); j++) {
      if (istDay(c[j].t) !== day0) { R = ((c[j - 1].c - entry) * s) / risk; j--; break; } // intraday: flat at day end
      const hitStop = s > 0 ? c[j].l <= stop : c[j].h >= stop;
      const hitTgt = s > 0 ? c[j].h >= target : c[j].l <= target;
      if (hitStop) { R = -1; break; }               // conservative: stop wins a same-bar tie
      if (hitTgt) { R = rr; break; }
    }
    if (R == null) { const jj = Math.min(j, c.length - 1); R = ((c[jj].c - entry) * s) / risk; }
    Rs.push(R); i = Math.max(i + 1, j + 1);
  }
  const n = Rs.length;
  if (n === 0) return null;
  const wins = Rs.filter((r) => r > 0).length;
  const winR = Rs.filter((r) => r > 0), lossR = Rs.filter((r) => r <= 0);
  const avgWin = winR.length ? winR.reduce((s, r) => s + r, 0) / winR.length : 0;
  const avgLoss = lossR.length ? Math.abs(lossR.reduce((s, r) => s + r, 0) / lossR.length) : 1;
  const be = avgWin > 0 ? avgLoss / (avgWin + avgLoss) : 1;
  const { lo, hi } = wilson(wins, n);
  let streak = 0, maxStreak = 0;
  for (const r of Rs) { streak = r <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const exp = Rs.reduce((s, r) => s + r, 0) / n;
  const verdict = n < 30 ? "INSUFFICIENT DATA (<30 signals) — do not conclude anything"
    : hi < be ? "NO EDGE — win-rate is below break-even with ~95% confidence on this sample"
    : exp > 0 && lo > be ? "POSITIVE on this sample (still paper-trade; costs/slippage not included)"
    : "INCONCLUSIVE — cannot separate from luck";
  return { signal: name, trades: n, winRate: wins / n, wrLo: lo, wrHi: hi, breakevenWR: be, avgR: avgWin * (wins / n) - avgLoss * (1 - wins / n), expectancyR: exp, maxLossStreak: maxStreak, verdict };
}

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────
const f1 = (x?: number) => (x == null ? "—" : x.toFixed(1));

export function formatTf(r: TfRead): string {
  const L: string[] = [];
  L.push(`[${r.tf}] close ${f1(r.close)} | ATR14 ${f1(r.atr)} | bars ${r.bars}`);
  L.push(`  SuperTrend: ${r.st.dir === 1 ? "UP" : r.st.dir === -1 ? "DOWN" : "n/a"} line ${f1(r.st.line)}${r.st.barsSinceFlip != null ? ` (flipped ${r.st.barsSinceFlip} bars ago)` : ""}`);
  L.push(`  EMA fast/slow: ${f1(r.ema.fast)}/${f1(r.ema.slow)} → ${r.ema.rel}${r.ema.lastCross ? `, last cross ${r.ema.lastCross} ${r.ema.barsSinceCross} bars ago` : ""} | slope ${r.ema.slowSlope} | crosses(30) ${r.ema.crossesLast30}${r.ema.chop ? " ⚠ CHOP" : ""}`);
  L.push(`  VWAP: ${f1(r.vwap)} (${r.vsVwap})`);
  const s = r.structure;
  L.push(`  Structure: ${s.trend}${s.lastHigh ? ` | last swing high ${f1(s.lastHigh.price)}` : ""}${s.lastLow ? ` | last swing low ${f1(s.lastLow.price)}` : ""}${s.event ? ` | ${s.event} ${s.eventBarsAgo} bar(s) ago` : ""}`);
  const above = r.pools.filter((p) => p.side === "above").sort((a, b) => a.price - b.price).slice(0, 3);
  const below = r.pools.filter((p) => p.side === "below").sort((a, b) => b.price - a.price).slice(0, 3);
  L.push(`  Liquidity above: ${above.map((p) => `${f1(p.price)} (${p.kind})`).join(", ") || "—"}`);
  L.push(`  Liquidity below: ${below.map((p) => `${f1(p.price)} (${p.kind})`).join(", ") || "—"}`);
  L.push(`  Sweeps (last 3 closed bars): ${r.sweeps.map((w) => `${w.kind} @${f1(w.level)} [${w.poolKind}] ${w.barsAgo} ago`).join("; ") || "none"}`);
  if (r.fvg.length) L.push(`  Unfilled FVG: ${r.fvg.slice(-3).map((g) => `${g.dir} ${f1(g.lo)}-${f1(g.hi)}`).join("; ")}`);
  for (const w of r.warnings) L.push(`  ⚠ ${w}`);
  return L.join("\n");
}

export const INDICATOR_KNOWLEDGE = `## INDICATORS — how to USE them (use check_indicators; never quote indicator values from memory)
- SuperTrend (10,3): trend filter. Line below price = uptrend (buy CE bias), above = downtrend (PE bias). A flip is a late signal; many flips in 12 bars = chop → do not trade it.
- EMA 9/21 crossover: only matters when the EMAs are spread apart and sloping. 3+ crosses in 30 bars or spread < 0.25 ATR = chop — ignore crossovers there. A cross is a TRIGGER only with SuperTrend + VWAP side agreeing.
- VWAP: price above = buyers in control (CE bias), below = PE bias. Index spot has no volume — use futures candles.
- Structure: HH+HL = uptrend, LH+LL = downtrend. BOS = close beyond the last swing in trend direction (continuation). CHoCH = close beyond the last swing AGAINST the trend (first warning of reversal). Use CLOSES, not wicks.
- Liquidity: stops rest above equal highs / prev-day high and below equal lows / prev-day low. Sweep = wick through the pool then CLOSE back inside (stop hunt) → fade it; close beyond AND holds = real break → go with it. Distinguish by the close and by whether the next candle holds.
- Apply as LAYERS: 15m structure (SuperTrend + EMA + HH/HL/BOS) → structure layer; 5m sweep-reclaim / fresh cross with VWAP+SuperTrend / BOS on a closed candle → trigger layer. Stop on the underlying beyond the structure + 0.25 ATR buffer; target = next liquidity pool; need chart R:R ≥ 1:2.
- Indicators lag and whipsaw. Before leaning on one, run backtest_indicator; if it says NO EDGE or INSUFFICIENT, treat it as decoration. Not financial advice.`;

// ─────────────────────────────────────────────────────────────
// Tool defs + executors
// ─────────────────────────────────────────────────────────────
export const INDICATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_indicators",
      description:
        "Compute SuperTrend, EMA crossover (with chop filter), VWAP, market structure (HH/HL, BOS, CHoCH) and liquidity (equal highs/lows, prev-day H/L, sweeps, FVG) from live candles on a trend timeframe (default 15m) and an entry timeframe (default 5m). If direction is given, also returns the structure + trigger layers, a structural stop on the underlying and the next-liquidity target with chart R:R. Use for: supertrend, EMA crossover, liquidity, sweep, BOS/CHoCH, VWAP, 'is the trend up', 'confirm entry'.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX (futures candles preferred for VWAP)" },
          direction: { type: "string", enum: ["call", "put"], description: "Optional: evaluate for a CE or PE idea" },
          trendTf: { type: "string", description: "Trend timeframe, default 15m" },
          entryTf: { type: "string", description: "Entry/trigger timeframe, default 5m" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "backtest_indicator",
      description:
        "Check whether an indicator signal has had an edge on recent candles: ema_cross, supertrend_flip or sweep_reclaim. ATR stop, fixed R target, intraday flat at day end. Returns trades, win-rate with 95% interval vs break-even, expectancy in R and a plain verdict. Use before trusting an indicator.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          signal: { type: "string", enum: ["ema_cross", "supertrend_flip", "sweep_reclaim"] },
          tf: { type: "string", description: "Timeframe, default 5m" },
          stopAtr: { type: "number", description: "Stop distance in ATR (default 1.5)" },
          rr: { type: "number", description: "Target in R (default 2)" },
        },
        required: ["signal"],
      },
    },
  },
];

/** ADAPT'd for this repo: the real intraday candle API is /api/breeze/candles (Breeze + daily fallback). */
export const CANDLE_URL = (base: string, symbol: string, tf: string) =>
  `${base}/api/breeze/candles?symbol=${enc(symbol)}&interval=${enc(tf)}&limit=600`;

export async function fetchCandles(base: string, symbol: string, tf: string): Promise<{ ok: true; candles: Candle[] } | { ok: false; error: string }> {
  const r = await getJSON(CANDLE_URL(base, symbol, tf), { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, error: r.error ?? "candle fetch failed" };
  const d: any = r.data;
  const arr = d?.data?.candles ?? d?.candles ?? (Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : null);
  if (!Array.isArray(arr)) return { ok: false, error: "no candle array in response" };
  const candles = normalizeCandles(arr);
  return candles.length ? { ok: true, candles } : { ok: false, error: "candle array empty/unparseable" };
}

export async function runCheckIndicators(
  args: any, base: string, state: { lastTech?: any }, fallbackSymbol = "NIFTY"
): Promise<string> {
  const symbol = safeSymbol(args?.symbol, fallbackSymbol);
  const trendTf = String(args?.trendTf || "15m"), entryTf = String(args?.entryTf || "5m");
  const [a, b] = await Promise.all([fetchCandles(base, symbol, trendTf), fetchCandles(base, symbol, entryTf)]);
  if (!a.ok || !b.ok) {
    return `Candles unavailable (${!a.ok ? `${trendTf}: ${a.error}` : ""} ${!b.ok ? `${entryTf}: ${b.error}` : ""}). Do NOT invent indicator values — say the candle feed is down.`;
  }
  const T = analyzeTf(trendTf, a.candles, symbol), E = analyzeTf(entryTf, b.candles, symbol);
  if (!E) return "Not enough closed candles to compute indicators (need ~40+ closed bars on the entry timeframe). Do NOT invent values.";
  // Trend TF can be thin (Breeze lookback limits) — fall back to the entry read rather than failing
  let trendRead = T, trendNote = "";
  if (!trendRead) {
    trendRead = E;
    trendNote = `⚠ trend TF ${trendTf} too thin (${a.candles.length} candles) — structure read falling back to ${entryTf}.`;
  }
  const lines = [`INDICATOR READ — ${symbol} (closed candles only)${trendNote ? `\n${trendNote}` : ""}`, formatTf(trendRead), formatTf(E)];
  const dir = args?.direction === "call" || args?.direction === "put" ? (args.direction as "call" | "put") : undefined;
  if (dir) {
    const sl = structureLayer(trendRead, dir), tl = triggerLayer(E, dir), lv = suggestLevels(trendRead, E, dir);
    state.lastTech = { dir, structure: sl, trigger: tl, levels: lv };
    lines.push("", `APPLIED TO ${dir.toUpperCase()}:`, `  structure layer → ${sl.state.toUpperCase()}  (${sl.evidence})`, `  trigger layer → ${tl.state.toUpperCase()}  (${tl.evidence})`);
    lines.push(lv
      ? `  underlying plan → stop ${f1(lv.stop)} (${f1(lv.riskPts)} pts incl. 0.25 ATR buffer) | target ${f1(lv.target)} ${lv.targetKind ? `(${lv.targetKind})` : ""} ${lv.targetPts != null ? `${f1(lv.targetPts)} pts` : ""} | chart R:R ${lv.underlyingRR != null ? "1:" + lv.underlyingRR.toFixed(2) : "n/a (no liquidity target ahead)"}`
      : "  underlying plan → no valid structural stop on the correct side; do not force one");
    lines.push("  Feed these into evaluate_trade_gate (structure, trigger, underlyingRR, targetPts). Stops are beyond structure + buffer; never widen after entry.");
  }
  lines.push("", "Indicators lag and whipsaw in chop; this is confluence, not a signal on its own. Not financial advice.");
  return lines.join("\n");
}

export async function runBacktestIndicator(args: any, base: string, fallbackSymbol = "NIFTY"): Promise<string> {
  const symbol = safeSymbol(args?.symbol, fallbackSymbol);
  const tf = String(args?.tf || "5m");
  const name = args?.signal as SignalName;
  if (!["ema_cross", "supertrend_flip", "sweep_reclaim"].includes(name)) return "signal must be ema_cross | supertrend_flip | sweep_reclaim";
  const cr = await fetchCandles(base, symbol, tf);
  if (!cr.ok) return `Candles unavailable (${cr.error}). Cannot backtest — do not guess results.`;
  const res = backtestSignal(closedOnly(cr.candles), name, { stopAtr: Number(args?.stopAtr) || 1.5, rr: Number(args?.rr) || 2 });
  if (!res) return "Too few candles/signals to backtest.";
  return [
    `BACKTEST ${name} on ${symbol} ${tf} (${cr.candles.length} candles) — underlying R-multiples, ATR stop ${args?.stopAtr || 1.5}, target ${args?.rr || 2}R, intraday flat at day end`,
    `Signals: ${res.trades} | win-rate ${(res.winRate * 100).toFixed(0)}% [95% CI ${(res.wrLo * 100).toFixed(0)}-${(res.wrHi * 100).toFixed(0)}%] vs break-even ${(res.breakevenWR * 100).toFixed(0)}% | expectancy ${res.expectancyR.toFixed(2)}R/trade | longest losing streak ${res.maxLossStreak}`,
    `Verdict: ${res.verdict}`,
    "Caveats: no costs/slippage, underlying not option P&L, one sample window, parameters not optimised. Paper-trade before trusting. Not financial advice.",
  ].join("\n");
}
