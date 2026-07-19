"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Activity, Zap, TrendingUp, TrendingDown, ChevronDown, ChevronRight, Target, ShieldAlert, BarChart3 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell, ComposedChart, Line, Area } from "recharts";
import type { EngineResult, StrikeScore, WeightSet, MarketRegime } from "@/lib/institutional-greeks-engine";

const fmt = (n: number, d = 1) =>
  n == null || isNaN(n) ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtInt = (n: number) =>
  n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-IN");

const scoreColor = (s: number) => {
  if (s >= 85) return "#2dd4a7";
  if (s >= 70) return "#4f8ff7";
  if (s >= 50) return "#e8a33d";
  return "#7d8ba0";
};

const regimeBadge: Record<MarketRegime, string> = {
  expiry: "bg-[rgba(232,163,61,.15)] text-[#e8a33d] border-[#e8a33d]/30",
  lowVol: "bg-[rgba(79,143,247,.15)] text-[#4f8ff7] border-[#4f8ff7]/30",
  highIV: "bg-[rgba(242,73,92,.15)] text-[#f2495c] border-[#f2495c]/30",
  normal: "bg-[rgba(125,139,160,.12)] text-[#7d8ba0] border-[#7d8ba0]/30",
};

function getMoneyness(strike: number, spot: number, type: "CE" | "PE"): string {
  if (strike === spot) return "ATM";
  if (type === "CE") {
    return strike > spot ? "OTM" : "ITM";
  } else {
    return strike < spot ? "OTM" : "ITM";
  }
}

function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.min(100, score);
  const color = scoreColor(score);
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] text-[#7d8ba0] w-11 text-right font-mono shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-[#1f2733] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[9px] font-mono w-7 shrink-0 font-bold" style={{ color }}>{fmt(score)}</span>
    </div>
  );
}

function TPSLBar({ entry, tp, sl }: { entry: number; tp: number; sl: number }) {
  if (!entry || !tp || !sl) return null;
  const range = Math.max(tp - sl, 1);
  const entryPct = ((entry - sl) / range) * 100;
  return (
    <div className="relative h-5 w-full">
      <div className="absolute inset-0 rounded-full bg-[#1f2733] overflow-hidden">
        <div className="absolute left-0 top-0 h-full bg-[rgba(242,73,92,.15)]" style={{ width: `${entryPct}%` }} />
        <div className="absolute right-0 top-0 h-full bg-[rgba(45,212,167,.15)]" style={{ width: `${100 - entryPct}%` }} />
      </div>
      <div className="absolute top-0 h-full w-0.5 bg-[#dfe6ee]" style={{ left: `${entryPct}%` }} />
      <div className="absolute top-0 h-full w-0.5 bg-[#2dd4a7]" style={{ right: 0 }} />
      <div className="absolute top-0 h-full w-0.5 bg-[#f2495c]" style={{ left: 0 }} />
      <div className="absolute -bottom-3.5 text-[8px] font-mono text-[#f2495c]" style={{ left: 0 }}>₹{fmt(sl)}</div>
      <div className="absolute -bottom-3.5 text-[8px] font-mono text-[#dfe6ee]" style={{ left: `${entryPct}%`, transform: "translateX(-50%)" }}>₹{fmt(entry)}</div>
      <div className="absolute -bottom-3.5 text-[8px] font-mono text-[#2dd4a7]" style={{ right: 0 }}>₹{fmt(tp)}</div>
    </div>
  );
}

// ─── Score Distribution Chart ─────────────────────────────────────

