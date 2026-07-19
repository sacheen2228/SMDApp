"use client";

import { useState, useEffect, useCallback } from "react";
import { Activity, Zap, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import type { EngineResult, StrikeScore, WeightSet, MarketRegime } from "@/lib/institutional-greeks-engine";

// ─── Helpers ──────────────────────────────────────────────────────

const fmt = (n: number, d = 1) =>
  n == null || isNaN(n) ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtInt = (n: number) =>
  n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-IN");

const scoreColor = (s: number) => {
  if (s >= 85) return "text-[#2dd4a7]";
  if (s >= 70) return "text-[#4f8ff7]";
  if (s >= 50) return "text-[#e8a33d]";
  return "text-[#7d8ba0]";
};

const scoreBg = (s: number) => {
  if (s >= 85) return "bg-[rgba(45,212,167,.12)]";
  if (s >= 70) return "bg-[rgba(79,143,247,.12)]";
  if (s >= 50) return "bg-[rgba(232,163,61,.12)]";
  return "bg-[rgba(125,139,160,.08)]";
};

const regimeColors: Record<MarketRegime, string> = {
  expiry: "bg-[rgba(232,163,61,.15)] text-[#e8a33d] border-[#e8a33d]/30",
  lowVol: "bg-[rgba(79,143,247,.15)] text-[#4f8ff7] border-[#4f8ff7]/30",
  highIV: "bg-[rgba(242,73,92,.15)] text-[#f2495c] border-[#f2495c]/30",
  normal: "bg-[rgba(125,139,160,.12)] text-[#7d8ba0] border-[#7d8ba0]/30",
};

// ─── Score Bar ────────────────────────────────────────────────────

function ScoreBar({ label, score, max = 100 }: { label: string; score: number; max?: number }) {
  const pct = Math.min(100, (score / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] text-[#7d8ba0] w-16 text-right font-mono">{label}</span>
      <div className="flex-1 h-1.5 bg-[#151b25] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: pct >= 85 ? "#2dd4a7" : pct >= 70 ? "#4f8ff7" : pct >= 50 ? "#e8a33d" : "#7d8ba0",
          }}
        />
      </div>
      <span className={`text-[9px] font-mono w-8 ${scoreColor(score)}`}>{fmt(score)}</span>
    </div>
  );
}

// ─── Strike Row ───────────────────────────────────────────────────

