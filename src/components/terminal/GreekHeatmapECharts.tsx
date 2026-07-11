"use client";

import { useState, useEffect, useCallback } from "react";
import { Grid3X3, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ReactECharts from "echarts-for-react";
import { useTerminalStore } from "@/stores/useTerminalStore";

interface StrikeData {
  strike: number;
  ceDelta: number;
  ceGamma: number;
  ceTheta: number;
  ceVega: number;
  ceIV: number;
  peDelta: number;
  peGamma: number;
  peTheta: number;
  peVega: number;
  peIV: number;
}

const GREEK_LABELS = ["Delta", "Gamma", "Theta", "Vega", "IV"];

function normalizeGreek(greek: string, value: number): number {
  const idx = GREEK_LABELS.indexOf(greek);
  switch (idx) {
    case 0: return Math.max(-1, Math.min(1, value));
    case 1: return Math.max(-1, Math.min(1, value * 200));
    case 2: return Math.max(-1, Math.min(1, value * 5));
    case 3: return Math.max(-1, Math.min(1, value * 10));
    case 4: return Math.max(-1, Math.min(1, (value - 20) / 30));
    default: return value;
  }
}

export function GreekHeatmapECharts() {
  const { symbol, expiry } = useTerminalStore();
  const [strikes, setStrikes] = useState<StrikeData[]>([]);
  const [atmStrike, setAtmStrike] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [side, setSide] = useState<"CE" | "PE">("CE");

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ symbol });
      if (expiry) params.set('expiry', expiry);
      const res = await fetch(`/api/option-chain?${params.toString()}`);
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
        ceDelta: s.ce?.delta || 0,
        ceGamma: s.ce?.gamma || 0,
        ceTheta: s.ce?.theta || 0,
        ceVega: s.ce?.vega || 0,
        ceIV: s.ce?.iv || 0,
        peDelta: s.pe?.delta || 0,
        peGamma: s.pe?.gamma || 0,
        peTheta: s.pe?.theta || 0,
        peVega: s.pe?.vega || 0,
        peIV: s.pe?.iv || 0,
      }));

      setStrikes(strikeData);
      setAtmStrike(atm);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [symbol, expiry]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const strikeLabels = strikes.map((s) =>
    s.strike >= 1000 ? Math.round(s.strike / 100).toString() : s.strike.toString()
  );

  const prefix = side === "CE" ? "ce" : "pe";

  const heatmapData: [number, number, number, string][] = [];
  for (let gIdx = 0; gIdx < GREEK_LABELS.length; gIdx++) {
    for (let sIdx = 0; sIdx < strikes.length; sIdx++) {
      const s = strikes[sIdx];
      const rawVal = [s[`${prefix}Delta` as keyof StrikeData], s[`${prefix}Gamma` as keyof StrikeData], s[`${prefix}Theta` as keyof StrikeData], s[`${prefix}Vega` as keyof StrikeData], s[`${prefix}IV` as keyof StrikeData]][gIdx];
      const normVal = normalizeGreek(GREEK_LABELS[gIdx], rawVal);
      const displayVal = GREEK_LABELS[gIdx] === "IV"
        ? rawVal.toFixed(1) + "%"
        : rawVal.toFixed(4);
      heatmapData.push([gIdx, sIdx, Math.round(normVal * 100) / 100, displayVal]);
    }
  }

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
        return `<div style="font-size:10px"><b style="color:#58a6ff">${side} ${greekName}</b> @ <b>${strikeVal.toLocaleString("en-IN")}</b><br/><span style="color:#f0f6fc;font-size:12px">${displayVal}</span></div>`;
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
          <div className="flex items-center gap-2">
            <div className="flex bg-white/5 rounded overflow-hidden border border-white/10">
              <button
                onClick={() => setSide("CE")}
                className={`px-2 py-0.5 text-[10px] font-mono font-semibold transition-colors ${
                  side === "CE"
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                CE
              </button>
              <button
                onClick={() => setSide("PE")}
                className={`px-2 py-0.5 text-[10px] font-mono font-semibold transition-colors ${
                  side === "PE"
                    ? "bg-red-500/20 text-red-400"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                PE
              </button>
            </div>
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
