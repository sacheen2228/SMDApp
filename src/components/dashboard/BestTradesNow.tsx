"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Star, TrendingUp, Target, Shield, AlertTriangle } from "lucide-react";

function ScoreBadge({ score }: { score: number }) {
  const grade = score >= 80 ? "A+" : score >= 65 ? "A" : score >= 50 ? "B" : "C";
  const color = score >= 80 ? "bg-emerald-600" : score >= 65 ? "bg-emerald-500/30 text-emerald-400" :
    score >= 50 ? "bg-yellow-500/30 text-yellow-400" : "bg-zinc-600 text-zinc-400";
  return (
    <Badge className={`${color} text-xs font-bold`}>{score}/100 {grade}</Badge>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const color = confidence === "VERY HIGH" ? "bg-emerald-600" :
    confidence === "HIGH" ? "bg-emerald-500/20 text-emerald-400" :
    confidence === "MEDIUM" ? "bg-yellow-500/20 text-yellow-400" :
    "bg-zinc-600 text-zinc-400";
  return <Badge variant="outline" className={`${color} text-[9px]`}>{confidence}</Badge>;
}

export function BestTradesNow() {
  const { data, isLoading } = useQuery({
    queryKey: ["best-trades"],
    queryFn: () => fetch("/api/market/opportunities?top=5").then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading || !data) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-4">
          <div className="animate-pulse space-y-3">
            {[1,2,3].map(i => <div key={i} className="h-20 bg-zinc-800 rounded" />)}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <Star className="h-3 w-3 text-yellow-500" />
          BEST TRADES NOW
          <Badge variant="outline" className="text-[9px] ml-auto">{data.opportunities?.length || 0} setups</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 space-y-3">
        {data.opportunities?.map((opp: any, idx: number) => (
          <div key={opp.symbol} className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3">
            {/* Header */}
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-500">#{idx + 1}</span>
                  <span className="text-sm font-bold text-white">{opp.symbol}</span>
                  <span className="text-[10px] text-zinc-500">{opp.name}</span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <Badge className="bg-emerald-600 text-white text-[9px]">LONG</Badge>
                  <Badge variant="outline" className="text-[9px] text-zinc-400">{opp.setup}</Badge>
                  <Badge variant="outline" className="text-[9px] text-zinc-400">{opp.sector}</Badge>
                </div>
              </div>
              <div className="text-right">
                <ScoreBadge score={opp.score} />
                <div className="mt-1">
                  <ConfidenceBadge confidence={opp.confidence} />
                </div>
              </div>
            </div>

            {/* Trade Plan */}
            <div className="grid grid-cols-5 gap-2 text-[10px] mb-2">
              <div>
                <span className="text-zinc-500">Entry</span>
                <div className="font-bold text-white">₹{opp.entry}</div>
              </div>
              <div>
                <span className="text-zinc-500">Stop</span>
                <div className="font-bold text-red-400">₹{opp.sl}</div>
              </div>
              <div>
                <span className="text-zinc-500">Target 1</span>
                <div className="font-bold text-emerald-400">₹{opp.tp1}</div>
              </div>
              <div>
                <span className="text-zinc-500">Target 2</span>
                <div className="font-bold text-emerald-400">₹{opp.tp2}</div>
              </div>
              <div>
                <span className="text-zinc-500">R:R</span>
                <div className={`font-bold ${opp.rr >= 2 ? "text-emerald-400" : opp.rr >= 1.5 ? "text-yellow-400" : "text-red-400"}`}>
                  1:{opp.rr}
                </div>
              </div>
            </div>

            {/* Reasons */}
            {opp.reasons?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {opp.reasons.slice(0, 3).map((r: string, i: number) => (
                  <Badge key={i} className="bg-emerald-500/10 text-emerald-400 text-[8px] border-emerald-500/20">
                    ✓ {r}
                  </Badge>
                ))}
              </div>
            )}

            {/* Risks */}
            {opp.risks?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {opp.risks.map((r: string, i: number) => (
                  <Badge key={i} className="bg-red-500/10 text-red-400 text-[8px] border-red-500/20">
                    ⚠ {r}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ))}

        {data.opportunities?.length === 0 && (
          <div className="text-center py-6 text-zinc-500 text-xs">
            <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-yellow-500" />
            NO CLEAR EDGE — Market conditions unfavorable
          </div>
        )}
      </CardContent>
    </Card>
  );
}