function StrikeRow({
  s,
  rank,
  onTrade,
}: {
  s: StrikeScore;
  rank: number;
  onTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div
        className="grid grid-cols-[30px_70px_60px_60px_45px_45px_45px_45px_55px_40px_40px_50px] gap-1 items-center py-2 px-2 border-b border-[#1f2733] font-mono text-[11px] cursor-pointer hover:bg-[#151b25] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="text-[#7d8ba0] font-bold">#{rank}</div>
        <div className="font-bold text-[#dfe6ee]">{fmtInt(s.strike)}</div>
        <div className={`${scoreColor(s.institutionalScore)} font-bold`}>{fmt(s.institutionalScore)}</div>
        <div className="text-[#2dd4a7]">₹{fmt(s.raw.ltp)}</div>
        <div className="text-[#dfe6ee]">{fmt(s.raw.gamma, 4)}</div>
        <div className="text-[#dfe6ee]">{fmt(s.raw.delta, 2)}</div>
        <div className="text-[#f2495c]">{fmt(s.raw.theta)}</div>
        <div className="text-[#dfe6ee]">{fmt(s.raw.vega)}</div>
        <div className="text-[#dfe6ee]">{fmtInt(s.raw.oi)}</div>
        <div className={s.raw.oiChg >= 0 ? "text-[#2dd4a7]" : "text-[#f2495c]"}>{s.raw.oiChg >= 0 ? "+" : ""}{fmtInt(s.raw.oiChg)}</div>
        <div className="text-[#dfe6ee]">{fmtInt(s.raw.volume)}</div>
        <div className="text-[#e8a33d]">{fmt(s.raw.iv)}%</div>
      </div>
      {expanded && (
        <div className="px-3 py-2 bg-[#0a1018] border-b border-[#1f2733] grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <ScoreBar label="Gamma" score={s.gammaScore} />
            <ScoreBar label="Delta" score={s.deltaScore} />
            <ScoreBar label="Theta" score={s.thetaScore} />
            <ScoreBar label="Vega" score={s.vegaScore} />
          </div>
          <div className="space-y-1">
            <ScoreBar label="OI" score={s.oiScore} />
            <ScoreBar label="OI Chg" score={s.oiChangeScore} />
            <ScoreBar label="Volume" score={s.volumeScore} />
            <ScoreBar label="Liquidity" score={s.liquidityScore} />
          </div>
          <div className="space-y-1">
            <ScoreBar label="PCR" score={s.pcrScore} />
            <ScoreBar label="IV" score={s.ivScore} />
            <div className="flex gap-3 mt-2 text-[9px] text-[#7d8ba0]">
              <span>Bid: ₹{fmt(s.raw.bid)}</span>
              <span>Ask: ₹{fmt(s.raw.ask)}</span>
              <span>Spread: ₹{fmt(s.raw.spread)}</span>
            </div>
            <div className="flex gap-3 mt-1 text-[9px] text-[#7d8ba0]">
              <span>PCR: {fmt(s.raw.pcr)}</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onTrade(s.strike, s.type, s.raw.ltp); }}
              className="mt-2 px-3 py-1 rounded bg-[#2dd4a7]/15 text-[#2dd4a7] text-[10px] font-bold hover:bg-[#2dd4a7]/25 transition-colors"
            >
              Trade {s.type}
            </button>
          </div>
        </div>
      )}
    </>
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

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/institutional-greeks?symbol=${encodeURIComponent(symbol)}`,
        { cache: "no-store" }
      );
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

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-[#2dd4a7]" />
          <span className="text-sm font-bold">Institutional Greeks Engine</span>
          {data && (
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${regimeColors[data.regime]}`}>
              {data.regimeLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#7d8ba0]">
          <span>Index:</span>
          {(["NIFTY", "SENSEX"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={`px-2 py-0.5 rounded font-bold ${
                symbol === s
                  ? "bg-[#2dd4a7]/20 text-[#2dd4a7] border border-[#2dd4a7]/40"
                  : "bg-[#10151d] border border-[#1f2733] text-[#7d8ba0]"
              }`}
            >
              {s}
            </button>
          ))}
          {loading && <Activity className="h-3 w-3 animate-spin" />}
          {updatedAt > 0 && (
            <span>{new Date(updatedAt).toLocaleTimeString("en-IN")}</span>
          )}
          <button
            onClick={fetchData}
            className="px-2 py-0.5 rounded bg-[#1f2733] hover:bg-[#2a3441] font-bold"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Dynamic Weights */}
      {data && (
        <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] p-3">
          <div className="text-[10px] text-[#7d8ba0] mb-2 font-bold uppercase">Dynamic Weights — {data.regimeLabel}</div>
          <div className="grid grid-cols-8 gap-3">
            {Object.entries(data.weights).map(([key, val]) => (
              <div key={key} className="text-center">
                <div className="text-[9px] text-[#7d8ba0] capitalize">{key}</div>
                <div className="text-[11px] font-mono font-bold text-[#dfe6ee]">{Math.round(val * 100)}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats Bar */}
      {data && (
        <div className="flex gap-3 text-[10px] text-[#7d8ba0]">
          <span>Spot <b className="text-[#dfe6ee]">{fmtInt(data.spot)}</b></span>
          <span>ATM <b className="text-[#e8a33d]">{fmtInt(data.atmStrike)}</b></span>
          <span>Strikes <b className="text-[#dfe6ee]">{data.totalStrikes}</b></span>
          <span>Qualified <b className="text-[#2dd4a7]">{data.qualifiedStrikes}</b></span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-[#10151d] border border-[#f2495c]/30 rounded-[10px] p-4 text-center text-[#f2495c] text-sm">
          {error}
        </div>
      )}

      {/* Content */}
      {!error && data && (
        <div className="flex-1 overflow-y-auto space-y-3">
          {/* Top 5 Calls */}
          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
            <div className="px-3 py-2 border-b border-[#1f2733] flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-[#2dd4a7]" />
              <span className="font-bold text-[13px] text-[#2dd4a7]">Top 5 Calls</span>
              <span className="text-[10px] text-[#7d8ba0]">— Institutional Score &gt; 85</span>
            </div>
            {/* Header */}
            <div className="grid grid-cols-[30px_70px_60px_60px_45px_45px_45px_45px_55px_40px_40px_50px] gap-1 items-center py-1.5 px-2 border-b border-[#1f2733] text-[9px] text-[#7d8ba0] uppercase font-bold">
              <div>#</div>
              <div>Strike</div>
              <div>Score</div>
              <div>Premium</div>
              <div>Γ</div>
              <div>Δ</div>
              <div>Θ</div>
              <div>V</div>
              <div>OI</div>
              <div>Chg</div>
              <div>Vol</div>
              <div>IV</div>
            </div>
            {data.topCalls.length === 0 ? (
              <div className="p-4 text-center text-[#7d8ba0] text-xs">No qualified calls (score &gt; 85)</div>
            ) : (
              data.topCalls.map((s, i) => (
                <StrikeRow key={`c-${s.strike}`} s={s} rank={i + 1} onTrade={onTrade} />
              ))
            )}
          </div>

          {/* Top 5 Puts */}
          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
            <div className="px-3 py-2 border-b border-[#1f2733] flex items-center gap-2">
              <TrendingDown className="h-3.5 w-3.5 text-[#f2495c]" />
              <span className="font-bold text-[13px] text-[#f2495c]">Top 5 Puts</span>
              <span className="text-[10px] text-[#7d8ba0]">— Institutional Score &gt; 85</span>
            </div>
            <div className="grid grid-cols-[30px_70px_60px_60px_45px_45px_45px_45px_55px_40px_40px_50px] gap-1 items-center py-1.5 px-2 border-b border-[#1f2733] text-[9px] text-[#7d8ba0] uppercase font-bold">
              <div>#</div>
              <div>Strike</div>
              <div>Score</div>
              <div>Premium</div>
              <div>Γ</div>
              <div>Δ</div>
              <div>Θ</div>
              <div>V</div>
              <div>OI</div>
              <div>Chg</div>
              <div>Vol</div>
              <div>IV</div>
            </div>
            {data.topPuts.length === 0 ? (
              <div className="p-4 text-center text-[#7d8ba0] text-xs">No qualified puts (score &gt; 85)</div>
            ) : (
              data.topPuts.map((s, i) => (
                <StrikeRow key={`p-${s.strike}`} s={s} rank={i + 1} onTrade={onTrade} />
              ))
            )}
          </div>

          {/* All Ranked Strikes (collapsible) */}
          <RankedStrikesAll strikes={data.strikes} onTrade={onTrade} />
        </div>
      )}
    </div>
  );
}

// ─── All Ranked Strikes (collapsed by default) ────────────────────

function RankedStrikesAll({
  strikes,
  onTrade,
}: {
  strikes: StrikeScore[];
  onTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
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
        <span className="text-[10px] text-[#7d8ba0]">{open ? "▾ Collapse" : "▸ Expand"}</span>
      </div>
      {open && (
        <>
          <div className="grid grid-cols-[30px_70px_60px_60px_45px_45px_45px_45px_55px_40px_40px_50px] gap-1 items-center py-1.5 px-2 border-b border-[#1f2733] text-[9px] text-[#7d8ba0] uppercase font-bold">
            <div>#</div>
            <div>Strike</div>
            <div>Score</div>
            <div>Premium</div>
            <div>Γ</div>
            <div>Δ</div>
            <div>Θ</div>
            <div>V</div>
            <div>OI</div>
            <div>Chg</div>
            <div>Vol</div>
            <div>IV</div>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {strikes.map((s, i) => (
              <StrikeRow key={`a-${s.type}-${s.strike}`} s={s} rank={i + 1} onTrade={onTrade} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
