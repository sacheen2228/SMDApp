"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Panel, StatCell } from "@/components/ui/panel";
import { getChainOiHistory, type ChainOiSnapshot } from "@/lib/market-history-client";
import { buildOptionPlan, PLAN_CONFIG, type OptionPlan } from "@/lib/option-plan";
import { getLotSizeStrict } from "@/lib/symbol-config";

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const SPEEDS = [0.5, 1, 2, 4, 8];
const ROW_H = 24;

function n(v: unknown, d = 0): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : d;
}
function fmtLakh(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (a >= 1e5) return (v / 1e5).toFixed(1) + "L";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
function istTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  } catch {
    return "—";
  }
}

/* ─── Buildup classification: spot direction × OI change ─── */
type Tone = "up" | "down" | "info" | "warn" | "neutral";
const CLASS_META: Record<string, { label: string; meaning: string; bar: string; dot: string }> = {
  LB: { label: "Long buildup", meaning: "spot up · OI added — fresh longs being built", bar: "bg-ty-up/80", dot: "text-ty-up" },
  SB: { label: "Short buildup", meaning: "spot down · OI added — writers pressing", bar: "bg-ty-down/80", dot: "text-ty-down" },
  SC: { label: "Short covering", meaning: "spot up · OI cut — shorts buying back", bar: "bg-ty-info/80", dot: "text-ty-info" },
  LU: { label: "Long unwinding", meaning: "spot down · OI cut — longs exiting", bar: "bg-ty-warn/80", dot: "text-ty-warn" },
  N: { label: "No change", meaning: "flat OI at this strike", bar: "bg-ty-muted-fg/30", dot: "text-ty-muted-fg" },
};
function classify(dir: number, oiDelta: number): string {
  if (Math.abs(oiDelta) < 1) return "N";
  if (dir > 0 && oiDelta > 0) return "LB";
  if (dir < 0 && oiDelta > 0) return "SB";
  if (dir > 0 && oiDelta < 0) return "SC";
  if (dir < 0 && oiDelta < 0) return "LU";
  return "N";
}

/* ─── Data ─── */
interface OIFlowData {
  symbol: string;
  spot: number;
  spotChange: number;
  spotChangePct: number;
  pcr: number;
  totalCallOI: number;
  totalPutOI: number;
  callOiChange: number;
  putOiChange: number;
  futuresPrice: number | null;
  strikes: Array<{ strike: number; ceOi: number; ceOiChg: number; ceStartOi: number; ceLtp: number; ceDeltaG: number | null; peOi: number; peOiChg: number; peStartOi: number; peLtp: number; peDeltaG: number | null }>;
  expiries: Array<{ date: string; label: string }>;
  lastUpdate: string;
  source: string;
  freshness: string;
}
function fetchOIFlow(symbol: string, expiry?: string) {
  const params = new URLSearchParams({ symbol });
  if (expiry) params.set("expiry", expiry);
  return fetch(`/api/option-chain?${params}`).then(async (r) => {
    if (!r.ok) throw new Error("option-chain failed");
    const json = await r.json();
    const d = json.data || json;
    const fr = d.freshness;
    const s = d.summary || {};
    const prevClose = n(s.prevClose) || n(s.prevCloseLive);
    const rows = (d.data || d.strikes || []).map((r: any) => {
      const ceOi = n(r.ce?.oi);
      const peOi = n(r.pe?.oi);
      const ceOiChg = n(r.ce?.oiChg);
      const peOiChg = n(r.pe?.oiChg);
      return {
        strike: r.strike,
        ceOi, ceOiChg, ceStartOi: Math.max(0, ceOi - ceOiChg),
        ceLtp: n(r.ce?.ltp), ceDeltaG: r.ce?.delta != null ? Number(r.ce.delta) : null,
        peOi, peOiChg, peStartOi: Math.max(0, peOi - peOiChg),
        peLtp: n(r.pe?.ltp), peDeltaG: r.pe?.delta != null ? Number(r.pe.delta) : null,
      };
    });
    return {
      symbol,
      spot: n(s.spotPrice),
      // some summary paths carry no spotChange/spotChangePct — derive from prevClose
      spotChange: s.spotChange != null ? n(s.spotChange) : prevClose ? n(s.spotPrice) - prevClose : 0,
      spotChangePct: s.spotChangePct != null ? n(s.spotChangePct) : prevClose && prevClose > 0 ? ((n(s.spotPrice) - prevClose) / prevClose) * 100 : 0,
      pcr: n(s.pcr),
      totalCallOI: n(s.totalCallOI),
      totalPutOI: n(s.totalPutOI),
      callOiChange: n(s.callOiChange),
      putOiChange: n(s.putOiChange),
      futuresPrice: s.futuresPrice != null ? n(s.futuresPrice) : null,
      strikes: rows,
      expiries: d.expiries || [],
      lastUpdate: d.lastUpdate || json.lastUpdate,
      source: d.source || json.source || fr?.source || "UNKNOWN",
      freshness: typeof fr === "string" ? fr : fr?.freshness || "UNKNOWN",
    } as OIFlowData;
  });
}

