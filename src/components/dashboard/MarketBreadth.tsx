"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, TrendingUp, TrendingDown, Minus } from "lucide-react";

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

  const breadthColor = data.breadthScore >= 70 ? "text-emerald-400" :
    data.breadthScore >= 50 ? "text-yellow-400" : "text-red-400";

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
          <div className={`text-3xl font-black ${breadthColor}`}>{data.breadthScore}</div>
          <div className="text-[10px] text-zinc-500">/100</div>
          <Badge className={`mt-1 text-xs ${
            data.breadthScore >= 70 ? "bg-emerald-500/20 text-emerald-400" :
            data.breadthScore >= 50 ? "bg-yellow-500/20 text-yellow-400" :
            "bg-red-500/20 text-red-400"
          }`}>
            {data.label}
          </Badge>
        </div>

        {/* Advance/Decline */}
        <div className="space-y-2 mb-3">
          <div className="flex justify-between items-center text-xs">
            <span className="text-zinc-500">Advances</span>
            <span className="text-emerald-400 font-bold">{data.advances}</span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${(data.advances / data.total) * 100}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-zinc-500">Declines</span>
            <span className="text-red-400 font-bold">{data.declines}</span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-red-500 rounded-full transition-all"
              style={{ width: `${(data.declines / data.total) * 100}%` }}
            />
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex justify-between">
            <span className="text-zinc-500">A/D Ratio</span>
            <span className="font-bold">{data.adRatio}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Vol Ratio</span>
            <span className="font-bold">{data.volRatio}x</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">52W Highs</span>
            <span className="text-emerald-400 font-bold">{data.newHighs}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">52W Lows</span>
            <span className="text-red-400 font-bold">{data.newLows}</span>
          </div>
        </div>

        {/* Top movers */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-zinc-500 mb-1">TOP GAINERS</div>
            {data.topGainers?.slice(0, 3).map((s: any) => (
              <div key={s.symbol} className="flex justify-between text-[10px]">
                <span className="text-zinc-400">{s.symbol}</span>
                <span className="text-emerald-400">+{s.changePct}%</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 mb-1">TOP LOSERS</div>
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
