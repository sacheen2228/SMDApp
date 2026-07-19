"use client";

import { useEffect, useState, useMemo } from "react";
import { useTerminalStore } from "@/stores/useTerminalStore";
import { TrendingUp, TrendingDown, Zap, Activity, BarChart3, Droplets, Shield, Flame, RefreshCw } from "lucide-react";
import type { ScoredStrike, FlowEngineResult } from "@/lib/greek-flow-engine";

function heatColor(value: number): string {
  if (value >= 95) return "text-emerald-400 bg-emerald-950 border-emerald-700";
  if (value >= 90) return "text-green-400 bg-green-950 border-green-700";
  if (value >= 80) return "text-yellow-400 bg-yellow-950 border-yellow-700";
  if (value >= 70) return "text-orange-400 bg-orange-950 border-orange-700";
  return "text-gray-500 bg-gray-900 border-gray-700";
}

function heatBg(value: number): string {
  if (value >= 95) return "bg-emerald-500/30";
  if (value >= 90) return "bg-green-500/25";
  if (value >= 80) return "bg-yellow-500/20";
  if (value >= 70) return "bg-orange-500/15";
  return "bg-gray-800/50";
}

function gammaHeat(value: number, max: number): string {
  const ratio = max > 0 ? value / max : 0;
  if (ratio > 0.8) return "text-red-400 bg-red-950";
  if (ratio > 0.5) return "text-red-300 bg-red-900/50";
  return "text-gray-500 bg-gray-900";
}

function oiHeat(value: number, max: number): string {
  const ratio = max > 0 ? value / max : 0;
  if (ratio > 0.8) return "text-blue-400 bg-blue-950";
  if (ratio > 0.5) return "text-blue-300 bg-blue-900/50";
  return "text-gray-500 bg-gray-900";
}

function volumeHeat(value: number, max: number): string {
  const ratio = max > 0 ? value / max : 0;
  if (ratio > 0.8) return "text-cyan-400 bg-cyan-950";
  if (ratio > 0.5) return "text-cyan-300 bg-cyan-900/50";
  return "text-gray-500 bg-gray-900";
}

function dealerHeat(pressure: string): string {
  if (pressure === "HIGH") return "text-purple-400 bg-purple-950";
  if (pressure === "MEDIUM") return "text-purple-300 bg-purple-900/50";
  return "text-gray-500 bg-gray-900";
}

