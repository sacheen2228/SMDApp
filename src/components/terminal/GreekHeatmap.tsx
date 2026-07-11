"use client";

import { useState, useEffect, useCallback } from "react";
import { Grid3X3, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface StrikeData {
  strike: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

const GREEK_LABELS = ["Delta", "Gamma", "Theta", "Vega", "IV"] as const;
type GreekKey = "delta" | "gamma" | "theta" | "vega" | "iv";

function getGreekColor(greek: string, value: number, strike: number, atmStrike: number): string {
  const isATM = strike === atmStrike;
  const absVal = Math.abs(value);

  switch (greek) {
    case "Delta":
      if (value > 0) {
        const intensity = Math.min(1, absVal);
        return `rgba(16, 185, 129, ${0.15 + intensity * 0.6})`; // green
      } else {
        const intensity = Math.min(1, absVal);
        return `rgba(239, 68, 68, ${0.15 + intensity * 0.6})`; // red
      }
    case "Gamma":
      const gIntensity = Math.min(1, absVal * 200);
      return isATM
        ? `rgba(168, 85, 247, ${0.3 + gIntensity * 0.5})` // purple for ATM
        : `rgba(168, 85, 247, ${0.05 + gIntensity * 0.3})`;
    case "Theta":
      if (value < 0) {
        const intensity = Math.min(1, absVal * 10);
        return `rgba(249, 115, 22, ${0.15 + intensity * 0.5})`; // orange (negative)
      }
      return `rgba(16, 185, 129, 0.15)`;
    case "Vega":
      const vIntensity = Math.min(1, absVal * 50);
      return `rgba(59, 130, 246, ${0.1 + vIntensity * 0.5})`; // blue
    case "IV":
      const ivIntensity = Math.min(1, value / 40);
      return `rgba(234, 179, 8, ${0.1 + ivIntensity * 0.5})`; // yellow
    default:
      return "rgba(255,255,255,0.05)";
  }
}

function formatGreekValue(greek: string, value: number): string {
  switch (greek) {
    case "Delta":
      return value.toFixed(2);
    case "Gamma":
      return value.toFixed(4);
    case "Theta":
      return value.toFixed(2);
    case "Vega":
      return value.toFixed(2);
    case "IV":
      return value.toFixed(1) + "%";
    default:
      return value.toFixed(2);
  }
}

export function GreekHeatmap() {
  const [strikes, setStrikes] = useState<StrikeData[]>([]);
  const [atmStrike, setAtmStrike] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hoveredCell, setHoveredCell] = useState<{
    greek: string;
    strike: number;
    value: number;
    x: number;
    y: number;
  } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/option-chain?symbol=NIFTY");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error("No data");

      const allStrikes = json.data?.data || [];
      const spot = json.data?.summary?.spotPrice || json.data?.spotPrice || 0;

      // Find ATM
      let closestStrike = allStrikes[0];
      let minDiff = Infinity;
      for (const s of allStrikes) {
        const diff = Math.abs(s.strike - spot);
        if (diff < minDiff) {
          minDiff = diff;
          closestStrike = s;
        }
      }
      const atm = closestStrike?.strike || 0;

      // Take ~11 strikes around ATM
      const sorted = [...allStrikes].sort((a: any, b: any) => a.strike - b.strike);
      const atmIdx = sorted.findIndex((s: any) => s.strike === atm);
      const start = Math.max(0, atmIdx - 5);
      const end = Math.min(sorted.length, start + 11);
      const nearby = sorted.slice(start, end);

      const strikeData: StrikeData[] = nearby.map((s: any) => ({
        strike: s.strike,
        delta: s.ce?.delta || 0,
        gamma: s.ce?.gamma || 0,
        theta: s.ce?.theta || 0,
        vega: s.ce?.vega || 0,
        iv: s.ce?.iv || 0,
      }));

      setStrikes(strikeData);
      setAtmStrike(atm);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const greekKeys: GreekKey[] = ["delta", "gamma", "theta", "vega", "iv"];

  return (
    <Card className="bg-[#0d1117] border-white/5 h-full flex flex-col overflow-hidden">
      <CardHeader className="py-2 px-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <Grid3X3 className="size-3.5 text-violet-400" />
            Greek Heatmap
          </CardTitle>
          <button
            onClick={() => {
              setLoading(true);
              fetchData();
            }}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 grid grid-cols-11 gap-px">
            {Array.from({ length: 55 }).map((_, i) => (
              <div key={i} className="h-7 bg-white/5 animate-pulse rounded-sm" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">Data unavailable</div>
        ) : strikes.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">No strike data</div>
        ) : (
          <div className="p-1 overflow-auto">
            {/* Tooltip */}
            {hoveredCell && (
              <div
                className="fixed z-50 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-[10px] font-mono shadow-lg pointer-events-none"
                style={{ left: hoveredCell.x + 10, top: hoveredCell.y - 30 }}
              >
                <span className="text-zinc-400">{hoveredCell.greek}</span>{" "}
                <span className="text-zinc-200">{hoveredCell.strike.toLocaleString("en-IN")}</span>
                <br />
                <span className="text-white font-semibold">
                  {formatGreekValue(hoveredCell.greek, hoveredCell.value)}
                </span>
              </div>
            )}

            {/* Heatmap Grid */}
            <div className="grid gap-px" style={{ gridTemplateColumns: `40px repeat(${strikes.length}, 1fr)` }}>
              {/* Header row: strike labels */}
              <div className="text-[8px] text-zinc-600 flex items-end justify-center" />
              {strikes.map((s) => (
                <div
                  key={s.strike}
                  className={`text-[8px] font-mono tabular-nums text-center py-0.5 ${
                    s.strike === atmStrike
                      ? "text-amber-400 font-bold"
                      : "text-zinc-500"
                  }`}
                >
                  {s.strike >= 1000 ? Math.round(s.strike / 100) : s.strike}
                </div>
              ))}

              {/* Data rows */}
              {GREEK_LABELS.map((greekLabel, gIdx) => (
                <>
                  <div
                    key={`label-${greekLabel}`}
                    className="text-[8px] text-zinc-500 flex items-center justify-end pr-1 font-medium"
                  >
                    {greekLabel}
                  </div>
                  {strikes.map((s) => {
                    const val = s[greekKeys[gIdx]];
                    const bg = getGreekColor(greekLabel, val, s.strike, atmStrike);
                    return (
                      <div
                        key={`${greekLabel}-${s.strike}`}
                        className="h-6 flex items-center justify-center text-[8px] font-mono tabular-nums cursor-default transition-all hover:ring-1 hover:ring-white/20 rounded-sm"
                        style={{ backgroundColor: bg }}
                        onMouseEnter={(e) =>
                          setHoveredCell({
                            greek: greekLabel,
                            strike: s.strike,
                            value: val,
                            x: e.clientX,
                            y: e.clientY,
                          })
                        }
                        onMouseLeave={() => setHoveredCell(null)}
                      >
                        <span className={`${val < 0 ? "text-red-300/80" : "text-zinc-300/80"}`}>
                          {formatGreekValue(greekLabel, val)}
                        </span>
                      </div>
                    );
                  })}
                </>
              ))}
            </div>

            {/* Legend */}
            <div className="flex items-center justify-center gap-3 mt-2 text-[8px] text-zinc-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-emerald-500/40" /> Positive
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-red-500/40" /> Negative
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-violet-500/40" /> Gamma
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-amber-500/40" /> ATM
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
