"use client";

import { useEffect, useState, useMemo } from "react";
import { useTerminalStore } from "@/stores/useTerminalStore";
import {
  TrendingUp,
  TrendingDown,
  Zap,
  Activity,
  BarChart3,
  Droplets,
  Shield,
  Flame,
  RefreshCw,
  Target,
  Gauge,
  Timer,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Rocket,
} from "lucide-react";
import type { AccelerationResult, AccelerationStrike } from "@/lib/option-acceleration-engine";

function heatColor(value: number): string {
  if (value >= 95) return "text-emerald-400 bg-emerald-950 border-emerald-700";
  if (value >= 90) return "text-green-400 bg-green-950 border-green-700";
  if (value >= 80) return "text-yellow-400 bg-yellow-950 border-yellow-700";
  if (value >= 70) return "text-orange-400 bg-orange-950 border-orange-700";
  if (value >= 50) return "text-gray-400 bg-gray-900 border-gray-700";
  return "text-gray-500 bg-gray-900 border-gray-800";
}

function signalBadge(signal: string): string {
  if (signal === "STRONG BUY") return "bg-emerald-600 text-white";
  if (signal === "BUY") return "bg-green-600 text-white";
  if (signal === "WATCH") return "bg-yellow-600 text-white";
  if (signal === "WAIT") return "bg-orange-600 text-white";
  return "bg-gray-700 text-gray-400";
}

function speedBadge(speed: string): string {
  if (speed === "INSTANT") return "bg-red-600 text-white";
  if (speed === "FAST") return "bg-orange-500 text-white";
  if (speed === "MODERATE") return "bg-yellow-500 text-white";
  if (speed === "SLOW") return "bg-gray-600 text-gray-300";
  return "bg-gray-700 text-gray-500";
}

function fmtNum(n: number, d = 1): string {
  if (n === 0 || isNaN(n)) return "0";
  return n.toFixed(d);
}

function fmtOINum(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(1) + "L";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toFixed(0);
}

