"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";

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

export default function IVSurface({ strikes, spotPrice, expiries }: IVSurfaceProps) {
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);

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

  const skewData = useMemo(() => {
    if (ivGrid.length === 0) return [];
    return sortedStrikes.map((s, i) => ({ strike: s.strike, iv: ivGrid[0][i] })).filter((d) => d.iv !== null);
  }, [sortedStrikes, ivGrid]);

  const overallLabel = ivLabel(avgIv, avgIv);

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
          <div className="text-[10px] text-muted-foreground">Shows how expensive options are across strikes and expiries</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground">Average IV</div>
            <div className="font-mono font-bold text-lg" style={{ color: overallLabel.color }}>{avgIv.toFixed(1)}%</div>
          </div>
          <div className="px-3 py-1.5 rounded-lg font-bold text-xs" style={{ background: `${overallLabel.color}20`, color: overallLabel.color, border: `1px solid ${overallLabel.color}40` }}>
            {overallLabel.emoji} {overallLabel.label}
          </div>
        </div>
      </div>

      {/* Color Legend — plain English */}
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

      {/* Heatmap — HTML table for readability */}
      <div className="overflow-x-auto rounded-lg border border-[#2a2e39] bg-[#131722]">
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr>
              <th className="px-2 py-2 text-left text-muted-foreground border-b border-[#2a2e39] sticky left-0 bg-[#131722] z-10">
                Expiry ↓ \ Strike →
              </th>
              {sortedStrikes.map((s, i) => (
                <th
                  key={s.strike}
                  className={`px-2 py-2 text-center border-b border-[#2a2e39] min-w-[60px] ${
                    i === atmIndex ? "text-cyan-400 font-bold" : "text-muted-foreground"
                  }`}
                >
                  {s.strike.toLocaleString("en-IN")}
                  {i === atmIndex && <div className="text-[8px] text-cyan-400">ATM</div>}
                </th>
              ))}
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
                  return (
                    <td
                      key={s.strike}
                      className="px-1 py-1 text-center cursor-pointer transition-all"
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
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* IV Skew — Smile chart */}
      {skewData.length > 0 && (
        <div className="bg-[#131722] rounded-lg border border-[#2a2e39] p-4">
          <div className="font-mono font-bold text-xs mb-1">IV Skew — Volatility Smile</div>
          <div className="text-[10px] text-muted-foreground mb-3">
            Shows if OTM options are priced higher (smile) or lower (skew) than ATM
          </div>
          <div className="flex items-end gap-1" style={{ height: 120 }}>
            {skewData.map((d, i) => {
              const maxIv = Math.max(...skewData.map((x) => x.iv || 0));
              const minIv = Math.min(...skewData.map((x) => x.iv || 0));
              const range = maxIv - minIv || 1;
              const height = ((d.iv - minIv) / range) * 80 + 20;
              const isATM = d.strike === sortedStrikes[atmIndex]?.strike;
              const label = ivLabel(d.iv, avgIv);
              const barHovered = hoveredCell?.col === i;
              return (
                <div key={d.strike} className="flex-1 flex flex-col items-center gap-1">
                  <div className="text-[9px] font-bold" style={{ color: label.color }}>{d.iv.toFixed(1)}%</div>
                  <div
                    className="w-full rounded-t transition-all"
                    style={{
                      height: `${height}px`,
                      background: isATM ? "#22d3ee" : ivToBorder(d.iv, minIv, maxIv),
                      opacity: barHovered ? 1 : 0.7,
                      border: isATM ? "2px solid #22d3ee" : "none",
                    }}
                  />
                  <div className={`text-[8px] ${isATM ? "text-cyan-400 font-bold" : "text-muted-foreground"}`}>
                    {d.strike.toLocaleString("en-IN")}
                  </div>
                  {isATM && <div className="text-[7px] text-cyan-400">ATM</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Explanation cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
          <div className="text-[11px] font-bold text-emerald-400 mb-1">🟢 CHEAP = Good to Buy</div>
          <div className="text-[10px] text-muted-foreground">
            Low IV means options are underpriced. Good time to buy calls/puts. Premium is small, so risk is low.
          </div>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <div className="text-[11px] font-bold text-red-400 mb-1">🔴 EXPENSIVE = Good to Sell</div>
          <div className="text-[10px] text-muted-foreground">
            High IV means options are overpriced. Good time to sell/write options. Collect high premium.
          </div>
        </div>
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
          <div className="text-[11px] font-bold text-blue-400 mb-1">🔵 SMILE = Normal Market</div>
          <div className="text-[10px] text-muted-foreground">
            U-shaped curve is normal. Both OTM calls and puts cost more. Flat or inverted = unusual.
          </div>
        </div>
      </div>
    </div>
  );
}
