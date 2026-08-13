"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { Skeleton } from "@/components/ui/skeleton";

// ─── Types ────────────────────────────────────────────────────────

interface Leg {
  ltp: number; oi: number; oiChg: number; iv: number;
  delta: number; gamma: number; theta: number;
}

interface StrikeRow {
  strike: number; ce: Leg; pe: Leg;
}

interface ApiResp {
  data?: { data?: StrikeRow[]; spotPrice?: number; summary?: any };
  spotPrice?: number;
  analysis?: any;
}

interface ScannerRow {
  strike: number; type: "CE" | "PE"; entry: number;
  delta: number; gamma: number; theta: number;
  target: number; sl: number; rr: number;
  tp1: number; tp1Pts: number; tp2: number; tp2Pts: number; wallPts: number;
  oi_rank: number; buildup: string; basis: string;
  capped: boolean;
  tp1Prob: number; tp2Prob: number; wallProb: number; slProb: number;
  instFiiDir: string; instFiiScore: number;
  instProDir: string; instProScore: number;
  instBias: string;
  instFilter: string;
  instRetailTrap: boolean;
  instPrediction: string;
}

// ─── Helpers ───────────────────────────────────────────────────────

function fmt(n: number, d = 2): string {
  if (n == null || isNaN(n)) return "0";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtInt(n: number): string {
  if (n == null || isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-IN");
}
function fmtOi(v: number): string { return (v / 100000).toFixed(1) + "L"; }
function fmtChg(v: number): string { return (v >= 0 ? "+" : "") + (v / 100000).toFixed(1) + "L"; }
function clsOi(v: number): string { return v >= 0 ? "text-emerald-500" : "text-red-500"; }

function getStep(sym: string): number {
  if (sym === "BANKNIFTY") return 100;
  if (sym === "SENSEX") return 100;
  if (sym === "MIDCPNIFTY") return 25;
  return 50;
}

function classifyBuildup(pct: number, oiPct: number): string {
  if (pct >= 0 && oiPct >= 0) return "Long Buildup";
  if (pct < 0 && oiPct >= 0) return "Short Buildup";
  if (pct >= 0 && oiPct < 0) return "Short Covering";
  return "Long Unwinding";
}

function buildupClass(s: string): string {
  const m: Record<string, string> = {
    "Long Buildup": "bg-emerald-900/60 text-emerald-400",
    "Short Covering": "bg-emerald-900/40 text-emerald-400",
    "Short Buildup": "bg-red-900/60 text-red-400",
    "Long Unwinding": "bg-red-900/40 text-red-400",
  };
  return m[s] || "text-gray-500";
}

type Regime = "breakout" | "breakdown" | "inside";

function buildScanner(
  strikes: StrikeRow[], resistance: number, support: number, spot: number,
  prevChain: Map<number, { ce: number; pe: number }>,
  expectedMoveRange: number,
  vix: number,
  instData?: any
): ScannerRow[] {
  const instScores = instData?.strengthScores || [];
  const instFii = instScores.find((s: any) => s.participant === 'FII');
  const instPro = instScores.find((s: any) => s.participant === 'Pro');
  const maxExtrapolation = 1.5 * expectedMoveRange;
  // VIX-adjusted SL: base 30% of premium, wider in high IV (more noise),
  // tighter in low IV (cleaner moves). VIX/14 = ratio relative to median.
  const vixRatio = Math.max(0.6, Math.min(2, (vix || 14) / 14));
  const slPct = 0.3 * vixRatio;
  const out: ScannerRow[] = [];
  for (const row of strikes) {
    const k = row.strike;
    for (const [right, key] of [["call", "ce"], ["put", "pe"]] as const) {
      const leg = row[key];
      if (!leg || leg.ltp <= 0) continue;

      const wall = right === "call" ? resistance : support;
      const rawMove = wall - k;

      // Cap extrapolation at 1.5x expected move to prevent Δ/Γ blowup
      const capped = maxExtrapolation > 0 && Math.abs(rawMove) > maxExtrapolation;
      const move = capped ? Math.sign(rawMove) * maxExtrapolation : rawMove;

      // Full wall projection
      const projected = leg.delta * move + 0.5 * leg.gamma * move * move;
      const target = Math.max(0.05, +(leg.ltp + projected).toFixed(2));

      // Fixed point-offset targets: TP1 at 20pts, TP2 at 50pts
      const tp1Pts = 20;
      const tp2Pts = 50;
      const move1 = key === "ce" ? tp1Pts : -tp1Pts;
      const move2 = key === "ce" ? tp2Pts : -tp2Pts;
      const proj1 = leg.delta * move1 + 0.5 * leg.gamma * move1 * move1;
      const proj2 = leg.delta * move2 + 0.5 * leg.gamma * move2 * move2;
      const tp1 = Math.max(0.05, +(leg.ltp + proj1).toFixed(2));
      const tp2 = Math.max(0.05, +(leg.ltp + proj2).toFixed(2));

      // VIX-adjusted SL
      const slAmt = Math.max(0.05, +(leg.ltp * slPct).toFixed(2));
      const sl = +(leg.ltp - slAmt).toFixed(2);
      const reward = target - leg.ltp;
      const risk = Math.abs(leg.ltp - sl);
      if (risk <= 0 || reward <= 0) continue;
      const rr = +(reward / risk).toFixed(2);

      // Gambler's ruin probabilities: P(TP hit before SL) = SL_dist / (TP_dist + SL_dist)
      const tp1Dist = Math.abs(tp1 - leg.ltp);
      const tp2Dist = Math.abs(tp2 - leg.ltp);
      const wallDist = Math.abs(target - leg.ltp);
      const slDist = Math.abs(leg.ltp - sl);
      const total1 = tp1Dist + slDist;
      const total2 = tp2Dist + slDist;
      const totalW = wallDist + slDist;
      const tp1Prob = total1 > 0 ? Math.round((slDist / total1) * 100) : 50;
      const tp2Prob = total2 > 0 ? Math.round((slDist / total2) * 100) : 50;
      const wallProb = totalW > 0 ? Math.round((slDist / totalW) * 100) : 50;
      const slProb = 100 - tp1Prob;

      // Real price change from previous snapshot
      const prev = prevChain.get(k);
      const prevLtp = prev ? (key === "ce" ? prev.ce : prev.pe) : leg.ltp;
      const priceChg = prevLtp > 0 ? ((leg.ltp - prevLtp) / prevLtp) * 100 : 0;
      const oiChgPct = leg.oi ? (leg.oiChg / leg.oi) * 100 : 0;

      const dirLabel = `Buy ${key === "ce" ? "CE" : "PE"}`;
      const wallDir = right === "call" ? "↑resistance" : "↓support";
      let basis = `${dirLabel} · TP1 +${tp1Pts}Upt ₹${fmt(tp1)} (${tp1Prob}%) · TP2 +${tp2Pts}Upt ₹${fmt(tp2)} (${tp2Prob}%) · Wall ${fmtInt(Math.abs(Math.round(move)))}Upt ₹${fmt(target)} (${wallProb}%) · SL ₹${fmt(sl)} (${Math.round(slPct * 100)}% risk · ${100 - tp1Prob}% hit)`;
      if (capped) {
        basis += ` — capped at 1.5× expected move (wall is ${fmtInt(Math.abs(rawMove))} pts away, market expects ~${fmtInt(maxExtrapolation)})`;
      }
      // Institutional filter warning
      const filterVerdict = instData?.institutionalFilter?.verdict || 'proceed';
      if (filterVerdict === 'reject') {
        basis += ' · 🛑 INST REJECTED';
      } else if (instData?.retailTrap?.detected) {
        basis += ` · ⚠️ ${instData.retailTrap.type === 'bull_trap' ? 'Bull' : 'Bear'} Trap`;
      }

      const fiiDir = instFii?.direction || 'neutral';
      const fiiSc = instFii?.score || 50;
      const proDir = instPro?.direction || 'neutral';
      const proSc = instPro?.score || 50;
      const smBias = instData?.bias?.dominantDirection || 'neutral';
      const trap = instData?.retailTrap?.detected || false;
      const pred = instData?.prediction?.tomorrowBias || 'neutral';

      out.push({
        strike: k, type: key.toUpperCase() as "CE" | "PE",
        entry: leg.ltp, delta: leg.delta, gamma: leg.gamma, theta: leg.theta,
        target, sl, rr,
        tp1, tp1Pts, tp2, tp2Pts, wallPts: Math.abs(Math.round(move)),
        oi_rank: leg.oi,
        buildup: classifyBuildup(priceChg, oiChgPct),
        basis, capped,
        tp1Prob, tp2Prob, wallProb, slProb,
        instFiiDir: fiiDir, instFiiScore: fiiSc,
        instProDir: proDir, instProScore: proSc,
        instBias: smBias, instFilter: filterVerdict,
        instRetailTrap: trap, instPrediction: pred,
      });
    }
  }
  out.sort((a, b) => b.oi_rank - a.oi_rank);
  return out.slice(0, 12);
}

// ─── Component ─────────────────────────────────────────────────────

const INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

export default function ZeroHeroLiveTerminal() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [loading, setLoading] = useState(true);
  const [chain, setChain] = useState<StrikeRow[]>([]);
  const [spot, setSpot] = useState(0);
  const [vix, setVix] = useState(0);
  const [pcr, setPcr] = useState(0);
  const [maxPain, setMaxPain] = useState(0);
  const [resistance, setResistance] = useState(0);
  const [support, setSupport] = useState(0);
  const [expiry, setExpiry] = useState("");
  const [source, setSource] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");
  const [scanner, setScanner] = useState<ScannerRow[]>([]);
  const [chainCount, setChainCount] = useState(0);
  const [error, setError] = useState("");
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [instData, setInstData] = useState<any>(null);

  // Track previous snapshot so we can compute real price change for classifyBuildup
  const prevChainRef = useRef<Map<number, { ce: number; pe: number }>>(new Map());
  const instDataRef = useRef<any>(null);

  // Fetch institutional data independently
  useEffect(() => {
    const fetchInst = () => {
      fetch(`/api/institutional-positioning`, { cache: "no-store" })
        .then(r => r.json())
        .then(d => { if (d.success) { instDataRef.current = d; setInstData(d); } })
        .catch(() => {});
    };
    fetchInst();
    const id = setInterval(fetchInst, 60000);
    return () => clearInterval(id);
  }, []);

  const fetchData = useCallback(async (sym: string) => {
    try {
      const res = await fetch(`/api/option-chain?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ApiResp = await res.json();
      const raw = json.data || json;
      let strikes: StrikeRow[] = (raw as any).data || [];
      if (!strikes.length && Array.isArray(raw)) strikes = raw as any;

      const summary = (raw as any).summary || {};
      const sp = summary.spotPrice ?? (raw as any).spotPrice ?? 0;
      const atm = summary.atmStrike ?? (strikes.length ? strikes.reduce((b: any, r: any) => Math.abs(r.strike - sp) < Math.abs(b.strike - sp) ? r : b).strike : 0);
      const pcrVal = summary.pcr ?? 1;
      const mp = summary.maxPain ?? (raw as any).maxPain ?? 0;
      const exp = (raw as any).selectedExpiry ?? "";
      const src = (raw as any).dataSource ?? "nse-api";
      const step = getStep(sym);

      // Compute OI walls from FULL chain
      const ceMax = strikes.reduce((b: any, r: any) => ((r.ce?.oi || 0) > (b.ce?.oi || 0) ? r : b), strikes[0]);
      const peMax = strikes.reduce((b: any, r: any) => ((r.pe?.oi || 0) > (b.pe?.oi || 0) ? r : b), strikes[0]);
      const resStr = ceMax?.strike || atm;
      const supStr = peMax?.strike || atm;

      // Max pain from full chain
      let maxPainVal = mp;
      if (!maxPainVal && strikes.length) {
        const oiMap = new Map(strikes.map((s: any) => [s.strike, { ce: s.ce?.oi || 0, pe: s.pe?.oi || 0 }]));
        let minPain = Infinity;
        for (const s of strikes) {
          const k = s.strike;
          let total = 0;
          oiMap.forEach((v, sk) => {
            total += Math.max(0, k - sk) * v.ce;
            total += Math.max(0, sk - k) * v.pe;
          });
          if (total < minPain) { minPain = total; maxPainVal = k; }
        }
      }

      // Display window: ATM ± 5 strikes
      const window = strikes.filter((s: any) => Math.abs(s.strike - atm) <= step * 5);

      // Expected move (straddle) from ATM row
      const atmChainRow = window.find((r: any) => Math.abs(r.strike - atm) < 1);
      const straddleRange = atmChainRow ? +((atmChainRow.ce?.ltp || 0) + (atmChainRow.pe?.ltp || 0)).toFixed(2) : 0;

      // Build prev snapshot for price change comparison
      const prev = prevChainRef.current;
      const sc = buildScanner(window, resStr, supStr, sp, prev, straddleRange, summary.indiaVIX || 0, instDataRef.current);

      // Update prev snapshot
      const nextPrev = new Map<number, { ce: number; pe: number }>();
      for (const s of window) {
        nextPrev.set(s.strike, { ce: s.ce?.ltp || 0, pe: s.pe?.ltp || 0 });
      }
      prevChainRef.current = nextPrev;

      setChain(window);
      setSpot(sp);
      setVix(summary.indiaVIX ?? 0);
      setPcr(pcrVal);
      setMaxPain(maxPainVal);
      setResistance(resStr);
      setSupport(supStr);
      setExpiry(exp);
      setSource(src);
      setFetchedAt(new Date().toISOString());
      setScanner(sc);
      setChainCount(strikes.length);
      setError("");
      setLoading(false);
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(symbol);
    const id = setInterval(() => fetchData(symbol), 15000);
    return () => clearInterval(id);
  }, [symbol, fetchData]);

  const switchSymbol = (sym: string) => {
    setLoading(true);
    setSymbol(sym);
  };

  const stale = fetchedAt ? (Date.now() - new Date(fetchedAt).getTime()) / 1000 > 30 : false;

  // Regime
  const regime: Regime = useMemo(() => {
    if (!spot || !resistance || !support) return "inside";
    if (spot > resistance) return "breakout";
    if (spot < support) return "breakdown";
    return "inside";
  }, [spot, resistance, support]);

  // ATM straddle for expected move — search within step/2 of spot
  const step = useMemo(() => getStep(symbol), [symbol]);
  const atmRow = useMemo(() => {
    const half = Math.max(step / 2, 50);
    return chain.find(r => Math.abs(r.strike - spot) <= half);
  }, [chain, spot, step]);
  const straddle = useMemo(() => {
    if (!atmRow) return 0;
    return +((atmRow.ce?.ltp || 0) + (atmRow.pe?.ltp || 0)).toFixed(2);
  }, [atmRow]);
  const emUpper = useMemo(() => +(spot + straddle).toFixed(2), [spot, straddle]);
  const emLower = useMemo(() => +(spot - straddle).toFixed(2), [spot, straddle]);

  // Level alert
  const levelAlert = useMemo(() => {
    if (!spot || !resistance || !support) return null;
    if (regime === "breakout") return { icon: "📈", color: "bg-emerald-900/30 border-emerald-800/50", text: `Breakout: spot ${fmtInt(spot)} > resistance ${fmtInt(resistance)}`, detail: `Buy CE or Sell PE. Targets at expected move ${fmtInt(emLower)}–${fmtInt(emUpper)}. SL at 30% premium.` };
    if (regime === "breakdown") return { icon: "📉", color: "bg-red-900/30 border-red-800/50", text: `Breakdown: spot ${fmtInt(spot)} < support ${fmtInt(support)}`, detail: `Buy PE or Sell CE. Targets at expected move ${fmtInt(emLower)}–${fmtInt(emUpper)}. SL at 30% premium.` };
    return { icon: "↔️", color: "bg-gray-800/50 border-gray-700", text: "Inside support/resistance & expected move", detail: `Expected move ${fmtInt(emLower)}–${fmtInt(emUpper)}. Wait for breakout above ${fmtInt(resistance)} or breakdown below ${fmtInt(support)}.` };
  }, [spot, resistance, support, regime, emLower, emUpper]);

  if (loading && !chain.length) {
    return (
      <div className="flex-1 p-4 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-3">
          {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3" style={{ backgroundColor: "#0A0E13", color: "#E9EEF3" }}>
      {/* Top Bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-[10px] font-bold text-black">ZH</div>
          <div>
            <h1 className="text-sm font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>Zero Hero Live Terminal</h1>
            <span className="text-[10px]" style={{ color: "#4E5A6B" }}>via SMDApp · {source} · data only</span>
          </div>
        </div>
        <div className="flex gap-1" style={{ background: "#111823", border: "1px solid #232E3D", borderRadius: 8, padding: 2 }}>
          {INDICES.map(s => (
            <button key={s} onClick={() => switchSymbol(s)}
              className="px-2.5 py-1 text-[11px] font-semibold rounded cursor-pointer"
              style={{ background: symbol === s ? "#4FB3E8" : "transparent", color: symbol === s ? "#06141A" : "#8A97A8", border: "none" }}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded" style={{ background: stale ? "#4A2229" : "#1E4A3B", border: `1px solid ${stale ? "#6B2A34" : "#1E4A3B"}`, color: stale ? "#F0566B" : "#33C98D" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" /> {stale ? "STALE" : "LIVE"}
        </div>
      </div>

      {/* Pulse Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-1.5">
        {[
          { label: `${symbol} Spot`, value: fmtInt(spot), color: "" },
          { label: "VIX", value: fmt(vix, 1), color: "#4FB3E8" },
          { label: "PCR (full chain)", value: fmt(pcr, 2), color: pcr > 1.2 ? "#33C98D" : pcr < 0.7 ? "#F0566B" : "", sub: `${chainCount} strikes` },
          { label: "Max Pain", value: fmtInt(maxPain), color: "" },
          { label: "Resistance (max CE)", value: fmtInt(resistance), color: "#F0566B" },
          { label: "Support (max PE)", value: fmtInt(support), color: "#33C98D" },
          { label: "Exp. Move (straddle)", value: `${fmtInt(emLower)}–${fmtInt(emUpper)}`, color: "", sub: straddle > 0 ? `₹${fmt(straddle)}` : "N/A" },
          { label: "Expiry", value: expiry, color: "", style: { fontSize: 12 } },
        ].map((c, i) => (
          <div key={i} className="rounded-lg p-1.5" style={{ background: "#111823", border: "1px solid #232E3D" }}>
            <div className="text-[8px] uppercase tracking-wider" style={{ color: "#4E5A6B" }}>{c.label}</div>
            <div className="font-mono font-semibold text-sm" style={{ color: c.color || "" } as React.CSSProperties}>{c.value}</div>
            {c.sub && <div className="text-[8px]" style={{ color: "#4E5A6B" }}>{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* Level Alert */}
      {levelAlert && (
        <div className={`flex items-start gap-3 rounded-lg p-2.5 border ${levelAlert.color}`}>
          <span className="text-lg">{levelAlert.icon}</span>
          <div>
            <b className="text-xs">{levelAlert.text}</b>
            <p className="text-[11px] mt-0.5" style={{ color: "#8A97A8" }}>{levelAlert.detail}</p>
          </div>
        </div>
      )}

      {/* Institutional Summary */}
      {instData && (() => {
        const fii = (instData.strengthScores || []).find((s: any) => s.participant === 'FII');
        const pro = (instData.strengthScores || []).find((s: any) => s.participant === 'Pro');
        const filter = instData.institutionalFilter?.verdict || 'proceed';
        const trap = instData.retailTrap?.detected;
        const bias = instData.bias?.dominantDirection || 'neutral';
        const align = instData.alignment?.overall;
        const pred = instData.prediction?.tomorrowBias || 'neutral';
        const predConf = instData.prediction?.confidence || 0;
        return (
          <div className="rounded-lg p-2.5 border"
            style={{
              background: filter === 'reject' ? '#4A2229' : filter === 'caution' ? '#4A3D22' : '#1A2433',
              borderColor: filter === 'reject' ? '#6B2A34' : filter === 'caution' ? '#6B5A2A' : '#232E3D',
            }}>
            <div className="flex items-center gap-2 text-[11px] flex-wrap">
              <span className="text-[9px] uppercase tracking-wider" style={{ color: "#7D8BA0" }}>🏛 NSE Participants</span>
              <span className={`font-bold ${fii?.direction === 'bullish' ? 'text-emerald-400' : fii?.direction === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
                FII {fii?.direction || 'neutral'}({fii?.score || 50})
              </span>
              <span className={`font-bold ${pro?.direction === 'bullish' ? 'text-emerald-400' : pro?.direction === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
                Pro {pro?.direction || 'neutral'}({pro?.score || 50})
              </span>
              <span style={{ color: "#5A6B7D" }}>·</span>
              <span className={`font-bold ${bias === 'bullish' ? 'text-emerald-400' : bias === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
                Smart {bias}
              </span>
              <span style={{ color: "#5A6B7D" }}>·</span>
              <span className={`font-bold px-1.5 py-0.5 rounded text-[9px] ${
                filter === 'proceed' ? 'bg-emerald-900/40 text-emerald-400' :
                filter === 'caution' ? 'bg-amber-900/40 text-amber-400' :
                'bg-red-900/40 text-red-400'
              }`}>
                {filter.toUpperCase()}
              </span>
              {align != null && (
                <><span style={{ color: "#5A6B7D" }}>·</span><span>Align {align}%</span></>
              )}
              <span style={{ color: "#5A6B7D" }}>·</span>
              <span>Pred {pred.toUpperCase()} ({predConf}%)</span>
              {trap && (
                <span className="text-red-400 font-bold">⚠️ TRAP</span>
              )}
            </div>
          </div>
        );
      })()}

      {/* Error */}
      {error && (
        <div className="rounded-lg p-3 text-sm font-mono" style={{ background: "#4A2229", border: "1px solid #6B2A34", color: "#F0C9CE" }}>
          ⚠ {error}
        </div>
      )}

      {/* Option Chain */}
      <div className="rounded-lg p-3" style={{ background: "#111823", border: "1px solid #232E3D" }}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>Option Chain — OI, IV & Greeks</h2>
          <span className="text-[9px] font-mono" style={{ color: "#4E5A6B" }}>refreshes every 15s</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono" style={{ minWidth: 700 }}>
            <thead>
              <tr>
                <th className="text-center px-1 py-0.5 text-[8px] uppercase tracking-wider" style={{ color: "#33C98D" }} colSpan={7}>CALLS (CE)</th>
                <th className="px-1 py-0.5 text-center font-bold" style={{ background: "#161F2C" }}>STRIKE</th>
                <th className="text-center px-1 py-0.5 text-[8px] uppercase tracking-wider" style={{ color: "#F0566B" }} colSpan={7}>PUTS (PE)</th>
              </tr>
              <tr>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Θ</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Γ</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Δ</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>IV%</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Chg OI</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>OI</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>LTP</th>
                <th className="px-1 py-0.5" style={{ background: "#161F2C" }}></th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>LTP</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>OI</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Chg OI</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>IV%</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Δ</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Γ</th>
                <th className="px-1 py-0.5 text-right text-[8px]" style={{ color: "#4E5A6B" }}>Θ</th>
              </tr>
            </thead>
            <tbody>
              {chain.map((r, i) => {
                const isAtm = Math.abs(r.strike - spot) / Math.max(spot, 1) < 0.005;
                return (
                  <tr key={i} className={isAtm ? "bg-amber-900/10" : ""} style={{ borderBottom: "1px solid #1B2531" }}>
                    <td style={{ color: "#F0566B", opacity: 0.85 }}>{fmt(r.ce.theta, 1)}</td>
                    <td style={{ color: "#4FB3E8" }}>{fmt(r.ce.gamma, 4)}</td>
                    <td>{fmt(r.ce.delta, 2)}</td>
                    <td>{fmt(r.ce.iv)}</td>
                    <td className={clsOi(r.ce.oiChg)}>{fmtChg(r.ce.oiChg)}</td>
                    <td>{fmtOi(r.ce.oi)}</td>
                    <td>₹{r.ce.ltp.toFixed(2)}</td>
                    <td className="text-center font-bold px-1 py-0.5" style={{ background: "#161F2C" }}>{fmtInt(r.strike)}</td>
                    <td>₹{r.pe.ltp.toFixed(2)}</td>
                    <td>{fmtOi(r.pe.oi)}</td>
                    <td className={clsOi(r.pe.oiChg)}>{fmtChg(r.pe.oiChg)}</td>
                    <td>{fmt(r.pe.iv)}</td>
                    <td>{fmt(r.pe.delta, 2)}</td>
                    <td style={{ color: "#4FB3E8" }}>{fmt(r.pe.gamma, 4)}</td>
                    <td style={{ color: "#F0566B", opacity: 0.85 }}>{fmt(r.pe.theta, 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* OI Buildup Read — shows actual price change from prev snapshot + OI change direction */}
      <div className="rounded-lg p-3" style={{ background: "#111823", border: "1px solid #232E3D" }}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>OI Buildup Read</h2>
          <span className="text-[9px] font-mono" style={{ color: "#4E5A6B" }}>price vs OI direction (vs prev 15s snapshot)</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono" style={{ minWidth: 500 }}>
            <thead>
              <tr>
                <th className="px-2 py-0.5 text-center font-bold" style={{ background: "#161F2C", color: "#E9EEF3" }}>Strike</th>
                <th className="px-2 py-0.5 text-center text-[8px] uppercase" style={{ color: "#33C98D" }}>CE Buildup</th>
                <th className="px-2 py-0.5 text-center text-[8px] uppercase" style={{ color: "#F0566B" }}>PE Buildup</th>
              </tr>
            </thead>
            <tbody>
              {chain.map((r, i) => {
                const prev = prevChainRef.current.get(r.strike);
                const cePct = prev && prev.ce > 0 ? ((r.ce.ltp - prev.ce) / prev.ce) * 100 : 0;
                const pePct = prev && prev.pe > 0 ? ((r.pe.ltp - prev.pe) / prev.pe) * 100 : 0;
                const ceOiPct = r.ce.oi > 0 ? (r.ce.oiChg / r.ce.oi) * 100 : 0;
                const peOiPct = r.pe.oi > 0 ? (r.pe.oiChg / r.pe.oi) * 100 : 0;
                const isAtm = Math.abs(r.strike - spot) / Math.max(spot, 1) < 0.005;
                return (
                  <tr key={i} className={isAtm ? "bg-amber-900/10" : ""} style={{ borderBottom: "1px solid #1B2531" }}>
                    <td className="text-center font-bold px-2 py-0.5" style={{ background: "#161F2C" }}>{fmtInt(r.strike)}</td>
                    <td className="px-2 py-0.5 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] ${buildupClass(classifyBuildup(cePct, ceOiPct))}`}>
                        {classifyBuildup(cePct, ceOiPct)}
                      </span>
                    </td>
                    <td className="px-2 py-0.5 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] ${buildupClass(classifyBuildup(pePct, peOiPct))}`}>
                        {classifyBuildup(pePct, peOiPct)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Scanner — shows only CE on breakout, only PE on breakdown, nothing when inside */}
      <div className="rounded-lg p-3" style={{ background: "#111823", border: "1px solid #232E3D" }}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>Scanner — {symbol}</h2>
          <span className="text-[9px] font-mono" style={{ color: "#4E5A6B" }}>
            Δ/Γ projections for both sides · ranked by OI · VIX-adjusted SL · gambler's ruin probabilities
          </span>
        </div>
        {scanner.length === 0 ? (
          <span className="text-[11px] font-mono" style={{ color: "#4E5A6B" }}>
            No coherent risk/reward shape — try a different index or wait for price movement.
          </span>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono" style={{ minWidth: 920 }}>
              <thead>
                <tr>
                  <th className="px-1 py-0.5 text-left text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Strike / Type</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>OI</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Entry ₹</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Δ</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Γ</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Θ</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>TP₁</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>TP₂</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>SL</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>P(win)</th>
                  <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: "#4E5A6B" }}>R:R</th>
                  <th className="px-1 py-0.5 text-center text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Inst</th>
                  <th className="px-1 py-0.5 text-left text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Buildup</th>
                  <th className="px-1 py-0.5 text-left text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Basis</th>
                  <th className="px-1 py-0.5 text-center text-[8px] uppercase" style={{ color: "#4E5A6B" }}>Order</th>
                </tr>
              </thead>
              <tbody>
                {scanner.map((r, i) => (
                  <Fragment key={i}>
                    <tr style={{ borderBottom: "1px solid #1B2531" }}>
                      <td className="px-1 py-0.5 text-left">
                        <span className="font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>{fmtInt(r.strike)}</span>
                        <span className="ml-1 text-[10px]" style={{ color: r.type === "CE" ? "#33C98D" : "#F0566B" }}>{r.type}</span>
                      </td>
                      <td className="px-1 py-0.5 text-right">{fmtOi(r.oi_rank)}</td>
                      <td className="px-1 py-0.5 text-right">₹{fmt(r.entry)}</td>
                      <td className="px-1 py-0.5 text-right">{fmt(r.delta, 2)}</td>
                      <td className="px-1 py-0.5 text-right" style={{ color: "#4FB3E8" }}>{fmt(r.gamma, 4)}</td>
                      <td className="px-1 py-0.5 text-right" style={{ color: "#F0566B", opacity: 0.85 }}>{fmt(r.theta, 1)}</td>
                      <td className="px-1 py-0.5 text-right" style={{ color: "#33C98D" }}>₹{fmt(r.tp1)}</td>
                      <td className="px-1 py-0.5 text-right" style={{ color: "#33C98D" }}>₹{fmt(r.tp2)}</td>
                      <td className="px-1 py-0.5 text-right" style={{ color: "#F0566B" }}>₹{fmt(r.sl)}</td>
                      <td className="px-1 py-0.5 text-right" style={{ color: "#E3A23D" }}>{r.tp1Prob}%</td>
                      <td className="px-1 py-0.5 text-right">{r.rr}</td>
                      <td className="px-1 py-0.5 text-center">
                        <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                          r.instFilter === 'proceed' ? 'bg-emerald-900/30 text-emerald-400' :
                          r.instFilter === 'caution' ? 'bg-amber-900/30 text-amber-400' :
                          'bg-red-900/30 text-red-400'
                        }`}>
                          {r.instFilter === 'proceed' ? 'P' : r.instFilter === 'caution' ? 'C' : 'R'}
                        </span>
                        <span className="ml-1 text-[9px]" style={{ color: "#5A6B7D" }}>
                          {r.instFiiDir.charAt(0).toUpperCase()}/{r.instProDir.charAt(0).toUpperCase()}
                        </span>
                        {r.instRetailTrap && <span className="ml-0.5 text-red-400" style={{ fontSize: 8 }}>⚠</span>}
                      </td>
                      <td className="px-1 py-0.5 text-left"><span className={`px-1 py-0.5 rounded text-[9px] ${buildupClass(r.buildup)}`}>{r.buildup}</span></td>
                      <td className="px-1 py-0.5 text-left text-[10px]" style={{ color: "#8A97A8", maxWidth: 260, whiteSpace: "normal", lineHeight: 1.3 }}>
                        {r.capped ? <span style={{ color: "#E3A23D", fontWeight: 600 }}>[CAPPED] </span> : ""}{r.basis}
                      </td>
                      <td className="px-1 py-0.5 text-center">
                        <button onClick={() => setPreviewIdx(previewIdx === i ? null : i)}
                          className="px-1.5 py-0.5 rounded text-[9px] font-bold cursor-pointer"
                          style={{ background: previewIdx === i ? "#4FB3E8" : "#1B2531", color: previewIdx === i ? "#06141A" : "#8A97A8", border: "none" }}>
                          {previewIdx === i ? "Hide" : "Preview"}
                        </button>
                      </td>
                    </tr>
                    {previewIdx === i && (
                      <tr>
                        <td colSpan={15} style={{ padding: "8px 12px", background: "#0D1520", borderBottom: "1px solid #1B2531" }}>
                          <pre style={{ margin: 0, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: "#8A97A8", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
{`Order Preview (dry-run — no order placed)
─────────────────────────────────────────
Symbol:     ${symbol}
Strike:     ${r.strike}
Type:       ${r.type}
Action:     Buy (long)
Entry:      ₹${r.entry}
TP1:        ₹${r.tp1} (+${r.tp1Pts}pt · ${Math.round((r.tp1 / r.entry - 1) * 100)}% · ${r.tp1Prob}% hit prob)
TP2:        ₹${r.tp2} (+${r.tp2Pts}pt · ${Math.round((r.tp2 / r.entry - 1) * 100)}% · ${r.tp2Prob}% hit prob)
Wall TP:    ₹${r.target} (+${r.wallPts}pt · ${Math.round((r.target / r.entry - 1) * 100)}% · ${r.wallProb}% hit prob)
SL:         ₹${r.sl} (${Math.round(Math.abs(1 - r.sl / r.entry) * 100)}% risk · ${r.slProb}% hit prob)
R:R (wall): ${r.rr}
Expiry:     ${expiry || "current expiry"}
Inst:       ${r.instFilter.toUpperCase()} · FII ${r.instFiiDir.toUpperCase()}(${r.instFiiScore}) · Pro ${r.instProDir.toUpperCase()}(${r.instProScore})
Smart Bias: ${r.instBias.toUpperCase()} · Pred: ${r.instPrediction.toUpperCase()}${r.instRetailTrap ? ' · ⚠ TRAP' : ''}

NOTE: This is a preview only. No order was sent.
Place orders through your broker's terminal.`}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Order Logic Summary */}
      {regime !== "inside" && (
        <div className="rounded-lg p-3" style={{ background: regime === "breakout" ? "#0A2E1E" : "#2E0A0A", border: `1px solid ${regime === "breakout" ? "#1E4A3B" : "#4A1E1E"}` }}>
          <h3 className="text-xs font-bold mb-1" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>Order Placement Logic</h3>
          <div className="text-[11px] font-mono leading-relaxed" style={{ color: "#8A97A8" }}>
            {regime === "breakout" ? (
              <>
                · <b style={{ color: "#33C98D" }}>Entry:</b> LTP crossed above resistance {fmtInt(resistance)} → <b>Buy CE</b> (or Sell PE)<br />
                · <b style={{ color: "#33C98D" }}>Target:</b> Expected move upper range {fmtInt(emUpper)}<br />
                · <b style={{ color: "#33C98D" }}>SL:</b> 30% of premium paid
              </>
            ) : (
              <>
                · <b style={{ color: "#F0566B" }}>Entry:</b> LTP dropped below support {fmtInt(support)} → <b>Buy PE</b> (or Sell CE)<br />
                · <b style={{ color: "#F0566B" }}>Target:</b> Expected move lower range {fmtInt(emLower)}<br />
                · <b style={{ color: "#F0566B" }}>SL:</b> 30% of premium paid
              </>
            )}
          </div>
        </div>
      )}

      <div className="text-center text-[10px] font-mono pt-2" style={{ color: "#4E5A6B" }}>
        Data from SMDApp (NSE / BSE / ICICI Breeze) · Targets are Δ/Γ Taylor projections to OI walls · SL = 30% of premium · Verify independently.
      </div>
    </div>
  );
}