function fmtVol(n: number): string {
  if (n === 0) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toFixed(0);
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Dashboard Card ───────────────────────────────────────────────
function DashCard({
  label,
  strike,
  value,
  sub,
  icon,
  color,
  highlight,
}: {
  label: string;
  strike: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div className={`border rounded-lg p-3 ${color} ${highlight ? "ring-1 ring-amber-500/60" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-lg font-bold text-white">{strike}</div>
      <div className="text-xs text-gray-300 font-medium">{value}</div>
      <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>
    </div>
  );
}

// ─── Strike Card ──────────────────────────────────────────────────
function StrikeCard({
  s,
  maxGamma,
  maxOI,
  maxVol,
  spot,
  onTrade,
}: {
  s: AccelerationStrike;
  maxGamma: number;
  maxOI: number;
  maxVol: number;
  spot: number;
  onTrade?: (strike: number, type: "CE" | "PE", ltp: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const distPct = spot > 0 ? ((s.distanceFromSpot / spot) * 100).toFixed(2) : "0";
  const isATM = s.distanceFromATM <= 50;

  return (
    <div
      className={`border rounded-lg transition-all cursor-pointer ${heatColor(s.acceleration)} ${
        isATM ? "ring-1 ring-amber-500/50" : ""
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${s.type === "CE" ? "bg-blue-600" : "bg-rose-600"}`}>
            {s.type}
          </span>
          <span className="font-mono text-sm font-bold text-white">{s.strike}</span>
          {isATM && <span className="text-[9px] bg-amber-600 text-white px-1 rounded">ATM</span>}
          {s.acceleration >= 92 && <Flame size={12} className="text-orange-400" />}
          {s.acceleration >= 80 && <Zap size={12} className="text-green-400" />}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-gray-400">LTP</span>
          <span className="text-xs font-mono font-bold text-white">{fmtNum(s.ltp)}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${speedBadge(s.speed)}`}>
            {s.speed}
          </span>
          {s.tp1 > 0 && <span className="text-[10px] text-green-400">TP1 {fmtNum(s.tp1)} ({s.tp1Prob}%)</span>}
          {s.sl > 0 && <span className="text-[10px] text-red-400">SL {fmtNum(s.sl)}</span>}
          {s.rr > 0 && <span className="text-[10px] text-amber-400">R:R {fmtNum(s.rr)}</span>}
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${signalBadge(s.signal)}`}>
            {s.signal}
          </span>
          <span className="text-xs font-mono font-bold">{fmtNum(s.acceleration)}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-700/50 px-3 py-2 space-y-2">
          <div className="grid grid-cols-4 gap-1.5 text-[10px]">
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Delta</div>
              <div className="font-mono font-bold">{fmtNum(s.delta, 4)}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Gamma</div>
              <div className="font-mono font-bold">{fmtNum(s.gamma, 4)}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Theta</div>
              <div className="font-mono font-bold">{fmtNum(s.theta)}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">IV</div>
              <div className="font-mono font-bold">{fmtNum(s.iv)}%</div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-1.5 text-[10px]">
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Velocity</div>
              <div className="font-mono font-bold text-amber-400">{fmtNum(s.expectedSpeed)}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Exp Premium/s</div>
              <div className="font-mono font-bold text-green-400">+{fmtNum(s.expectedPremiumVelocity)}/min</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">ETA to TP1</div>
              <div className="font-mono font-bold text-blue-400">{s.expectedTimeToTP}min</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Spot Required</div>
              <div className="font-mono font-bold text-purple-400">+{fmtNum(s.expectedSpotRequired)}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-[10px]">
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">TP1</div>
              <div className="font-mono font-bold text-green-400">{fmtNum(s.tp1)} ({s.tp1Prob}%)</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">TP2</div>
              <div className="font-mono font-bold text-green-300">{fmtNum(s.tp2)} ({s.tp2Prob}%)</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">TP3</div>
              <div className="font-mono font-bold text-green-200">{fmtNum(s.tp3)} ({s.tp3Prob}%)</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-[10px]">
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Inst. Flow</div>
              <div className="font-mono font-bold">{s.institutionalBuying}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Dealer Resist</div>
              <div className="font-mono font-bold">{s.dealerResistance}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Elasticity</div>
              <div className="font-mono font-bold">{s.premiumElasticity}</div>
            </div>
          </div>

          {s.tp1 > 0 && s.sl > 0 && (
            <div className="flex items-center gap-2 p-1.5 rounded bg-gray-900 text-[10px]">
              <span className="text-red-400 font-mono">SL {fmtNum(s.sl)}</span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden relative">
                <div className="absolute inset-0 flex">
                  <div className="h-full bg-red-900/50" style={{ width: `${((s.ltp - s.sl) / (s.tp1 - s.sl)) * 100}%` }} />
                  <div className="h-full bg-green-900/50" style={{ width: `${((s.tp1 - s.ltp) / (s.tp1 - s.sl)) * 100}%` }} />
                </div>
                <div
                  className="absolute top-0 h-full w-0.5 bg-white"
                  style={{ left: `${((s.ltp - s.sl) / (s.tp1 - s.sl)) * 100}%` }}
                />
              </div>
              <span className="text-green-400 font-mono">TP1 {fmtNum(s.tp1)}</span>
              <span className="text-amber-400 font-mono ml-1">R:R {fmtNum(s.rr)}</span>
            </div>
          )}

          <div className="grid grid-cols-5 gap-1 text-[10px]">
            {(["deltaAcceleration", "gammaExplosion", "oiAbsorption", "volumeMomentum", "institutionalFlow"] as const).map(
              (k) => (
                <div key={k} className="text-center">
                  <div className="text-gray-500 mb-0.5">{k.replace(/([A-Z])/g, " $1").trim()}</div>
                  <MiniBar value={s.engines[k].score} max={100} color="bg-emerald-500" />
                  <div className="font-mono mt-0.5">{Math.round(s.engines[k].score)}</div>
                </div>
              )
            )}
          </div>

          <div className="grid grid-cols-3 gap-1 text-[10px]">
            {(["historicalMemory", "regime", "premiumElasticity"] as const).map(
              (k) => (
                <div key={k} className="text-center">
                  <div className="text-gray-500 mb-0.5">{k.replace(/([A-Z])/g, " $1").trim()}</div>
                  <MiniBar value={s.engines[k].score} max={100} color="bg-blue-500" />
                  <div className="font-mono mt-0.5">{Math.round(s.engines[k].score)}</div>
                </div>
              )
            )}
          </div>

          {s.reason.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {s.reason.map((r, i) => (
                <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300">
                  {r}
                </span>
              ))}
            </div>
          )}

          {onTrade && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTrade(s.strike, s.type, s.ltp);
              }}
              className="w-full text-xs py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium"
            >
              Trade {s.strike} {s.type} @ ₹{fmtNum(s.ltp)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────
export default function GreekFlowHeatmap({ onTrade }: { onTrade?: (strike: number, type: "CE" | "PE", ltp: number) => void }) {
  const { symbol: storeSymbol } = useTerminalStore();
  const [symbol, setSymbol] = useState<string>(storeSymbol || "NIFTY");
  const [result, setResult] = useState<AccelerationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showRace, setShowRace] = useState(true);

  const fetchData = async () => {
    try {
      const res = await fetch(`/api/greek-flow?symbol=${symbol}`, { cache: "no-store" });
      const json = await res.json();
      if (json.success && json.result) {
        setResult(json.result);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
      } else {
        setError(json.error || "Failed");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, 900000);
    return () => clearInterval(interval);
  }, [symbol]);

  const ceStrikes = useMemo(() => (result?.strikes || []).filter((s) => s.type === "CE"), [result]);
  const peStrikes = useMemo(() => (result?.strikes || []).filter((s) => s.type === "PE"), [result]);
  const allStrikes = useMemo(() => result?.strikes || [], [result]);

  const maxGamma = useMemo(() => Math.max(...allStrikes.map((s) => s.gamma), 0.001), [allStrikes]);
  const maxOI = useMemo(() => Math.max(...allStrikes.map((s) => s.oi), 1), [allStrikes]);
  const maxVol = useMemo(() => Math.max(...allStrikes.map((s) => s.volume), 1), [allStrikes]);

  const uniqueStrikes = useMemo(() => {
    const seen = new Set<number>();
    return allStrikes.filter((s) => {
      if (seen.has(s.strike)) return false;
      seen.add(s.strike);
      return true;
    });
  }, [allStrikes]);

  if (loading && !result) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={20} className="animate-spin text-blue-400 mr-2" />
        <span className="text-gray-400">Loading acceleration engine...</span>
      </div>
    );
  }

  if (error && !result) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-red-400">{error}</span>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Rocket size={18} className="text-orange-400" />
            Option Acceleration Engine
          </h2>
          <div className="flex gap-1">
            {(["NIFTY", "SENSEX", "BANKNIFTY", "MIDCPNIFTY"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`text-[10px] px-2 py-1 rounded font-medium ${
                  symbol === s ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500">Spot: {fmtNum(result.spot)}</span>
          <span className="text-[10px] text-gray-500">ATM: {result.atmStrike}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-300 font-medium">{result.regime}</span>
          <span className="text-[10px] text-gray-500">{lastUpdate}</span>
          <RefreshCw size={12} className={`text-gray-500 ${loading ? "animate-spin" : ""}`} />
        </div>
      </div>

      {/* 12 Dashboard Cards */}
      <div className="grid grid-cols-4 gap-2">
        {result.fastestPremium && (
          <DashCard
            label="Fastest Premium"
            strike={`${result.fastestPremium.strike} ${result.fastestPremium.type}`}
            value={`Speed ${fmtNum(result.fastestPremium.expectedSpeed)} | ${result.fastestPremium.speed}`}
            sub={`TP1 ₹${fmtNum(result.fastestPremium.tp1)} (${result.fastestPremium.tp1Prob}%) | ETA ${result.fastestPremium.expectedTimeToTP}min`}
            icon={<Rocket size={12} className="text-red-400" />}
            color="border-red-700/50 bg-red-950/30"
            highlight={result.fastestPremium.acceleration >= 90}
          />
        )}
        {result.highestVelocity && (
          <DashCard
            label="Premium Velocity"
            strike={`${result.highestVelocity.strike} ${result.highestVelocity.type}`}
            value={`Velocity ${fmtNum(result.highestVelocity.expectedSpeed)} | ${result.highestVelocity.speed}`}
            sub={`LTP ${fmtNum(result.highestVelocity.ltp)} | Δ ${fmtNum(result.highestVelocity.delta, 4)}`}
            icon={<Gauge size={12} className="text-amber-400" />}
            color="border-amber-700/50 bg-amber-950/30"
          />
        )}
        {result.highestExplosion && (
          <DashCard
            label="Explosion Probability"
            strike={`${result.highestExplosion.strike} ${result.highestExplosion.type}`}
            value={`Gamma Exp ${fmtNum(result.highestExplosion.engines.gammaExplosion.score)}`}
            sub={`γ ${fmtNum(result.highestExplosion.gamma, 4)} | Near ATM: ${result.highestExplosion.engines.gammaExplosion.nearATM ? "Yes" : "No"}`}
            icon={<Zap size={12} className="text-red-400" />}
            color="border-red-700/50 bg-red-950/30"
          />
        )}
        {result.institutionalStrike && (
          <DashCard
            label="Institutional Buying"
            strike={`${result.institutionalStrike.strike} ${result.institutionalStrike.type}`}
            value={`OI Absorption ${fmtNum(result.institutionalStrike.engines.oiAbsorption.score)}`}
            sub={`${result.institutionalStrike.engines.oiAbsorption.signal} | ${fmtVol(result.institutionalStrike.volume)} vol`}
            icon={<Shield size={12} className="text-blue-400" />}
            color="border-blue-700/50 bg-blue-950/30"
          />
        )}
        {result.dealerWallStrike && (
          <DashCard
            label="Dealer Gamma Wall"
            strike={`${result.dealerWallStrike.strike} ${result.dealerWallStrike.type}`}
            value={`Inst Flow ${fmtNum(result.dealerWallStrike.engines.institutionalFlow.score)}`}
            sub={`${result.dealerWallStrike.dealerResistance} resistance | ${result.dealerWallStrike.engines.institutionalFlow.dealerHedging ? "Dealer Unwind" : ""}`}
            icon={<Activity size={12} className="text-purple-400" />}
            color="border-purple-700/50 bg-purple-950/30"
          />
        )}
        {result.bestScalp && (
          <DashCard
            label="Best Scalping Strike"
            strike={`${result.bestScalp.strike} ${result.bestScalp.type}`}
            value={`Accel ${fmtNum(result.bestScalp.acceleration)} | ${result.bestScalp.speed}`}
            sub={`TP1 ₹${fmtNum(result.bestScalp.tp1)} (${result.bestScalp.tp1Prob}%) | ETA ${result.bestScalp.expectedTimeToTP}min`}
            icon={<Timer size={12} className="text-green-400" />}
            color="border-green-700/50 bg-green-950/30"
          />
        )}
        {result.bestSwing && (
          <DashCard
            label="Best Swing Strike"
            strike={`${result.bestSwing.strike} ${result.bestSwing.type}`}
            value={`Accel ${fmtNum(result.bestSwing.acceleration)} | ${result.bestSwing.speed}`}
            sub={`TP2 ₹${fmtNum(result.bestSwing.tp2)} (${result.bestSwing.tp2Prob}%) | R:R ${fmtNum(result.bestSwing.rr)}`}
            icon={<TrendingUp size={12} className="text-teal-400" />}
            color="border-teal-700/50 bg-teal-950/30"
          />
        )}
        {result.trapRiskStrike && (
          <DashCard
            label="Trap Probability"
            strike={`${result.trapRiskStrike.strike} ${result.trapRiskStrike.type}`}
            value={`Risk ${fmtNum(100 - result.trapRiskStrike.engines.oiAbsorption.score)}%`}
            sub={`${result.trapRiskStrike.engines.oiAbsorption.freshShort ? "Fresh Short" : result.trapRiskStrike.engines.oiAbsorption.longUnwinding ? "Long Unwind" : "Caution"}`}
            icon={<AlertTriangle size={12} className="text-rose-400" />}
            color="border-rose-700/50 bg-rose-950/30"
          />
        )}
      </div>

      <div className="grid grid-cols-4 gap-2">
        <DashCard
          label="Avg Acceleration"
          strike={fmtNum(result.metrics.avgAcceleration)}
          value={`Max ${fmtNum(result.metrics.maxAcceleration)}`}
          sub={`PCR ${fmtNum(result.metrics.pcr)} | VIX ${fmtNum(result.metrics.vix)}`}
          icon={<BarChart3 size={12} className="text-cyan-400" />}
          color="border-cyan-700/50 bg-cyan-950/30"
        />
        <DashCard
          label="Avg Velocity"
          strike={fmtNum(result.metrics.avgVelocity)}
          value={`Total Vol ${fmtVol(result.metrics.totalVolume)}`}
          sub={`OI Change ${fmtOINum(result.metrics.totalOIChange)}`}
          icon={<Droplets size={12} className="text-blue-400" />}
          color="border-blue-700/50 bg-blue-950/30"
        />
        <DashCard
          label="Historical Match"
          strike={`${result.fastestPremium?.historicalWinRate || 0}%`}
          value={`TP1 ${result.fastestPremium?.tp1Prob || 0}% | TP2 ${result.fastestPremium?.tp2Prob || 0}%`}
          sub={`ETA ${result.fastestPremium?.expectedTimeToTP || 0}min | Vel +₹${fmtNum(result.fastestPremium?.expectedPremiumVelocity || 0)}/min`}
          icon={<Target size={12} className="text-amber-400" />}
          color="border-amber-700/50 bg-amber-950/30"
        />
        <DashCard
          label="Regime & Phase"
          strike={result.regime}
          value={`Session: ${result.sessionPhase}`}
          sub={`Exp Move ±${fmtNum(result.expectedMove)}`}
          icon={<Shield size={12} className="text-purple-400" />}
          color="border-purple-700/50 bg-purple-950/30"
        />
      </div>

      {/* Premium Race Engine */}
      <div>
        <button
          onClick={() => setShowRace(!showRace)}
          className="flex items-center gap-2 mb-2 text-sm font-bold text-white"
        >
          <Flame size={14} className="text-orange-400" />
          Premium Race Engine
          {showRace ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span className="text-[10px] text-gray-500 font-normal">Strikes ranked by expected return per minute</span>
        </button>
        {showRace && (
          <div className="border rounded-lg overflow-hidden">
            <div className="bg-gray-900 px-3 py-2 border-b border-gray-800">
              <span className="text-xs font-bold text-white">Acceleration Race</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-gray-900 text-gray-400">
                    <th className="px-3 py-1.5 text-left font-medium">#</th>
                    <th className="px-3 py-1.5 text-left font-medium">Strike</th>
                    <th className="px-3 py-1.5 text-right font-medium">LTP</th>
                    <th className="px-3 py-1.5 text-right font-medium">Accel</th>
                    <th className="px-3 py-1.5 text-right font-medium">Speed</th>
                    <th className="px-3 py-1.5 text-right font-medium">Velocity</th>
                    <th className="px-3 py-1.5 text-right font-medium">Exp Move</th>
                    <th className="px-3 py-1.5 text-right font-medium">Prob</th>
                    <th className="px-3 py-1.5 text-right font-medium">TP1</th>
                    <th className="px-3 py-1.5 text-right font-medium">TP2</th>
                    <th className="px-3 py-1.5 text-right font-medium">TP3</th>
                    <th className="px-3 py-1.5 text-right font-medium">SL</th>
                    <th className="px-3 py-1.5 text-right font-medium">R:R</th>
                    <th className="px-3 py-1.5 text-right font-medium">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {allStrikes.slice(0, 20).map((s, i) => (
                    <tr
                      key={`${s.strike}-${s.type}`}
                      className={`border-t border-gray-800/50 hover:bg-gray-800/30 ${
                        i === 0 ? "bg-amber-950/20" : ""
                      }`}
                    >
                    <td className="px-3 py-1.5 font-mono text-gray-500">{i + 1}</td>
                    <td className="px-3 py-1.5 font-mono font-bold text-white">
                      {s.strike}
                      <span className={`ml-1 text-[9px] px-1 rounded ${s.type === "CE" ? "bg-blue-600" : "bg-rose-600"}`}>
                        {s.type}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono font-bold text-white">₹{fmtNum(s.ltp)}</td>
                      <td className="px-3 py-1.5 text-right font-mono font-bold">{fmtNum(s.acceleration)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${speedBadge(s.speed)}`}>
                          {s.speed}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-amber-400">{fmtNum(s.expectedSpeed)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-green-400">+{fmtNum(s.expectedPremiumMove)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{s.probability}%</td>
                      <td className="px-3 py-1.5 text-right font-mono text-green-400">{fmtNum(s.tp1)} ({s.tp1Prob}%)</td>
                      <td className="px-3 py-1.5 text-right font-mono text-green-300">{fmtNum(s.tp2)} ({s.tp2Prob}%)</td>
                      <td className="px-3 py-1.5 text-right font-mono text-green-200">{fmtNum(s.tp3)} ({s.tp3Prob}%)</td>
                      <td className="px-3 py-1.5 text-right font-mono text-red-400">{fmtNum(s.sl)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-amber-400">{fmtNum(s.rr)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={`text-[9px] px-1 py-0.5 rounded ${signalBadge(s.signal)}`}>
                          {s.signal}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Top Calls + Puts side by side */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={14} className="text-green-400" />
            <span className="text-sm font-bold text-white">Top 5 Calls</span>
            <span className="text-[10px] text-gray-500">({ceStrikes.length} total)</span>
          </div>
          <div className="space-y-1.5">
            {result.topCalls.map((s) => (
              <StrikeCard key={`ce-${s.strike}`} s={s} maxGamma={maxGamma} maxOI={maxOI} maxVol={maxVol} spot={result.spot} onTrade={onTrade} />
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown size={14} className="text-rose-400" />
            <span className="text-sm font-bold text-white">Top 5 Puts</span>
            <span className="text-[10px] text-gray-500">({peStrikes.length} total)</span>
          </div>
          <div className="space-y-1.5">
            {result.topPuts.map((s) => (
              <StrikeCard key={`pe-${s.strike}`} s={s} maxGamma={maxGamma} maxOI={maxOI} maxVol={maxVol} spot={result.spot} onTrade={onTrade} />
            ))}
          </div>
        </div>
      </div>

      {/* Full Heatmap Table */}
      {showHeatmap && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-gray-900 px-3 py-2 border-b border-gray-800">
            <span className="text-xs font-bold text-white">Full Heatmap</span>
            <span className="text-[10px] text-gray-500 ml-2">{uniqueStrikes.length} strikes</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-gray-900 text-gray-400">
                  <th className="px-3 py-1.5 text-left font-medium">Strike</th>
                  <th className="px-3 py-1.5 text-right font-medium">Accel</th>
                  <th className="px-3 py-1.5 text-right font-medium">Speed</th>
                  <th className="px-3 py-1.5 text-right font-medium">Velocity</th>
                  <th className="px-3 py-1.5 text-right font-medium">Prob</th>
                  <th className="px-3 py-1.5 text-right font-medium">Gamma</th>
                  <th className="px-3 py-1.5 text-right font-medium">OI</th>
                  <th className="px-3 py-1.5 text-right font-medium">Vol</th>
                  <th className="px-3 py-1.5 text-right font-medium">Delta</th>
                  <th className="px-3 py-1.5 text-right font-medium">Theta</th>
                  <th className="px-3 py-1.5 text-right font-medium">IV</th>
                  <th className="px-3 py-1.5 text-right font-medium">LTP</th>
                  <th className="px-3 py-1.5 text-right font-medium">TP1</th>
                  <th className="px-3 py-1.5 text-right font-medium">TP2</th>
                  <th className="px-3 py-1.5 text-right font-medium">SL</th>
                  <th className="px-3 py-1.5 text-right font-medium">R:R</th>
                  <th className="px-3 py-1.5 text-right font-medium">Signal</th>
                </tr>
              </thead>
              <tbody>
                {uniqueStrikes.map((s) => {
                  const isATM = Math.abs(s.strike - result.atmStrike) <= 50;
                  return (
                    <tr
                      key={`${s.strike}-${s.type}`}
                      className={`border-t border-gray-800/50 hover:bg-gray-800/30 ${
                        isATM ? "bg-amber-950/20" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5 font-mono font-bold text-white">
                        {s.strike}
                        <span className={`ml-1 text-[9px] px-1 rounded ${s.type === "CE" ? "bg-blue-600" : "bg-rose-600"}`}>
                          {s.type}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-bold">{fmtNum(s.acceleration)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${speedBadge(s.speed)}`}>
                          {s.speed}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-amber-400">{fmtNum(s.expectedSpeed)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{s.probability}%</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtNum(s.gamma, 4)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtOINum(s.oi)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtVol(s.volume)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-300">{fmtNum(s.delta, 4)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-300">{fmtNum(s.theta)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-300">{fmtNum(s.iv)}%</td>
                      <td className="px-3 py-1.5 text-right font-mono text-white font-bold">{fmtNum(s.ltp)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-green-400">{s.tp1 > 0 ? `${fmtNum(s.tp1)} (${s.tp1Prob}%)` : "-"}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-green-300">{s.tp2 > 0 ? `${fmtNum(s.tp2)} (${s.tp2Prob}%)` : "-"}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-red-400">{s.sl > 0 ? fmtNum(s.sl) : "-"}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-amber-400">{s.rr > 0 ? fmtNum(s.rr) : "-"}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={`text-[9px] px-1 py-0.5 rounded ${signalBadge(s.signal)}`}>
                          {s.signal}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex gap-4 text-[10px] text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-emerald-500" /> Accel ≥95</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-green-500" /> Accel 90-95</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-yellow-500" /> Accel 80-90</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-orange-500" /> Accel 70-80</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-gray-500" /> Accel &lt;70</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-600" /> INSTANT</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-orange-500" /> FAST</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-yellow-500" /> MODERATE</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-600" /> ATM</span>
      </div>
    </div>
  );
}
