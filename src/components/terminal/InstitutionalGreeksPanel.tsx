"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Activity,
  Zap,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronRight,
  Target,
  ShieldAlert,
  BarChart3,
  Flame,
  Gauge,
  Timer,
  AlertTriangle,
  Rocket,
  RefreshCw,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
  ComposedChart,
  Line,
  Area,
} from "recharts";
import type { AccelerationResult, AccelerationStrike } from "@/lib/option-acceleration-engine";

const fmt = (n: number, d = 1) =>
  n == null || isNaN(n) ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtInt = (n: number) =>
  n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-IN");

const fmtOINum = (n: number): string => {
  if (n === 0) return "0";
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(1) + "L";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toFixed(0);
};

const fmtVol = (n: number): string => {
  if (n === 0) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toFixed(0);
};

const scoreColor = (s: number) => {
  if (s >= 85) return "#2dd4a7";
  if (s >= 70) return "#4f8ff7";
  if (s >= 50) return "#e8a33d";
  return "#7d8ba0";
};

const speedColor: Record<string, string> = {
  INSTANT: "#ef4444",
  FAST: "#f97316",
  MODERATE: "#eab308",
  SLOW: "#6b7280",
  STAGNANT: "#374151",
};

const signalBadge: Record<string, string> = {
  "STRONG BUY": "bg-[rgba(45,212,167,.15)] text-[#2dd4a7] border-[#2dd4a7]/30",
  BUY: "bg-[rgba(79,143,247,.15)] text-[#4f8ff7] border-[#4f8ff7]/30",
  WATCH: "bg-[rgba(232,163,61,.15)] text-[#e8a33d] border-[#e8a33d]/30",
  WAIT: "bg-[rgba(242,73,92,.15)] text-[#f2495c] border-[#f2495c]/30",
  IGNORE: "bg-[rgba(125,139,160,.12)] text-[#7d8ba0] border-[#7d8ba0]/30",
};

function getMoneyness(strike: number, spot: number, type: "CE" | "PE"): string {
  if (Math.abs(strike - spot) <= 50) return "ATM";
  if (type === "CE") return strike > spot ? "OTM" : "ITM";
  return strike < spot ? "OTM" : "ITM";
}

// ─── Score Bar ────────────────────────────────────────────────────
function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.min(100, score);
  const color = scoreColor(score);
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] text-[#7d8ba0] w-14 text-right font-mono shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-[#1f2733] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[9px] font-mono w-7 shrink-0 font-bold" style={{ color }}>{fmt(score)}</span>
    </div>
  );
}

