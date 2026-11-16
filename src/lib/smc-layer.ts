// smc-layer.ts
// SMC (Smart Money Concepts) layer — objective, observable-only definitions.
// No "operator" or "smart money" intent claims. Price, volume and OI behaviour only.
// Integrates with layer-builder.ts GateLayer contract and GATE_CONFIG gates.
// Cap: SMC contributes at most 2 scorecard points; never overrides failed OI/Greeks gates.

import { GATE_CONFIG, type GateLayer } from "./agent-brain-gate";
import { type Candle, type Pool, atrSeries, liquidityPools } from "./tech-read";

// ─────────────────────────────────────────────────────────────
// Types (local — do not import Fvg from tech-read; shapes differ)
// ─────────────────────────────────────────────────────────────

export interface MarkedLevel {
  kind: "prev-day-high" | "prev-day-low" | "or-high" | "or-low" | "swing-high" | "swing-low" | "round-number" | "vwap-1sd-up" | "vwap-1sd-down" | "vwap-2sd-up" | "vwap-2sd-down" | "oi-strike";
  price: number;
  distPts: number;
  distPct: number;
  swept: boolean;
  sweepTime: string | null;
  sweepBarsAgo: number | null;
  closeBackInside: boolean;
  closeBackBar: number | null;
  volumeVsAvg: number | null;
  side: "above" | "below";
}

export interface SweepEvent {
  levelPrice: number;
  levelKind: string;
  side: "above" | "below";
  breakBarIdx: number;
  breakTime: string;
  breakPct: number;
  closeBackBarIdx: number | null;
  closeBackTime: string | null;
  closeBackInside: boolean;
  volumeVsAvg: number | null;
  barsAgo: number;
}

export interface CHoCHEvent {
  dir: "bullish" | "bearish";
  swingPrice: number;
  closeTime: string;
  barsAgo: number;
  afterSweep: boolean;
}

export interface Displacement {
  barIdx: number;
  time: string;
  range: number;
  atr14: number;
  ratio: number;
  closeInOuter25: boolean;
  dir: "up" | "down";
}

export interface SMCFvg {
  dir: "bullish" | "bearish";
  lo: number;
  hi: number;
  barIdx: number;
  barsAgo: number;
  filled: boolean;
}

export interface SMCOrderBlock {
  barIdx: number;
  time: string;
  dir: "bullish" | "bearish";
  lo: number;
  hi: number;
  displacementBarIdx: number;
}

/** Structure event: HH/HL/LH/LL label or a BOS/CHOCH break. */
export interface StructureEvent {
  type: "HH" | "HL" | "LH" | "LL" | "BOS" | "CHOCH";
  dir: "bullish" | "bearish";
  price: number;
  time: string;
  barsAgo: number;
}

/** Equal highs / equal lows — clustered swing liquidity. */
export interface EqualLevel {
  price: number;
  side: "high" | "low";
  count: number;
  swept: boolean;
  sweptBarsAgo: number | null;
}

/** Premium / discount position inside the recent swing range. */
export interface PremiumDiscount {
  zone: "premium" | "discount" | "none";
  mid: number | null;
  swingHigh: number | null;
  swingLow: number | null;
  /** 0 = at swing low, 100 = at swing high. null when range unknown. */
  positionPct: number | null;
}

export interface SMCResult {
  spot: number;
  atr14: number | null;
  levels: MarkedLevel[];
  sweeps: SweepEvent[];
  choch: CHoCHEvent[];
  displacements: Displacement[];
  fvgs: SMCFvg[];
  orderBlocks: SMCOrderBlock[];
  /** HH/HL/LH/LL + BOS/CHOCH timeline (recent → old order preserved). */
  structure: StructureEvent[];
  structureTrend: "UP" | "DOWN" | "SIDEWAYS";
  /** Equal highs / equal lows clusters (swing liquidity). */
  equalLevels: EqualLevel[];
  /** Sweeps that closed back inside = liquidity grabbed then reclaimed. */
  liquidityGrabs: number;
  premiumDiscount: PremiumDiscount;
  g16: { passed: boolean; reason: string };
  g17: { passed: boolean; reason: string };
  g18: { passed: boolean; reason: string };
  g19: { passed: boolean; reason: string; stopPrice?: number | null };
  scorePoints: number;
  scoreReason: string;
  footprints: string[];
  tableRows: Array<{ level: string; price: number; distPts: number; distPct: string; swept: string; closeBack: string; volVsAvg: string }>;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const num = (v: any): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function roundPct(x: number): string {
  return (x * 100).toFixed(2) + "%";
}

function istTime(ms: number): string {
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 16);
}

// ─────────────────────────────────────────────────────────────
// Marked levels
// ─────────────────────────────────────────────────────────────

