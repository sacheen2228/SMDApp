"use client";

import { useState, useEffect, useCallback } from "react";
import { BarChart3, RefreshCw, Maximize2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

interface OIStrike {
  strike: number;
  callOI: number;
  putOI: number;
  callOIChg: number;
  putOIChg: number;
  isATM: boolean;
}

function formatOI(n: number): string {
  if (n >= 10000000) return (n / 10000000).toFixed(1) + "Cr";
  if (n >= 100000) return (n / 100000).toFixed(1) + "L";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

export function OIHeatmap() {
  const [strikes, setStrikes] = useState<OIStrike[]>([]);
  const [maxPain, setMaxPain] = useState(0);
  const [atmStrike, setAtmStrike] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/option-chain?symbol=NIFTY");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error("No data");

      const allStrikes = json.data?.data || [];
      const spot = json.data?.summary?.spotPrice || json.data?.spotPrice || 0;
      const mp = json.data?.summary?.maxPain || 0;

      // Find ATM
      let closest = allStrikes[0];
      let minDiff = Infinity;
      for (const s of allStrikes) {
        const diff = Math.abs(s.strike - spot);
        if (diff < minDiff) {
          minDiff = diff;
          closest = s;
        }
      }
      const atm = closest?.strike || 0;

      // Take strikes with non-zero OI, sort, take ~21 centered on ATM
      const sorted = [...allStrikes]
        .filter((s: any) => (s.ce?.oi || 0) > 0 || (s.pe?.oi || 0) > 0)
        .sort((a: any, b: any) => a.strike - b.strike);

      const atmIdx = sorted.findIndex((s: any) => s.strike === atm);
      const start = Math.max(0, atmIdx - 10);
      const end = Math.min(sorted.length, start + 21);
      const nearby = sorted.slice(start, end);

      const oiStrikes: OIStrike[] = nearby.map((s: any) => ({
        strike: s.strike,
        callOI: s.ce?.oi || 0,
        putOI: s.pe?.oi || 0,
        callOIChg: s.ce?.oiChg || 0,
        putOIChg: s.pe?.oiChg || 0,
        isATM: s.strike === atm,
      }));

      setStrikes(oiStrikes);
      setMaxPain(mp);
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

  const maxOI = Math.max(
    ...strikes.map((s) => Math.max(s.callOI, s.putOI)),
    1
  );

  return (
    <Card className="bg-[#0d1117] border-white/5 h-full flex flex-col overflow-hidden">
      <CardHeader className="py-2 px-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <BarChart3 className="size-3.5 text-cyan-400" />
            OI Distribution
          </CardTitle>
          <div className="flex items-center gap-2">
            {maxPain > 0 && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-3.5 text-amber-400 border-amber-500/30 font-mono"
              >
                MP {maxPain.toLocaleString("en-IN")}
              </Badge>
            )}
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
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 space-y-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-5 bg-white/5 animate-pulse rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">Data unavailable</div>
        ) : strikes.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">No OI data</div>
        ) : (
          <ScrollArea className="h-full">
            <div className="p-2 space-y-px">
              {/* Legend */}
              <div className="flex items-center justify-between mb-1.5 px-1 text-[8px] text-zinc-500">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-emerald-500/60" /> Call OI
                </span>
                <span className="flex items-center gap-1">
                  Put OI <span className="w-2 h-2 rounded-sm bg-red-500/60" />
                </span>
              </div>

              {strikes.map((s) => {
                const callPct = maxOI > 0 ? (s.callOI / maxOI) * 100 : 0;
                const putPct = maxOI > 0 ? (s.putOI / maxOI) * 100 : 0;
                const isMaxPain = s.strike === maxPain;

                return (
                  <div
                    key={s.strike}
                    className={`flex items-center gap-1 text-[9px] font-mono tabular-nums ${
                      s.isATM ? "bg-amber-500/10 rounded" : ""
                    } ${isMaxPain && !s.isATM ? "bg-violet-500/5 rounded" : ""}`}
                  >
                    {/* Strike label */}
                    <span
                      className={`w-12 text-right shrink-0 pr-1 ${
                        s.isATM
                          ? "text-amber-400 font-bold"
                          : isMaxPain
                          ? "text-violet-400 font-semibold"
                          : "text-zinc-500"
                      }`}
                    >
                      {Math.round(s.strike / 100)}
                    </span>

                    {/* Put OI bar (grows left from center) */}
                    <div className="flex-1 flex justify-end">
                      <div
                        className="h-3.5 bg-red-500/50 rounded-l-sm transition-all duration-300 relative group"
                        style={{ width: `${putPct}%` }}
                      >
                        {/* OI Change indicator */}
                        {s.putOIChg !== 0 && (
                          <div
                            className={`absolute -right-0.5 top-0 bottom-0 w-0.5 rounded-r ${
                              s.putOIChg > 0 ? "bg-red-400" : "bg-emerald-400"
                            }`}
                          />
                        )}
                        <div className="absolute inset-0 flex items-center justify-end pr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <span className="text-[7px] text-white/80 font-semibold">
                            {formatOI(s.putOI)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Center divider / Strike */}
                    <div className="w-8 text-center shrink-0 text-zinc-300 font-semibold text-[9px]">
                      {Math.round(s.strike)}
                    </div>

                    {/* Call OI bar (grows right from center) */}
                    <div className="flex-1">
                      <div
                        className="h-3.5 bg-emerald-500/50 rounded-r-sm transition-all duration-300 relative group"
                        style={{ width: `${callPct}%` }}
                      >
                        {s.callOIChg !== 0 && (
                          <div
                            className={`absolute -left-0.5 top-0 bottom-0 w-0.5 rounded-l ${
                              s.callOIChg > 0 ? "bg-emerald-400" : "bg-red-400"
                            }`}
                          />
                        )}
                        <div className="absolute inset-0 flex items-center pl-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <span className="text-[7px] text-white/80 font-semibold">
                            {formatOI(s.callOI)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* OI Change badge on hover */}
                    <span className="w-10 text-[7px] text-right shrink-0 text-zinc-600">
                      {s.callOIChg > 0 ? "+" : ""}
                      {formatOI(s.callOIChg)}
                    </span>
                  </div>
                );
              })}

              {/* Max Pain marker */}
              {maxPain > 0 && (
                <div className="flex items-center justify-center gap-1 mt-1 text-[8px]">
                  <Maximize2 className="size-2 text-violet-400" />
                  <span className="text-violet-400 font-mono">
                    Max Pain: {maxPain.toLocaleString("en-IN")}
                  </span>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
