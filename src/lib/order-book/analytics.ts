/**
 * Order Book analytics — pure functions shared by the Order Book panel UI.
 *
 * No React, no network, no server-only imports — safe in client bundles and
 * bun tests. All sizes are LOTS (raw contract quantity / lot size).
 *
 * Bucketing: deep books aggregate resting size into per-index price buckets
 * (5 pts NIFTY, 20 pts SENSEX); a shallow book (levels <= 20, e.g. the ~5
 * levels brokers stream) keeps real price levels instead. Nothing here
 * invents depth — garbage in the snapshot is dropped, never extrapolated.
 *
 * Scorecard semantics (context, NOT guaranteed support/resistance):
 *   watch   — big level resting, price has not reached it
 *   reached — price traded within one bucket of the level
 *   turned  — price reached it and moved away without crossing
 *   broke   — price traded through the level
 */
import type { BookSnapshot } from "./types";

/** Mirror of the feed freshness contract (nifty-feed FRESH_MS). */
export const FRESH_MS = 15_000;

/** How long a vanished wall's first-seen clock is remembered (it restarts after this). */
export const WALL_MEMORY_MS = 30 * 60_000;

export interface IndexDepthCfg {
  lot: number;
  tick: number;
  step: number;
  near: number;
  usualSpread: number;
  /** round-number grid for stop-loss reference levels (100 NIFTY, 500 SENSEX) */
  roundStep: number;
}

export interface Wall {
  k: number;
  side: "b" | "a";
  lots: number;
  mult: number; // lots / mean bucket size
}

export type ScoreStatus = "watch" | "reached" | "turned" | "broke";

export interface ScoreEntry {
  k: number;
  side: "b" | "a";
  lots: number; // last seen size (lots)
  mult: number; // last seen multiple of usual
  seenTs: number; // first seen (epoch ms)
  touchedTs: number | null; // price first reached the level
  status: ScoreStatus;
  resolvedTs: number | null;
}

export interface SessionState {
  /** oversized buckets from the previous ingest (pulled-order detection) */
  prev: Array<[number, "b" | "a", number]> | null;
  pulled: Array<{ k: number; side: "b" | "a"; lots: number; mult: number; ts: number }>;
  emaDepth: number;
  /** "k|side" -> first-seen epoch ms */
  wallSeen: Map<string, number>;
  /** today's big-level scorecard */
  score: Map<string, ScoreEntry>;
  /** IST day-start (ms) of the current analytics session */
  day: number;
}

