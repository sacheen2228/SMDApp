"use client";

/**
 * Order Book panel — live NIFTY / SENSEX futures depth.
 *
 * Data: `GET /api/book?index=<INDEX>` (Breeze stream for NIFTY, MO sidecar for
 * SENSEX) — polled every second. The panel keeps the LAST GOOD snapshot when
 * the feed stalls and labels its age honestly; it never invents depth.
 *
 * The broker streams only a SHALLOW book (~5 levels per side) — detected from
 * the `levels` field — so pulled-order alerts and the 200-level ladder are
 * deep-book features and stay off in shallow mode. Resting walls are context,
 * never guaranteed support/resistance.
 *
 * Analytics (bucketing, walls, waiting clocks, today's scorecard) live in
 * `@/lib/order-book/analytics` (pure, unit-tested).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { getLotSize } from "@/lib/symbol-config";
import type { BookSnapshot } from "@/lib/order-book/types";
import {
  FRESH_MS,
  freshSession,
  ingest,
  nearestBig,
  fmtAge,
  maxPutOiStrike,
  roundLevels,
  depthQuality,
  type IndexDepthCfg,
  type SessionState,
  type ScoreEntry,
} from "@/lib/order-book/analytics";

interface BookData extends BookSnapshot {
  index: string;
}

const IDX_CFG: Record<string, IndexDepthCfg> = {
  NIFTY: { lot: 65, tick: 0.5, step: 5, near: 20, usualSpread: 3, roundStep: 100 },
  SENSEX: { lot: 20, tick: 2, step: 20, near: 80, usualSpread: 10, roundStep: 500 },
};

function fmt(n: number, d = 0): string {
  try {
    return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  } catch {
    return String(n);
  }
}

const STATUS_STYLE: Record<ScoreEntry["status"], string> = {
  watch: "text-muted-foreground",
  reached: "text-amber-500",
  turned: "text-emerald-600",
  broke: "text-red-600",
};

export function OrderBookPanel() {
  const [idx, setIdx] = useState<string>("NIFTY");
  const [data, setData] = useState<BookData | null>(null); // last GOOD snapshot, kept through feed failures
  const [feedErr, setFeedErr] = useState(false); // last poll failed
  const S = useRef<SessionState>(freshSession());
  const dataRef = useRef<BookData | null>(null);
  const inFlight = useRef(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (inFlight.current) return; // never overlap polls
      inFlight.current = true;
      try {
        const r = await fetch(`/api/book?index=${idx}`, { signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "bad status");
        const snap: BookData = { ...j, index: idx };
        if (!alive) return;
        dataRef.current = snap;
        setData(snap);
        setFeedErr(false);
      } catch {
        if (!alive) return;
        setFeedErr(true); // keep the last good snapshot on screen
      } finally {
        inFlight.current = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), 1000); // updated every second
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [idx]);

  // Fresh analytics session when the index changes (per-index clock + scorecard).
  useEffect(() => {
    S.current = freshSession();
    dataRef.current = null;
    setData(null);
    setFeedErr(false);
  }, [idx]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Option-chain context: max put OI strike, refreshed every 60s ──────────
  // Used for one stop-loss reference line ("below the strike with the most
  // puts"). Chain trouble never blocks the depth panel — the line just hides.
  const [putStrike, setPutStrike] = useState<{ k: number; ts: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/option-chain?symbol=${encodeURIComponent(idx)}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error("chain unavailable");
        const j = await r.json();
        // chain payload shapes: {data:{data:[rows], spotPrice}} (current) or bare/records
        const holder = j?.data && typeof j.data === "object" && !Array.isArray(j.data) ? j.data : null;
        const rows = Array.isArray(j?.data)
          ? j.data
          : Array.isArray(holder?.data)
            ? holder.data
            : Array.isArray(j?.records?.data)
              ? j.records.data
              : null;
        const spot = Number(holder?.spotPrice || j?.records?.underlyingValue || 0);
        const ltpForPick = spot > 0 ? spot : dataRef.current?.ltp || 0;
        const k = maxPutOiStrike(rows, ltpForPick);
        if (!alive) return;
        setPutStrike(k ? { k, ts: Date.now() } : null); // unusable payload → line hides (never guessed)
      } catch {
        // keep the last good strike; it is staleness-guarded at render time
      }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [idx]);

  const cfg = IDX_CFG[idx] || IDX_CFG.NIFTY;

  const result = useMemo(() => {
    const d = dataRef.current;
    if (!d) return null;
    return ingest(d, S.current, { lot: getLotSize(idx) || cfg.lot, step: cfg.step, near: cfg.near }, now);
    // `now` re-folds the same snapshot each second so waiting clocks and the
    // scorecard advance even while the book itself is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, idx, now]);

  // ── snapshot age / feed state ────────────────────────────────────────────
  const ageMs = data ? Math.max(0, now - (data.ts > 0 ? data.ts : 0)) : 0;
  const stale = !!data && (feedErr || !data?.ts || ageMs > FRESH_MS);
  const staleBanner = !data
    ? null
    : feedErr && ageMs > FRESH_MS
      ? `Feed interrupted — showing the last order book from ${fmtAge(ageMs)} ago.`
      : feedErr
        ? "Reconnecting to the live feed — showing the last known order book."
        : ageMs > FRESH_MS
          ? `Market closed or feed stalled — showing the last order book from ${fmtAge(ageMs)} ago.`
          : null;

  const ladderRows = useMemo(() => {
    const d = dataRef.current;
    const res = result;
    if (!d || !res) return [] as React.ReactNode[];
    const c = IDX_CFG[idx] || IDX_CFG.NIFTY;
    const keys = res.sh
      ? Array.from(new Set([...res.b.keys(), ...res.a.keys()])).sort((x, y) => y - x)
      : Array.from({ length: 24 }, (_, i) => Math.floor(d.ltp / c.step) * c.step + c.step * (11 - i));
    const maxV = Math.max(1, ...[...res.b.values(), ...res.a.values()].slice(0, 400));
    const pulled = new Map(res.pulled.map((x) => [x.k, x]));
    const wallK = new Set<string>();
    res.walls.forEach((w) => wallK.add(w.k + w.side));
    const ltpK = res.sh
      ? keys.reduce((p, q) => (Math.abs(q - d.ltp) < Math.abs(p - d.ltp) ? q : p), keys[0])
      : Math.floor(d.ltp / c.step) * c.step;
    const rows: React.ReactNode[] = [];
    for (const k of keys) {
      const bv = res.b.get(k);
      const av = res.a.get(k);
      const pl = pulled.get(k);
      const wall = wallK.has(k + "b") || wallK.has(k + "a");
      const pct = (v?: number) => (v ? Math.min(100, (v / (maxV * 0.85)) * 100) : 0);
      rows.push(
        <div
          key={k}
          className={`grid grid-cols-[1fr_6rem_1fr] items-center h-[25px] text-[12px] font-mono tabular-nums ${k === ltpK ? "bg-primary/10 rounded" : ""} ${wall ? "opacity-70" : ""}`}
        >
          <div className="flex items-center justify-end pr-2">
            {bv ? <div className="relative h-4 bg-emerald-500/20 rounded w-16"><div className="absolute right-0 top-0 h-4 bg-emerald-500/40 rounded w-0" style={{ width: pct(bv) + "%" }} /></div> : null}
            <span className={bv ? "text-emerald-600 font-semibold ml-1" : ""}>{bv != null ? Math.round(bv) : null}</span>
          </div>
          <div className="text-center text-muted-foreground">
            {fmt(k, res.sh ? 2 : 0)}
            {k === ltpK ? " ◀" : ""}
            {pl ? ` · Pulled ${Math.round(pl.lots)} lots` : ""}
          </div>
          <div className="flex items-center justify-end pr-2">
            {av ? <span className="text-red-600 font-semibold ml-1">{Math.round(av)}</span> : null}
          </div>
        </div>
      );
    }
    return rows;
  }, [data, result, idx]);

  if (!data) {
    return (
      <div className="flex-1 overflow-auto p-2" data-testid="order-book-offline">
        <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground text-sm">
          {feedErr
            ? "Order book feed offline — no fresh data from Breeze / Motilal Oswal. The panel goes live as soon as the stream delivers ticks."
            : "Connecting to the live order book feed…"}
        </div>
      </div>
    );
  }

  // ── derived presentation values ──────────────────────────────────────────
  const quality = depthQuality(!!data, data?.levels || 0, ageMs);
  const liquidityPct = result ? ((result.depth / (result.emaDepth || result.depth || 1)) * 100) || 0 : 0;
  const liqLabel = liquidityPct >= 80 ? "Normal" : liquidityPct >= 50 ? "Thin" : "Stressed";
  const liqColor =
    liquidityPct >= 80 ? "text-emerald-600" : liquidityPct >= 50 ? "text-amber-500" : "text-red-600";

  const bigBuyer = result ? nearestBig(result.walls, data.ltp, S.current, "b", now) : null;
  const bigSeller = result ? nearestBig(result.walls, data.ltp, S.current, "a", now) : null;

  const rangeLabel = (k: number) => (result?.sh ? fmt(k, 2) : `${fmt(k)}–${fmt(k + cfg.step)}`);

  // Today's scorecard: only levels the price has actually reached.
  const scorecard = [...S.current.score.values()]
    .filter((e) => e.touchedTs != null)
    .sort((x, y) => {
      const rank = (s: ScoreEntry["status"]) => (s === "reached" ? 0 : s === "turned" ? 1 : 2);
      return rank(x.status) - rank(y.status) || y.k - x.k;
    });

  return (
    <div className="flex-1 overflow-auto p-2" data-testid="order-book-panel">
      {/* header */}
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center text-primary">📊</div>
          <div>
            <div className="text-sm font-semibold">{idx} Order Book</div>
            <div className="text-[10px] text-muted-foreground">
              Where large orders are waiting in the {idx} future, read live from the broker order book · updated every second
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* depth-quality badge: DEEP / SHALLOW / STALE / OFFLINE */}
          {data && (
            <span
              data-testid="order-book-quality"
              className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${
                quality === "deep"
                  ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
                  : quality === "shallow"
                    ? "bg-sky-500/15 text-sky-600 border-sky-500/30"
                    : "bg-amber-500/15 text-amber-600 border-amber-500/30"
              }`}
            >
              {quality.toUpperCase()}
            </span>
          )}
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
            {(["NIFTY", "SENSEX"] as const).map((i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className={`h-6 px-2 text-[9px] font-bold rounded-md ${idx === i ? "bg-emerald-600 text-white" : "text-muted-foreground"}`}
              >
                {i}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* honest stale-data banner */}
      {staleBanner && (
        <div
          data-testid="order-book-stale-banner"
          className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-600"
        >
          {staleBanner}
        </div>
      )}

      {/* stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 mb-2">
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{idx} future</div>
          <div className="text-sm font-bold tabular-nums">{fmt(data.ltp, 2)}</div>
          <div className="text-[9px] text-muted-foreground">expires {data?.expiry || "–"}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Nearest Big Buyers</div>
          {bigBuyer ? (
            <>
              <div className="text-sm font-bold tabular-nums text-emerald-600">{rangeLabel(bigBuyer.k)}</div>
              <div className="text-[9px] text-muted-foreground">
                {Math.round(bigBuyer.lots)} lots · {bigBuyer.distance > 0 ? fmt(bigBuyer.distance) + " pts below" : "at price"} · waiting {fmtAge(now - bigBuyer.seenTs)}
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-bold text-muted-foreground">—</div>
              <div className="text-[9px] text-muted-foreground">no big buyers below right now</div>
            </>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Nearest Big Sellers</div>
          {bigSeller ? (
            <>
              <div className="text-sm font-bold tabular-nums text-red-600">{rangeLabel(bigSeller.k)}</div>
              <div className="text-[9px] text-muted-foreground">
                {Math.round(bigSeller.lots)} lots · {bigSeller.distance > 0 ? fmt(bigSeller.distance) + " pts above" : "at price"} · waiting {fmtAge(now - bigSeller.seenTs)}
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-bold text-muted-foreground">—</div>
              <div className="text-[9px] text-muted-foreground">no big sellers above right now</div>
            </>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Liquidity</div>
          <div className={`text-sm font-bold tabular-nums ${liqColor}`}>{liqLabel}</div>
          <div className="text-[9px] text-muted-foreground">
            {liquidityPct.toFixed(0)}% of usual depth · spread {fmt(result?.spread || 0, 1)} pts (usual {fmt(cfg.usualSpread, 1)})
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Updated</div>
          <div className={`text-sm font-bold tabular-nums ${stale ? "text-amber-500" : ""}`}>{fmtAge(ageMs)} ago</div>
          <div className="text-[9px] text-muted-foreground">
            {result
              ? `buyers ${result.bp.toFixed(0)}% · sellers ${(100 - result.bp).toFixed(0)}% within ${fmt(cfg.near)} pts (context, not direction)`
              : "waiting for first book"}
          </div>
        </div>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)" }}>
        {/* ladder */}
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="text-xs font-semibold mb-1">Order book ladder</div>
          <div className="text-[10px] text-muted-foreground mb-2">
            {result?.sh
              ? `Best ${data?.levels || 5} levels per side from your broker, in lots. A deeper 200-level book is not available from this feed, so bucketing and pulled-order alerts are off.`
              : "Lots waiting, per " + fmt(cfg.step, 0) + " points. Buyers on the left, sellers on the right."}
          </div>
          <div className="space-y-0.5 max-h-[380px] overflow-auto pr-1">
            {ladderRows}
            {ladderRows.length === 0 && <div className="text-[10px] text-muted-foreground py-2">No data.</div>}
          </div>
        </div>

        {/* side panels */}
        <div className="space-y-2">
          <div className="rounded-lg border border-border bg-card p-2">
            <div className="text-xs font-semibold mb-1">Big orders right now</div>
            <div className="text-[10px] text-muted-foreground mb-1">Resting orders far larger than the usual depth — context, not a direction call.</div>
            <div className="space-y-1">
              {(result?.walls || []).length === 0 && <div className="text-[10px] text-muted-foreground">No unusually large orders right now.</div>}
              {(result?.walls || []).map((w, i) => {
                const seenTs = S.current.wallSeen.get(w.k + "|" + w.side) ?? now;
                return (
                  <div key={i} className="text-[10px]">
                    <span className={w.side === "b" ? "text-emerald-600" : "text-red-600"}>
                      {w.side === "b" ? "Big Buyers" : "Big Sellers"}
                    </span>{" "}
                    {rangeLabel(w.k)} · {Math.round(w.lots)} lots · {w.mult.toFixed(1)}× normal · waiting {fmtAge(now - seenTs)}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-2" data-testid="order-book-scorecard">
            <div className="text-xs font-semibold mb-1">Today's scorecard: big levels price reached</div>
            <div className="text-[10px] text-muted-foreground mb-1">Each big level is judged live once the price reaches it: turned or broke. Context, not guaranteed support/resistance.</div>
            <div className="space-y-1">
              {scorecard.length === 0 && (
                <div className="text-[10px] text-muted-foreground">No big level has been reached yet today.</div>
              )}
              {scorecard.map((e) => (
                <div key={e.k + "|" + e.side} className="text-[10px] flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    <span className={e.side === "b" ? "text-emerald-600" : "text-red-600"}>
                      {e.side === "b" ? "Buyers" : "Sellers"}
                    </span>{" "}
                    {rangeLabel(e.k)} · {Math.round(e.lots)} lots
                  </span>
                  <span className={`font-bold uppercase ${STATUS_STYLE[e.status]}`}>{e.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-2">
            <div className="text-xs font-semibold mb-1">Stop-loss areas (estimated)</div>
            <div className="text-[10px] text-muted-foreground mb-1">Where stops likely sit — from today's high/low, the chain's heaviest put strike and round numbers. Context, not guaranteed levels.</div>
            <div className="space-y-1">
              {!!data?.low && !!data?.ltp && (
                <div className="text-[10px]">Just below {fmt(data.low)} — below today's low · {fmt(Math.max(0, data.ltp - data.low), 0)} pts away</div>
              )}
              {putStrike && now - putStrike.ts < 10 * 60_000 && data?.ltp ? (
                <div className="text-[10px]">
                  {putStrike.k <= data.ltp ? "Just below" : "Just above"} {fmt(putStrike.k)} — {putStrike.k <= data.ltp ? "below" : "above"} the strike with the most puts · {fmt(Math.abs(data.ltp - putStrike.k), 0)} pts away
                </div>
              ) : null}
              {(() => {
                const rl = data?.ltp ? roundLevels(data.ltp, cfg.roundStep) : null;
                if (!rl || !data) return null;
                return (
                  <>
                    <div className="text-[10px]">Just below {fmt(rl.below)} — below a round number · {fmt(data.ltp - rl.below, 0)} pts away</div>
                    <div className="text-[10px]">Just above {fmt(rl.above)} — above a round number · {fmt(rl.above - data.ltp, 0)} pts away</div>
                  </>
                );
              })()}
              {!!data?.high && !!data?.ltp && (
                <div className="text-[10px]">Just above {fmt(data.high)} — above today's high · {fmt(Math.max(0, data.high - data.ltp), 0)} pts away</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
