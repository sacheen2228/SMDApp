"use client";

import { useState, useEffect, useCallback } from "react";
import { Grid3X3, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReactECharts from "echarts-for-react";

interface StrikeData {
  strike: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

const GREEK_LABELS = ["Delta", "Gamma", "Theta", "Vega", "IV"];

function normalizeGreek(greek: string, value: number): number {
  switch (greeks.indexOf(greek)) {
    case 0: return Math.max(-1, Math.min(1, value)); // Delta: -1..1
    case 1: return Math.max(-1, Math.min(1, value * 200)); // Gamma: scale
    case 2: return Math.max(-1, Math.min(1, value * 5)); // Theta: scale
    case 3: return Math.max(-1, Math.min(1, value * 10)); // Vega: scale
    case 4: return Math.max(-1, Math.min(1, (value - 20) / 30)); // IV: center at 20%
    default: return value;
  }
}

const greeks = ["Delta", "Gamma", "Theta", "Vega", "IV"];

export function GreekHeatmapECharts() {
  const [strikes, setStrikes] = useState<StrikeData[]>([]);
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

      const sorted = [...allStrikes].sort((a: any, b: any) => a.strike - b.strike);
      const atmIdx = sorted.findIndex((s: any) => s.strike === atm);
      const start = Math.max(0, atmIdx - 10);
      const end = Math.min(sorted.length, start + 21);
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

  const strikeLabels = strikes.map((s) =>
    s.strike >= 1000 ? Math.round(s.strike / 100).toString() : s.strike.toString()
  );

  // Build heatmap data: [greekIndex, strikeIndex, normalizedValue]
  const heatmapData: [number, number, number, string][] = [];
  for (let gIdx = 0; gIdx < GREEK_LABELS.length; gIdx++) {
    for (let sIdx = 0; sIdx < strikes.length; sIdx++) {
      const s = strikes[sIdx];
      const rawVal = [s.delta, s.gamma, s.theta, s.vega, s.iv][gIdx];
      const normVal = normalizeGreek(GREEK_LABELS[gIdx], rawVal);
      const displayVal = GREEK_LABELS[gIdx] === "IV"
        ? rawVal.toFixed(1) + "%"
        : rawVal.toFixed(4);
      heatmapData.push([gIdx, sIdx, Math.round(normVal * 100) / 100, displayVal]);
    }
  }

  // ATM marker index
  const atmStrikeIdx = strikes.findIndex((s) => s.strike === atmStrike);

  const option = {
    tooltip: {
      position: "top" as const,
      backgroundColor: "#161b22",
      borderColor: "#30363d",
      textStyle: { color: "#c9d1d9", fontSize: 11, fontFamily: "monospace" },
      formatter: (params: any) => {
        const [greekIdx, strikeIdx, , displayVal] = params.data;
        const greekName = GREEK_LABELS[greekIdx] || "";
        const strikeVal = strikes[strikeIdx]?.strike || 0;
        return `<div style="font-size:10px"><b style="color:#58a6ff">${greekName}</b> @ <b>${strikeVal.toLocaleString("en-IN")}</b><br/><span style="color:#f0f6fc;font-size:12px">${displayVal}</span></div>`;
      },
    },
    grid: {
      top: 10,
      right: 15,
      bottom: 50,
      left: 55,
      containLabel: false,
    },
    xAxis: {
      type: "category" as const,
      data: strikeLabels,
      splitArea: { show: false },
      axisLabel: {
        color: "#8b949e",
        fontSize: 9,
        fontFamily: "monospace",
        rotate: 45,
        interval: strikes.length > 15 ? Math.floor(strikes.length / 10) : 0,
      },
      axisLine: { lineStyle: { color: "#21262d" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category" as const,
      data: GREEK_LABELS,
      splitArea: { show: false },
      axisLabel: { color: "#8b949e", fontSize: 10, fontFamily: "monospace" },
      axisLine: { lineStyle: { color: "#21262d" } },
      axisTick: { show: false },
    },
    visualMap: {
      min: -1,
      max: 1,
      calculable: false,
      orient: "horizontal" as const,
      left: "center",
      bottom: 0,
      itemWidth: 12,
      itemHeight: 100,
      text: ["+", "-"],
      textStyle: { color: "#8b949e", fontSize: 9 },
      inRange: {
        color: [
          "#da3633",
          "#f85149",
          "#ffa198",
          "#ffc8c0",
          "#f6f8fa",
          "#aff5b4",
          "#56d364",
          "#3fb950",
          "#238636",
          "#1a7f37",
        ],
      },
    },
    series: [
      {
        name: "Greeks",
        type: "heatmap",
        data: heatmapData.map((d) => [d[0], d[1], d[2]]),
        label: {
          show: strikes.length <= 21,
          fontSize: 8,
          fontFamily: "monospace",
          color: "#c9d1d9",
          formatter: (params: any) => {
            const d = heatmapData[params.dataIndex];
            return d ? d[3] : "";
          },
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: "rgba(0, 0, 0, 0.5)",
            borderColor: "#58a6ff",
            borderWidth: 1,
          },
        },
        itemStyle: {
          borderColor: "#0d1117",
          borderWidth: 1,
          borderRadius: 2,
        },
        // ATM markLine
        ...(atmStrikeIdx >= 0
          ? {
              markLine: {
                silent: true,
                symbol: ["none", "none"],
                lineStyle: {
                  color: "#f0883e",
                  type: "dashed" as const,
                  width: 1.5,
                },
                data: [
                  {
                    xAxis: atmStrikeIdx,
                    label: {
                      show: true,
                      formatter: "ATM",
                      color: "#f0883e",
                      fontSize: 9,
                      fontFamily: "monospace",
                      position: "insideEndTop" as const,
                    },
                  },
                ],
              },
            }
          : {}),
      },
    ],
  };

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
      <CardContent className="p-1 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 grid grid-cols-11 gap-px">
            {Array.from({ length: 55 }).map((_, i) => (
              <div key={i} className="h-7 bg-white/5 animate-pulse rounded-sm" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            Data unavailable
          </div>
        ) : strikes.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            No strike data
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
