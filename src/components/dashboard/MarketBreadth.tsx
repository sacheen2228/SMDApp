"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, TrendingUp, TrendingDown, Minus, Gauge, Activity, Volume2, Moving } from "lucide-react";

export function MarketBreadth() {
  const { data, isLoading } = useQuery({
    queryKey: ["market-breadth"],
    queryFn: () => fetch("/api/market/breadth").then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading || !data) {
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

  const b = data.breadth || {};
  const breadthScore = b.score || 0;
  const breadthColor = breadthScore >= 70 ? "text-emerald-400" :
    breadthScore >= 50 ? "text-yellow-400" : "text-red-400";

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <BarChart3 className="h-3 w-3" />
          MARKET BREADTH
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {/* Breadth Score */}
        <div className="text-center mb-4">
          <div className={`text-3xl font-black ${breadthColor}`}>{breadthScore}</div>
          <div className="text-[10px] text-zinc-500">/100</div>
          <Badge className={`mt-1 text-xs ${
            breadthScore >= 70 ? "bg-emerald-500/20 text-emerald-400" :
            breadthScore >= 50 ? "bg-yellow-500/20 text-yellow-400" :
            "bg-red-500/20 text-red-400"
          }`}>
            {b.label || "NEUTRAL"}
          </Badge>
        </div>

        {/* Advance/Decline */}
        <div className="space-y-2 mb-3">
          <div className="flex justify-between items-center text-xs">
            <span className="text-zinc-500">Advances</span>
            <span className="text-emerald-400 font-bold">{b.advances || 0}</span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${((b.advances || 0) / (b.total || 1)) * 100}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-zinc-500">Declines</span>
            <span className="text-red-400 font-bold">{b.declines || 0}</span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-red-500 rounded-full transition-all"
              style={{ width: `${((b.declines || 0) / (b.total || 1)) * 100}%` }}
            />
          </div>
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-3 gap-2 text-xs mb-3">
          <div className="flex justify-between">
            <span className="text-zinc-500">A/D Ratio</span>
            <span className="font-bold">{b.adRatio || 0}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Vol Ratio</span>
            <span className="font-bold">{b.volRatio || 0}x</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Score</span>
            <span className={`font-bold ${breadthColor}`}>{breadthScore}/100</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">52W Highs</span>
            <span className="text-emerald-400 font-bold">{b.newHighs || 0} ({b.newHighsPct || 0}%)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">52W Lows</span>
            <span className="text-red-400 font-bold">{b.newLows || 0} ({b.newLowsPct || 0}%)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Day Highs/Lows</span>
            <span className="font-bold">{b.freshDayHighs || 0} / {b.freshDayLows || 0}</span>
          </div>
        </div>

        {/* EMA / VWAP / Relative Volume */}
        <div className="space-y-2 mb-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 flex items-center gap-1"><Gauge className="h-3 w-3" /> EMA Participation</span>
            <Badge variant="outline" className={`text-[9px] ${b.aboveEMA20Pct >= 70 ? "text-emerald-400" : b.aboveEMA20Pct >= 50 ? "text-yellow-400" : "text-red-400"}`}>
              {(b.aboveEMA20Pct || 0) + "% > EMA20"}
            </Badge>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${b.aboveEMA20Pct || 0}%` }} />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 flex items-center gap-1"><Activity className="h-3 w-3" /> VWAP Participation</span>
            <Badge variant="outline" className={`text-[9px] ${b.aboveVWAPPct >= 70 ? "text-emerald-400" : b.aboveVWAPPct >= 50 ? "text-yellow-400" : "text-red-400"}`}>
              {(b.aboveVWAPPct || 0) + "% > VWAP"}
            </Badge>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${b.aboveVWAPPct || 0}%` }} />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 flex items-center gap-1"><Volume2 className="h-3 w-3" /> Relative Volume</span>
            <Badge variant="outline" className={`text-[9px] ${b.highRelVolPct >= 30 ? "text-emerald-400" : b.highRelVolPct >= 15 ? "text-yellow-400" : "text-red-400"}`}>
              {(b.highRelVolPct || 0) + "% > 2x RVOL"}
            </Badge>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-orange-500 rounded-full transition-all" style={{ width: `${b.highRelVolPct || 0}%` }} />
          </div>
        </div>

        {/* Detailed Stats */}
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div className="bg-zinc-900/50 rounded p-2">
            <div className="text-zinc-500 mb-1">EMA Participation</div>
            <div className="flex justify-between text-[9px]">
              <span>EMA 20</span>
              <span className="font-bold">{(b.aboveEMA20Pct || 0) + "%"}</span>
            </div>
            <div className="flex justify-between text-[9px]">
              <span>EMA 50</span>
              <span className="font-bold">{(b.aboveEMA50Pct || 0) + "%"}</span>
            </div>
            <div className="flex justify-between text-[9px]">
              <span>EMA 200</span>
              <span className="font-bold">{(b.aboveEMA200Pct || 0) + "%"}</span>
            </div>
          </div>

          <div className="bg-zinc-900/50 rounded p-2">
            <div className="text-zinc-500 mb-1">Relative Volume</div>
            <div className="flex justify-between text-[9px]"><span>{"> 2x"}</span><span className="font-bold text-emerald-400">{b.highRelVol || 0} ({(b.highRelVolPct || 0) + "%"})</span></div>
            <div className="flex justify-between text-[9px]"><span>{"1.5-2x"}</span><span className="font-bold text-yellow-400">{b.elevatedRelVol || 0}</span></div>
            <div className="flex justify-between text-[9px]"><span>{"0.8-1.5x"}</span><span className="font-bold">{b.normalRelVol || 0}</span></div>
            <div className="flex justify-between text-[9px]"><span>{"< 0.8x"}</span><span className="font-bold text-red-400">{b.lowRelVol || 0}</span></div>
          </div>

          <div className="bg-zinc-900/50 rounded p-2">
            <div className="text-zinc-500 mb-1">Score Breakdown</div>
            <div className="flex justify-between text-[9px]"><span>A/D</span><span className="font-bold">{b.adScore || 0}</span></div>
            <div className="flex justify-between text-[9px]"><span>Volume</span><span className="font-bold">{b.volScore || 0}</span></div>
            <div className="flex justify-between text-[9px]"><span>High/Low</span><span className="font-bold">{b.highLowScore || 0}</span></div>
            <div className="flex justify-between text-[9px]"><span>EMA</span><span className="font-bold">{b.emaScore || 0}</span></div>
            <div className="flex justify-between text-[9px]"><span>VWAP</span><span className="font-bold">{b.vwapScore || 0}</span></div>
            <div className="flex justify-between text-[9px]"><span>Rel Vol</span><span className="font-bold">{b.relVolScore || 0}</span></div>
          </div>
        </div>

        {/* Top movers */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-zinc-500 mb-1 flex items-center gap-1"><TrendingUp className="h-3 w-3" /> TOP GAINERS</div>
            {b.topGainers?.slice(0, 3).map((s: any) => (
              <div key={s.symbol} className="flex justify-between text-[10px]">
                <span className="text-zinc-400">{s.symbol}</span>
                <span className="text-emerald-400">+{s.changePct}%</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 mb-1 flex items-center gap-1"><TrendingDown className="h-3 w-3" /> TOP LOSERS</div>
            {b.topLosers?.slice(0, 3).map((s: any) => (
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