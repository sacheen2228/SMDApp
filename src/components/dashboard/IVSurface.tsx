"use client";

import { useState, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, ReferenceLine
} from "recharts";

export interface StrikeData {
  strike: number;
  ce: { iv: number; oi: number } | null;
  pe: { iv: number; oi: number } | null;
}

interface IVSurfaceProps {
  strikes: StrikeData[];
  spotPrice: number;
  expiries: string[];
}

function daysToExpiry(expiry: string): number {
  let d = new Date(expiry);
  if (isNaN(d.getTime())) {
    const m = expiry.match(/(\d+)([A-Z]{3})(\d+)/);
    if (m) {
      const months: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
      const ds = `${m[3].length === 4 ? m[3] : "20"+m[3]}-${months[m[2]] || "01"}-${m[1].padStart(2, "0")}`;
      const d2 = new Date(ds);
      if (!isNaN(d2.getTime())) d = d2;
    }
  }
  return Math.max(1, Math.round((d.getTime() - Date.now()) / 86400000));
}

function ivLabel(iv: number, avgIv: number): { label: string; color: string; emoji: string } {
  const ratio = iv / (avgIv || 1);
  if (ratio > 1.3) return { label: "VERY EXPENSIVE", color: "#ef4444", emoji: "🔴" };
  if (ratio > 1.1) return { label: "EXPENSIVE", color: "#f97316", emoji: "🟠" };
  if (ratio > 0.9) return { label: "NORMAL", color: "#22c55e", emoji: "🟢" };
  if (ratio > 0.7) return { label: "CHEAP", color: "#3b82f6", emoji: "🔵" };
  return { label: "VERY CHEAP", color: "#8b5cf6", emoji: "🟣" };
}

function ivToBg(iv: number, minIv: number, maxIv: number): string {
  if (maxIv === minIv) return "rgba(59,130,246,0.3)";
  const t = Math.max(0, Math.min(1, (iv - minIv) / (maxIv - minIv)));
  if (t < 0.2) return "rgba(139,92,246,0.35)";
  if (t < 0.4) return "rgba(59,130,246,0.35)";
  if (t < 0.6) return "rgba(34,197,94,0.35)";
  if (t < 0.8) return "rgba(249,115,22,0.35)";
  return "rgba(239,68,68,0.4)";
}

function ivToBorder(iv: number, minIv: number, maxIv: number): string {
  if (maxIv === minIv) return "#3b82f6";
  const t = Math.max(0, Math.min(1, (iv - minIv) / (maxIv - minIv)));
  if (t < 0.2) return "#8b5cf6";
  if (t < 0.4) return "#3b82f6";
  if (t < 0.6) return "#22c55e";
  if (t < 0.8) return "#f97316";
  return "#ef4444";
}

function moneynessLabel(strike: number, spot: number): string {
  const ratio = strike / spot;
  if (Math.abs(ratio - 1) < 0.005) return "ATM";
  if (ratio < 0.97) return "DITM";
  if (ratio < 1) return "ITM";
  if (ratio < 1.03) return "OTM";
  return "DOTM";
}

function moneynessColor(strike: number, spot: number): string {
  const label = moneynessLabel(strike, spot);
  if (label === "ATM") return "#22d3ee";
  if (label === "ITM" || label === "OTM") return "#a78bfa";
  return "#6b7280";
}

interface TermStructPoint {
  expiry: string;
  label: string;
  atmIv: number;
  fwdIv: number | null;
  dte: number;
}

interface SkewPoint {
  strike: number;
  peRatio: number;
  ceIv: number;
  peIv: number;
}

interface RegimeInfo {
  level: string;
  levelColor: string;
  skew: string;
  skewColor: string;
  termShape: string;
  termColor: string;
  strategy: string;
  strategyColor: string;
}