// ─── TP/SL Range Bar ──────────────────────────────────────────────
function TPSLBar({ entry, tp, sl }: { entry: number; tp: number; sl: number }) {
  if (!entry || !tp || !sl || tp <= sl) return null;
  const range = Math.max(tp - sl, 1);
  const entryPct = Math.max(0, Math.min(100, ((entry - sl) / range) * 100));
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

// ─── Dashboard Card ───────────────────────────────────────────────
function DashCard({
  label, strike, value, sub, icon, color, highlight,
}: {
  label: string; strike: string; value: string; sub: string; icon: React.ReactNode; color: string; highlight?: boolean;
}) {
  return (
    <div className={`border rounded-lg p-2.5 ${color} ${highlight ? "ring-1 ring-[#e8a33d]/60" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[9px] font-medium text-[#7d8ba0] uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-[13px] font-bold text-[#dfe6ee] leading-tight">{strike}</div>
      <div className="text-[10px] text-[#a0aec0] font-medium">{value}</div>
      <div className="text-[9px] text-[#7d8ba0] mt-0.5">{sub}</div>
    </div>
  );
}

// ─── Acceleration Score Chart ─────────────────────────────────────
function AccelChart({ strikes, spot }: { strikes: AccelerationStrike[]; spot: number }) {
  const chartData = useMemo(() => {
    return strikes
      .filter((s) => s.type === "CE" && s.ltp > 0)
      .sort((a, b) => a.strike - b.strike)
      .map((s) => ({
        strike: s.strike,
        acceleration: s.acceleration,
        velocity: s.expectedSpeed,
        isATM: Math.abs(s.strike - spot) <= 50,
      }));
  }, [strikes, spot]);

  const atmStrike = Math.round(spot / 50) * 50;

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] p-3">
      <div className="flex items-center gap-2 mb-2">
        <BarChart3 className="h-3 w-3 text-[#4f8ff7]" />
        <span className="text-[10px] font-bold text-[#7d8ba0] uppercase">CE Acceleration Distribution</span>
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: -20 }}>
            <XAxis dataKey="strike" tick={{ fontSize: 8, fill: "#7d8ba0" }} interval={Math.max(0, Math.floor(chartData.length / 8))} />
            <YAxis tick={{ fontSize: 8, fill: "#7d8ba0" }} domain={[0, 100]} />
            <Tooltip
              contentStyle={{ background: "#151b25", border: "1px solid #1f2733", borderRadius: 8, fontSize: 10 }}
              formatter={(val: number, name: string) => [`${fmt(val)}`, name === "acceleration" ? "Acceleration" : "Velocity"]}
              labelFormatter={(l) => `Strike ${l}`}
            />
            <ReferenceLine x={atmStrike} stroke="#e8a33d" strokeDasharray="3 3" strokeWidth={1} />
            <Bar dataKey="acceleration" radius={[3, 3, 0, 0]} maxBarSize={20}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.isATM ? "#e8a33d" : scoreColor(entry.acceleration)} fillOpacity={0.8} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── TP/SL Range Chart ────────────────────────────────────────────
function TPSLChart({ strikes, spot }: { strikes: AccelerationStrike[]; spot: number }) {
  const chartData = useMemo(() => {
    return strikes
      .filter((s) => s.type === "CE" && s.ltp > 0 && s.tp1 > 0)
      .sort((a, b) => a.strike - b.strike)
      .map((s) => ({
        strike: s.strike,
        tp: s.tp1,
        entry: s.ltp,
        sl: s.sl,
        tp2: s.tp2,
      }));
  }, [strikes]);

  const atmStrike = Math.round(spot / 50) * 50;

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Target className="h-3 w-3 text-[#2dd4a7]" />
        <span className="text-[10px] font-bold text-[#7d8ba0] uppercase">CE TP1 / Entry / SL Range</span>
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: -20 }}>
            <XAxis dataKey="strike" tick={{ fontSize: 8, fill: "#7d8ba0" }} interval={Math.max(0, Math.floor(chartData.length / 8))} />
            <YAxis tick={{ fontSize: 8, fill: "#7d8ba0" }} />
            <Tooltip
              contentStyle={{ background: "#151b25", border: "1px solid #1f2733", borderRadius: 8, fontSize: 10 }}
              formatter={(val: number, name: string) => [`₹${fmt(val)}`, name === "tp" ? "TP1" : name === "tp2" ? "TP2" : name === "entry" ? "Entry" : name === "sl" ? "SL" : name]}
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
  s: AccelerationStrike; rank: number;
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
        className="grid grid-cols-[24px_100px_44px_60px_180px_56px_60px_56px_44px] items-center py-2 px-3 cursor-pointer hover:bg-[#151b25]/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="text-[10px] text-[#7d8ba0] font-bold flex items-center gap-1">
          #{rank}
          {s.tradable && <span className="w-1.5 h-1.5 rounded-full bg-[#2dd4a7]" title="Tradable" />}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono font-bold text-[#dfe6ee] text-[13px]">{fmtInt(s.strike)}</span>
            <span className={`text-[9px] font-bold px-1 py-px rounded ${isCE ? "bg-[rgba(45,212,167,.12)] text-[#2dd4a7]" : "bg-[rgba(242,73,92,.12)] text-[#f2495c]"}`}>{s.type}</span>
            <span className={`text-[9px] font-mono font-bold ${moneyColor}`}>{money}</span>
          </div>
        </div>
        <div className="text-center">
          <span className="font-mono font-bold text-[14px] leading-none" style={{ color: scoreColor(s.acceleration) }}>
            {fmt(s.acceleration)}
          </span>
        </div>
        <div className="text-right font-mono font-bold text-[14px] text-[#2dd4a7] leading-none">₹{fmt(s.ltp)}</div>
        <div className="text-[11px] font-mono text-[#a0aec0] leading-tight whitespace-nowrap overflow-hidden">
          <span className="text-[#dfe6ee]">Γ</span>{s.gamma.toFixed(4)}{" "}
          <span className="text-[#dfe6ee]">Δ</span>{s.delta.toFixed(2)}{" "}
          <span className="text-[#f2495c]">Θ</span>{fmt(s.theta)}{" "}
          <span className="text-[#e8a33d]">{fmt(s.iv)}%</span>
        </div>
        <div className="text-center">
          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ background: `${speedColor[s.speed]}20`, color: speedColor[s.speed] }}>
            {s.speed}
          </span>
        </div>
        <div className="text-right font-mono font-bold text-[12px] text-[#2dd4a7]">₹{fmt(s.tp1)}</div>
        <div className="text-right font-mono font-bold text-[12px] text-[#f2495c]">₹{fmt(s.sl)}</div>
        <div className="text-right">
          <span className="text-[12px] font-mono font-bold" style={{ color: rrColor }}>{fmt(s.rr)}x</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-2.5 bg-[#0a1018]">
          <div className="flex items-center gap-4 text-[10px] text-[#7d8ba0] mb-1 flex-wrap">
            <span className="flex items-center gap-1"><Target className="h-2.5 w-2.5 text-[#2dd4a7]" /> TP1 ₹{fmt(s.tp1)} <span className="text-[#2dd4a7] font-bold">({s.tp1Prob}%)</span></span>
            <span className="flex items-center gap-1"><Target className="h-2.5 w-2.5 text-[#4f8ff7]" /> TP2 ₹{fmt(s.tp2)} <span className="text-[#4f8ff7] font-bold">({s.tp2Prob}%)</span></span>
            <span className="flex items-center gap-1"><Target className="h-2.5 w-2.5 text-[#a78bfa]" /> TP3 ₹{fmt(s.tp3)} <span className="text-[#a78bfa] font-bold">({s.tp3Prob}%)</span></span>
            <span className="flex items-center gap-1"><ShieldAlert className="h-2.5 w-2.5 text-[#f2495c]" /> SL ₹{fmt(s.sl)}</span>
            <span className="font-bold" style={{ color: rrColor }}>R:R {fmt(s.rr)}x</span>
            <span className="flex items-center gap-1 text-[#4f8ff7]">ETA {s.expectedTimeToTP}min</span>
            <span className="flex items-center gap-1 text-[#eab308]">+₹{fmt(s.expectedPremiumVelocity)}/min</span>
            <span className="flex items-center gap-1 text-[#a855f7]">Spot +{fmt(s.expectedSpotRequired)}</span>
          </div>
          <TPSLBar entry={s.ltp} tp={s.tp1} sl={s.sl} />
          <div className="h-3" />
          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Delta Accel</div>
              <ScoreBar label="Delta" score={s.engines.deltaAcceleration.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                10pt: {fmt(s.engines.deltaAcceleration.reaction10)}<br/>
                20pt: {fmt(s.engines.deltaAcceleration.reaction20)}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Gamma Explosion</div>
              <ScoreBar label="Gamma" score={s.engines.gammaExplosion.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                Near ATM: {s.engines.gammaExplosion.nearATM ? "Yes" : "No"}<br/>
                Boost: {fmt(s.engines.gammaExplosion.expiryBoost)}x
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">OI Absorption</div>
              <ScoreBar label="OI" score={s.engines.oiAbsorption.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                {s.engines.oiAbsorption.signal}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Volume Momentum</div>
              <ScoreBar label="Volume" score={s.engines.volumeMomentum.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                Rel Vol: {fmt(s.engines.volumeMomentum.relativeVolume, 3)}<br/>
                Spike: {s.engines.volumeMomentum.unusualParticipation ? "Yes" : "No"}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3 mt-2">
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Institutional Flow</div>
              <ScoreBar label="Inst" score={s.engines.institutionalFlow.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                {s.engines.institutionalFlow.dealerHedging ? "Dealer Unwind" : ""} {s.engines.institutionalFlow.repeatedBuying ? "Repeated Buy" : ""}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Premium Elasticity</div>
              <ScoreBar label="Elast" score={s.engines.premiumElasticity.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                Move: +{fmt(s.engines.premiumElasticity.expectedMove20)}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Historical Memory</div>
              <ScoreBar label="Hist" score={s.engines.historicalMemory.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                Win: {s.historicalWinRate}% | Match: {fmt(s.engines.historicalMemory.matchConfidence * 100)}%
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-0.5">Time Decay</div>
              <ScoreBar label="Time" score={s.engines.timeDecay.score} />
              <div className="text-[9px] font-mono text-[#a0aec0] mt-1">
                Phase: {s.engines.timeDecay.sessionPhase}<br/>
                Decay: {fmt(s.engines.timeDecay.decayRate, 4)}/hr
              </div>
            </div>
          </div>

          {s.reason.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {s.reason.map((r, i) => (
                <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-[rgba(79,143,247,.12)] text-[#4f8ff7] border border-[#4f8ff7]/20">
                  {r}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1 mt-2">
            <span className="text-[9px] text-[#7d8ba0]">OI {fmtOINum(s.oi)}</span>
            <span className="text-[9px] text-[#7d8ba0]">· Vol {fmtVol(s.volume)}</span>
            <span className="text-[9px] text-[#7d8ba0]">· Spread ₹{fmt(s.bidAskSpread, 1)}</span>
            {!s.tradable && s.acceleration >= 65 && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">⚠️ Late</span>
            )}
          </div>

          {s.tradable ? (
            <button
              onClick={(e) => { e.stopPropagation(); onTrade(s.strike, s.type, s.ltp); }}
              className="mt-2 w-full py-1.5 rounded-lg bg-[#2dd4a7]/10 text-[#2dd4a7] text-[11px] font-bold hover:bg-[#2dd4a7]/20 transition-colors border border-[#2dd4a7]/20"
            >
              Trade {s.type} @ ₹{fmt(s.ltp)}
            </button>
          ) : (
            <div className="mt-2 w-full py-1.5 rounded-lg bg-[#1f2733]/50 text-[#7d8ba0] text-[10px] font-medium text-center border border-[#1f2733]">
              {s.signal === "IGNORE" ? "Not tradable (low quality)" : "Signal suppressed (closing hour)"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Ranked Strikes All ───────────────────────────────────────────
function RankedStrikesAll({
  strikes, onTrade, spot,
}: {
  strikes: AccelerationStrike[];
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
        <div className="max-h-[400px] overflow-y-auto">
          {strikes.map((s, i) => (
            <StrikeRow key={`a-${s.type}-${s.strike}`} s={s} rank={i + 1} onTrade={onTrade} spot={spot} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Table Header ─────────────────────────────────────────────────
const tableHeader = (
  <div className="grid grid-cols-[24px_100px_44px_60px_180px_56px_60px_56px_44px] items-center py-1.5 px-3 border-b border-[#1f2733] text-[9px] text-[#7d8ba0] uppercase font-bold">
    <div>#</div>
    <div>Strike</div>
    <div className="text-center">Accel</div>
    <div className="text-right">Premium</div>
    <div>Greeks</div>
    <div className="text-center">Speed</div>
    <div className="text-right">TP1</div>
    <div className="text-right">SL</div>
    <div className="text-right">R:R</div>
  </div>
);

// ─── Main Panel ───────────────────────────────────────────────────
export function InstitutionalGreeksPanel({
  onTrade,
}: {
  onTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
}) {
  const [symbol, setSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY");
  const [data, setData] = useState<AccelerationResult | null>(null);
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
    const id = setInterval(fetchData, 900000);
    return () => clearInterval(id);
  }, [fetchData]);

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-[#2dd4a7]" />
          <span className="text-sm font-bold">Institutional Greeks</span>
          {data && (
            <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-[rgba(232,163,61,.15)] text-[#e8a33d] border-[#e8a33d]/30">
              {data.regime}
            </span>
          )}
          {data && (
            <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-[rgba(125,139,160,.12)] text-[#7d8ba0] border-[#7d8ba0]/30">
              {data.sessionPhase}
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
                : "bg-[#10151d] border border-[#1f2733] text-[#7d8ba0]"
            }`}
          >Charts</button>
          {loading && <Activity className="h-3 w-3 animate-spin" />}
          {updatedAt > 0 && <span>{new Date(updatedAt).toLocaleTimeString("en-IN")}</span>}
        </div>
      </div>

      {/* Summary row */}
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
              <div className="text-[8px] text-[#7d8ba0] uppercase">Avg Accel</div>
              <div className="text-[13px] font-mono font-bold text-[#2dd4a7]">{fmt(data.metrics.avgAcceleration)}</div>
            </div>
            <div>
              <div className="text-[8px] text-[#7d8ba0] uppercase">Max Accel</div>
              <div className="text-[13px] font-mono font-bold text-[#4f8ff7]">{fmt(data.metrics.maxAcceleration)}</div>
            </div>
            <div>
              <div className="text-[8px] text-[#7d8ba0] uppercase">Avg Velocity</div>
              <div className="text-[13px] font-mono font-bold text-[#eab308]">{fmt(data.metrics.avgVelocity)}</div>
            </div>
            <div>
              <div className="text-[8px] text-[#7d8ba0] uppercase">Regime</div>
              <div className="text-[11px] font-bold text-[#e8a33d]">{data.regime}</div>
            </div>
          </div>
          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] px-3 py-2">
            <div className="text-[8px] text-[#7d8ba0] uppercase font-bold mb-1">Key Metrics</div>
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              <div>
                <div className="text-[#7d8ba0]">PCR</div>
                <div className="font-mono font-bold text-[#dfe6ee]">{fmt(data.metrics.pcr, 2)}</div>
              </div>
              <div>
                <div className="text-[#7d8ba0]">VIX</div>
                <div className="font-mono font-bold text-[#dfe6ee]">{fmt(data.metrics.vix)}</div>
              </div>
              <div>
                <div className="text-[#7d8ba0]">Exp Move</div>
                <div className="font-mono font-bold text-[#2dd4a7]">±{fmt(data.expectedMove)}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Closing hour warning banner */}
      {data && data.sessionPhase === "Closing Hour" && (
        <div className="bg-[rgba(242,73,92,.1)] border border-[#f2495c]/30 rounded-[10px] px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-[#f2495c] shrink-0" />
          <span className="text-[11px] text-[#f2495c] font-medium">
            Closing Hour — signals suppressed. New trades strongly discouraged. Review only.
          </span>
        </div>
      )}

      {/* Regime warning banner for Reversal + high OI */}
      {data && data.regime === "Reversal" && data.sessionPhase === "Closing Hour" && (
        <div className="bg-[rgba(232,163,61,.1)] border border-[#e8a33d]/30 rounded-[10px] px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-[#e8a33d] shrink-0" />
          <span className="text-[11px] text-[#e8a33d] font-medium">
            Reversal + Closing Hour — contradictory signals. Do not trade.
          </span>
        </div>
      )}

      {/* 12 Dashboard Cards */}
      {data && (
        <div className="grid grid-cols-4 gap-2">
          {data.fastestPremium && (
            <DashCard
              label="Fastest Premium"
              strike={`${data.fastestPremium.strike} ${data.fastestPremium.type}`}
              value={`Speed ${fmt(data.fastestPremium.expectedSpeed)} | ${data.fastestPremium.speed}`}
              sub={`TP1 ₹${fmt(data.fastestPremium.tp1)} (${data.fastestPremium.tp1Prob}%) | ETA ${data.fastestPremium.expectedTimeToTP}min`}
              icon={<Rocket size={11} className="text-[#ef4444]" />}
              color="border-[#ef4444]/30 bg-[rgba(239,68,68,.08)]"
              highlight={data.fastestPremium.acceleration >= 90}
            />
          )}
          {data.highestVelocity && (
            <DashCard
              label="Premium Velocity"
              strike={`${data.highestVelocity.strike} ${data.highestVelocity.type}`}
              value={`Velocity ${fmt(data.highestVelocity.expectedSpeed)} | ${data.highestVelocity.speed}`}
              sub={`LTP ${fmt(data.highestVelocity.ltp)} | Δ ${fmt(data.highestVelocity.delta, 4)}`}
              icon={<Gauge size={11} className="text-[#eab308]" />}
              color="border-[#eab308]/30 bg-[rgba(234,179,8,.08)]"
            />
          )}
          {data.highestExplosion && (
            <DashCard
              label="Explosion Probability"
              strike={`${data.highestExplosion.strike} ${data.highestExplosion.type}`}
              value={`Gamma Exp ${fmt(data.highestExplosion.engines.gammaExplosion.score)}`}
              sub={`γ ${fmt(data.highestExplosion.gamma, 4)} | Near ATM: ${data.highestExplosion.engines.gammaExplosion.nearATM ? "Yes" : "No"}`}
              icon={<Zap size={11} className="text-[#ef4444]" />}
              color="border-[#ef4444]/30 bg-[rgba(239,68,68,.08)]"
            />
          )}
          {data.institutionalStrike && (
            <DashCard
              label="Institutional Buying"
              strike={`${data.institutionalStrike.strike} ${data.institutionalStrike.type}`}
              value={`OI Absorption ${fmt(data.institutionalStrike.engines.oiAbsorption.score)}`}
              sub={`${data.institutionalStrike.engines.oiAbsorption.signal} | ${fmtVol(data.institutionalStrike.volume)} vol`}
              icon={<ShieldAlert size={11} className="text-[#4f8ff7]" />}
              color="border-[#4f8ff7]/30 bg-[rgba(79,143,247,.08)]"
            />
          )}
          {data.dealerWallStrike && (
            <DashCard
              label="Dealer Gamma Wall"
              strike={`${data.dealerWallStrike.strike} ${data.dealerWallStrike.type}`}
              value={`Inst Flow ${fmt(data.dealerWallStrike.engines.institutionalFlow.score)}`}
              sub={`${data.dealerWallStrike.dealerResistance} resistance`}
              icon={<Flame size={11} className="text-[#a855f7]" />}
              color="border-[#a855f7]/30 bg-[rgba(168,85,247,.08)]"
            />
          )}
          {data.bestScalp && (
            <DashCard
              label="Best Scalping Strike"
              strike={`${data.bestScalp.strike} ${data.bestScalp.type}`}
              value={`Accel ${fmt(data.bestScalp.acceleration)} | ${data.bestScalp.speed}`}
              sub={`TP1 ₹${fmt(data.bestScalp.tp1)} (${data.bestScalp.tp1Prob}%) | ETA ${data.bestScalp.expectedTimeToTP}min`}
              icon={<Timer size={11} className="text-[#22c55e]" />}
              color="border-[#22c55e]/30 bg-[rgba(34,197,94,.08)]"
            />
          )}
          {data.bestSwing && (
            <DashCard
              label="Best Swing Strike"
              strike={`${data.bestSwing.strike} ${data.bestSwing.type}`}
              value={`Accel ${fmt(data.bestSwing.acceleration)} | ${data.bestSwing.speed}`}
              sub={`TP2 ₹${fmt(data.bestSwing.tp2)} (${data.bestSwing.tp2Prob}%) | R:R ${fmt(data.bestSwing.rr)}`}
              icon={<TrendingUp size={11} className="text-[#14b8a6]" />}
              color="border-[#14b8a6]/30 bg-[rgba(20,184,166,.08)]"
            />
          )}
          {data.trapRiskStrike && (
            <DashCard
              label="Trap Probability"
              strike={`${data.trapRiskStrike.strike} ${data.trapRiskStrike.type}`}
              value={`Risk ${fmt(100 - data.trapRiskStrike.engines.oiAbsorption.score)}%`}
              sub={`${data.trapRiskStrike.engines.oiAbsorption.freshShort ? "Fresh Short" : data.trapRiskStrike.engines.oiAbsorption.longUnwinding ? "Long Unwind" : "Caution"}`}
              icon={<AlertTriangle size={11} className="text-[#f2495c]" />}
              color="border-[#f2495c]/30 bg-[rgba(242,73,92,.08)]"
            />
          )}
        </div>
      )}

      {error && (
        <div className="bg-[#10151d] border border-[#f2495c]/30 rounded-[10px] p-4 text-center text-[#f2495c] text-sm">{error}</div>
      )}

      {!error && data && (
        <div className="flex-1 overflow-y-auto space-y-2">
          {showCharts && data.strikes.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <AccelChart strikes={data.strikes} spot={data.spot} />
              <TPSLChart strikes={data.strikes} spot={data.spot} />
            </div>
          )}

          <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
            <div className="px-3 py-2 border-b border-[#1f2733] flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-[#2dd4a7]" />
              <span className="font-bold text-[13px] text-[#2dd4a7]">Top 5 Calls</span>
              <span className="text-[9px] text-[#7d8ba0] font-mono">({data.topCalls.filter(s => s.tradable).length} tradable)</span>
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
              <span className="text-[9px] text-[#7d8ba0] font-mono">({data.topPuts.filter(s => s.tradable).length} tradable)</span>
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
