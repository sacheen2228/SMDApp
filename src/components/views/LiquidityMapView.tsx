"use client";

import { useMemo, useState } from "react";
import { Activity as ActivityIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const TFS = ["5m", "15m", "1h", "1d"] as const;
type Tf = (typeof TFS)[number];

function n(v: unknown, d = 0): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : d;
}
function fmtLakh(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (a >= 1e5) return (v / 1e5).toFixed(1) + "L";
  return String(Math.round(v));
}

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface WallStrike { strike: number; ceOi: number; ceOiChg: number; peOi: number; peOiChg: number }

interface LiquidityData {
  symbol: string;
  spot: number;
  maxPain: number;
  pcr: number;
  callOiChange: number;
  putOiChange: number;
  totalCallOI: number;
  totalPutOI: number;
  walls: WallStrike[];
  candles: Candle[];
  source: string;
  freshness: string;
}

function fetchLiquidity(symbol: string, tf: string) {
  const chainPromise = fetch(`/api/option-chain?symbol=${symbol}`).then(async (r) => {
    if (!r.ok) throw new Error("chain failed");
    const json = await r.json();
    const d = json.data || json;
    const fr = d.freshness;
    const s = d.summary || {};
    const rows = (d.data || d.strikes || []) as any[];
    return {
      symbol,
      spot: n(s.spotPrice),
      maxPain: n(s.maxPain),
      pcr: n(s.pcr),
      callOiChange: n(s.callOiChange),
      putOiChange: n(s.putOiChange),
      totalCallOI: n(s.totalCallOI),
      totalPutOI: n(s.totalPutOI),
      walls: rows.map((r) => ({ strike: r.strike, ceOi: n(r.ce?.oi), ceOiChg: n(r.ce?.oiChg), peOi: n(r.pe?.oi), peOiChg: n(r.pe?.oiChg) })).filter((w) => w.ceOi > 0 || w.peOi > 0),
      source: d.source || json.source || fr?.source || "UNKNOWN",
      freshness: typeof fr === "string" ? fr : fr?.freshness || "UNKNOWN",
    };
  });
  const candlePromise = fetch(`/api/breeze/candles?symbol=${symbol}&interval=${tf}&limit=200`).then(async (r) => {
    if (!r.ok) return [] as Candle[];
    const j = await r.json();
    return (j.data || []).map((c: any) => ({
      time: c.time, open: n(c.open), high: n(c.high), low: n(c.low), close: n(c.close), volume: n(c.volume),
    }));
  });
  return Promise.all([chainPromise, candlePromise]).then(([chain, candles]) => ({ ...chain, candles } as LiquidityData));
}

/* ─── score ring card ─── */
function RingCard({ title, score, tone, level, caption }: { title: string; score: number; tone: string; level: string; caption: string }) {
  const R = 20, C = 2 * Math.PI * R;
  const color = tone === "up" ? "var(--ty-up)" : tone === "down" ? "var(--ty-down)" : "var(--ty-warn)";
  return (
    <div className="ty-panel ty-panel-raised flex items-center gap-4 p-4">
      <div className="relative size-12 shrink-0">
        <svg viewBox="0 0 48 48" className="size-12 -rotate-90">
          <circle cx="24" cy="24" r={R} fill="none" stroke="var(--ty-hairline-strong)" strokeWidth="4" />
          <circle cx="24" cy="24" r={R} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
            strokeDasharray={`${(C * score) / 100} ${C}`} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="ty-stat-value" style={{ color }}>{score}</span>
        </div>
      </div>
      <div className="min-w-0">
        <p className="ty-stat-label">{title}</p>
        <p className="ty-text-title font-semibold text-foreground truncate">{level}</p>
        <p className="ty-text-xs text-ty-subtle-fg">{caption}</p>
      </div>
    </div>
  );
}

/* ─── overlay chip rendered in SVG ─── */
function ChartChip({ x, y, label, color, anchor = "start" }: { x: number; y: number; label: string; color: string; anchor?: "start" | "middle" | "end" }) {
  const w = label.length * 6.2 + 26;
  const rx = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return (
    <g>
      <rect x={rx} y={y - 10} width={w} height={20} rx="10" fill="var(--ty-surface)" stroke="var(--ty-hairline-strong)" opacity="0.95" />
      <circle cx={rx + 11} cy={y} r="3" fill={color} />
      <text x={rx + 19} y={y + 4} fill="var(--foreground)" style={{ fontSize: 10.5 }}>{label}</text>
    </g>
  );
}