/* ─── A frame is one snapshot of OI (live = today, replay = a moment) ─── */
interface FrameStrike { strike: number; ceOi: number; ceDelta: number; cePrev: number; peOi: number; peDelta: number; pePrev: number; }
interface Frame { t: string | null; spot: number; dir: number; strikes: FrameStrike[]; live: boolean }

function buildLiveFrame(d: OIFlowData | undefined): Frame | null {
  if (!d) return null;
  return {
    t: d.lastUpdate,
    spot: d.spot,
    dir: d.spotChangePct,
    live: true,
    strikes: d.strikes.map((s) => ({
      strike: s.strike, ceOi: s.ceOi, ceDelta: s.ceOiChg, cePrev: s.ceStartOi,
      peOi: s.peOi, peDelta: s.peOiChg, pePrev: s.peStartOi,
    })),
  };
}
function buildReplayFrames(history: ChainOiSnapshot[]): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < history.length; i++) {
    const cur = history[i];
    const prev = history[i - 1];
    const spot = n(cur.spot);
    const dir = prev && cur.spot != null && prev.spot != null ? n(cur.spot) - n(prev.spot) : 0;
    const prevMap = new Map((prev?.rows ?? []).map((r) => [r.strike, r]));
    out.push({
      t: cur.timestamp,
      spot,
      dir,
      live: false,
      strikes: cur.rows.map((r) => {
        const p = prevMap.get(r.strike);
        const ceOi = n(r.ceOi), peOi = n(r.peOi);
        const cePrev = p ? n(p.ceOi) : ceOi;
        const pePrev = p ? n(p.peOi) : peOi;
        return { strike: r.strike, ceOi, ceDelta: ceOi - cePrev, cePrev, peOi, peDelta: peOi - pePrev, pePrev };
      }),
    });
  }
  return out;
}

/* ─── Flow dots: visualize OI speed at a bar's leading edge ─── */
function FlowDots({ edgePct, inflow, count, color }: { edgePct: number; inflow: boolean; count: number; color: string }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="ty-dot"
          style={{
            left: `calc(${edgePct}% + 2px)`,
            top: "50%",
            marginTop: -2,
            color,
            animationDelay: `${i * 200}ms`,
            ["--ty-dir" as string]: inflow ? -1 : 1,
          } as React.CSSProperties}
        />
      ))}
    </>
  );
}

