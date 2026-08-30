// CAS (Closing Auction Session) Analysis Panel
// Shows accumulation/distribution signals from institutional positioning

"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, ArrowDownRight, Minus, Activity } from "lucide-react";

export function CASPanel() {
  const { data: breadth } = useQuery({
    queryKey: ["cas-breadth"],
    queryFn: () => fetch("/api/market/breadth").then(r => r.json()),
    refetchInterval: 120_000,
  });

  const { data: sectors } = useQuery({
    queryKey: ["cas-sectors"],
    queryFn: () => fetch("/api/market/sectors").then(r => r.json()),
    refetchInterval: 120_000,
  });

  const { data: regime } = useQuery({
    queryKey: ["cas-regime"],
    queryFn: () => fetch("/api/market/regime").then(r => r.json()),
    refetchInterval: 120_000,
  });

  // Derive CAS signal from available data
  const breadthScore = breadth?.breadthScore || 50;
  const advances = breadth?.advances || 0;
  const declines = breadth?.declines || 0;
  const volRatio = breadth?.volRatio || 1;
  const sectorStrength = sectors?.sectorStrengthScore || 50;
  const regimeData = regime?.regime || "NEUTRAL";

  // CAS score: accumulation vs distribution
  let casScore = 50;
  if (breadthScore > 70) casScore += 15;
  else if (breadthScore < 30) casScore -= 15;
  if (volRatio > 1.5) casScore += 10;
  else if (volRatio < 0.7) casScore -= 10;
  if (sectorStrength > 60) casScore += 10;
  else if (sectorStrength < 40) casScore -= 10;
  if (regimeData.includes("BULL")) casScore += 10;
  else if (regimeData.includes("BEAR")) casScore -= 10;
  casScore = Math.min(100, Math.max(0, casScore));

  const casLabel = casScore >= 70 ? "ACCUMULATION" : casScore >= 55 ? "MILD ACCUMULATION" :
    casScore >= 45 ? "NEUTRAL" : casScore >= 30 ? "MILD DISTRIBUTION" : "DISTRIBUTION";

  const casColor = casScore >= 70 ? "text-emerald-400" : casScore >= 55 ? "text-emerald-300" :
    casScore >= 45 ? "text-yellow-400" : casScore >= 30 ? "text-orange-400" : "text-red-400";

  const casBadgeColor = casScore >= 70 ? "bg-emerald-600" : casScore >= 55 ? "bg-emerald-500/20 text-emerald-400" :
    casScore >= 45 ? "bg-yellow-500/20 text-yellow-400" : casScore >= 30 ? "bg-orange-500/20 text-orange-400" :
    "bg-red-600";

  // Price vs CAS matrix
  const avgChange = sectors?.sectors?.length
    ? sectors.sectors.reduce((sum: number, s: any) => sum + s.changePct, 0) / sectors.sectors.length
    : 0;
  const priceUp = avgChange > 0.2;
  const priceDown = avgChange < -0.2;
  const accumulating = casScore > 55;
  const distributing = casScore < 45;

  let matrixSignal: string;
  let matrixColor: string;
  if (priceUp && accumulating) { matrixSignal = "STRONG BULLISH"; matrixColor = "text-emerald-400"; }
  else if (priceUp && distributing) { matrixSignal = "CAUTION — Distribution"; matrixColor = "text-orange-400"; }
  else if (priceDown && accumulating) { matrixSignal = "POSSIBLE ABSORPTION"; matrixColor = "text-yellow-400"; }
  else if (priceDown && distributing) { matrixSignal = "STRONG BEARISH"; matrixColor = "text-red-400"; }
  else { matrixSignal = "NEUTRAL"; matrixColor = "text-zinc-400"; }

  // Sector accumulation/distribution
  const sectorSignals = (sectors?.sectors || []).map((s: any) => ({
    name: s.name,
    signal: s.changePct > 0.5 ? "ACCUMULATION" : s.changePct < -0.5 ? "DISTRIBUTION" : "NEUTRAL",
    changePct: s.changePct,
    color: s.changePct > 0.5 ? "text-emerald-400" : s.changePct < -0.5 ? "text-red-400" : "text-zinc-400",
  }));

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <Activity className="h-3 w-3" />
          CAS — ACCUMULATION / DISTRIBUTION
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {/* CAS Score */}
        <div className="text-center mb-3">
          <div className={`text-3xl font-black ${casColor}`}>{casScore}</div>
          <div className="text-[10px] text-zinc-500">/100</div>
          <Badge className={`mt-1 text-xs font-bold ${casBadgeColor}`}>{casLabel}</Badge>
        </div>

        {/* Price × CAS Matrix */}
        <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3 mb-3">
          <div className="text-[9px] text-zinc-500 mb-1">PRICE × CAS MATRIX</div>
          <div className={`text-sm font-bold ${matrixColor}`}>{matrixSignal}</div>
          <div className="grid grid-cols-2 gap-2 mt-2 text-[10px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">Market Price</span>
              <span className={priceUp ? "text-emerald-400" : priceDown ? "text-red-400" : "text-zinc-400"}>
                {priceUp ? "↑ UP" : priceDown ? "↓ DOWN" : "→ FLAT"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">CAS Signal</span>
              <span className={accumulating ? "text-emerald-400" : distributing ? "text-red-400" : "text-zinc-400"}>
                {accumulating ? "↑ ACCUM" : distributing ? "↓ DISTRIB" : "→ NEUTRAL"}
              </span>
            </div>
          </div>
        </div>

        {/* Sector CAS */}
        <div className="space-y-1">
          <div className="text-[9px] text-zinc-500 mb-1">SECTOR FLOWS</div>
          {sectorSignals.map((s: any) => (
            <div key={s.name} className="flex items-center justify-between text-[10px] py-0.5">
              <span className="text-zinc-300 w-20">{s.name}</span>
              <div className="flex items-center gap-1">
                {s.signal === "ACCUMULATION" ? (
                  <ArrowUpRight className="h-3 w-3 text-emerald-400" />
                ) : s.signal === "DISTRIBUTION" ? (
                  <ArrowDownRight className="h-3 w-3 text-red-400" />
                ) : (
                  <Minus className="h-3 w-3 text-zinc-500" />
                )}
                <span className={`font-bold ${s.color}`}>{s.changePct >= 0 ? "+" : ""}{s.changePct}%</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
