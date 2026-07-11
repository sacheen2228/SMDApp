"use client";

import { useState, useEffect, useCallback } from "react";
import { BarChart3, RefreshCw, Maximize2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ReactECharts from "echarts-for-react";

interface OIStrike {
  strike: number;
  callOI: number;
  putOI: number;
  callOIChg: number;
  putOIChg: number;
}

function formatOI(n: number): string {
  if (n >= 10000000) return (n / 10000000).toFixed(1) + "Cr";
  if (n >= 100000) return (n / 100000).toFixed(1) + "L";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

export function OIHeatmapECharts() {
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

  const strikeLabels = strikes.map((s) => {
    const label = s.strike >= 1000 ? Math.round(s.strike / 100).toString() : s.strike.toString();
    return label;
  });

  // Max pain index
  const maxPainIdx = maxPain > 0 ? strikes.findIndex((s) => s.strike === maxPain) : -1;

  // ATM index
  const atmIdx = strikes.findIndex((s) => s.strike === atmStrike);

  const option = {
    tooltip: {
      trigger: "axis" as const,
      axisPointer: { type: "shadow" as const },
      backgroundColor: "#161b22",
      borderColor: "#30363d",
      textStyle: { color: "#c9d1d9", fontSize: 10, fontFamily: "monospace" },
      formatter: (params: any) => {
        if (!params || params.length === 0) return "";
        const idx = params[0].dataIndex;
        const s = strikes[idx];
        if (!s) return "";
        return `<div style="font-size:10px;font-family:monospace">
          <b style="color:#f0883e">${s.strike.toLocaleString("en-IN")}</b>${idx === atmIdx ? ' <span style="color:#f0883e">[ATM]</span>' : ""}
          <br/><span style="color:#3fb950">CE OI: ${formatOI(s.callOI)}</span>
          <span style="color:#484f58"> | </span>
          <span style="color:#f85149">PE OI: ${formatOI(s.putOI)}</span>
          <br/>CE Chg: <span style="color:#3fb950">${s.callOIChg > 0 ? "+" : ""}${formatOI(s.callOIChg)}</span>
          <span style="color:#484f58"> | </span>
          PE Chg: <span style="color:#f85149">${s.putOIChg > 0 ? "+" : ""}${formatOI(s.putOIChg)}</span>
          ${s.strike === maxPain ? '<br/><span style="color:#a855f7">★ MAX PAIN</span>' : ""}
        </div>`;
      },
    },
    grid: {
      top: 15,
      right: 15,
      bottom: 25,
      left: 15,
      containLabel: true,
    },
    xAxis: {
      type: "category" as const,
      data: strikeLabels,
      axisLabel: {
        color: (value: string, idx: number) => {
          if (strikes[idx]?.strike === atmStrike) return "#f0883e";
          if (strikes[idx]?.strike === maxPain) return "#a855f7";
          return "#8b949e";
        },
        fontSize: 9,
        fontFamily: "monospace",
        rotate: strikes.length > 15 ? 45 : 0,
        interval: strikes.length > 15 ? Math.floor(strikes.length / 8) : 0,
      },
      axisLine: { lineStyle: { color: "#21262d" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value" as const,
      axisLabel: {
        color: "#8b949e",
        fontSize: 9,
        fontFamily: "monospace",
        formatter: (v: number) => formatOI(Math.abs(v)),
      },
      splitLine: { lineStyle: { color: "#21262d", type: "dashed" as const } },
      axisLine: { show: false },
    },
    series: [
      {
        name: "Call OI",
        type: "bar",
        stack: "oi",
        data: strikes.map((s) => s.callOI),
        itemStyle: {
          color: {
            type: "linear" as const,
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: "#3fb950" },
              { offset: 1, color: "#238636" },
            ],
          },
          borderRadius: [2, 2, 0, 0],
        },
        emphasis: {
          itemStyle: { color: "#56d364" },
        },
        barMaxWidth: 20,
      },
      {
        name: "Put OI",
        type: "bar",
        stack: "oi",
        data: strikes.map((s) => -s.putOI),
        itemStyle: {
          color: {
            type: "linear" as const,
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: "#f85149" },
              { offset: 1, color: "#da3633" },
            ],
          },
          borderRadius: [0, 0, 2, 2],
        },
        emphasis: {
          itemStyle: { color: "#ff7b72" },
        },
        barMaxWidth: 20,
      },
      // OI Change overlay (small dots)
      {
        name: "CE OI Chg",
        type: "bar",
        stack: "oi",
        data: strikes.map((s) => Math.abs(s.callOIChg) * 0.3),
        barWidth: 4,
        itemStyle: {
          color: "rgba(63, 185, 80, 0.6)",
          borderRadius: [1, 1, 0, 0],
        },
        silent: true,
      },
      {
        name: "PE OI Chg",
        type: "bar",
        stack: "oi",
        data: strikes.map((s) => -Math.abs(s.putOIChg) * 0.3),
        barWidth: 4,
        itemStyle: {
          color: "rgba(248, 81, 73, 0.6)",
          borderRadius: [0, 0, 1, 1],
        },
        silent: true,
      },
    ],
    // Max pain vertical dashed line
    ...(maxPainIdx >= 0
      ? {
          markLine: {
            silent: true,
            symbol: ["none", "none"],
            lineStyle: {
              color: "#a855f7",
              type: "dashed" as const,
              width: 1.5,
            },
            data: [
              {
                xAxis: maxPainIdx,
                label: {
                  show: true,
                  formatter: "Max Pain",
                  color: "#a855f7",
                  fontSize: 9,
                  fontFamily: "monospace",
                  position: "insideEndTop" as const,
                },
              },
            ],
          },
        }
      : {}),
  };

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
                className="text-[9px] px-1.5 py-0 h-3.5 text-purple-400 border-purple-500/30 font-mono"
              >
                <Maximize2 className="size-2 mr-0.5" />
                MP {maxPain.toLocaleString("en-IN")}
              </Badge>
            )}
            {atmStrike > 0 && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-3.5 text-amber-400 border-amber-500/30 font-mono"
              >
                ATM {atmStrike.toLocaleString("en-IN")}
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
      <CardContent className="p-1 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 space-y-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-6 bg-white/5 animate-pulse rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            Data unavailable
          </div>
        ) : strikes.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            No OI data
          </div>
        ) : (
          <ReactECharts
            option={option}
            style={{ height: "100%", width: "100%" }}
            opts={{ renderer: "canvas" }}
            theme="dark"
          />
        )}
      </CardContent>
    </Card>
  );
}