/* ─── Momentum gauge (−100..+100 semicircle) ─── */
function MomentumGauge({ value }: { value: number }) {
  const clamped = Math.max(-100, Math.min(100, value));
  const angle = Math.PI * (1 - (clamped + 100) / 200); // π → 0
  const cx = 100, cy = 96, r = 72;
  const nx = cx + r * Math.cos(Math.PI - angle);
  const ny = cy - r * Math.sin(angle);
  const arc = (a0: number, a1: number) => {
    const x0 = cx + r * Math.cos(a0), y0 = cy - r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const bearArc = arc(Math.PI, Math.PI * 0.5);
  const bullArc = arc(Math.PI * 0.5, 0);
  const pos = angle >= Math.PI / 2 ? arc(Math.PI, angle) : arc(angle, 0);
  return (
    <div className="relative flex flex-col items-center">
      <svg viewBox="0 0 200 110" className="w-[200px]">
        <path d={bearArc} fill="none" stroke="var(--ty-down)" strokeWidth="7" strokeLinecap="round" opacity="0.25" />
        <path d={bullArc} fill="none" stroke="var(--ty-up)" strokeWidth="7" strokeLinecap="round" opacity="0.25" />
        {clamped !== 0 && (
          <path d={pos} fill="none" stroke={clamped > 0 ? "var(--ty-up)" : "var(--ty-down)"} strokeWidth="7" strokeLinecap="round" />
        )}
        <circle cx={nx} cy={ny} r="7" fill="var(--ty-surface)" stroke="var(--ty-hairline-strong)" />
        <circle cx={nx} cy={ny} r="4" fill="var(--foreground)" />
      </svg>
      <div className="absolute top-8 text-center">
        <p className="ty-text-title font-semibold" style={{ color: clamped > 20 ? "var(--ty-up)" : clamped < -20 ? "var(--ty-down)" : "var(--ty-warn)" }}>
          {clamped > 0 ? "+" : ""}{clamped}
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════ VIEW ══════════════════════════ */
export function OIFlowView() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [expiry, setExpiry] = useState(""); // "" = nearest
  const [replayIdx, setReplayIdx] = useState<number | null>(null); // null = live
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading, error } = useQuery<OIFlowData>({
    queryKey: ["oiflow", symbol, expiry],
    queryFn: () => fetchOIFlow(symbol, expiry || undefined),
    refetchInterval: 30000,
    staleTime: 10000,
    retry: 1,
  });
  const { data: history = [] } = useQuery<ChainOiSnapshot[]>({
    queryKey: ["chain-oi-history", symbol],
    queryFn: () => getChainOiHistory(symbol),
    refetchInterval: 60000,
    staleTime: 30000,
    retry: 1,
  });

  const liveFrame = useMemo(() => buildLiveFrame(data), [data]);
  const replayFrames = useMemo(() => buildReplayFrames(history), [history]);
  const hasReplay = replayFrames.length > 1;
  const frame: Frame | null = replayIdx === null ? liveFrame : replayFrames[Math.min(replayIdx, replayFrames.length - 1)];

  /* Replay clock */
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (playing && hasReplay) {
      timerRef.current = setInterval(() => {
        setReplayIdx((cur) => {
          const base = cur === null ? 0 : cur + 1;
          if (base >= replayFrames.length - 1) { setPlaying(false); return replayFrames.length - 1; }
          return base;
        });
      }, 1500 / speed);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [playing, speed, hasReplay, replayFrames.length]);

  const goLive = useCallback(() => { setReplayIdx(null); setPlaying(false); }, []);
  const startReplay = useCallback(() => {
    if (!hasReplay) return;
    setReplayIdx((c) => (c === null ? 0 : c));
    setPlaying((p) => !p);
  }, [hasReplay]);
  const step = useCallback((d: number) => {
    setReplayIdx((c) => {
      if (c === null) return d < 0 ? replayFrames.length - 1 : replayFrames.length - 1;
      return Math.max(0, Math.min(replayFrames.length - 1, c + d));
    });
  }, [replayFrames.length]);

  /* Keyboard: Space play/pause · ←/→ step · Home replay start · End live */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); startReplay(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "Home") { setReplayIdx(0); }
      else if (e.key === "End") goLive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startReplay, step, goLive]);

  /* ─── Window of strikes around spot ─── */
  const WINDOW = 12;
  const sorted = useMemo(() => (frame?.strikes ?? []).slice().sort((a, b) => a.strike - b.strike), [frame]);
  const windowData = useMemo(() => {
    if (!frame || !sorted.length) return { rows: [], spotTop: 0, maxOi: 1, floorStrike: null as number | null, ceilStrike: null as number | null };
    const spot = frame.spot;
    let mid = sorted.findIndex((s) => s.strike >= spot);
    if (mid === -1) mid = sorted.length;
    const start = Math.max(0, mid - WINDOW);
    const end = Math.min(sorted.length, mid + WINDOW);
    const rows = sorted.slice(start, end);
    // fractional spot position between rows
    const below = rows.filter((s) => s.strike < spot);
    const atOrAbove = rows.filter((s) => s.strike >= spot);
    let spotTop = rows.length * ROW_H;
    if (below.length && atOrAbove.length) {
      const lo = below[below.length - 1].strike, hi = atOrAbove[0].strike;
      const frac = hi > lo ? (spot - lo) / (hi - lo) : 0;
      spotTop = (below.length - 1 + frac) * ROW_H;
    }
    const maxOi = Math.max(...rows.flatMap((s) => [s.ceOi, s.peOi]), 1);
    const floor = rows.filter((s) => s.strike < spot).sort((a, b) => b.peOi - a.peOi)[0];
    const ceil = rows.filter((s) => s.strike > spot).sort((a, b) => b.ceOi - a.ceOi)[0];
    return { rows, spotTop, maxOi, floorStrike: floor?.strike ?? null, ceilStrike: ceil?.strike ?? null };
  }, [frame, sorted]);
  const { rows, spotTop, maxOi, floorStrike, ceilStrike } = windowData;

  /* fastest strike → halo */
  const fastest = useMemo(() => {
    let best: FrameStrike | null = null, bestV = 0;
    for (const s of rows) {
      const v = Math.abs(s.ceDelta) + Math.abs(s.peDelta);
      if (v > bestV) { bestV = v; best = s; }
    }
    return bestV > maxOi * 0.04 ? best : null;
  }, [rows, maxOi]);

  /* ─── Momentum & speed (near spot ±5 strikes) ─── */
  const momentum = useMemo(() => {
    if (!frame) return null;
    const near = sorted.filter((s) => Math.abs(s.strike - frame.spot) <= 5 * (sorted[1] && sorted[0] ? sorted[1].strike - sorted[0].strike : 50));
    let bull = 0, bear = 0;
    for (const s of near) {
      bull += Math.max(0, s.peDelta) + Math.abs(Math.min(0, s.ceDelta));
      bear += Math.max(0, s.ceDelta) + Math.abs(Math.min(0, s.peDelta));
    }
    const net = bull - bear;
    const val = Math.max(-100, Math.min(100, Math.round((net / Math.max(1, bull + bear)) * 100)));
    return { val, bull, bear, net, nearCount: near.length };
  }, [frame, sorted]);

  const speedPerMin = useMemo(() => {
    if (!momentum || replayIdx === null) return null;
    const cur = replayFrames[replayIdx];
    const prev = replayFrames[Math.max(0, replayIdx - 1)];
    const mins = Math.abs((new Date(cur.t ?? 0).getTime() - new Date(prev.t ?? 0).getTime()) / 60000) || 2;
    return Math.round((momentum.bull + momentum.bear) / mins);
  }, [momentum, replayIdx, replayFrames]);

  const conviction = momentum ? Math.min(99, Math.max(55, Math.abs(momentum.val))) : 55;
  const regime = !momentum ? "—" : momentum.val > 25 ? "Bullish" : momentum.val < -25 ? "Bearish" : "Range-bound";
  const regimeTone = regime === "Bullish" ? "text-ty-up" : regime === "Bearish" ? "text-ty-down" : "text-ty-warn";

  /* ─── Trade plan from live flow (uses the repo's own buildOptionPlan engine) ─── */
  const tradePlan = useMemo(() => {
    if (!data || !momentum) return null;
    const dir: "CE" | "PE" | null = momentum.val >= 25 ? "CE" : momentum.val <= -25 ? "PE" : null;
    if (!dir) return { dir: null as null, plan: null, strike: null, entry: 0, notes: ["Flow is range-bound near spot — the plan waits for a wall break or |momentum| ≥ 25."] };
    const spot = data.spot;
    const stepSize = data.strikes.length > 1 ? Math.abs(data.strikes[1].strike - data.strikes[0].strike) || 50 : 50;
    // ATM → 2 steps ITM-preferred side, nearest strike with a live premium
    const candidates = dir === "CE"
      ? data.strikes.filter((s) => s.strike >= spot - stepSize && s.ceLtp > 0)
      : data.strikes.filter((s) => s.strike <= spot + stepSize && s.peLtp > 0);
    const pick = candidates.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    if (!pick) return { dir, plan: null, strike: null, entry: 0, notes: ["No live premium at any strike near spot — chain data incomplete."] };
    const entry = dir === "CE" ? pick.ceLtp : pick.peLtp;
    const lotSize = getLotSizeStrict(symbol) ?? 0;
    if (!lotSize || entry <= 0) return { dir, plan: null, strike: pick.strike, entry, notes: [!lotSize ? `Lot size for ${symbol} unknown — fail closed.` : "Premium is zero — no tradable quote."] };
    const plan = buildOptionPlan({ symbol, optionType: dir, entryPremium: entry, lotSize });
    const notes: string[] = [];
    const delta = dir === "CE" ? pick.ceDeltaG : pick.peDeltaG;
    if (delta != null && Math.abs(delta) < 0.35) notes.push(`|delta| ${Math.abs(delta).toFixed(2)} < 0.35 — deep OTM lottery risk, halve size.`);
    if (plan && !plan.tradable) notes.push(plan.notes.join(" "));
    return { dir, plan, strike: pick.strike, entry, notes };
  }, [data, momentum, symbol]);

  /* ─── What's next read (own wording) ─── */
  const nextRead = useMemo(() => {
    if (!frame) return [];
    const spot = frame.spot;
    const putWall = sorted.filter((s) => s.strike < spot).sort((a, b) => b.peOi - a.peOi)[0];
    const callWall = sorted.filter((s) => s.strike > spot).sort((a, b) => b.ceOi - a.ceOi)[0];
    const fastPe = sorted.filter((s) => s.peDelta > maxOi * 0.02).sort((a, b) => b.peDelta - a.peDelta)[0];
    const fastCe = sorted.filter((s) => s.ceDelta > maxOi * 0.02).sort((a, b) => b.ceDelta - a.ceDelta)[0];
    const lines: string[] = [];
    if (callWall) lines.push(`Call writers defending ${callWall.strike.toLocaleString("en-IN")} — ${fmtLakh(callWall.ceOi)} OI ${callWall.ceDelta >= 0 ? "and still adding" : "but covering today"}.`);
    if (putWall) lines.push(`Put writers at ${putWall.strike.toLocaleString("en-IN")} — ${fmtLakh(putWall.peOi)} OI ${putWall.peDelta >= 0 ? "and still adding" : "but unwinding today"}.`);
    if (fastPe) lines.push(`Fastest put writing: ${fastPe.strike.toLocaleString("en-IN")} (+${fmtLakh(fastPe.peDelta)}).`);
    if (fastCe) lines.push(`Fastest call writing: ${fastCe.strike.toLocaleString("en-IN")} (+${fmtLakh(fastCe.ceDelta)}).`);
    if (momentum) lines.push(momentum.val > 25 ? "Flow leans bullish near spot — put writing dominates." : momentum.val < -25 ? "Flow leans bearish near spot — call writing dominates." : "Flow is balanced near spot — expect a range day unless a wall breaks.");
    return lines;
  }, [frame, sorted, maxOi, momentum]);

  if (isLoading) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <Activity className="mx-auto h-8 w-8 animate-spin text-ty-muted-fg mb-2" />
        <p className="ty-text-body-sm text-ty-muted-fg">Loading OI flow…</p>
      </div>
    );
  }
  if (error || !data || !frame) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <p className="ty-text-xs text-ty-down">{String(error?.message ?? "No data")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ─── Header: symbol pills + expiry ─── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {SYMBOLS.map((s) => (
            <Button key={s} variant="ghost" size="sm"
              onClick={() => { setSymbol(s); goLive(); }}
              className={`h-7 px-2.5 ty-text-xs font-semibold rounded-full ${symbol === s ? "ty-fill text-foreground" : "text-ty-muted-fg hover:text-foreground"}`}>
              {s}
            </Button>
          ))}
        </div>
        <Select value={expiry || "nearest"} onValueChange={(v) => { setExpiry(v === "nearest" ? "" : v); goLive(); }}>
          <SelectTrigger className="h-7 w-[130px] ty-text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="nearest">Nearest</SelectItem>
            {(data.expiries ?? []).map((e) => (
              <SelectItem key={e.date} value={e.label}>{e.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="outline" className="ml-auto px-2 py-1 ty-text-xs">
          {replayIdx === null ? "LIVE" : `REPLAY · ${istTime(replayFrames[replayIdx]?.t ?? null)}`}
        </Badge>
      </div>

      {/* ─── Stat strip ─── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCell label="Spot" value={data.spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })} change={{ value: `${data.spotChangePct >= 0 ? "+" : ""}${data.spotChangePct.toFixed(2)}%`, up: data.spotChangePct >= 0 }} />
        <StatCell label="PCR" value={data.pcr.toFixed(2)} change={{ value: data.pcr > 1 ? "put-heavy" : "call-heavy", up: data.pcr < 1 }} />
        <StatCell label="Call OI Δ" value={fmtLakh(data.callOiChange)} change={{ value: data.callOiChange >= 0 ? "added" : "covered", up: false }} />
        <StatCell label="Put OI Δ" value={fmtLakh(data.putOiChange)} change={{ value: data.putOiChange >= 0 ? "added" : "covered", up: true }} />
        <StatCell label="Total CE OI" value={fmtLakh(data.totalCallOI)} />
        <StatCell label="Total PE OI" value={fmtLakh(data.totalPutOI)} />
      </div>

      {/* ═══ Trade plan card — strike/SL/TP from buildOptionPlan on the live flow ═══ */}
      {tradePlan && (
        <Panel title="Trade plan · from live flow" subtitle={tradePlan.dir ? `${tradePlan.dir === "CE" ? "Call buy — bullish flow" : "Put buy — bearish flow"} · momentum ${momentum!.val > 0 ? "+" : ""}${momentum!.val}` : "no trade — range-bound"}>
          {tradePlan.dir && tradePlan.plan && tradePlan.plan.tradable ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="bg-ty-brand text-white px-2 py-1 ty-text-xs font-bold">{symbol} {tradePlan.strike?.toLocaleString("en-IN")} {tradePlan.dir}</Badge>
                <span className="ty-text-xs text-ty-subtle-fg">premium quote at plan build · {data.freshness}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <StatCell label="Entry" value={tradePlan.entry.toFixed(2)} />
                <StatCell label="Stop Loss" value={tradePlan.plan.stopLoss.toFixed(2)} change={{ value: `${tradePlan.plan.riskPoints.toFixed(1)} pts risk`, up: false }} />
                <StatCell label="TP1 (2R)" value={tradePlan.plan.targets[0]?.toFixed(2) ?? "—"} change={{ value: `+₹${tradePlan.plan.rupee.tp1.toFixed(0)}`, up: true }} />
                <StatCell label="TP2 (3R)" value={tradePlan.plan.targets[1]?.toFixed(2) ?? "—"} change={{ value: `+₹${tradePlan.plan.rupee.tp2.toFixed(0)}`, up: true }} />
                <StatCell label="TP3 (4R)" value={tradePlan.plan.targets[2]?.toFixed(2) ?? "—"} change={{ value: `+₹${tradePlan.plan.rupee.tp3.toFixed(0)}`, up: true }} />
                <StatCell label="Size" value={`${tradePlan.plan.lots} lot${tradePlan.plan.lots === 1 ? "" : "s"}`} change={{ value: `₹${tradePlan.plan.deployed.toFixed(0)} · risk ₹${tradePlan.plan.riskAmount.toFixed(0)}`, up: true }} />
              </div>
              <p className="ty-text-xs text-ty-subtle-fg">
                R:R 1:{tradePlan.plan.rr.toFixed(1)} · one lot costs ₹{tradePlan.plan.lotCost.toFixed(0)} · stop capped at {Math.round(tradePlan.plan.stopPctOfPremium * 100)}% of premium
              </p>
              {tradePlan.notes.length > 0 && (
                <ul className="space-y-1">
                  {tradePlan.notes.map((nt, i) => (
                    <li key={i} className="ty-text-xs text-ty-warn flex gap-1.5"><span className="mt-1 size-1 shrink-0 rounded-full bg-ty-warn" />{nt}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : tradePlan.dir && tradePlan.plan && !tradePlan.plan.tradable ? (
            <div className="space-y-2">
              <Badge variant="outline" className="px-2 py-1 ty-text-xs text-ty-warn">{symbol} {tradePlan.strike?.toLocaleString("en-IN")} {tradePlan.dir} — NOT tradable</Badge>
              <p className="ty-text-xs text-ty-muted-fg">One lot costs ₹{tradePlan.plan.lotCost.toFixed(0)} — over the ₹{PLAN_CONFIG.maxDeployedAmount.toLocaleString("en-IN")} per-trade budget, so 0 lots. Nothing deployed.</p>
              {tradePlan.notes.map((nt, i) => (
                <p key={i} className="ty-text-xs text-ty-warn">{nt}</p>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <Badge variant="outline" className="px-2 py-1 ty-text-xs text-ty-warn">WAIT — no fresh option buy</Badge>
              {floorStrike && ceilStrike && (
                <p className="ty-text-xs text-ty-muted-fg">
                  Writers bracket the spot: ceiling {ceilStrike.toLocaleString("en-IN")} · floor {floorStrike.toLocaleString("en-IN")}. The plan fires when flow commits to a side (|momentum| ≥ 25).
                </p>
              )}
              {tradePlan.notes.map((nt, i) => (
                <p key={i} className="ty-text-xs text-ty-muted-fg">{nt}</p>
              ))}
            </div>
          )}
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        {/* ═══ OI flow by strike — mirrored canvas ═══ */}
        <Panel title="OI flow by strike" subtitle={replayIdx === null ? "live · hollow bar = start-of-day OI" : `snapshot ${istTime(frame.t)} vs previous`}
          className="lg:col-span-8">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 ty-text-xs text-ty-muted-fg">
            {(["LB", "SB", "SC", "LU"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={`size-2 rounded-full ${CLASS_META[k].bar}`} />
                {CLASS_META[k].label}
              </span>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_84px_minmax(0,1fr)] ty-text-xs text-ty-subtle-fg pb-1">
            <span>← PUT OI · writers = floor</span>
            <span />
            <span className="text-right">CALL OI · writers = ceiling →</span>
          </div>

          <div className="relative">
            {rows.map((s) => {
              const peCls = classify(-frame.dir, s.peDelta);
              const ceCls = classify(frame.dir, s.ceDelta);
              const peW = Math.min(100, (s.peOi / maxOi) * 100);
              const ceW = Math.min(100, (s.ceOi / maxOi) * 100);
              const pePrevW = Math.min(100, (s.pePrev / maxOi) * 100);
              const cePrevW = Math.min(100, (s.cePrev / maxOi) * 100);
              const peDots = Math.abs(s.peDelta) > maxOi * 0.08 ? 3 : Math.abs(s.peDelta) > maxOi * 0.04 ? 2 : Math.abs(s.peDelta) > maxOi * 0.015 ? 1 : 0;
              const ceDots = Math.abs(s.ceDelta) > maxOi * 0.08 ? 3 : Math.abs(s.ceDelta) > maxOi * 0.04 ? 2 : Math.abs(s.ceDelta) > maxOi * 0.015 ? 1 : 0;
              const isFast = fastest?.strike === s.strike;
              return (
                <div key={s.strike} className="grid grid-cols-[minmax(0,1fr)_84px_minmax(0,1fr)] items-center" style={{ height: ROW_H }}>
                  {/* PUT */}
                  <div className="relative h-full">
                    <div className={`absolute inset-y-0 my-auto h-[12px] rounded-l-[3px] ${CLASS_META[peCls].bar} ${isFast ? "ty-halo" : ""}`}
                      style={{ right: 0, width: `${peW}%`, ["--ty-halo-c" as string]: "var(--ty-warn)" } as React.CSSProperties} />
                    <div className="absolute inset-y-0 my-auto h-[12px] rounded-l-[3px] border border-dashed border-ty-muted-fg/40"
                      style={{ right: 0, width: `${pePrevW}%` }} />
                    {peDots > 0 && (
                      <div className="absolute" style={{ left: `calc(${100 - peW}% - 2px)`, top: "50%" }}>
                        {Array.from({ length: peDots }).map((_, i) => (
                          <span key={i} className={`ty-dot ${CLASS_META[peCls].dot}`} style={{ animationDelay: `${i * 200}ms`, ["--ty-dir" as string]: s.peDelta > 0 ? -1 : 1 } as React.CSSProperties} />
                        ))}
                      </div>
                    )}
                    {floorStrike === s.strike && (
                      <span className="absolute right-full mr-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-ty-hairline-strong bg-ty-fill px-1.5 py-0.5 ty-text-xs whitespace-nowrap">
                        <span className="size-1.5 rounded-full bg-ty-up" /> Floor
                      </span>
                    )}
                  </div>
                  {/* STRIKE */}
                  <span className="text-center font-mono ty-text-xs text-ty-subtle-fg">{s.strike.toLocaleString("en-IN")}</span>
                  {/* CALL */}
                  <div className="relative h-full">
                    <div className={`absolute inset-y-0 my-auto h-[12px] rounded-r-[3px] ${CLASS_META[ceCls].bar} ${isFast ? "ty-halo" : ""}`}
                      style={{ left: 0, width: `${ceW}%`, ["--ty-halo-c" as string]: "var(--ty-info)" } as React.CSSProperties} />
                    <div className="absolute inset-y-0 my-auto h-[12px] rounded-r-[3px] border border-dashed border-ty-muted-fg/40"
                      style={{ left: 0, width: `${cePrevW}%` }} />
                    {ceDots > 0 && (
                      <div className="absolute" style={{ left: `calc(${ceW}% + 2px)`, top: "50%" }}>
                        {Array.from({ length: ceDots }).map((_, i) => (
                          <span key={i} className={`ty-dot ${CLASS_META[ceCls].dot}`} style={{ animationDelay: `${i * 200}ms`, ["--ty-dir" as string]: s.ceDelta > 0 ? 1 : -1 } as React.CSSProperties} />
                        ))}
                      </div>
                    )}
                    {ceilStrike === s.strike && (
                      <span className="absolute left-full ml-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-ty-hairline-strong bg-ty-fill px-1.5 py-0.5 ty-text-xs whitespace-nowrap">
                        <span className="size-1.5 rounded-full bg-ty-down" /> Ceiling
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {/* spot line overlay */}
            <div className="pointer-events-none absolute left-0 right-0 flex items-center" style={{ top: spotTop }}>
              <span className="z-10 inline-flex items-center rounded-full bg-ty-info px-2 py-0.5 ty-text-xs font-semibold text-white shadow">
                Spot {Math.round(frame.spot).toLocaleString("en-IN")}
              </span>
              <span className="z-10 mx-1 size-2 rounded-full bg-ty-info" />
              <span className="flex-1 border-t border-dashed border-ty-info/70" />
            </div>
          </div>
        </Panel>

        {/* ═══ Right column: momentum + what's next ═══ */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          <Panel title="Momentum & speed" subtitle="near-spot flow · ±5 strikes">
            {momentum ? (
              <div className="space-y-3">
                <MomentumGauge value={momentum.val} />
                <p className="text-center ty-text-xs text-ty-subtle-fg">−100 bearish · +100 bullish</p>
                <div className="grid grid-cols-2 gap-4 border-t border-ty-hairline pt-3">
                  <div>
                    <p className="ty-stat-label">SPEED</p>
                    <p className="ty-stat-value">{speedPerMin != null ? speedPerMin.toLocaleString("en-IN") : fmtLakh(momentum.bull + momentum.bear)}</p>
                    <p className="ty-text-xs text-ty-subtle-fg">{speedPerMin != null ? "contracts/min near spot" : "near-spot flow today"}</p>
                  </div>
                  <div>
                    <p className="ty-stat-label">FUTURES</p>
                    {data.futuresPrice ? (
                      <>
                        <p className="ty-stat-value">{data.futuresPrice.toLocaleString("en-IN", { maximumFractionDigits: 1 })}</p>
                        <p className="ty-text-xs text-ty-subtle-fg">basis {(((data.futuresPrice - data.spot) / data.spot) * 100).toFixed(2)}% vs spot</p>
                      </>
                    ) : (
                      <p className="ty-text-xs text-ty-muted-fg">—</p>
                    )}
                  </div>
                </div>
              </div>
            ) : <p className="ty-text-xs text-ty-muted-fg">—</p>}
          </Panel>

          <Panel title="What's next" subtitle={`${regime} · ${conviction}% conviction`}>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-ty-fill">
              <div className={`h-full rounded-full ${regime === "Bullish" ? "bg-ty-up" : regime === "Bearish" ? "bg-ty-down" : "bg-ty-warn"}`} style={{ width: `${conviction}%` }} />
            </div>
            <ul className="mt-3 space-y-1.5">
              {nextRead.map((l, i) => (
                <li key={i} className="ty-text-xs text-ty-muted-fg flex gap-1.5">
                  <span className="mt-1 size-1 shrink-0 rounded-full bg-ty-brand" />{l}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      {/* ═══ Replay the day ═══ */}
      <Panel title="Replay the day" subtitle={hasReplay ? `${replayFrames.length} snapshots · ~2 min apart` : "no snapshots saved yet for today"}>
        {hasReplay ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => step(-1)}><SkipBack className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={startReplay}>
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => step(1)}><SkipForward className="h-3.5 w-3.5" /></Button>
              <Slider
                className="min-w-[200px] flex-1"
                min={0}
                max={replayFrames.length - 1}
                step={1}
                value={[replayIdx === null ? replayFrames.length - 1 : replayIdx]}
                onValueChange={(v) => { setReplayIdx(Number(v[0])); setPlaying(false); }}
              />
              <span className="font-mono ty-text-xs text-ty-subtle-fg whitespace-nowrap">
                {replayIdx === null ? "LIVE" : `${istTime(replayFrames[replayIdx]?.t ?? null)}`}
              </span>
              {replayIdx !== null && (
                <Button variant="ghost" size="sm" className="h-7 px-2 ty-text-xs" onClick={goLive}>Latest</Button>
              )}
              <div className="flex items-center gap-1">
                {SPEEDS.map((sp) => (
                  <Button key={sp} variant="ghost" size="sm"
                    onClick={() => setSpeed(sp)}
                    className={`h-7 px-1.5 ty-text-xs ${speed === sp ? "ty-fill text-foreground" : "text-ty-muted-fg"}`}>
                    {sp}×
                  </Button>
                ))}
              </div>
            </div>
            <p className="ty-text-xs text-ty-subtle-fg">Space = play/pause · ← → = step · Home = first · End = live</p>
          </div>
        ) : (
          <p className="ty-text-xs text-ty-muted-fg">Snapshots get saved every ~2 minutes while the recorder runs. Press Play once they exist.</p>
        )}
      </Panel>

      {/* ═══ Hot strikes ═══ */}
      <Panel title="Hot strikes · fastest OI" subtitle="today's movers">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-ty-hairline">
                <th className="ty-stat-label pr-2 py-2">STRIKE</th>
                <th className="ty-stat-label px-2 py-2 text-right">CE OI</th>
                <th className="ty-stat-label px-2 py-2 text-right">CE Δ</th>
                <th className="ty-stat-label px-2 py-2 text-right">PE OI</th>
                <th className="ty-stat-label px-2 py-2 text-right">PE Δ</th>
                <th className="ty-stat-label pl-2 py-2">CLASS</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice().sort((a, b) => Math.abs(b.ceDelta) + Math.abs(b.peDelta) - (Math.abs(a.ceDelta) + Math.abs(a.peDelta))).slice(0, 8).map((s) => {
                const peCls = CLASS_META[classify(-frame.dir, s.peDelta)];
                const ceCls = CLASS_META[classify(frame.dir, s.ceDelta)];
                return (
                  <tr key={s.strike} className="hover:bg-ty-fill/50 transition-colors">
                    <td className="pr-2 py-1.5 font-mono ty-text-xs text-foreground">{s.strike.toLocaleString("en-IN")}</td>
                    <td className="px-2 py-1.5 text-right font-mono ty-text-xs">{fmtLakh(s.ceOi)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ty-text-xs ${s.ceDelta >= 0 ? "text-ty-up" : "text-ty-down"}`}>{s.ceDelta >= 0 ? "+" : ""}{fmtLakh(s.ceDelta)}</td>
                    <td className="px-2 py-1.5 text-right font-mono ty-text-xs">{fmtLakh(s.peOi)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ty-text-xs ${s.peDelta >= 0 ? "text-ty-up" : "text-ty-down"}`}>{s.peDelta >= 0 ? "+" : ""}{fmtLakh(s.peDelta)}</td>
                    <td className="pl-2 py-1.5 ty-text-xs font-medium">
                      <span className={ceCls.bar.includes("muted") ? "text-ty-muted-fg" : ""}>{ceCls.label}</span>
                      <span className="text-ty-subtle-fg"> / </span>
                      <span className={peCls.bar.includes("muted") ? "text-ty-muted-fg" : ""}>{peCls.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ═══ Legend ─── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="How each strike is classified" subtitle="spot direction × OI change">
          <ul className="space-y-2">
            {(["LB", "SB", "SC", "LU"] as const).map((k) => (
              <li key={k} className="flex items-start gap-2 ty-text-xs">
                <span className={`mt-1 size-2 shrink-0 rounded-full ${CLASS_META[k].bar}`} />
                <span><b className="font-semibold text-foreground">{CLASS_META[k].label}</b>: {CLASS_META[k].meaning}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Reading it for writers" subtitle="the floor and the ceiling">
          <p className="ty-text-xs text-ty-muted-fg">PUT short buildup means put writers are adding — the floor is getting stronger (bullish). CALL short buildup means call writers are adding — the ceiling is getting stronger (bearish). CALL covering near spot melts the ceiling (bullish); PUT unwinding near spot softens the floor (bearish).</p>
        </Panel>
      </div>
    </div>
  );
}