function ScoreChart({ strikes, spot }: { strikes: StrikeScore[]; spot: number }) {
  const chartData = useMemo(() => {
    return strikes
      .filter((s) => s.type === "CE")
      .sort((a, b) => a.strike - b.strike)
      .map((s) => ({
        strike: s.strike,
        score: s.institutionalScore,
        tp: s.tp,
        sl: s.sl,
        entry: s.raw.ltp,
        isATM: s.strike === Math.round(spot / 50) * 50,
        label: `${s.strike}`,
      }));
  }, [strikes, spot]);

  const atmStrike = Math.round(spot / 50) * 50;

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] p-3">
      <div className="flex items-center gap-2 mb-2">
        <BarChart3 className="h-3 w-3 text-[#4f8ff7]" />
        <span className="text-[10px] font-bold text-[#7d8ba0] uppercase">CE Score Distribution</span>
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: -20 }}>
            <XAxis dataKey="strike" tick={{ fontSize: 8, fill: "#7d8ba0" }} interval={Math.max(0, Math.floor(chartData.length / 8))} />
            <YAxis tick={{ fontSize: 8, fill: "#7d8ba0" }} domain={[0, 100]} />
            <Tooltip
              contentStyle={{ background: "#151b25", border: "1px solid #1f2733", borderRadius: 8, fontSize: 10 }}
              formatter={(val: number, name: string) => [`${fmt(val)}`, name === "score" ? "Score" : name]}
              labelFormatter={(l) => `Strike ${l}`}
            />
            <ReferenceLine x={atmStrike} stroke="#e8a33d" strokeDasharray="3 3" strokeWidth={1} />
            <Bar dataKey="score" radius={[3, 3, 0, 0]} maxBarSize={20}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.isATM ? "#e8a33d" : scoreColor(entry.score)} fillOpacity={0.8} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── TP/SL Range Chart ────────────────────────────────────────────