export function istDayStart(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** New analytics session (per index; also used on IST day rollover). */
export function freshSession(now = Date.now()): SessionState {
  return {
    prev: null,
    pulled: [],
    emaDepth: 0,
    wallSeen: new Map(),
    score: new Map(),
    day: istDayStart(now),
  };
}

export interface IngestCfg {
  lot: number;
  step: number;
  near: number;
}

export interface IngestResult {
  b: Map<number, number>;
  a: Map<number, number>;
  /** buyers % of resting lots within `near` of LTP (context, not direction) */
  bp: number;
  /** total lots resting on the book */
  depth: number;
  /** mean lots per bucket (or per level when shallow) */
  mean: number;
  walls: Wall[];
  /** shallow book: real price levels, no bucketing, pulled detection off */
  sh: boolean;
  spread: number;
  bestBid: number;
  bestAsk: number;
  /** recent pulled-order alerts (deep books only) */
  pulled: SessionState["pulled"];
  /** EMA of total depth — the "usual depth" baseline */
  emaDepth: number;
}

/**
 * Fold one snapshot into the session and return the derived view.
 * `now` is injectable so replays/tests can pin the clock.
 */
export function ingest(d: BookSnapshot, S: SessionState, cfg: IngestCfg, now = Date.now()): IngestResult {
  const lotQ = (q: number) => (cfg.lot > 0 ? q / cfg.lot : q);
  const sh = (d.levels || 200) <= 20;

  const b = new Map<number, number>();
  const a = new Map<number, number>();
  const add = (m: Map<number, number>, p: number, q: number) => {
    if (!(p > 0) || !(q > 0)) return; // drop garbage levels, never invent
    const k = sh ? p : Math.floor(p / cfg.step) * cfg.step;
    m.set(k, (m.get(k) || 0) + lotQ(q));
  };
  (d.bids || []).forEach(([p, q]) => add(b, p, q));
  (d.asks || []).forEach(([p, q]) => add(a, p, q));

  const bestBid = (d.bids || []).length ? Math.max(...d.bids.map((x) => x[0])) : 0;
  const bestAsk = (d.asks || []).length ? Math.min(...d.asks.map((x) => x[0])) : 0;
  const depth = [...b.values(), ...a.values()].reduce((x, y) => x + y, 0);
  S.emaDepth = S.emaDepth ? S.emaDepth * 0.97 + depth * 0.03 : depth;
  const all = [...b.values(), ...a.values()];
  const mean = all.length ? all.reduce((x, y) => x + y, 0) / all.length : 0;

  // buyers/sellers split within `near` points of the LTP
  let nb = 0;
  let na = 0;
  (d.bids || []).forEach(([p, q]) => {
    if (sh || d.ltp - p <= cfg.near) nb += lotQ(q);
  });
  (d.asks || []).forEach(([p, q]) => {
    if (sh || p - d.ltp <= cfg.near) na += lotQ(q);
  });
  const bp = nb + na ? (nb / (nb + na)) * 100 : 50;

  // pulled-order detection (meaningful on deep books only; needs history)
  const pulled: SessionState["pulled"] = [];
  if (S.prev) {
    for (const [k, side, v] of S.prev) {
      const m = side === "b" ? b : a;
      const nowV = m.get(k) || 0;
      if (v > mean * 2.5 && nowV < v * 0.4 && Math.abs(d.ltp - k) > cfg.step * 2) {
        if (!pulled.some((x) => x.k === k && now - x.ts < 60_000)) {
          pulled.unshift({ k, side, lots: v, mult: v / (mean || 1), ts: now });
        }
      }
    }
  }
  S.pulled = pulled.filter((x) => now - x.ts < 30 * 60_000).slice(0, 5);
  S.prev = [...b]
    .map(([k, v]) => [k, "b" as const, v] as [number, "b" | "a", number])
    .concat([...a].map(([k, v]) => [k, "a" as const, v] as [number, "b" | "a", number]))
    .filter((x) => x[2] > mean * 2.5);

  const walls: Wall[] = ([...b]
    .map(([k, v]): Wall => ({ k, side: "b", lots: v, mult: v / (mean || 1) })) as Wall[])
    .concat([...a].map(([k, v]): Wall => ({ k, side: "a", lots: v, mult: v / (mean || 1) })))
    .filter((x) => x.lots > mean * 2.5)
    .sort((x, y) => y.lots - x.lots)
    .slice(0, 4);

  updateScorecard(d.ltp, walls, S, cfg, now);

  return { b, a, bp, depth, mean, walls, sh, spread: bestAsk - bestBid, bestBid, bestAsk, pulled: S.pulled, emaDepth: S.emaDepth };
}

/**
 * Track first-seen times for walls and judge each big level as the price
 * reaches / turns at / breaks through it. Session-aware: a new IST day
 * resets the scorecard and the waiting clocks.
 */
export function updateScorecard(
  ltp: number,
  walls: Wall[],
  S: SessionState,
  cfg: IngestCfg,
  now = Date.now()
): void {
  const day = istDayStart(now);
  if (S.day !== day) {
    S.day = day;
    S.score.clear();
    S.wallSeen.clear();
  }

  const tol = cfg.step; // "reached" = price within one bucket of the level

  for (const w of walls) {
    const key = `${w.k}|${w.side}`;
    if (!S.wallSeen.has(key)) S.wallSeen.set(key, now);

    let e = S.score.get(key);
    if (!e) {
      e = {
        k: w.k,
        side: w.side,
        lots: w.lots,
        mult: w.mult,
        seenTs: S.wallSeen.get(key)!,
        touchedTs: null,
        status: "watch",
        resolvedTs: null,
      };
      S.score.set(key, e);
    }
    e.lots = w.lots;
    e.mult = w.mult;

    if (e.status === "watch" || e.status === "reached") {
      const crossed = w.side === "b" ? ltp < w.k - tol : ltp > w.k + tol;
      const nearIt = Math.abs(ltp - w.k) <= tol;
      const held = w.side === "b" ? ltp > w.k + tol : ltp < w.k - tol;
      if (crossed) {
        e.status = "broke";
        e.resolvedTs = now;
        if (e.touchedTs == null) e.touchedTs = now;
      } else if (nearIt) {
        if (e.touchedTs == null) e.touchedTs = now;
        e.status = "reached";
      } else if (e.touchedTs != null && held) {
        e.status = "turned";
        e.resolvedTs = now;
      }
    }
  }

  // Forget walls that vanished long ago (a returning wall starts a new clock).
  for (const [key, ts] of S.wallSeen) {
    if (now - ts > WALL_MEMORY_MS && !walls.some((w) => `${w.k}|${w.side}` === key)) {
      S.wallSeen.delete(key);
    }
  }
}

export interface NearestBig {
  k: number;
  side: "b" | "a";
  lots: number;
  mult: number;
  /** |LTP - level| in points */
  distance: number;
  seenTs: number;
}

/** Nearest big resting level on one side of the price, or null. */
export function nearestBig(
  walls: Wall[],
  ltp: number,
  S: SessionState,
  side: "b" | "a",
  now = Date.now()
): NearestBig | null {
  const cands = walls.filter((w) => (side === "b" ? w.k < ltp : w.k > ltp));
  if (!cands.length || !(ltp > 0)) return null;
  const pick =
    side === "b"
      ? cands.reduce((p, q) => (q.k > p.k ? q : p))
      : cands.reduce((p, q) => (q.k < p.k ? q : p));
  const seenTs = S.wallSeen.get(`${pick.k}|${pick.side}`) ?? now;
  return { ...pick, distance: Math.abs(ltp - pick.k), seenTs };
}

/** "42s" / "5m" / "2h 13m" — honest human durations for ages and waiting times. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Round-number levels just below/above the LTP on the per-index grid.
 * On-round LTP steps OUT (24500 → below 24400 / above 24600), never a
 * "just below 24500" that sits exactly at the price. Null for bad input.
 */
export function roundLevels(ltp: number, step: number): { below: number; above: number } | null {
  if (!(ltp > 0) || !(step > 0)) return null;
  let below = Math.floor(ltp / step) * step;
  let above = Math.ceil(ltp / step) * step;
  if (below >= ltp) below -= step;
  if (above <= ltp) above += step;
  return { below, above };
}

export interface ChainRowLite {
  strike?: unknown;
  pe?: { oi?: unknown } | null;
}

/**
 * Strike carrying the most put OI — where the put side's biggest resting
 * interest sits. Prefers the heaviest put strike AT OR BELOW the LTP (the
 * support side); falls back to the global max when every put strike is
 * above the LTP. Returns null for empty/garbage payloads — never guesses.
 */
export function maxPutOiStrike(
  rows: ChainRowLite[] | null | undefined,
  ltp: number
): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let globalBest: { k: number; oi: number } | null = null;
  let belowBest: { k: number; oi: number } | null = null;
  for (const r of rows) {
    const k = Number(r?.strike);
    const oi = Number(r?.pe?.oi);
    if (!(k > 0) || !Number.isFinite(oi) || oi <= 0) continue;
    if (!globalBest || oi > globalBest.oi) globalBest = { k, oi };
    if (ltp > 0 && k <= ltp && (!belowBest || oi > belowBest.oi)) belowBest = { k, oi };
  }
  const pick = belowBest ?? globalBest;
  return pick ? pick.k : null;
}

export type DepthQuality = "deep" | "shallow" | "stale" | "offline";

/**
 * Honest depth-quality badge:
 *   offline — never received a snapshot
 *   stale   — snapshot older than FRESH_MS (or unparseable ts)
 *   shallow — fresh, but the broker only streams a few levels (<= 20)
 *   deep    — fresh, genuinely deep book
 */
export function depthQuality(hasData: boolean, levels: number, ageMs: number): DepthQuality {
  if (!hasData) return "offline";
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > FRESH_MS) return "stale";
  return levels > 20 ? "deep" : "shallow";
}