export default function IVSurface({ strikes, spotPrice, expiries }: IVSurfaceProps) {
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);
  const [tab, setTab] = useState<"heatmap" | "structure">("heatmap");

  const sortedStrikes = useMemo(
    () => [...strikes].filter((s) => s.ce || s.pe).sort((a, b) => a.strike - b.strike),
    [strikes]
  );

  const ivGrid = useMemo(() => {
    const grid: (number | null)[][] = [];
    for (const expiry of expiries) {
      const row: (number | null)[] = [];
      for (const s of sortedStrikes) {
        const ceIv = s.ce?.iv ?? null;
        const peIv = s.pe?.iv ?? null;
        if (ceIv !== null && peIv !== null) row.push((ceIv + peIv) / 2);
        else if (ceIv !== null) row.push(ceIv);
        else if (peIv !== null) row.push(peIv);
        else row.push(null);
      }
      grid.push(row);
    }
    return grid;
  }, [sortedStrikes, expiries]);

  const ivRange = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const row of ivGrid) {
      for (const v of row) {
        if (v !== null) { min = Math.min(min, v); max = Math.max(max, v); }
      }
    }
    if (!isFinite(min)) min = 10;
    if (!isFinite(max)) max = 50;
    if (max === min) max = min + 1;
    return { min, max };
  }, [ivGrid]);

  const avgIv = useMemo(() => {
    let sum = 0, count = 0;
    for (const row of ivGrid) for (const v of row) if (v !== null) { sum += v; count++; }
    return count > 0 ? sum / count : 20;
  }, [ivGrid]);

  const atmIndex = useMemo(() => {
    if (sortedStrikes.length === 0) return 0;
    return sortedStrikes.reduce(
      (best, s, i) => Math.abs(s.strike - spotPrice) < Math.abs(sortedStrikes[best].strike - spotPrice) ? i : best,
      0
    );
  }, [sortedStrikes, spotPrice]);

  const overallLabel = ivLabel(avgIv, avgIv);

  const atmStrike = sortedStrikes[atmIndex]?.strike || 0;

  // OI-weighted IV
  const oiWeightedIv = useMemo(() => {
    let totalIvOi = 0, totalOi = 0;
    for (const s of sortedStrikes) {
      if (s.ce?.iv && s.ce?.oi) { totalIvOi += s.ce.iv * s.ce.oi; totalOi += s.ce.oi; }
      if (s.pe?.iv && s.pe?.oi) { totalIvOi += s.pe.iv * s.pe.oi; totalOi += s.pe.oi; }
    }
    return totalOi > 0 ? totalIvOi / totalOi : avgIv;
  }, [sortedStrikes, avgIv]);

  // Term structure: ATM IV per expiry
  const termStructure = useMemo((): TermStructPoint[] => {
    return expiries.map((expiry, r) => {
      const row = ivGrid[r];
      if (!row) return { expiry, label: expiry.slice(0, 6), atmIv: avgIv, fwdIv: null, dte: 7 * (r + 1) };
      const atmIv = row[atmIndex];
      const dte = daysToExpiry(expiry);
      return { expiry, label: expiry.slice(0, 6), atmIv: atmIv ?? avgIv, fwdIv: null, dte };
    });
  }, [expiries, ivGrid, atmIndex, avgIv]);

  // Forward IV between consecutive expiries
  const forwardIvPoints = useMemo((): TermStructPoint[] => {
    return termStructure.map((p, i) => {
      if (i === 0) return { ...p, fwdIv: null };
      const prev = termStructure[i - 1];
      const t1 = prev.dte / 365;
      const t2 = p.dte / 365;
      const iv1 = prev.atmIv / 100;
      const iv2 = p.atmIv / 100;
      if (t2 <= t1 || iv2 <= 0 || iv1 <= 0) return { ...p, fwdIv: null };
      const fwd = Math.sqrt(Math.max(0, (iv2 * iv2 * t2 - iv1 * iv1 * t1) / (t2 - t1)));
      return { ...p, fwdIv: Math.round(fwd * 10000) / 100 };
    });
  }, [termStructure]);

  // Skew: PE IV / CE IV ratio per strike (nearest expiry)
  const skewPoints = useMemo((): SkewPoint[] => {
    return sortedStrikes.map((s) => {
      const ceIv = s.ce?.iv ?? 0;
      const peIv = s.pe?.iv ?? 0;
      return {
        strike: s.strike,
        peRatio: ceIv > 0 ? peIv / ceIv : 1,
        ceIv,
        peIv,
      };
    });
  }, [sortedStrikes]);

  // ATM skew ratio
  const atmSkewRatio = useMemo(() => {
    const atm = sortedStrikes[atmIndex];
    if (!atm?.ce?.iv || !atm?.pe?.iv) return 1;
    return atm.pe.iv / atm.ce.iv;
  }, [sortedStrikes, atmIndex]);

  // Term structure shape
  const termShape = useMemo((): string => {
    if (termStructure.length < 2) return "flat";
    const first = termStructure[0].atmIv;
    const last = termStructure[termStructure.length - 1].atmIv;
    const diff = last - first;
    if (diff > 2) return "contango";
    if (diff < -2) return "backwardation";
    return "flat";
  }, [termStructure]);

  // IV Regime analysis
  const regime = useMemo((): RegimeInfo => {
    const level = avgIv > 25 ? "HIGH" : avgIv > 15 ? "NORMAL" : "LOW";
    const levelColor = level === "HIGH" ? "#ef4444" : level === "NORMAL" ? "#22c55e" : "#3b82f6";
    const skew = atmSkewRatio > 1.1 ? "PUT SKEW" : atmSkewRatio < 0.95 ? "CALL SKEW" : "NEUTRAL";
    const skewColor = skew === "PUT SKEW" ? "#f97316" : skew === "CALL SKEW" ? "#a78bfa" : "#22c55e";
    const termColor = termShape === "contango" ? "#f97316" : termShape === "backwardation" ? "#3b82f6" : "#6b7280";

    let strategy = "";
    let strategyColor = "#6b7280";

    if (level === "LOW") {
      if (termShape === "contango") {
        strategy = "Long premium (buy options) — low IV expected to rise";
        strategyColor = "#22c55e";
      } else {
        strategy = "Buy options / calendars — IV cheap across board";
        strategyColor = "#22c55e";
      }
    } else if (level === "HIGH") {
      if (skew === "PUT SKEW") {
        strategy = "Sell put spreads — elevated put premium";
        strategyColor = "#ef4444";
      } else {
        strategy = "Sell premium — high IV favors short options";
        strategyColor = "#ef4444";
      }
    } else {
      if (termShape === "backwardation") {
        strategy = "Short-dated sells, long-dated buys — term structure working for you";
        strategyColor = "#f97316";
      } else if (skew === "PUT SKEW") {
        strategy = "Put credit spreads — puts more expensive than calls";
        strategyColor = "#f97316";
      } else {
        strategy = "Neutral — Iron condors / strangles in range-bound market";
        strategyColor = "#6b7280";
      }
    }

    return { level, levelColor, skew, skewColor, termShape: termShape.toUpperCase(), termColor, strategy, strategyColor };
  }, [avgIv, atmSkewRatio, termShape]);

  // skew chart data for recharts — nearest expiry
  const nearestExpirySkew = useMemo(() => {
    if (ivGrid.length === 0) return [];
    return sortedStrikes.map((s, i) => {
      const ceIv = s.ce?.iv ?? 0;
      const peIv = s.pe?.iv ?? 0;
      const avg = ivGrid[0]?.[i] ?? 0;
      return {
        strike: s.strike / 1000,
        iv: avg,
        ceIv,
        peIv,
        peRatio: ceIv > 0 ? +(peIv / ceIv).toFixed(2) : 1,
        isATM: i === atmIndex,
      };
    });
  }, [sortedStrikes, ivGrid, atmIndex]);

  // Term structure data for recharts
  const termChartData = useMemo(() => {
    return forwardIvPoints.map((p) => ({
      label: p.label,
      expiry: p.expiry,
      atmIv: +p.atmIv.toFixed(1),
      fwdIv: p.fwdIv !== null ? +p.fwdIv.toFixed(1) : null,
    }));
  }, [forwardIvPoints]);

  const CustomSkewTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-[#1e222d] border border-[#2a2e39] rounded-lg p-2 text-[10px] font-mono shadow-xl">
        <div className="font-bold text-xs mb-1">Strike {d.strike * 1000}</div>
        <div className="text-muted-foreground">CE IV: {d.ceIv?.toFixed(1)}%</div>
        <div className="text-muted-foreground">PE IV: {d.peIv?.toFixed(1)}%</div>
        <div className="text-muted-foreground">P/C Ratio: {d.peRatio}x</div>
        {d.isATM && <div className="text-cyan-400 font-bold mt-0.5">← ATM</div>}
      </div>
    );
  };

  const CustomTermTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div className="bg-[#1e222d] border border-[#2a2e39] rounded-lg p-2 text-[10px] font-mono shadow-xl">
        <div className="font-bold text-xs mb-1">{label}</div>
        <div className="text-cyan-400">ATM IV: {d?.atmIv}%</div>
        {d?.fwdIv !== null && d?.fwdIv !== undefined && (
          <div className="text-purple-400">Forward IV: {d.fwdIv}%</div>
        )}
      </div>
    );
  };

  if (sortedStrikes.length === 0 || expiries.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm bg-[#131722] rounded-lg">
        No IV data available — connect to Breeze API during market hours
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono font-bold text-sm">IV Surface — Volatility Map</div>
          <div className="text-[10px] text-muted-foreground">Implied volatility across strikes & expiries</div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground">Avg IV</div>
            <div className="font-mono font-bold text-lg" style={{ color: overallLabel.color }}>{avgIv.toFixed(1)}%</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground">OI-Wtd IV</div>
            <div className="font-mono font-bold text-sm" style={{ color: ivLabel(oiWeightedIv, avgIv).color }}>{oiWeightedIv.toFixed(1)}%</div>
          </div>
          <div className="px-3 py-1.5 rounded-lg font-bold text-xs" style={{ background: `${overallLabel.color}20`, color: overallLabel.color, border: `1px solid ${overallLabel.color}40` }}>
            {overallLabel.emoji} {overallLabel.label}
          </div>
        </div>
      </div>

      {/* Regime Summary Cards */}
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-[#131722] border border-[#2a2e39] rounded-lg p-2.5">
          <div className="text-[9px] text-muted-foreground mb-0.5">IV Level</div>
          <div className="font-bold text-sm" style={{ color: regime.levelColor }}>{regime.level}</div>
        </div>
        <div className="bg-[#131722] border border-[#2a2e39] rounded-lg p-2.5">
          <div className="text-[9px] text-muted-foreground mb-0.5">ATM Put/Call Skew</div>
          <div className="font-bold text-sm" style={{ color: regime.skewColor }}>{atmSkewRatio.toFixed(2)}x</div>
          <div className="text-[9px] font-bold" style={{ color: regime.skewColor }}>{regime.skew}</div>
        </div>
        <div className="bg-[#131722] border border-[#2a2e39] rounded-lg p-2.5">
          <div className="text-[9px] text-muted-foreground mb-0.5">Term Structure</div>
          <div className="font-bold text-sm" style={{ color: regime.termColor }}>{regime.termShape}</div>
        </div>
        <div className="bg-[#131722] border border-[#2a2e39] rounded-lg p-2.5">
          <div className="text-[9px] text-muted-foreground mb-0.5">Strategy</div>
          <div className="font-bold text-[11px] leading-tight" style={{ color: regime.strategyColor }}>{regime.strategy}</div>
        </div>
      </div>

      {/* Tab selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab("heatmap")}
          className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${tab === "heatmap" ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30" : "bg-[#131722] text-muted-foreground border border-[#2a2e39] hover:border-cyan-500/30"}`}
        >
          Heatmap Table
        </button>
        <button
          onClick={() => setTab("structure")}
          className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${tab === "structure" ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30" : "bg-[#131722] text-muted-foreground border border-[#2a2e39] hover:border-cyan-500/30"}`}
        >
          Term Structure & Skew
        </button>
      </div>

      {/* Color Legend */}
      <div className="flex items-center gap-3 text-[10px]">
        <span className="text-muted-foreground">IV Level:</span>
        {[
          { label: "Very Cheap", color: "#8b5cf6", emoji: "🟣" },
          { label: "Cheap", color: "#3b82f6", emoji: "🔵" },
          { label: "Normal", color: "#22c55e", emoji: "🟢" },
          { label: "Expensive", color: "#f97316", emoji: "🟠" },
          { label: "Very Expensive", color: "#ef4444", emoji: "🔴" },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-1">
            <div className="w-3 h-3 rounded" style={{ background: item.color, opacity: 0.7 }} />
            <span>{item.emoji} {item.label}</span>
          </div>
        ))}
      </div>

      {tab === "heatmap" ? (
        <>
          {/* Heatmap — HTML table */}
          <div className="overflow-x-auto rounded-lg border border-[#2a2e39] bg-[#131722]">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr>
                  <th className="px-2 py-2 text-left text-muted-foreground border-b border-[#2a2e39] sticky left-0 bg-[#131722] z-10">
                    Expiry ↓ \ Strike →
                  </th>
                  {sortedStrikes.map((s, i) => {
                    const mn = moneynessLabel(s.strike, spotPrice);
                    return (
                      <th
                        key={s.strike}
                        className={`px-2 py-1 text-center border-b border-[#2a2e39] min-w-[60px] ${
                          i === atmIndex ? "text-cyan-400" : "text-muted-foreground"
                        }`}
                      >
                        <div>{s.strike.toLocaleString("en-IN")}</div>
                        <div className="text-[7px] leading-tight" style={{ color: moneynessColor(s.strike, spotPrice) }}>{mn}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {expiries.map((expiry, r) => (
                  <tr key={expiry}>
                    <td className="px-2 py-1.5 text-muted-foreground border-r border-[#2a2e39] sticky left-0 bg-[#131722] z-10 whitespace-nowrap">
                      <div className="font-bold">{expiry.slice(0, 6)}</div>
                      {r === 0 && <div className="text-[8px] text-cyan-400">Nearest</div>}
                    </td>
                    {sortedStrikes.map((s, c) => {
                      const iv = ivGrid[r]?.[c];
                      const isHovered = hoveredCell?.row === r && hoveredCell?.col === c;
                      const isATM = c === atmIndex;
                      if (iv === null || iv === undefined) {
                        return (
                          <td key={s.strike} className="px-1 py-1 text-center text-muted-foreground/30">
                            —
                          </td>
                        );
                      }
                      const cellLabel = ivLabel(iv, avgIv);
                      const ceIv = s.ce?.iv;
                      const peIv = s.pe?.iv;
                      const ceOi = s.ce?.oi;
                      const peOi = s.pe?.oi;
                      return (
                        <td
                          key={s.strike}
                          className="px-1 py-1 text-center cursor-pointer transition-all relative"
                          style={{
                            background: ivToBg(iv, ivRange.min, ivRange.max),
                            borderLeft: `2px solid ${ivToBorder(iv, ivRange.min, ivRange.max)}`,
                            outline: isHovered ? "2px solid white" : isATM ? "1px solid rgba(34,211,238,0.3)" : "none",
                          }}
                          onMouseEnter={() => setHoveredCell({ row: r, col: c })}
                          onMouseLeave={() => setHoveredCell(null)}
                        >
                          <div className="font-bold text-sm">{iv.toFixed(1)}%</div>
                          <div className="text-[8px]" style={{ color: cellLabel.color }}>{cellLabel.label}</div>
                          {isHovered && (ceIv !== undefined || peIv !== undefined) && (
                            <div className="absolute z-20 bg-[#1e222d] border border-[#2a2e39] rounded-lg p-1.5 text-[9px] shadow-xl pointer-events-none"
                              style={{ top: "100%", left: "50%", transform: "translateX(-50%)", minWidth: 100 }}
                            >
                              {ceIv !== null && <div>CE IV: {ceIv?.toFixed(1)}% (OI: {(ceOi || 0).toLocaleString("en-IN")})</div>}
                              {peIv !== null && <div>PE IV: {peIv?.toFixed(1)}% (OI: {(peOi || 0).toLocaleString("en-IN")})</div>}
                              <div className="text-cyan-400 mt-0.5">Avg: {iv.toFixed(1)}%</div>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Skew bar chart — nearest expiry */}
          {nearestExpirySkew.length > 0 && (
            <div className="bg-[#131722] rounded-lg border border-[#2a2e39] p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-mono font-bold text-xs">IV Skew — Volatility Smile</div>
                  <div className="text-[10px] text-muted-foreground">Shows if OTM options are priced higher (smile) or lower (skew) than ATM</div>
                </div>
                <div className="text-[9px] text-muted-foreground">Nearest expiry</div>
              </div>
              <div style={{ height: 140 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={nearestExpirySkew} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2e39" />
                    <XAxis dataKey="strike" tick={{ fontSize: 9, fill: "#9ca3af" }} tickFormatter={(v: number) => `${(v).toFixed(1)}K`} />
                    <YAxis tick={{ fontSize: 9, fill: "#9ca3af" }} unit="%" domain={["auto", "auto"]} width={36} />
                    <Tooltip content={<CustomSkewTooltip />} />
                    <Bar dataKey="iv" name="IV%" radius={[2, 2, 0, 0]}>
                      {nearestExpirySkew.map((entry, idx) => (
                        <rect key={idx} fill={entry.isATM ? "#22d3ee" : ivToBorder(entry.iv, 0, Math.max(...nearestExpirySkew.map(d => d.iv)))} />
                      ))}
                    </Bar>
                    <ReferenceLine x={spotPrice / 1000} stroke="#22d3ee" strokeDasharray="4 2" label={{ value: "SPOT", fill: "#22d3ee", fontSize: 9 }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Term Structure Chart */}
          <div className="bg-[#131722] rounded-lg border border-[#2a2e39] p-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="font-mono font-bold text-xs">ATM IV Term Structure</div>
                <div className="text-[10px] text-muted-foreground">How IV changes across expiries — contango (up) or backwardation (down)</div>
              </div>
              <div className="flex items-center gap-3 text-[9px]">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-0.5 rounded bg-cyan-400" />
                  <span className="text-muted-foreground">ATM IV</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-0.5 rounded bg-purple-400" style={{ borderTop: "2px dashed #a78bfa", height: 0 }} />
                  <span className="text-muted-foreground">Forward IV</span>
                </div>
              </div>
            </div>
            <div style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={termChartData} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2e39" />
                  <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#9ca3af" }} />
                  <YAxis tick={{ fontSize: 9, fill: "#9ca3af" }} unit="%" domain={["auto", "auto"]} width={36} />
                  <Tooltip content={<CustomTermTooltip />} />
                  <Line type="monotone" dataKey="atmIv" stroke="#22d3ee" strokeWidth={2} dot={{ fill: "#22d3ee", r: 4 }} activeDot={{ r: 6 }} name="ATM IV" />
                  <Line type="monotone" dataKey="fwdIv" stroke="#a78bfa" strokeWidth={2} strokeDasharray="6 3" dot={{ fill: "#a78bfa", r: 3 }} name="Forward IV" connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Put/Call Skew by strike — nearest expiry */}
          <div className="bg-[#131722] rounded-lg border border-[#2a2e39] p-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="font-mono font-bold text-xs">Put / Call IV Ratio</div>
                <div className="text-[10px] text-muted-foreground">PE IV ÷ CE IV — values &gt;1 = puts more expensive, &lt;1 = calls more expensive</div>
              </div>
              <div className="text-[9px] text-muted-foreground">Nearest expiry</div>
            </div>
            <div style={{ height: 140 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={nearestExpirySkew} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2e39" />
                  <XAxis dataKey="strike" tick={{ fontSize: 9, fill: "#9ca3af" }} tickFormatter={(v: number) => `${(v).toFixed(1)}K`} />
                  <YAxis tick={{ fontSize: 9, fill: "#9ca3af" }} domain={[0, "auto"]} width={36} />
                  <Tooltip content={<CustomSkewTooltip />} />
                  <Bar dataKey="peRatio" name="P/C Ratio" radius={[2, 2, 0, 0]}>
                    {nearestExpirySkew.map((entry, idx) => {
                      let fill = "#22c55e";
                      if (entry.peRatio > 1.15) fill = "#ef4444";
                      else if (entry.peRatio > 1.05) fill = "#f97316";
                      else if (entry.peRatio < 0.9) fill = "#3b82f6";
                      if (entry.isATM) fill = "#22d3ee";
                      return <rect key={idx} fill={fill} />;
                    })}
                  </Bar>
                  <ReferenceLine y={1} stroke="#6b7280" strokeDasharray="4 2" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}

      {/* Explanation cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
          <div className="text-[11px] font-bold text-emerald-400 mb-1">🟢 CHEAP = Buy Options</div>
          <div className="text-[10px] text-muted-foreground">
            Low IV means options are underpriced. Premium is low. Good to buy calls/puts.
            {regime.level === "LOW" && <span className="text-emerald-400 block mt-0.5">Current regime confirms: {regime.strategy}</span>}
          </div>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <div className="text-[11px] font-bold text-red-400 mb-1">🔴 EXPENSIVE = Sell Options</div>
          <div className="text-[10px] text-muted-foreground">
            High IV means options are overpriced. Collect high premium by selling.
            {regime.level === "HIGH" && <span className="text-red-400 block mt-0.5">Current regime confirms: {regime.strategy}</span>}
          </div>
        </div>
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
          <div className="text-[11px] font-bold text-blue-400 mb-1">📐 Skew & Term Structure</div>
          <div className="text-[10px] text-muted-foreground">
            Put/Call skew tells you which side is expensive. Term structure shows IV direction.
            {termShape === "backwardation" && <span className="text-blue-400 block mt-0.5">Near-term IV &gt; longer-term — sell front, buy back</span>}
            {termShape === "contango" && <span className="text-orange-400 block mt-0.5">Longer-term IV &gt; near-term — buy front, sell back</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