/**
 * Raw candle shape accepted by analyzeSMCFromCandles — the Breeze/NSE 5m
 * rows ({ time, open, high, low, close, volume }) and any numeric-epoch
 * variant. Tolerant by design: a missing/invalid bar is skipped, never faked.
 */
export interface RawSMCandle {
  time?: string | number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

/**
 * Parse a candle timestamp to epoch ms.
 *
 * Breeze sends IST wall-clock strings ("2026-11-17 09:15:00"). `Date.parse`
 * treats such a string as LOCAL time, so a browser (or server) outside IST
 * would place every bar at the wrong instant — shifting the session day and
 * the bar spacing the SMC engine reasons about. The IST wall clock is
 * therefore converted explicitly (IST = UTC+5:30, no DST).
 */
export function parseCandleTimeMs(raw: string | number | undefined | null): number {
  if (raw == null) return NaN;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  // "YYYY-MM-DD HH:MM:SS" (Breeze) → IST wall clock → epoch ms.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const ms = Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
    );
    return ms - 5.5 * 3600_000;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * ONE SMC entry point for the whole app: raw candle rows → SMCResult.
 *
 * The scorecard (quant-toolkit) and the Simple Tab card used to have two
 * separate SMC code paths, so the card could show "N/A" while the scorecard
 * was scoring the same candles. This helper is the single implementation —
 * both callers use it, so the card and the scorecard always agree.
 *
 * Returns null when there is not enough real data (fail closed — an absent
 * result means "no candles", never "no structure found").
 */
export function analyzeSMCFromCandles(input: {
  candles: RawSMCandle[];
  spot: number;
  symbol?: string;
  direction?: "call" | "put";
  oiStrikeNearSpot?: number | null;
  /** Minimum real bars required (default 30 — SMC needs a structure). */
  minBars?: number;
}): SMCResult | null {
  const rows = input.candles ?? [];
  const parsed: Candle[] = [];
  for (const r of rows) {
    const o = Number(r.open ?? r.o);
    const h = Number(r.high ?? r.h);
    const l = Number(r.low ?? r.l);
    const c = Number(r.close ?? r.c);
    if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0)) continue;
    const v = Number(r.volume ?? r.v ?? 0);
    let t = Number(r.t);
    if (!Number.isFinite(t) || t <= 0) {
      t = parseCandleTimeMs(r.time);
    }
    parsed.push({ t: Number.isFinite(t) ? t : parsed.length * 300_000, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  if (parsed.length < (input.minBars ?? 30)) return null;
  parsed.sort((a, b) => a.t - b.t);

  const atrArr = atrSeries(parsed, 14);
  const atrNow = atrArr[atrArr.length - 1];
  const pools = atrNow != null && atrNow > 0
    ? liquidityPools(parsed, (input.symbol || "NIFTY").toUpperCase(), atrNow, 2)
    : [];
  const avgVolume = parsed.reduce((s, c) => s + (c.v ?? 0), 0) / parsed.length;

  return analyzeSMC({
    candles: parsed,
    spot: input.spot,
    pools,
    avgVolume,
    direction: input.direction ?? "call",
    oiStrikeNearSpot: input.oiStrikeNearSpot ?? null,
  });
}

function buildMarkedLevels(
  candles: Candle[],
  spot: number,
  pools: Pool[],
  vwapSd1: number | null,
  vwapSd2: number | null,
): MarkedLevel[] {
  const levels: MarkedLevel[] = [];
  const add = (kind: MarkedLevel["kind"], price: number | null | undefined, side: "above" | "below") => {
    const p = num(price);
    if (p == null || !Number.isFinite(p) || p <= 0) return;
    const distPts = p - spot;
    const distPct = distPts / spot;
    levels.push({
      kind, price: p, distPts, distPct,
      swept: false, sweepTime: null, sweepBarsAgo: null,
      closeBackInside: false, closeBackBar: null, volumeVsAvg: null,
      side: distPts >= 0 ? "above" : "below",
    });
  };

  for (const p of pools) {
    if (p.kind === "prev-day-high") add("prev-day-high", p.price, "above");
    if (p.kind === "prev-day-low") add("prev-day-low", p.price, "below");
    if (p.kind === "opening-range-high") add("or-high", p.price, "above");
    if (p.kind === "opening-range-low") add("or-low", p.price, "below");
    if (p.kind === "round-number") { const d = p.price - spot; add("round-number", p.price, d >= 0 ? "above" : "below"); }
    if (p.kind === "swing-high") add("swing-high", p.price, "above");
    if (p.kind === "swing-low") add("swing-low", p.price, "below");
  }

  if (vwapSd1 != null) {
    add("vwap-1sd-up", spot + vwapSd1, "above");
    add("vwap-1sd-down", spot - vwapSd1, "below");
  }
  if (vwapSd2 != null) {
    add("vwap-2sd-up", spot + vwapSd2, "above");
    add("vwap-2sd-down", spot - vwapSd2, "below");
  }

  // Deduplicate by price within 0.5 pts
  const uniq: MarkedLevel[] = [];
  for (const l of levels.sort((a, b) => a.price - b.price)) {
    const exists = uniq.some((u) => Math.abs(u.price - l.price) <= 0.5 && u.side === l.side);
    if (!exists) uniq.push(l);
  }
  return uniq;
}

// ─────────────────────────────────────────────────────────────
// Sweep detection per the spec
// ─────────────────────────────────────────────────────────────

function detectSweepsSpec(
  candles: Candle[],
  levels: MarkedLevel[],
  breakPctMin: number,
): SweepEvent[] {
  const sweeps: SweepEvent[] = [];
  const n = candles.length - 1;
  const lookback = 3;

  for (let li = 0; li < levels.length; li++) {
    const lvl = levels[li];
    const threshold = lvl.price * breakPctMin;

    for (let i = n - lookback - 2; i <= n - 1; i++) {
      if (i < 0) continue;
      const c = candles[i];
      const sweptAbove = lvl.side === "above" && c.h > lvl.price && (c.h - lvl.price) >= threshold;
      const sweptBelow = lvl.side === "below" && c.l < lvl.price && (lvl.price - c.l) >= threshold;

      if (!sweptAbove && !sweptBelow) continue;

      const side = sweptAbove ? "above" : "below";
      const breakPct = sweptAbove ? (c.h - lvl.price) / lvl.price : (lvl.price - c.l) / lvl.price;
      const volVsAvg: number | null = null; // volume not available in Candle type (v is optional, no avg reference here)

      let closeBackBar: number | null = null;
      let closeBackInside = false;
      for (let j = i + 1; j <= Math.min(n, i + lookback); j++) {
        const nc = candles[j];
        const backInside = side === "above" ? nc.c <= lvl.price : nc.c >= lvl.price;
        if (backInside) { closeBackBar = j; closeBackInside = true; break; }
      }

      sweeps.push({
        levelPrice: lvl.price,
        levelKind: lvl.kind,
        side,
        breakBarIdx: i,
        breakTime: istTime(c.t),
        breakPct,
        closeBackBarIdx: closeBackBar,
        closeBackTime: closeBackBar != null ? istTime(candles[closeBackBar].t) : null,
        closeBackInside,
        volumeVsAvg: volVsAvg,
        barsAgo: n - i,
      });

      levels[li].swept = true;
      levels[li].sweepTime = istTime(c.t);
      levels[li].sweepBarsAgo = n - i;
      levels[li].closeBackInside = closeBackInside;
      levels[li].closeBackBar = closeBackBar;
      levels[li].volumeVsAvg = volVsAvg;
    }
  }
  return sweeps;
}

// ─────────────────────────────────────────────────────────────
// CHoCH after sweep
// ─────────────────────────────────────────────────────────────

function detectChochAfterSweep(
  candles: Candle[],
  sweeps: SweepEvent[],
  swings: { highs: { i: number; price: number }[]; lows: { i: number; price: number }[] },
): CHoCHEvent[] {
  const choch: CHoCHEvent[] = [];
  const n = candles.length - 1;

  for (const sw of sweeps) {
    if (!sw.closeBackInside) continue;
    const closeIdx = sw.closeBackBarIdx ?? n;
    const closePrice = candles[closeIdx].c;

    let lastOpposite: { i: number; price: number } | null = null;
    if (sw.side === "above") {
      const opp = swings.lows.slice().reverse().find((s) => s.i < sw.breakBarIdx);
      if (opp && closePrice < opp.price) {
        choch.push({ dir: "bearish", swingPrice: opp.price, closeTime: istTime(candles[closeIdx].t), barsAgo: n - closeIdx, afterSweep: true });
      }
    } else {
      const opp = swings.highs.slice().reverse().find((s) => s.i < sw.breakBarIdx);
      if (opp && closePrice > opp.price) {
        choch.push({ dir: "bullish", swingPrice: opp.price, closeTime: istTime(candles[closeIdx].t), barsAgo: n - closeIdx, afterSweep: true });
      }
    }
  }
  return choch;
}

// ─────────────────────────────────────────────────────────────
// Displacement per spec: range >= 1.5 x ATR14, close in outer 25%
// ─────────────────────────────────────────────────────────────

function detectDisplacementSpec(
  candles: Candle[],
  atr14: number | null,
): Displacement[] {
  const out: Displacement[] = [];
  if (!atr14) return out;
  const n = candles.length - 1;
  const lookback = 5;
  for (let i = Math.max(0, n - lookback); i <= n; i++) {
    const c = candles[i];
    const range = c.h - c.l;
    const ratio = range / atr14;
    if (ratio < 1.5) continue;
    const bodyPct = Math.abs(c.c - c.o) / range;
    const closeInOuter25 = bodyPct >= 0.75;
    if (!closeInOuter25) continue;
    out.push({
      barIdx: i,
      time: istTime(c.t),
      range,
      atr14,
      ratio,
      closeInOuter25: true,
      dir: c.c > c.o ? "up" : "down",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// FVG per spec
// ─────────────────────────────────────────────────────────────

function detectFvgSpec(candles: Candle[]): SMCFvg[] {
  const out: SMCFvg[] = [];
  const n = candles.length - 1;
  const maxBars = 30;
  for (let i = Math.max(2, n - maxBars); i <= n; i++) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (c0.h < c2.l) {
      const filled = candles.slice(i + 1).some((x) => x.l <= c0.h);
      out.push({ dir: "bullish", lo: c0.h, hi: c2.l, barIdx: i, barsAgo: n - i, filled });
    }
    if (c0.l > c2.h) {
      const filled = candles.slice(i + 1).some((x) => x.h >= c0.l);
      out.push({ dir: "bearish", lo: c2.h, hi: c0.l, barIdx: i, barsAgo: n - i, filled });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Order block: last opposite candle before displacement
// ─────────────────────────────────────────────────────────────

function detectOrderBlocks(
  candles: Candle[],
  displacements: Displacement[],
): SMCOrderBlock[] {
  const out: SMCOrderBlock[] = [];
  for (const disp of displacements) {
    for (let i = disp.barIdx - 1; i >= Math.max(0, disp.barIdx - 5); i--) {
      const c = candles[i];
      const opposite = disp.dir === "up" ? c.c < c.o : c.c > c.o;
      if (opposite) {
        out.push({
          barIdx: i,
          time: istTime(c.t),
          dir: disp.dir === "up" ? "bearish" : "bullish",
          lo: c.l,
          hi: c.h,
          displacementBarIdx: disp.barIdx,
        });
        break;
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Premium/discount zone
// ─────────────────────────────────────────────────────────────

function inPremiumDiscountZone(
  price: number,
  swingHigh: number | null,
  swingLow: number | null,
  dir: "call" | "put",
): { inZone: boolean; zone: "premium" | "discount" | "none" } {
  if (swingHigh == null || swingLow == null || swingHigh <= swingLow) return { inZone: false, zone: "none" };
  const mid = (swingHigh + swingLow) / 2;
  if (dir === "call") {
    if (price <= mid) return { inZone: true, zone: "discount" };
  } else {
    if (price >= mid) return { inZone: true, zone: "premium" };
  }
  return { inZone: false, zone: price < mid ? "discount" : "premium" };
}

// ─────────────────────────────────────────────────────────────
// VWAP +/- SD
// ─────────────────────────────────────────────────────────────

function computeVwapSd(candles: Candle[]): { vwap: number | null; sd1: number | null; sd2: number | null } {
  if (candles.length === 0) return { vwap: null, sd1: null, sd2: null };
  let cumPV = 0, cumV = 0;
  const tps: number[] = [];
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v ?? 0;
    cumPV += tp * v; cumV += v;
    tps.push(tp);
  }
  const vwap = cumV > 0 ? cumPV / cumV : null;
  if (vwap == null) return { vwap: null, sd1: null, sd2: null };
  let sumSq = 0;
  for (const tp of tps) sumSq += (tp - vwap) ** 2;
  const sd = Math.sqrt(sumSq / Math.max(1, tps.length - 1));
  return { vwap, sd1: sd, sd2: sd * 2 };
}

// ─────────────────────────────────────────────────────────────
// Structure timeline: HH/HL/LH/LL + BOS/CHOCH from confirmed swings
// ─────────────────────────────────────────────────────────────

function detectStructureTimeline(
  candles: Candle[],
  swings: { highs: { i: number; price: number }[]; lows: { i: number; price: number }[] },
): { events: StructureEvent[]; trend: "UP" | "DOWN" | "SIDEWAYS" } {
  const n = candles.length - 1;
  // Merge swings into one time-ordered sequence
  const seq: { i: number; price: number; type: "H" | "L" }[] = [
    ...swings.highs.map((s) => ({ ...s, type: "H" as const })),
    ...swings.lows.map((s) => ({ ...s, type: "L" as const })),
  ].sort((a, b) => a.i - b.i);

  const events: StructureEvent[] = [];
  let lastTrend: 1 | -1 | 0 = 0;
  let prevHigh: number | null = null;
  let prevLow: number | null = null;

  for (const s of seq) {
    const time = istTime(candles[s.i].t);
    const barsAgo = n - s.i;
    if (s.type === "H") {
      if (prevHigh != null) {
        if (s.price > prevHigh) {
          events.push({ type: "HH", dir: "bullish", price: s.price, time, barsAgo });
          if (lastTrend === -1) events.push({ type: "CHOCH", dir: "bullish", price: s.price, time, barsAgo });
          lastTrend = 1;
        } else if (s.price < prevHigh) {
          events.push({ type: "LH", dir: "bearish", price: s.price, time, barsAgo });
          if (lastTrend === 1) events.push({ type: "CHOCH", dir: "bearish", price: s.price, time, barsAgo });
          lastTrend = -1;
        }
      }
      // BOS: close beyond the prior swing high in trend direction
      if (prevHigh != null && candles[n].c > prevHigh && lastTrend === 1) {
        const already = events.some((e) => e.type === "BOS" && e.dir === "bullish" && e.price === prevHigh);
        if (!already) events.push({ type: "BOS", dir: "bullish", price: prevHigh, time, barsAgo });
      }
      prevHigh = s.price;
    } else {
      if (prevLow != null) {
        if (s.price > prevLow) {
          events.push({ type: "HL", dir: "bullish", price: s.price, time, barsAgo });
          if (lastTrend === -1) events.push({ type: "CHOCH", dir: "bullish", price: s.price, time, barsAgo });
          lastTrend = 1;
        } else if (s.price < prevLow) {
          events.push({ type: "LL", dir: "bearish", price: s.price, time, barsAgo });
          if (lastTrend === 1) events.push({ type: "CHOCH", dir: "bearish", price: s.price, time, barsAgo });
          lastTrend = -1;
        }
      }
      if (prevLow != null && candles[n].c < prevLow && lastTrend === -1) {
        const already = events.some((e) => e.type === "BOS" && e.dir === "bearish" && e.price === prevLow);
        if (!already) events.push({ type: "BOS", dir: "bearish", price: prevLow, time, barsAgo });
      }
      prevLow = s.price;
    }
  }

  // Trend from last two swings of each type
  let trend: "UP" | "DOWN" | "SIDEWAYS" = "SIDEWAYS";
  const recentH = swings.highs.slice(-2);
  const recentL = swings.lows.slice(-2);
  if (recentH.length === 2 && recentL.length === 2) {
    const hh = recentH[1].price > recentH[0].price;
    const hl = recentL[1].price > recentL[0].price;
    const lh = recentH[1].price < recentH[0].price;
    const ll = recentL[1].price < recentL[0].price;
    if (hh && hl) trend = "UP";
    else if (lh && ll) trend = "DOWN";
  }

  // Keep the most recent 12 events
  return { events: events.slice(-12), trend };
}

// ─────────────────────────────────────────────────────────────
// Equal highs / equal lows — clustered swing liquidity
// ─────────────────────────────────────────────────────────────

function detectEqualLevels(
  candles: Candle[],
  swings: { highs: { i: number; price: number }[]; lows: { i: number; price: number }[] },
): EqualLevel[] {
  const n = candles.length - 1;
  const tol = 0.001; // 0.1% clustering
  const out: EqualLevel[] = [];

  const cluster = (pts: { i: number; price: number }[], side: "high" | "low") => {
    const used = new Set<number>();
    for (let a = 0; a < pts.length; a++) {
      if (used.has(a)) continue;
      const group = [pts[a]];
      used.add(a);
      for (let b = a + 1; b < pts.length; b++) {
        if (used.has(b)) continue;
        if (Math.abs(pts[b].price - pts[a].price) / pts[a].price <= tol) {
          group.push(pts[b]);
          used.add(b);
        }
      }
      if (group.length >= 2) {
        const price = group.reduce((s, g) => s + g.price, 0) / group.length;
        // Swept? any candle after the last cluster member broke beyond it
        const lastIdx = Math.max(...group.map((g) => g.i));
        let swept = false;
        let sweptBarsAgo: number | null = null;
        for (let j = lastIdx + 1; j <= n; j++) {
          const broke = side === "high" ? candles[j].h > price : candles[j].l < price;
          if (broke) { swept = true; sweptBarsAgo = n - j; break; }
        }
        out.push({ price, side, count: group.length, swept, sweptBarsAgo });
      }
    }
  };

  cluster(swings.highs, "high");
  cluster(swings.lows, "low");
  return out.sort((a, b) => b.count - a.count).slice(0, 6);
}

// ─────────────────────────────────────────────────────────────
// Main SMC analysis
// ─────────────────────────────────────────────────────────────

export interface SMCInput {
  candles: Candle[];
  spot: number;
  pools: Pool[];
  avgVolume: number;
  direction: "call" | "put";
  oiStrikeNearSpot?: number | null;
  swingHigh?: number | null;
  swingLow?: number | null;
}

export function analyzeSMC(input: SMCInput): SMCResult {
  const { candles, spot, pools, avgVolume, direction } = input;
  const n = candles.length - 1;
  const atrArr = atrSeries(candles, 14);
  const atr14 = atrArr[atrArr.length - 1] ?? null;

  const { vwap, sd1: vwapSd1, sd2: vwapSd2 } = computeVwapSd(candles);
  const levels = buildMarkedLevels(candles, spot, pools, vwapSd1, vwapSd2);

  if (input.oiStrikeNearSpot != null && input.oiStrikeNearSpot > 0) {
    const exists = levels.some((l) => Math.abs(l.price - input.oiStrikeNearSpot!) <= 0.5);
    if (!exists) {
      const distPts = input.oiStrikeNearSpot - spot;
      levels.push({
        kind: "oi-strike", price: input.oiStrikeNearSpot, distPts, distPct: distPts / spot,
        swept: false, sweepTime: null, sweepBarsAgo: null,
        closeBackInside: false, closeBackBar: null, volumeVsAvg: null,
        side: input.oiStrikeNearSpot >= spot ? "above" : "below",
      });
    }
  }

  const breakPctMin = 0.0005;
  const sweeps = detectSweepsSpec(candles, levels, breakPctMin);

  const k = 2;
  const highs: { i: number; price: number }[] = [];
  const lows: { i: number; price: number }[] = [];
  for (let i = k; i < candles.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(candles[i].h > candles[i - j].h && candles[i].h > candles[i + j].h)) isH = false;
      if (!(candles[i].l < candles[i - j].l && candles[i].l < candles[i + j].l)) isL = false;
    }
    if (isH) highs.push({ i, price: candles[i].h });
    if (isL) lows.push({ i, price: candles[i].l });
  }
  const swings = { highs, lows };

  const choch = detectChochAfterSweep(candles, sweeps, swings);
  const displacements = detectDisplacementSpec(candles, atr14);
  const fvgs = detectFvgSpec(candles);
  const orderBlocks = detectOrderBlocks(candles, displacements);
  const { events: structureEvents, trend: structureTrend } = detectStructureTimeline(candles, swings);
  const equalLevels = detectEqualLevels(candles, swings);
  const liquidityGrabs = sweeps.filter((s) => s.closeBackInside).length;

  // G16
  let g16Passed = false;
  let g16Reason = "";
  const sweptAndClosed = sweeps.filter((s) => s.closeBackInside);
  const hasDisplacement = displacements.length > 0;
  const hasChochAfterSweep = choch.length > 0;
  if (sweptAndClosed.length > 0 && hasChochAfterSweep && hasDisplacement) {
    g16Passed = true;
    g16Reason = `sweep+close-back+CHOCH+displacement confirmed (${sweptAndClosed.length} sweep(s), ${choch.length} CHoCH, ${displacements.length} displacement)`;
  } else if (sweeps.length > 0 && !sweptAndClosed.some((s) => s.closeBackInside)) {
    g16Reason = "sweep did not close back inside — possible breakout, not reversal";
  } else if (!hasChochAfterSweep) {
    g16Reason = "no CHoCH after sweep close-back";
  } else if (!hasDisplacement) {
    g16Reason = "no displacement candle (range < 1.5x ATR or close not in outer 25%)";
  } else {
    g16Reason = "no qualifying sweep";
  }

  // G17
  let g17Passed = false;
  let g17Reason = "";
  const confluentSweeps = sweeps.filter((s) =>
    s.closeBackInside &&
    (s.levelKind === "oi-strike" || s.levelKind.includes("vwap") || s.levelKind.includes("or-"))
  );
  if (confluentSweeps.length > 0) {
    g17Passed = true;
    g17Reason = `swept level has confluence: ${confluentSweeps.map((s) => `${s.levelKind} @${s.levelPrice.toFixed(0)}`).join(", ")}`;
  } else if (sweeps.length > 0) {
    g17Reason = "swept level lacks confluence (no OI strike, VWAP band, or opening range)";
  } else {
    g17Reason = "no sweep to evaluate confluence";
  }

  // G18
  let g18Passed = false;
  let g18Reason = "";
  const lastPrice = candles[n].c;

  // Premium/discount zone from the swing range (needs lastPrice)
  const pdMid = input.swingHigh != null && input.swingLow != null && input.swingHigh > input.swingLow
    ? (input.swingHigh + input.swingLow) / 2 : null;
  const pdPos = pdMid != null && input.swingHigh != null && input.swingLow != null
    ? ((lastPrice - input.swingLow) / (input.swingHigh - input.swingLow)) * 100 : null;
  const premiumDiscount: PremiumDiscount = {
    zone: pdMid == null ? "none" : lastPrice >= pdMid ? "premium" : "discount",
    mid: pdMid,
    swingHigh: input.swingHigh ?? null,
    swingLow: input.swingLow ?? null,
    positionPct: pdPos != null ? Math.max(0, Math.min(100, pdPos)) : null,
  };

  const zone = inPremiumDiscountZone(lastPrice, input.swingHigh ?? null, input.swingLow ?? null, direction);
  const nearFvg = fvgs.some((f) => !f.filled && lastPrice >= f.lo && lastPrice <= f.hi);
  const nearOb = orderBlocks.some((ob) => lastPrice >= ob.lo && lastPrice <= ob.hi);
  const nearVwap = vwap != null && Math.abs(lastPrice - vwap) / spot <= 0.001;
  const retestZone = nearFvg || nearOb || nearVwap;
  if (retestZone && zone.inZone) {
    g18Passed = true;
    g18Reason = `retest in ${zone.zone} zone (FVG=${nearFvg}, OB=${nearOb}, VWAP=${nearVwap})`;
  } else if (!zone.inZone) {
    g18Reason = `price in ${zone.zone} zone — not the correct premium/discount side for ${direction}`;
  } else if (!retestZone) {
    g18Reason = "no retest into FVG/order block/VWAP/BB middle";
  } else {
    g18Reason = "no retest setup";
  }

  // G19
  let g19Passed = false;
  let g19Reason = "";
  let stopPrice: number | null = null;
  const lastSweep = sweeps[sweeps.length - 1];
  if (lastSweep && lastSweep.closeBackInside) {
    const buffer = atr14 ? atr14 * 0.25 : spot * 0.002;
    if (direction === "call") {
      stopPrice = lastSweep.levelPrice - buffer;
      if (stopPrice < lastPrice) { g19Passed = true; g19Reason = `stop below sweep extreme @${stopPrice.toFixed(2)} (+${((lastPrice - stopPrice) / lastPrice * 100).toFixed(1)}% risk)`; }
      else { g19Reason = "stop not below entry — invalid"; }
    } else {
      stopPrice = lastSweep.levelPrice + buffer;
      if (stopPrice > lastPrice) { g19Passed = true; g19Reason = `stop above sweep extreme @${stopPrice.toFixed(2)} (+${((stopPrice - lastPrice) / lastPrice * 100).toFixed(1)}% risk)`; }
      else { g19Reason = "stop not above entry — invalid"; }
    }
  } else {
    g19Reason = "no valid sweep with close-back inside to place stop beyond";
  }

  // Score contribution (capped at 2)
  let scorePoints = 0;
  const points: string[] = [];
  if (g16Passed) { scorePoints += 1; points.push("sweep+CHOCH+displacement"); }
  if (g17Passed && scorePoints < 2) { scorePoints += 1; points.push("level confluence"); }

  // Footprints
  const footprints: string[] = [];
  const volAbsorption = sweeps.some((s) => s.volumeVsAvg != null && s.volumeVsAvg >= 2.0 && Math.abs(s.breakPct) < 0.003);
  if (volAbsorption) footprints.push("absorption (high volume, small range)");
  if (fvgs.some((f) => !f.filled)) footprints.push("imbalance (unfilled FVG)");
  const oiShift = pools.some((p) => Math.abs(p.price - spot) / spot <= 0.02);
  if (oiShift) footprints.push("OI shift near spot level");

  // Table rows
  const tableRows = levels.map((l) => ({
    level: l.kind,
    price: l.price,
    distPts: Math.abs(l.distPts),
    distPct: roundPct(Math.abs(l.distPct)),
    swept: l.swept ? "YES" : "no",
    closeBack: l.swept ? (l.closeBackInside ? "YES" : "no") : "—",
    volVsAvg: l.volumeVsAvg != null ? l.volumeVsAvg.toFixed(2) + "x" : "—",
  }));

  return {
    spot, atr14, levels, sweeps, choch, displacements, fvgs, orderBlocks,
    structure: structureEvents, structureTrend, equalLevels, liquidityGrabs, premiumDiscount,
    g16: { passed: g16Passed, reason: g16Reason },
    g17: { passed: g17Passed, reason: g17Reason },
    g18: { passed: g18Passed, reason: g18Reason },
    g19: { passed: g19Passed, reason: g19Reason, stopPrice },
    scorePoints: Math.min(2, scorePoints),
    scoreReason: points.length ? points.join(" + ") : "no SMC gates passed",
    footprints,
    tableRows,
  };
}

// ─────────────────────────────────────────────────────────────
// GateLayer output
// ─────────────────────────────────────────────────────────────

export function smcLayer(result: SMCResult, direction: "call" | "put"): GateLayer {
  const votes: string[] = [];
  let agree = 0, against = 0;

  const vote = (ok: boolean | null, label: string) => {
    if (ok === true) { agree++; votes.push("+" + label); }
    else if (ok === false) { against++; votes.push("-" + label); }
  };

  vote(result.g16.passed, `G16 sweep+CHOCH+disp (${result.g16.reason})`);
  vote(result.g17.passed, `G17 confluence (${result.g17.reason})`);
  vote(result.g18.passed, `G18 retest+zone (${result.g18.reason})`);
  vote(result.g19.passed, `G19 stop placement (${result.g19.reason})`);

  const ev = `SMC: ${votes.join("; ") || "no gates passed"} | score ${result.scorePoints}/2 | ${result.scoreReason}`;
  if (agree >= 2 && against === 0) return { state: "agree", evidence: ev };
  if (against >= 1 && agree === 0) return { state: "against", evidence: ev };
  return { state: "neutral", evidence: ev };
}

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────

export function formatSMC(result: SMCResult): string {
  const L: string[] = [];
  L.push("=== SMC LAYER (objective only) ===");
  L.push(`Spot: ${result.spot.toFixed(2)} | ATR14: ${result.atr14?.toFixed(2) ?? "n/a"}`);
  L.push("");
  L.push("--- Marked Levels ---");
  for (const r of result.tableRows) {
    L.push(`  ${r.level.padEnd(14)} @${r.price.toFixed(0)} | dist ${r.distPts.toFixed(0)}pts (${r.distPct}) | swept ${r.swept.padEnd(3)} | close-back ${r.closeBack.padEnd(3)} | vol ${r.volVsAvg}`);
  }
  L.push("");
  L.push("--- Sweeps ---");
  for (const s of result.sweeps) {
    L.push(`  ${s.levelKind} @${s.levelPrice.toFixed(0)} side=${s.side} breakPct=${(s.breakPct * 100).toFixed(3)}% closeBack=${s.closeBackInside ? "YES @" + s.closeBackTime : "NO"} vol=${s.volumeVsAvg?.toFixed(2) ?? "n/a"}x barsAgo=${s.barsAgo}`);
  }
  L.push("");
  L.push("--- Gates ---");
  L.push(`  G16: ${result.g16.passed ? "PASS" : "FAIL"} — ${result.g16.reason}`);
  L.push(`  G17: ${result.g17.passed ? "PASS" : "FAIL"} — ${result.g17.reason}`);
  L.push(`  G18: ${result.g18.passed ? "PASS" : "FAIL"} — ${result.g18.reason}`);
  L.push(`  G19: ${result.g19.passed ? "PASS" : "FAIL"} — ${result.g19.reason}`);
  L.push("");
  L.push(`--- Score: ${result.scorePoints}/2 — ${result.scoreReason} ---`);
  L.push("");
  L.push("--- Structure ---");
  L.push(`  Trend: ${result.structureTrend}`);
  for (const e of result.structure) {
    L.push(`  ${e.type} ${e.dir} @${e.price.toFixed(2)} (${e.time}, ${e.barsAgo} bars ago)`);
  }
  L.push("");
  L.push(`--- Premium/Discount: ${result.premiumDiscount.zone} (mid ${result.premiumDiscount.mid?.toFixed(2) ?? "n/a"}, pos ${result.premiumDiscount.positionPct?.toFixed(0) ?? "n/a"}%) ---`);
  L.push("");
  L.push(`--- Equal Levels (${result.equalLevels.length}) & Liquidity Grabs (${result.liquidityGrabs}) ---`);
  for (const eq of result.equalLevels) {
    L.push(`  ${eq.side === "high" ? "EQH" : "EQL"} @${eq.price.toFixed(2)} x${eq.count} swept=${eq.swept}`);
  }
  L.push("");
  L.push("--- Footprints ---");
  if (result.footprints.length) L.push(`  ${result.footprints.join(", ")}`);
  else L.push("  none observed");
  L.push("");
  L.push("--- Displacements ---");
  for (const d of result.displacements) {
    L.push(`  ${d.dir} @${d.time} range=${d.range.toFixed(2)} ratio=${d.ratio.toFixed(2)}x ATR`);
  }
  L.push("");
  L.push("--- FVGs ---");
  for (const f of result.fvgs) {
    L.push(`  ${f.dir} ${f.lo.toFixed(2)}-${f.hi.toFixed(2)} filled=${f.filled} barsAgo=${f.barsAgo}`);
  }
  L.push("");
  L.push("--- Order Blocks ---");
  for (const ob of result.orderBlocks) {
    L.push(`  ${ob.dir} @${ob.time} ${ob.lo.toFixed(2)}-${ob.hi.toFixed(2)} before disp bar ${ob.displacementBarIdx}`);
  }
  L.push("");
  L.push("NOTE: SMC describes observable price/volume/OI behaviour only. No 'operator' or 'smart money' intent inferred.");
  return L.join("\n");
}
