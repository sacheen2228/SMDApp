"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Minus, Activity, BarChart3 } from "lucide-react";

function RegimeBadge({ regime }: { regime: string }) {
  const colors: Record<string, string> = {
    "STRONG BULLISH": "bg-emerald-600 text-white",
    "BULLISH": "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    "NEUTRAL": "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    "BEARISH": "bg-red-500/20 text-red-400 border-red-500/30",
    "STRONG BEARISH": "bg-red-600 text-white",
    "HIGH VOLATILITY": "bg-orange-500/20 text-orange-400 border-orange-500/30",
  };
  return (
    <Badge className={`${colors[regime] || "bg-zinc-500/20 text-zinc-400"} text-xs font-bold px-2 py-0.5`}>
      {regime}
    </Badge>
  );
}

export function MarketRegimePanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["market-regime"],
    queryFn: () => fetch("/api/market/regime").then(r => r.json()),
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

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <Activity className="h-3 w-3" />
          MARKET REGIME
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="flex items-center gap-3 mb-3">
          <RegimeBadge regime={data.regime} />
          <Badge variant="outline" className={`text-xs ${
            data.bias === "BULLISH" ? "text-emerald-400 border-emerald-500/30" :
            data.bias === "BEARISH" ? "text-red-400 border-red-500/30" :
            "text-yellow-400 border-yellow-500/30"
          }`}>
            {data.bias}
          </Badge>
        </div>

        <p className="text-xs text-zinc-500 mb-3">{data.tradeEnv}</p>

        <div className="grid grid-cols-3 gap-3">
          {data.indices?.map((idx: any) => (
            <div key={idx.key} className="text-center">
              <div className="text-[10px] text-zinc-500">{idx.name}</div>
              <div className={`text-sm font-bold ${idx.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {idx.changePct >= 0 ? "+" : ""}{idx.changePct}%
              </div>
            </div>
          ))}
        </div>

        {data.vix && (
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-zinc-500">VIX</span>
            <span className={`font-bold ${data.vix.value > 20 ? "text-red-400" : data.vix.value > 15 ? "text-yellow-400" : "text-emerald-400"}`}>
              {data.vix.value} ({data.vix.change >= 0 ? "+" : ""}{data.vix.change})
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
