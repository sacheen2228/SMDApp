"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, TrendingUp, TrendingDown, Gauge, Activity, Volume2 } from "lucide-react";
import { DataFreshnessBadge, UnavailableCard } from "./DataFreshnessBadge";

export function MarketBreadth({ breadthData }: { breadthData?: any }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["market-breadth"],
    queryFn: () => fetch("/api/market/breadth").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "breadth failed");
      return json;
    }),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: !breadthData,
  });

  const dataWithDefault = breadthData ?? data;

  if (isLoading || !dataWithDefault) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-4">
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-zinc-800 rounded w-1/3" />
            <div className="h-8 bg-zinc-800 rounded w-1/2" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // A failed feed must NOT render as "0 breadth / 0 advances".
  if (!dataWithDefault.breadth || dataWithDefault.status === "UNAVAILABLE") {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
            <BarChart3 className="h-3 w-3" />
            MARKET BREADTH
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <UnavailableCard
            title="Market breadth"
            reason={dataWithDefault.error}
            meta={dataWithDefault.data}
          />
        </CardContent>
      </Card>
    );
  }

  const b = dataWithDefault.breadth || {};
  const breadthScore = b.score ?? null;
  const breadthColor = breadthScore == null ? "text-zinc-500" : breadthScore >= 70 ? "text-emerald-400" :
    breadthScore >= 50 ? "text-yellow-400" : "text-red-400";
  // "—" for a metric the feed could not compute (never 0).
  const show = (v: any) => (v == null ? "—" : v);
  const pctText = (v: any) => (v == null ? "—" : `${v}%`);

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <BarChart3 className="h-3 w-3" />
          MARKET BREADTH
          <DataFreshnessBadge meta={dataWithDefault.data} className="ml-1" showReason />
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {/* Breadth Score */}
        <div className="text-center mb-4">
          <div className={`text-3xl font-black ${breadthColor}`}>{show(breadthScore)}</div>
          <div className="text-[10px] text-zinc-500">/100</div>
          <Badge className={`mt-1 text-xs ${
            breadthScore == null ? "bg-zinc-500/20 text-zinc-400" :
            breadthScore >= 70 ? "bg-emerald-500/20 text-emerald-400" :
            breadthScore >= 50 ? "bg-yellow-500/20 text-yellow-400" :
            "bg-red-500/20 text-red-400"
          }`}>
            {b.label || "NO DATA"}
          </Badge>
          {dataWithDefault.data?.coverage ? (
            <div className="text-[9px] text-zinc-500 mt-1">
              {dataWithDefault.data.coverage.technicals}/{dataWithDefault.data.coverage.requested} symbols with real EMA/VWAP history
            </div>
          ) : null}
        </div>

        {/* Advance/Decline */}
        <div className="space-y-2 mb-3">
          <div className="flex justify-between items-center text-xs">
            <span className="text-zinc-500">Advances</span>
            <span className="text-emerald-400 font-bold">{show(b.advances)}</span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${b.total ? ((b.advances || 0) / b.total) * 100 : 0}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-zinc-500">Declines</span>
            <span className="text-red-400 font-bold">{show(b.declines)}</span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-red-500 rounded-full transition-all"
              style={{ width: `${b.total ? ((b.declines || 0) / b.total) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-3 gap-2 text-xs mb-3">
          <div className="flex justify-between">
            <span className="text-zinc-500">A/D Ratio</span>
            <span className="font-bold">{show(b.adRatio)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Vol Ratio</span>
            <span className="font-bold">{b.volRatio == null ? "—" : `${b.volRatio}x`}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Score</span>
            <span className={`font-bold ${breadthColor}`}>{show(breadthScore)}/100</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">52W Highs</span>
            <span className="text-emerald-400 font-bold">{show(b.newHighs)} ({pctText(b.newHighsPct)})</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">52W Lows</span>
            <span className="text-red-400 font-bold">{show(b.newLows)} ({pctText(b.newLowsPct)})</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Day Highs/Lows</span>
            <span className="font-bold">{show(b.freshDayHighs)} / {show(b.freshDayLows)}</span>
          </div>
        </div>

        {/* EMA / VWAP / Relative Volume */}
        <div className="space-y-2 mb-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 flex items-center gap-1"><Gauge className="h-3 w-3" /> EMA Participation</span>
            <Badge variant="outline" className={`text-[9px] ${b.aboveEMA20Pct == null ? "text-zinc-500" : b.aboveEMA20Pct >= 70 ? "text-emerald-400" : b.aboveEMA20Pct >= 50 ? "text-yellow-400" : "text-red-400"}`}>
              {pctText(b.aboveEMA20Pct) + " > EMA20"}
            </Badge>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${b.aboveEMA20Pct ?? 0}%` }} />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 flex items-center gap-1"><Activity className="h-3 w-3" /> VWAP Participation</span>
            <Badge variant="outline" className={`text-[9px] ${b.aboveVWAPPct == null ? "text-zinc-500" : b.aboveVWAPPct >= 70 ? "text-emerald-400" : b.aboveVWAPPct >= 50 ? "text-yellow-400" : "text-red-400"}`}>
              {pctText(b.aboveVWAPPct) + " > VWAP"}
            </Badge>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${b.aboveVWAPPct ?? 0}%` }} />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 flex items-center gap-1"><Volume2 className="h-3 w-3" /> Relative Volume</span>
            <Badge variant="outline" className={`text-[9px] ${b.highRelVolPct == null ? "text-zinc-500" : b.highRelVolPct >= 30 ? "text-emerald-400" : b.highRelVolPct >= 15 ? "text-yellow-400" : "text-red-400"}`}>
              {pctText(b.highRelVolPct) + " > 2x RVOL"}
            </Badge>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-orange-500 rounded-full transition-all" style={{ width: `${b.highRelVolPct ?? 0}%` }} />
          </div>
        </div>

        {/* Detailed Stats */}
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div className="bg-zinc-900/50 rounded p-2">
            <div className="text-zinc-500 mb-1">EMA Participation</div>
            <div className="flex justify-between text-[9px]">
              <span>EMA 20</span>
              <span className="font-bold">{pctText(b.aboveEMA20Pct)}</span>
            </div>
            <div className="flex justify-between text-[9px]">
              <span>EMA 50</span>
              <span className="font-bold">{pctText(b.aboveEMA50Pct)}</span>
            </div>
            <div className="flex justify-between text-[9px]">
              <span>EMA 200</span>
              <span className="font-bold">{pctText(b.aboveEMA200Pct)}</span>
            </div>
          </div>

          <div className="bg-zinc-900/50 rounded p-2">
            <div className="text-zinc-500 mb-1">Relative Volume</div>
            <div className="flex justify-between text-[9px]"><span>{"> 2x"}</span><span className="font-bold text-emerald-400">{show(b.highRelVol)} ({pctText(b.highRelVolPct)})</span></div>
            <div className="flex justify-between text-[9px]"><span>{"1.5-2x"}</span><span className="font-bold text-yellow-400">{show(b.elevatedRelVol)}</span></div>
            <div className="flex justify-between text-[9px]"><span>{"0.8-1.5x"}</span><span className="font-bold">{show(b.normalRelVol)}</span></div>
            <div className="flex justify-between text-[9px]"><span>{"< 0.8x"}</span><span className="font-bold text-red-400">{show(b.lowRelVol)}</span></div>
          </div>

          <div className="bg-zinc-900/50 rounded p-2">
            <div className="text-zinc-500 mb-1">Score Breakdown</div>
            <div className="flex justify-between text-[9px]"><span>A/D</span><span className="font-bold">{show(b.adScore)}</span></div>
            <div className="flex justify-between text-[9px]"><span>Volume</span><span className="font-bold">{show(b.volScore)}</span></div>
            <div className="flex justify-between text-[9px]"><span>High/Low</span><span className="font-bold">{show(b.highLowScore)}</span></div>
            <div className="flex justify-between text-[9px]"><span>EMA</span><span className="font-bold">{show(b.emaScore)}</span></div>
            <div className="flex justify-between text-[9px]"><span>VWAP</span><span className="font-bold">{show(b.vwapScore)}</span></div>
            <div className="flex justify-between text-[9px]"><span>Rel Vol</span><span className="font-bold">{show(b.relVolScore)}</span></div>
          </div>
        </div>

        {/* Top movers */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-zinc-500 mb-1 flex items-center gap-1"><TrendingUp className="h-3 w-3" /> TOP GAINERS</div>
            {data.topGainers?.slice(0, 3).map((s: any) => (
              <div key={s.symbol} className="flex justify-between text-[10px]">
                <span className="text-zinc-400">{s.symbol}</span>
                <span className="text-emerald-400">+{s.changePct}%</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 mb-1 flex items-center gap-1"><TrendingDown className="h-3 w-3" /> TOP LOSERS</div>
            {data.topLosers?.slice(0, 3).map((s: any) => (
              <div key={s.symbol} className="flex justify-between text-[10px]">
                <span className="text-zinc-400">{s.symbol}</span>
                <span className="text-red-400">{s.changePct}%</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}