function signalBadge(signal: string): string {
  if (signal === "STRONG BUY") return "bg-emerald-600 text-white";
  if (signal === "BUY") return "bg-green-600 text-white";
  if (signal === "WATCH") return "bg-yellow-600 text-white";
  if (signal === "WAIT") return "bg-orange-600 text-white";
  return "bg-gray-700 text-gray-400";
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

function TopPanelCard({
  label,
  strike,
  value,
  sub,
  icon,
  color,
}: {
  label: string;
  strike: number;
  value: string;
  sub: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className={`border rounded-lg p-3 ${color}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-lg font-bold text-white">{strike}</div>
      <div className="text-xs text-gray-300">{value}</div>
      <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>
    </div>
  );
}

function ScoreCard({
  s,
  maxGamma,
  maxOI,
  maxVol,
  spot,
}: {
  s: ScoredStrike;
  maxGamma: number;
  maxOI: number;
  maxVol: number;
  spot: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const distFromSpot = Math.abs(s.strike - spot);
  const pctDist = spot > 0 ? ((distFromSpot / spot) * 100).toFixed(2) : "0";
  const isATM = distFromSpot <= 50;

  return (
    <div
      className={`border rounded-lg transition-all cursor-pointer ${heatColor(s.institutionalScore)} ${
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
          {s.signal === "STRONG BUY" && <Flame size={12} className="text-orange-400" />}
          {s.signal === "BUY" && <Zap size={12} className="text-green-400" />}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-gray-400">LTP</span>
          <span className="text-xs font-mono font-bold text-white">{fmtNum(s.ltp)}</span>
          {s.tp > 0 && <span className="text-[10px] text-green-400">TP {fmtNum(s.tp)}</span>}
          {s.sl > 0 && <span className="text-[10px] text-red-400">SL {fmtNum(s.sl)}</span>}
          {s.rr > 0 && <span className="text-[10px] text-amber-400">R:R {fmtNum(s.rr)}</span>}
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${signalBadge(s.signal)}`}>
            {s.signal}
          </span>
          <span className="text-xs font-mono font-bold">{fmtNum(s.institutionalScore)}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-700/50 px-3 py-2 space-y-2">
          <div className="grid grid-cols-5 gap-1.5 text-[10px]">
            <div className={`p-1.5 rounded ${gammaHeat(s.gamma, maxGamma)}`}>
              <div className="text-gray-400">Gamma</div>
              <div className="font-mono font-bold">{fmtNum(s.gamma, 4)}</div>
            </div>
            <div className={`p-1.5 rounded ${oiHeat(s.oi, maxOI)}`}>
              <div className="text-gray-400">OI</div>
              <div className="font-mono font-bold">{fmtOINum(s.oi)}</div>
            </div>
            <div className={`p-1.5 rounded ${volumeHeat(s.volume, maxVol)}`}>
              <div className="text-gray-400">Volume</div>
              <div className="font-mono font-bold">{fmtVol(s.volume)}</div>
            </div>
            <div className={`p-1.5 rounded ${dealerHeat(s.dealerPressure)}`}>
              <div className="text-gray-400">Dealer</div>
              <div className="font-mono font-bold">{s.dealerPressure}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">IV</div>
              <div className="font-mono font-bold">{fmtNum(s.iv)}%</div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-1.5 text-[10px]">
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Delta</div>
              <div className="font-mono font-bold">{fmtNum(s.delta)}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Theta</div>
              <div className="font-mono font-bold">{fmtNum(s.theta)}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Vega</div>
              <div className="font-mono font-bold">{fmtNum(s.vega)}</div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Spread</div>
              <div className="font-mono font-bold">{fmtNum(s.bidAskSpread, 2)}</div>
            </div>
          </div>

          {s.tp > 0 && s.sl > 0 && (
            <div className="flex items-center gap-2 p-1.5 rounded bg-gray-900 text-[10px]">
              <span className="text-red-400 font-mono">SL {fmtNum(s.sl)}</span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden relative">
                <div className="absolute inset-0 flex">
                  <div className="h-full bg-red-900/50" style={{ width: `${((s.ltp - s.sl) / (s.tp - s.sl)) * 100}%` }} />
                  <div className="h-full bg-green-900/50" style={{ width: `${((s.tp - s.ltp) / (s.tp - s.sl)) * 100}%` }} />
                </div>
                <div
                  className="absolute top-0 h-full w-0.5 bg-white"
                  style={{ left: `${((s.ltp - s.sl) / (s.tp - s.sl)) * 100}%` }}
                />
              </div>
              <span className="text-green-400 font-mono">TP {fmtNum(s.tp)}</span>
              <span className="text-amber-400 font-mono ml-1">R:R {fmtNum(s.rr)}</span>
            </div>
          )}

          <div className="grid grid-cols-3 gap-1.5 text-[10px]">
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Gamma Exp</div>
              <div className={`font-mono font-bold ${s.gammaExpansion > 0 ? "text-red-400" : "text-gray-500"}`}>
                {s.gammaExpansion > 0 ? "+" : ""}{fmtNum(s.gammaExpansion)}%
              </div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">OI Flow</div>
              <div className={`font-mono font-bold ${s.oiFlow > 0 ? "text-blue-400" : "text-gray-500"}`}>
                {s.oiFlow > 0 ? "+" : ""}{fmtNum(s.oiFlow)}%
              </div>
            </div>
            <div className="p-1.5 rounded bg-gray-900">
              <div className="text-gray-400">Dist</div>
              <div className="font-mono font-bold">{pctDist}%</div>
            </div>
          </div>

          <div className="grid grid-cols-5 gap-1 text-[10px]">
            {(["gammaScore", "oiFlowScore", "oiChangeScore", "deltaQualityScore", "volumeScore"] as const).map(
              (k) => (
                <div key={k} className="text-center">
                  <div className="text-gray-500 mb-0.5">{k.replace("Score", "").replace("Quality", " Qual")}</div>
                  <MiniBar value={s[k]} max={100} color="bg-emerald-500" />
                  <div className="font-mono mt-0.5">{Math.round(s[k])}</div>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function GreekFlowHeatmap({ onTrade }: { onTrade?: (strike: number, type: "CE" | "PE", ltp: number) => void }) {
  const { symbol: storeSymbol } = useTerminalStore();
  const [symbol, setSymbol] = useState<string>(storeSymbol || "NIFTY");
  const [result, setResult] = useState<FlowEngineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [showHeatmap, setShowHeatmap] = useState(true);

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
    const interval = setInterval(fetchData, 15000);
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
        <span className="text-gray-400">Loading institutional flow data...</span>
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Flame size={18} className="text-orange-400" />
            Institutional Greek Flow
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
          <button
            onClick={() => setShowHeatmap(!showHeatmap)}
            className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700"
          >
            {showHeatmap ? "Table" : "Heatmap"}
          </button>
          <span className="text-[10px] text-gray-500">Spot: {fmtNum(result.spot)}</span>
          <span className="text-[10px] text-gray-500">ATM: {result.atmStrike}</span>
          <span className="text-[10px] text-gray-500">{lastUpdate}</span>
          <RefreshCw size={12} className={`text-gray-500 ${loading ? "animate-spin" : ""}`} />
        </div>
      </div>

      <div className="grid grid-cols-7 gap-2">
        {result.bestCallStrike && (
          <TopPanelCard
            label="Best Call"
            strike={result.bestCallStrike.strike}
            value={`Score ${fmtNum(result.bestCallStrike.institutionalScore)}`}
            sub={`${result.bestCallStrike.signal} | ${fmtNum(result.bestCallStrike.ltp)}`}
            icon={<TrendingUp size={12} className="text-green-400" />}
            color="border-green-700/50 bg-green-950/30"
          />
        )}
        {result.bestPutStrike && (
          <TopPanelCard
            label="Best Put"
            strike={result.bestPutStrike.strike}
            value={`Score ${fmtNum(result.bestPutStrike.institutionalScore)}`}
            sub={`${result.bestPutStrike.signal} | ${fmtNum(result.bestPutStrike.ltp)}`}
            icon={<TrendingDown size={12} className="text-rose-400" />}
            color="border-rose-700/50 bg-rose-950/30"
          />
        )}
        {result.bestGammaStrike && (
          <TopPanelCard
            label="Best Gamma"
            strike={result.bestGammaStrike.strike}
            value={`γ ${fmtNum(result.bestGammaStrike.gamma, 4)}`}
            sub={`${result.bestGammaStrike.type} | Score ${fmtNum(result.bestGammaStrike.institutionalScore)}`}
            icon={<Zap size={12} className="text-red-400" />}
            color="border-red-700/50 bg-red-950/30"
          />
        )}
        {result.highestOIStrike && (
          <TopPanelCard
            label="Highest OI"
            strike={result.highestOIStrike.strike}
            value={`${fmtOINum(result.highestOIStrike.oi)}`}
            sub={`${result.highestOIStrike.type} | Score ${fmtNum(result.highestOIStrike.institutionalScore)}`}
            icon={<BarChart3 size={12} className="text-blue-400" />}
            color="border-blue-700/50 bg-blue-950/30"
          />
        )}
        {result.highestOIChangeStrike && (
          <TopPanelCard
            label="OI Change"
            strike={result.highestOIChangeStrike.strike}
            value={`${result.highestOIChangeStrike.oiChg > 0 ? "+" : ""}${fmtOINum(result.highestOIChangeStrike.oiChg)}`}
            sub={`${result.highestOIChangeStrike.type} | Score ${fmtNum(result.highestOIChangeStrike.institutionalScore)}`}
            icon={<Activity size={12} className="text-cyan-400" />}
            color="border-cyan-700/50 bg-cyan-950/30"
          />
        )}
        {result.highestVolumeStrike && (
          <TopPanelCard
            label="Highest Vol"
            strike={result.highestVolumeStrike.strike}
            value={`${fmtVol(result.highestVolumeStrike.volume)}`}
            sub={`${result.highestVolumeStrike.type} | Score ${fmtNum(result.highestVolumeStrike.institutionalScore)}`}
            icon={<Droplets size={12} className="text-teal-400" />}
            color="border-teal-700/50 bg-teal-950/30"
          />
        )}
        {result.highestScoreStrike && (
          <TopPanelCard
            label="Top Score"
            strike={result.highestScoreStrike.strike}
            value={`${fmtNum(result.highestScoreStrike.institutionalScore)}`}
            sub={`${result.highestScoreStrike.type} | ${result.highestScoreStrike.signal}`}
            icon={<Shield size={12} className="text-amber-400" />}
            color="border-amber-700/50 bg-amber-950/30"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={14} className="text-green-400" />
            <span className="text-sm font-bold text-white">Top 5 Calls</span>
            <span className="text-[10px] text-gray-500">({ceStrikes.length} total)</span>
          </div>
          <div className="space-y-1.5">
            {result.topCalls.map((s, i) => (
              <ScoreCard key={`ce-${s.strike}`} s={s} maxGamma={maxGamma} maxOI={maxOI} maxVol={maxVol} spot={result.spot} />
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
            {result.topPuts.map((s, i) => (
              <ScoreCard key={`pe-${s.strike}`} s={s} maxGamma={maxGamma} maxOI={maxOI} maxVol={maxVol} spot={result.spot} />
            ))}
          </div>
        </div>
      </div>

      {showHeatmap && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-gray-900 px-3 py-2 border-b border-gray-800">
            <span className="text-xs font-bold text-white">Full Heatmap</span>
            <span className="text-[10px] text-gray-500 ml-2">{uniqueStrikes.length} strikes</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="bg-gray-900 text-gray-400">
                  <th className="px-2 py-1.5 text-left font-medium">Strike</th>
                  <th className="px-2 py-1.5 text-right font-medium">Score</th>
                  <th className="px-2 py-1.5 text-right font-medium">Signal</th>
                  <th className="px-2 py-1.5 text-right font-medium">Gamma</th>
                  <th className="px-2 py-1.5 text-right font-medium">OI</th>
                  <th className="px-2 py-1.5 text-right font-medium">Vol</th>
                  <th className="px-2 py-1.5 text-right font-medium">Dealer</th>
                  <th className="px-2 py-1.5 text-right font-medium">Delta</th>
                  <th className="px-2 py-1.5 text-right font-medium">Theta</th>
                  <th className="px-2 py-1.5 text-right font-medium">Vega</th>
                  <th className="px-2 py-1.5 text-right font-medium">IV</th>
                  <th className="px-2 py-1.5 text-right font-medium">LTP</th>
                  <th className="px-2 py-1.5 text-right font-medium">TP</th>
                  <th className="px-2 py-1.5 text-right font-medium">SL</th>
                  <th className="px-2 py-1.5 text-right font-medium">R:R</th>
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
                      } ${heatBg(s.institutionalScore)}`}
                    >
                      <td className="px-2 py-1 font-mono font-bold text-white">
                        {s.strike}
                        <span className={`ml-1 text-[9px] px-1 rounded ${s.type === "CE" ? "bg-blue-600" : "bg-rose-600"}`}>
                          {s.type}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right font-mono font-bold">{fmtNum(s.institutionalScore)}</td>
                      <td className="px-2 py-1 text-right">
                        <span className={`text-[9px] px-1 py-0.5 rounded ${signalBadge(s.signal)}`}>
                          {s.signal}
                        </span>
                      </td>
                      <td className={`px-2 py-1 text-right font-mono ${gammaHeat(s.gamma, maxGamma)}`}>{fmtNum(s.gamma, 4)}</td>
                      <td className={`px-2 py-1 text-right font-mono ${oiHeat(s.oi, maxOI)}`}>{fmtOINum(s.oi)}</td>
                      <td className={`px-2 py-1 text-right font-mono ${volumeHeat(s.volume, maxVol)}`}>{fmtVol(s.volume)}</td>
                      <td className={`px-2 py-1 text-right font-mono ${dealerHeat(s.dealerPressure)}`}>{s.dealerPressure}</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-300">{fmtNum(s.delta)}</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-300">{fmtNum(s.theta)}</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-300">{fmtNum(s.vega)}</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-300">{fmtNum(s.iv)}%</td>
                      <td className="px-2 py-1 text-right font-mono text-white font-bold">{fmtNum(s.ltp)}</td>
                      <td className="px-2 py-1 text-right font-mono text-green-400">{s.tp > 0 ? fmtNum(s.tp) : "-"}</td>
                      <td className="px-2 py-1 text-right font-mono text-red-400">{s.sl > 0 ? fmtNum(s.sl) : "-"}</td>
                      <td className="px-2 py-1 text-right font-mono text-amber-400">{s.rr > 0 ? fmtNum(s.rr) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex gap-4 text-[10px] text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-emerald-500" /> Score ≥95</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-green-500" /> Score 90-95</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-yellow-500" /> Score 80-90</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-orange-500" /> Score 70-80</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-gray-500" /> Score &lt;70</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-500" /> High Gamma</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-blue-500" /> High OI</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-purple-500" /> Dealer Pressure</span>
      </div>
    </div>
  );
}