function TPSLChart({ strikes, spot }: { strikes: StrikeScore[]; spot: number }) {
  const chartData = useMemo(() => {
    return strikes
      .filter((s) => s.type === "CE")
      .sort((a, b) => a.strike - b.strike)
      .map((s) => ({
        strike: s.strike,
        tp: s.tp,
        entry: s.raw.ltp,
        sl: s.sl,
        rr: s.rr,
        label: `${s.strike}`,
      }));
  }, [strikes]);

  const atmStrike = Math.round(spot / 50) * 50;

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Target className="h-3 w-3 text-[#2dd4a7]" />
        <span className="text-[10px] font-bold text-[#7d8ba0] uppercase">CE TP / Entry / SL Range</span>
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: -20 }}>
            <XAxis dataKey="strike" tick={{ fontSize: 8, fill: "#7d8ba0" }} interval={Math.max(0, Math.floor(chartData.length / 8))} />
            <YAxis tick={{ fontSize: 8, fill: "#7d8ba0" }} />
            <Tooltip
              contentStyle={{ background: "#151b25", border: "1px solid #1f2733", borderRadius: 8, fontSize: 10 }}
              formatter={(val: number, name: string) => [`₹${fmt(val)}`, name === "tp" ? "TP" : name === "entry" ? "Entry" : name === "sl" ? "SL" : name]}
              labelFormatter={(l) => `Strike ${l}`}
            />
            <ReferenceLine x={atmStrike} stroke="#e8a33d" strokeDasharray="3 3" strokeWidth={1} />
            <Area dataKey="tp" stroke="#2dd4a7" fill="#2dd4a7" fillOpacity={0.08} strokeWidth={1.5} dot={false} />
            <Line dataKey="entry" stroke="#dfe6ee" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
            <Area dataKey="sl" stroke="#f2495c" fill="#f2495c" fillOpacity={0.08} strokeWidth={1.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Strike Row ───────────────────────────────────────────────────

function StrikeRow({
  s, rank, onTrade, spot,
}: {
  s: StrikeScore; rank: number;
  onTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
  spot: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const rrColor = s.rr >= 2 ? "#2dd4a7" : s.rr >= 1.5 ? "#4f8ff7" : "#e8a33d";
  const isCE = s.type === "CE";
  const money = getMoneyness(s.strike, spot, s.type);
  const moneyColor = money === "ATM" ? "text-[#e8a33d]" : money === "ITM" ? "text-[#4f8ff7]" : "text-[#7d8ba0]";

  return (
    <div className="border-b border-[#1f2733] last:border-b-0">
      <div
        className="grid grid-cols-[28px_1fr_44px_60px_56px_56px_50px_48px_48px] gap-1 items-center py-2 px-2 cursor-pointer hover:bg-[#151b25]/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="text-[10px] text-[#7d8ba0] font-bold">#{rank}</div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono font-bold text-[#dfe6ee] text-[12px]">{fmtInt(s.strike)}</span>
            <span className={`text-[8px] font-bold px-1 py-px rounded ${isCE ? "bg-[rgba(45,212,167,.12)] text-[#2dd4a7]" : "bg-[rgba(242,73,92,.12)] text-[#f2495c]"}`}>{s.type}</span>
            <span className={`text-[8px] font-mono font-bold ${moneyColor}`}>{money}</span>
          </div>
        </div>
        <div className="text-center">
          <span className="font-mono font-bold text-[14px] leading-none" style={{ color: scoreColor(s.institutionalScore) }}>
            {fmt(s.institutionalScore)}
          </span>
        </div>
        <div className="text-right font-mono font-bold text-[14px] text-[#2dd4a7] leading-none">₹{fmt(s.raw.ltp)}</div>
        <div className="text-[10px] font-mono text-[#a0aec0] leading-tight">
          <span className="text-[#dfe6ee]">Γ</span>{s.raw.gamma.toFixed(4)}{' '}
          <span className="text-[#dfe6ee]">Δ</span>{s.raw.delta.toFixed(2)}{' '}
          <span className="text-[#f2495c]">Θ</span>{fmt(s.raw.theta)}{' '}
          <span className="text-[#e8a33d]">{fmt(s.raw.iv)}%</span>
        </div>
        <div className="text-right font-mono font-bold text-[11px] text-[#2dd4a7]">₹{fmt(s.tp)}</div>
        <div className="text-right font-mono font-bold text-[11px] text-[#f2495c]">₹{fmt(s.sl)}</div>
        <div className="text-right">
          <span className="text-[12px] font-mono font-bold" style={{ color: rrColor }}>{fmt(s.rr)}x</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-2.5 bg-[#0a1018]">
          <div className="flex items-center gap-4 text-[10px] text-[#7d8ba0] mb-1">
            <span className="flex items-center gap-1"><Target className="h-2.5 w-2.5 text-[#2dd4a7]" /> TP ₹{fmt(s.tp)} <span className="text-[#2dd4a7] font-bold">(+{fmt(((s.tp - s.raw.ltp) / s.raw.ltp) * 100)}%)</span></span>
            <span className="flex items-center gap-1"><ShieldAlert className="h-2.5 w-2.5 text-[#f2495c]" /> SL ₹{fmt(s.sl)} <span className="text-[#f2495c] font-bold">({fmt(((s.sl - s.raw.ltp) / s.raw.ltp) * 100)}%)</span></span>
            <span className="font-bold" style={{ color: rrColor }}>R:R {fmt(s.rr)}x</span>
          </div>
          <TPSLBar entry={s.raw.ltp} tp={s.tp} sl={s.sl} />
          <div className="h-3" />
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Greeks</div>
              <ScoreBar label="Gamma" score={s.gammaScore} />
              <ScoreBar label="Delta" score={s.deltaScore} />
              <ScoreBar label="Theta" score={s.thetaScore} />
              <ScoreBar label="Vega" score={s.vegaScore} />
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Flow</div>
              <ScoreBar label="OI" score={s.oiScore} />
              <ScoreBar label="OI Chg" score={s.oiChangeScore} />
              <ScoreBar label="Volume" score={s.volumeScore} />
              <ScoreBar label="PCR" score={s.pcrScore} />
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Market</div>
              <ScoreBar label="IV" score={s.ivScore} />
              <ScoreBar label="Liquidity" score={s.liquidityScore} />
              <div className="flex gap-2 text-[9px] text-[#7d8ba0] font-mono mt-1">
                <span>Bid ₹{fmt(s.raw.bid)}</span>
                <span>Ask ₹{fmt(s.raw.ask)}</span>
              </div>
              <div className="flex gap-2 text-[9px] text-[#7d8ba0] font-mono">
                <span>OI {fmtInt(s.raw.oi)}</span>
                <span>Vol {fmtInt(s.raw.volume)}</span>
              </div>
            </div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onTrade(s.strike, s.type, s.raw.ltp); }}
            className="mt-2 w-full py-1.5 rounded-lg bg-[#2dd4a7]/10 text-[#2dd4a7] text-[11px] font-bold hover:bg-[#2dd4a7]/20 transition-colors border border-[#2dd4a7]/20"
          >
            Trade {s.type} @ ₹{fmt(s.raw.ltp)}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Weights Display ──────────────────────────────────────────────

function WeightsDisplay({ weights, regime }: { weights: WeightSet; regime: MarketRegime }) {
  const labels: Record<string, string> = {
    gamma: "Γ", delta: "Δ", theta: "Θ", vega: "V",
    oi: "OI", oiChange: "ΔOI", volume: "Vol", liquidity: "Liq",
  };
  const sorted = Object.entries(weights).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex gap-1 items-end h-5">
      {sorted.map(([key, val]) => {
        const pct = Math.round(val * 100);
        const isTop = sorted[0][0] === key;
        return (
          <div key={key} className="flex flex-col items-center gap-0.5 flex-1">
            <div className="w-full rounded-t" style={{ height: `${Math.max(3, pct * 0.7)}px`, background: isTop ? scoreColor(pct) : "#1f2733" }} />
            <span className="text-[7px] text-[#7d8ba0] font-mono">{labels[key]}</span>
            <span className="text-[8px] font-mono font-bold" style={{ color: isTop ? scoreColor(pct) : "#7d8ba0" }}>{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────

export function InstitutionalGreeksPanel({
  onTrade,
}: {
  onTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
}) {
  const [symbol, setSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY");
  const [data, setData] = useState<EngineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [showCharts, setShowCharts] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/institutional-greeks?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Engine failed");
      setData(json.data);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const id = setInterval(fetchData, 15000);
    return () => clearInterval(id);
  }, [fetchData]);

  const tableHeader = (
    <div className="grid grid-cols-[28px_1fr_44px_60px_56px_56px_50px_48px_48px] gap-1 items-center py-1 px-2 border-b border-[#1f2733] text-[9px] text-[#7d8ba0] uppercase font-bold">
      <div>#</div>
      <div>Strike</div>
      <div className="text-center">Score</div>
      <div className="text-right">Premium</div>
      <div>Greeks</div>
      <div className="text-right">TP</div>
      <div className="text-right">SL</div>
      <div className="text-right">R:R</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-[#2dd4a7]" />
          <span className="text-sm font-bold">Institutional Greeks</span>
          {data && (
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${regimeBadge[data.regime]}`}>
              {data.regimeLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#7d8ba0]">
          {(["NIFTY", "SENSEX"] as const).map((s) => (
            <button
              key={s} onClick={() => setSymbol(s)}
              className={`px-2 py-0.5 rounded font-bold transition-colors ${
                symbol === s
                  ? "bg-[#2dd4a7]/20 text-[#2dd4a7] border border-[#2dd4a7]/40"
                  : "bg-[#10151d] border border-[#1f2733] text-[#7d8ba0] hover:bg-[#1f2733]"
              }`}
            >{s}</button>
          ))}
          <button
            onClick={() => setShowCharts(!showCharts)}
            className={`px-2 py-0.5 rounded font-bold transition-colors border ${
              showCharts
                ? "bg-[#4f8ff7]/20 text-[#4f8ff7] border-[#4f8ff7]/40"
                : "bg-[#10151d] border-[#1f2733] text-[#7d8ba0]"
            }`}
          >Charts</button>
          {loading && <Activity className="h-3 w-3 animate-spin" />}
          {updatedAt > 0 && <span>{new Date(updatedAt).toLocaleTimeString("en-IN")}</span>}
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-[1fr_260px] gap-2">
          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] px-3 py-2 flex items-center gap-4 text-[10px]">
            <div>
              <div className="text-[8px] text-[#7d8ba0] uppercase">Spot</div>
              <div className="text-[13px] font-mono font-bold text-[#dfe6ee]">{fmtInt(data.spot)}</div>
            </div>
            <div>
              <div className="text-[8px] text-[#7d8ba0] uppercase">ATM</div>
              <div className="text-[13px] font-mono font-bold text-[#e8a33d]">{fmtInt(data.atmStrike)}</div>
            </div>
            <div>
              <div className="text-[8px] text-[#7d8ba0] uppercase">Qualified</div>
              <div className="text-[13px] font-mono font-bold text-[#2dd4a7]">{data.qualifiedStrikes}<span className="text-[9px] text-[#7d8ba0]">/{data.totalStrikes}</span></div>
            </div>
            <div>
              <div className="text-[8px] text-[#7d8ba0] uppercase">Regime</div>
              <div className={`text-[11px] font-bold ${regimeBadge[data.regime].split(' ')[1]}`}>{data.regimeLabel}</div>
            </div>
          </div>
          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] px-3 py-2">
            <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-1">Dynamic Weights</div>
            <WeightsDisplay weights={data.weights} regime={data.regime} />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-[#10151d] border border-[#f2495c]/30 rounded-[10px] p-4 text-center text-[#f2495c] text-sm">{error}</div>
      )}

      {!error && data && (
        <div className="flex-1 overflow-y-auto space-y-2">
          {showCharts && data.strikes.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <ScoreChart strikes={data.strikes} spot={data.spot} />
              <TPSLChart strikes={data.strikes} spot={data.spot} />
            </div>
          )}

          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
            <div className="px-3 py-2 border-b border-[#1f2733] flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-[#2dd4a7]" />
              <span className="font-bold text-[13px] text-[#2dd4a7]">Top 5 Calls</span>
            </div>
            {tableHeader}
            {data.topCalls.length === 0 ? (
              <div className="p-4 text-center text-[#7d8ba0] text-xs">No qualified calls</div>
            ) : (
              data.topCalls.map((s, i) => (
                <StrikeRow key={`c-${s.strike}`} s={s} rank={i + 1} onTrade={onTrade} spot={data.spot} />
              ))
            )}
          </div>

          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
            <div className="px-3 py-2 border-b border-[#1f2733] flex items-center gap-2">
              <TrendingDown className="h-3.5 w-3.5 text-[#f2495c]" />
              <span className="font-bold text-[13px] text-[#f2495c]">Top 5 Puts</span>
            </div>
            {tableHeader}
            {data.topPuts.length === 0 ? (
              <div className="p-4 text-center text-[#7d8ba0] text-xs">No qualified puts</div>
            ) : (
              data.topPuts.map((s, i) => (
                <StrikeRow key={`p-${s.strike}`} s={s} rank={i + 1} onTrade={onTrade} spot={data.spot} />
              ))
            )}
          </div>

          <RankedStrikesAll strikes={data.strikes} onTrade={onTrade} spot={data.spot} />
        </div>
      )}
    </div>
  );
}

function RankedStrikesAll({
  strikes, onTrade, spot,
}: {
  strikes: StrikeScore[];
  onTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
  spot: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div
        className="px-3 py-2 border-b border-[#1f2733] flex items-center justify-between cursor-pointer hover:bg-[#151b25] transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className="font-bold text-[13px]">
          All Ranked Strikes <span className="text-[#7d8ba0] font-mono text-[11px]">({strikes.length})</span>
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-[#7d8ba0]" /> : <ChevronRight className="h-3.5 w-3.5 text-[#7d8ba0]" />}
      </div>
      {open && (
        <>
          {tableHeader}
          <div className="max-h-[400px] overflow-y-auto">
            {strikes.map((s, i) => (
              <StrikeRow key={`a-${s.type}-${s.strike}`} s={s} rank={i + 1} onTrade={onTrade} spot={spot} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