const LAYERS = [
  { key: "walls", label: "Option OI walls", color: "var(--ty-down)" },
  { key: "profile", label: "Volume profile", color: "var(--ty-muted-fg)" },
  { key: "range", label: "Max pain & writer's range", color: "var(--ty-brand)" },
  { key: "vwap", label: "VWAP", color: "var(--ty-info)" },
] as const;

export function LiquidityMapView() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [tf, setTf] = useState<Tf>("15m");
  const [active, setActive] = useState<Set<string>>(new Set(LAYERS.map((l) => l.key)));

  const { data, isLoading, error } = useQuery<LiquidityData>({
    queryKey: ["liquidity", symbol, tf],
    queryFn: () => fetchLiquidity(symbol, tf),
    refetchInterval: 30000,
    staleTime: 10000,
    retry: 1,
  });

  const toggleLayer = (k: string) => {
    setActive((cur) => {
      const nx = new Set(cur);
      if (nx.has(k)) nx.delete(k); else nx.add(k);
      return nx;
    });
  };

  /* walls above/below spot */
  const derived = useMemo(() => {
    if (!data) return null;
    const spot = data.spot;
    const putWalls = data.walls.filter((w) => w.strike < spot && w.peOi > 0).sort((a, b) => b.peOi - a.peOi);
    const callWalls = data.walls.filter((w) => w.strike > spot && w.ceOi > 0).sort((a, b) => b.ceOi - a.ceOi);
    const putWall = putWalls[0] ?? null;
    const callWall = callWalls[0] ?? null;
    const maxPe = Math.max(...data.walls.map((w) => w.peOi), 1);
    const maxCe = Math.max(...data.walls.map((w) => w.ceOi), 1);
    const supportScore = putWall ? Math.round(Math.min(95, Math.max(10, (putWall.peOi / maxPe) * 90))) : 0;
    const resistScore = callWall ? Math.round(Math.min(95, Math.max(10, (callWall.ceOi / maxCe) * 90))) : 0;
    const net = data.putOiChange - data.callOiChange;
    const buildScore = Math.round(Math.min(95, Math.max(10, 50 + (net / Math.max(1, data.totalPutOI + data.totalCallOI)) * 250)));
    const buildup = data.pcr > 1.05 || net > 0 ? "Bullish" : data.pcr < 0.95 || net < 0 ? "Bearish" : "Neutral";
    return { putWalls, callWalls, putWall, callWall, supportScore, resistScore, buildScore, buildup, net };
  }, [data]);

  /* chart geometry */
  const W = 1240, H = 540;
  const plot = { x0: 10, x1: 1140, y0: 20, y1: H - 40 };
  const candleX0 = 150, candleX1 = 980;
  const wallX1 = 1140, wallMaxW = 150;
  const profX0 = 10, profMaxW = 135;

  const chart = useMemo(() => {
    if (!data) return null;
    const candles = data.candles;
    const spot = data.spot;
    const clipped = data.walls.filter((w) => w.strike >= spot * 0.94 && w.strike <= spot * 1.06);
    const loCandidates = [spot * 0.985, ...candles.map((c) => c.low), ...clipped.map((w) => w.strike)];
    const hiCandidates = [spot * 1.015, ...candles.map((c) => c.high), ...clipped.map((w) => w.strike)];
    let lo = Math.min(...loCandidates);
    let hi = Math.max(...hiCandidates);
    const pad = (hi - lo) * 0.03;
    lo -= pad; hi += pad;
    const y = (p: number) => plot.y1 - ((p - lo) / (hi - lo)) * (plot.y1 - plot.y0);

    // candles layout
    const nC = candles.length;
    const cw = nC > 1 ? (candleX1 - candleX0) / nC : 8;
    const bodyW = Math.max(1.5, Math.min(7, cw * 0.55));
    const cX = (i: number) => candleX0 + i * cw + cw / 2;

    // VWAP + profile are intraday metrics — scope them to the LATEST session in the series
    const istDay = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(t));
    const lastDay = candles.length ? istDay(candles[candles.length - 1].time) : "";
    const sessionCandles = candles.filter((c) => istDay(c.time) === lastDay);
    const lastSessionLabel = candles.length
      ? new Date(candles[candles.length - 1].time).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })
      : "";

    // VWAP (last session only)
    const hasVol = candles.some((c) => c.volume > 0);
    let vwapPts: Array<{ x: number; y: number }> = [];
    if (hasVol) {
      let pv = 0, vv = 0;
      candles.forEach((c, i) => {
        if (istDay(c.time) !== lastDay) return;
        const tp = (c.high + c.low + c.close) / 3;
        pv += tp * c.volume; vv += c.volume;
        const v = vv > 0 ? pv / vv : tp;
        vwapPts.push({ x: cX(i), y: y(v) });
      });
    }

    // volume profile (time-at-price when index volume is zero) — last session only
    const BINS = 34;
    const bins = Array.from({ length: BINS }, () => 0);
    const binH = (plot.y1 - plot.y0) / BINS;
    sessionCandles.forEach((c) => {
      const cnt = hasVol ? c.volume : 1;
      const loC = Math.max(0, Math.min(BINS - 1, Math.floor((c.low - lo) / ((hi - lo) / BINS))));
      const hiC = Math.max(0, Math.min(BINS - 1, Math.floor((c.high - lo) / ((hi - lo) / BINS))));
      for (let b = loC; b <= hiC; b++) bins[b] += cnt;
    });
    const maxBin = Math.max(...bins, 1);
    const pocIdx = bins.indexOf(maxBin);
    const pocPrice = lo + ((pocIdx + 0.5) * (hi - lo)) / BINS;

    return { candles, y, lo, hi, cw, bodyW, cX, vwapPts, hasVol, bins, maxBin, binH, pocPrice, clipped, lastSessionLabel, sessionCount: sessionCandles.length };
  }, [data]);

  if (isLoading) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <ActivityIcon className="mx-auto h-8 w-8 animate-spin text-ty-muted-fg mb-2" />
        <p className="ty-text-body-sm text-ty-muted-fg">Loading liquidity map…</p>
      </div>
    );
  }
  if (error || !data || !derived || !chart) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <p className="ty-text-xs text-ty-down">{String(error?.message ?? "No data")}</p>
      </div>
    );
  }

  const spotY = chart.y(data.spot);
  const fmtNum = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const tfLabel = (t: string) => (t === "1d" ? "1D" : t);

  return (
    <div className="space-y-4">
      {/* symbol pills */}
      <div className="flex flex-wrap items-center gap-1">
        {SYMBOLS.map((s) => (
          <Button key={s} variant="ghost" size="sm"
            onClick={() => setSymbol(s)}
            className={`h-7 px-2.5 ty-text-xs font-semibold rounded-full ${symbol === s ? "ty-fill text-foreground" : "text-ty-muted-fg hover:text-foreground"}`}>
            {s}
          </Button>
        ))}
        <Badge variant="outline" className="ml-auto px-2 py-1 ty-text-xs">{data.source.toUpperCase()} · {data.freshness}</Badge>
      </div>

      {/* score cards */}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="relative">
          <RingCard title="SUPPORT" score={derived.supportScore} tone="up"
            level={derived.putWall ? fmtNum(derived.putWall.strike) : "—"}
            caption={derived.putWall ? (derived.putWall.peOiChg >= 0 ? "strong, fresh adds" : "unwinding — weakening") : "no wall below"} />
        </div>
        <RingCard title="RESISTANCE" score={derived.resistScore} tone="down"
          level={derived.callWall ? fmtNum(derived.callWall.strike) : "—"}
          caption={derived.callWall ? (derived.callWall.ceOiChg >= 0 ? "strong, fresh adds" : "covering — melting") : "no wall above"} />
        <RingCard title="BUILDUP" score={derived.buildScore}
          tone={derived.buildup === "Bullish" ? "up" : derived.buildup === "Bearish" ? "down" : "warn"}
          level={derived.buildup}
          caption={`PCR ${data.pcr.toFixed(2)} · CE ${fmtLakh(data.callOiChange)} / PE ${fmtLakh(data.putOiChange)}`} />
      </div>

      {/* chart panel */}
      <Panel title="Price · where the big money sits" subtitle={`${symbol} · ${tfLabel(tf)} candles`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 ty-text-xs text-ty-muted-fg">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-ty-up" /> Long buildup</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-ty-down" /> Short buildup</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-ty-info" /> Short covering</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-ty-warn" /> Long unwinding</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {TFS.map((t) => (
              <Button key={t} variant="ghost" size="sm" onClick={() => setTf(t)}
                className={`h-6 px-2 ty-text-xs rounded-md ${tf === t ? "ty-fill text-foreground" : "text-ty-muted-fg"}`}>
                {tfLabel(t)}
              </Button>
            ))}
          </div>
          <div className="mx-1 h-4 w-px bg-ty-hairline" />
          {LAYERS.map((l) => (
            <button key={l.key} onClick={() => toggleLayer(l.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ty-text-xs transition-colors ${active.has(l.key) ? "border-ty-hairline-strong bg-ty-fill text-foreground" : "border-ty-hairline text-ty-subtle-fg"}`}>
              <span className="size-2 rounded-full" style={{ background: active.has(l.key) ? l.color : "transparent", border: `1px solid ${l.color}` }} />
              {l.label}
            </button>
          ))}
        </div>

        <div className="mt-2 overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[900px]">
            {/* grid */}
            {Array.from({ length: 7 }).map((_, i) => {
              const p = chart.lo + ((chart.hi - chart.lo) * (i + 0.5)) / 7;
              const yy = chart.y(p);
              return (
                <g key={i}>
                  <line x1={plot.x0} x2={plot.x1} y1={yy} y2={yy} stroke="var(--ty-hairline)" strokeWidth="0.5" />
                  <text x={plot.x1 + 8} y={yy + 3.5} fill="var(--ty-subtle-fg)" style={{ fontSize: 10 }}>{fmtNum(p)}</text>
                </g>
              );
            })}

            {/* volume profile (left) */}
            {active.has("profile") && chart.bins.map((v, i) => {
              const wpx = (v / chart.maxBin) * profMaxW;
              const yy = plot.y1 - (i + 1) * chart.binH;
              return <rect key={i} x={profX0} y={yy + 0.5} width={wpx} height={chart.binH - 1.5} rx="2" fill="var(--ty-muted-fg)" opacity="0.28" />;
            })}

            {/* candles */}
            {chart.candles.map((c, i) => {
              const x = chart.cX(i);
              const up = c.close >= c.open;
              const col = up ? "var(--ty-up)" : "var(--ty-down)";
              const yO = chart.y(c.open), yC = chart.y(c.close);
              return (
                <g key={i}>
                  <line x1={x} x2={x} y1={chart.y(c.high)} y2={chart.y(c.low)} stroke={col} strokeWidth="1" opacity="0.9" />
                  <rect x={x - chart.bodyW / 2} y={Math.min(yO, yC)} width={chart.bodyW} height={Math.max(1, Math.abs(yC - yO))} fill={col} opacity="0.95" />
                </g>
              );
            })}

            {/* VWAP */}
            {active.has("vwap") && chart.vwapPts.length > 1 && (
              <path d={chart.vwapPts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ")} fill="none" stroke="var(--ty-info)" strokeWidth="1.6" opacity="0.9" />
            )}

            {/* max pain + writer's range */}
            {active.has("range") && (
              <>
                <line x1={plot.x0} x2={plot.x1} y1={chart.y(data.maxPain)} y2={chart.y(data.maxPain)} stroke="var(--ty-brand)" strokeWidth="1" strokeDasharray="5 4" opacity="0.75" />
                {derived.putWall && (
                  <line x1={plot.x0} x2={plot.x1} y1={chart.y(derived.putWall.strike)} y2={chart.y(derived.putWall.strike)} stroke="var(--ty-brand)" strokeWidth="0.8" strokeDasharray="2 4" opacity="0.55" />
                )}
                {derived.callWall && (
                  <line x1={plot.x0} x2={plot.x1} y1={chart.y(derived.callWall.strike)} y2={chart.y(derived.callWall.strike)} stroke="var(--ty-brand)" strokeWidth="0.8" strokeDasharray="2 4" opacity="0.55" />
                )}
                <ChartChip x={560} y={chart.y(data.maxPain)} label={`Max pain ${fmtNum(data.maxPain)}`} color="var(--ty-brand)" anchor="middle" />
                {derived.putWall && derived.callWall && (
                  <ChartChip x={340} y={Math.min(chart.y(derived.callWall.strike), chart.y(derived.putWall.strike)) - 0}
                    label={`Writer's range ${fmtNum(derived.putWall.strike)}–${fmtNum(derived.callWall.strike)}`} color="var(--ty-brand)" anchor="middle" />
                )}
              </>
            )}

            {/* OI walls (right) */}
            {active.has("walls") && chart.clipped.map((w) => {
              const callW = (w.ceOi / Math.max(...chart.clipped.map((x) => x.ceOi), 1)) * wallMaxW;
              const putW = (w.peOi / Math.max(...chart.clipped.map((x) => x.peOi), 1)) * wallMaxW;
              const yStrike = chart.y(w.strike);
              return (
                <g key={w.strike}>
                  <rect x={wallX1 - callW} y={yStrike - 4.5} width={callW} height={4} rx="1" fill="var(--ty-down)" opacity="0.55" />
                  <rect x={wallX1 - putW} y={yStrike + 0.5} width={putW} height={4} rx="1" fill="var(--ty-up)" opacity="0.55" />
                </g>
              );
            })}

            {/* big sellers chips */}
            {active.has("walls") && derived.callWalls.slice(0, 1).map((w) => (
              <ChartChip key={`bc-${w.strike}`} x={wallX1 - 12} y={chart.y(w.strike) - 9} label={`Big call sellers ${fmtNum(w.strike)}`} color="var(--ty-down)" anchor="end" />
            ))}
            {active.has("walls") && derived.putWalls.slice(0, 2).map((w, i) => (
              <ChartChip key={`bp-${w.strike}`} x={wallX1 - 12} y={chart.y(w.strike) + 11 + i * 16} label={`Big put sellers @ ${fmtNum(w.strike)}`} color="var(--ty-up)" anchor="end" />
            ))}

            {/* spot tag */}
            <rect x={wallX1 + 2} y={spotY - 9} width={64} height={18} rx="4" fill="var(--ty-up)" />
            <text x={wallX1 + 34} y={spotY + 4} textAnchor="middle" fill="#fff" style={{ fontSize: 10.5, fontWeight: 700 }}>{fmtNum(data.spot)}</text>

            {/* POC chip */}
            {active.has("profile") && chart.candles.length > 0 && (
              <ChartChip x={profX0 + profMaxW + 6} y={chart.y(chart.pocPrice)} label={`POC ${fmtNum(chart.pocPrice)}`} color="var(--ty-muted-fg)" />
            )}

            {/* time axis */}
            {chart.candles.length > 3 && [0, Math.floor(chart.candles.length / 3), Math.floor((chart.candles.length * 2) / 3), chart.candles.length - 1].map((i) => {
              const t = new Date(chart.candles[i].time);
              const lbl = t.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
              return (
                <g key={`tx-${i}`}>
                  <line x1={chart.cX(i)} x2={chart.cX(i)} y1={plot.y1} y2={plot.y1 + 4} stroke="var(--ty-hairline-strong)" />
                  <text x={chart.cX(i)} y={plot.y1 + 16} textAnchor="middle" fill="var(--ty-subtle-fg)" style={{ fontSize: 9.5 }}>{lbl}</text>
                </g>
              );
            })}
          </svg>
        </div>
        <p className="ty-text-xs text-ty-subtle-fg mt-1">
          {chart.hasVol ? "profile + VWAP use candle volume" : "index candles carry no volume — profile uses time-at-price"} · both scoped to the latest session ({chart.lastSessionLabel}) · walls &amp; max pain from {data.source} chain · {data.freshness}
        </p>
      </Panel>
    </div>
  );
}
