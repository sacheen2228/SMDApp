// CAS (Closing Auction Session) Analysis Panel
// Shows accumulation/distribution signals from institutional positioning

"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, ArrowDownRight, Minus, Activity } from "lucide-react";
import { DataFreshnessBadge } from "./DataFreshnessBadge";

export function CASPanel({ breadthData, sectorData, regimeData }: { breadthData?: any; sectorData?: any; regimeData?: any }) {
  const { data: bData, isLoading, isError } = useQuery({
    queryKey: ["cas-breadth"],
    queryFn: () => fetch("/api/market/breadth").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "breadth failed");
      return json;
    }),
    refetchInterval: 120_000,
    staleTime: 30_000,
  });

  const { data: sData } = useQuery({
    queryKey: ["cas-sectors"],
    queryFn: () => fetch("/api/market/sectors").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "sectors failed");
      return json;
    }),
    refetchInterval: 120_000,
  });

  const { data: rData } = useQuery({
    queryKey: ["cas-regime"],
    queryFn: () => fetch("/api/market/regime").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "regime failed");
      return json;
    }),
    refetchInterval: 120_000,
  });

  const breadth = breadthData ?? bData;
  const sectors = sectorData ?? sData;
  const regime = regimeData ?? rData;

  // Derive the CAS signal from the data that actually arrived.
  // Breadth API shape: { breadth: { score, advances, declines, volRatio, ... } }
  // The old code defaulted a MISSING breadth score to 50, a missing vol ratio
  // to 1 and a missing sector strength to 50, so a dead feed produced a
  // confident "NEUTRAL 50" CAS reading. Missing inputs now make the card
  // say "unavailable" instead.
  const b = breadth?.breadth;
  const breadthScore = typeof b?.score === "number" ? b.score : null;
  const advances = typeof b?.advances === "number" ? b.advances : null;
  const declines = typeof b?.declines === "number" ? b.declines : null;
  const volRatio = typeof b?.volRatio === "number" ? b.volRatio : null;
  // The sectors endpoint publishes per-sector moves, not a "sector strength
  // score" — derive it from the real sector averages.
  const sectorList: any[] = sectors?.sectors || [];
  const sectorStrength = sectorList.length
    ? Math.round(
        (sectorList.reduce((sum: number, s: any) => sum + (s.avgChangePct || 0), 0) /
          sectorList.length + 50) * 10,
      ) / 10
    : null;
  const regimeDataVal = regime?.regime && regime.regime !== "UNKNOWN" ? regime.regime : null;

  // CAS score: accumulation vs distribution — only over the inputs we have.
  const casParts: Array<{ w: number; v: number }> = [];
  if (breadthScore != null) casParts.push({ w: 15, v: breadthScore > 70 ? 15 : breadthScore < 30 ? -15 : 0 });
  if (volRatio != null) casParts.push({ w: 10, v: volRatio > 1.5 ? 10 : volRatio < 0.7 ? -10 : 0 });
  if (sectorStrength != null) casParts.push({ w: 10, v: sectorStrength > 60 ? 10 : sectorStrength < 40 ? -10 : 0 });
  if (regimeDataVal) casParts.push({ w: 10, v: regimeDataVal.includes("BULL") ? 10 : regimeDataVal.includes("BEAR") ? -10 : 0 });

  const casAvailable = casParts.length > 0;
  const casScore = casAvailable
    ? Math.min(100, Math.max(0, Math.round(50 + casParts.reduce((sum, p) => sum + p.v, 0))))
    : null;

  const casLabel = casScore == null ? "NO DATA" : casScore >= 70 ? "ACCUMULATION" : casScore >= 55 ? "MILD ACCUMULATION" :
    casScore >= 45 ? "NEUTRAL" : casScore >= 30 ? "MILD DISTRIBUTION" : "DISTRIBUTION";

  const casColor = casScore == null ? "text-zinc-500" : casScore >= 70 ? "text-emerald-400" : casScore >= 55 ? "text-emerald-300" :
    casScore >= 45 ? "text-yellow-400" : casScore >= 30 ? "text-orange-400" : "text-red-400";

  const casBadgeColor = casScore == null ? "bg-zinc-600" : casScore >= 70 ? "bg-emerald-600" : casScore >= 55 ? "bg-emerald-500/20 text-emerald-400" :
    casScore >= 45 ? "bg-yellow-500/20 text-yellow-400" : casScore >= 30 ? "bg-orange-500/20 text-orange-400" :
    "bg-red-600";

  // Price vs CAS matrix (sectors API field is avgChangePct, not changePct —
  // reading changePct gave NaN/undefined: matrix stuck on FLAT, flows "%")
  const avgChange = sectorList.length
    ? sectorList.reduce((sum: number, s: any) => sum + (s.avgChangePct || 0), 0) / sectorList.length
    : null;
  const priceUp = avgChange != null && avgChange > 0.2;
  const priceDown = avgChange != null && avgChange < -0.2;
  const accumulating = casScore != null && casScore > 55;
  const distributing = casScore != null && casScore < 45;

  let matrixSignal: string;
  let matrixColor: string;
  if (!casAvailable) { matrixSignal = "NO DATA"; matrixColor = "text-zinc-500"; }
  else if (priceUp && accumulating) { matrixSignal = "STRONG BULLISH"; matrixColor = "text-emerald-400"; }
  else if (priceUp && distributing) { matrixSignal = "CAUTION — Distribution"; matrixColor = "text-orange-400"; }
  else if (priceDown && accumulating) { matrixSignal = "POSSIBLE ABSORPTION"; matrixColor = "text-yellow-400"; }
  else if (priceDown && distributing) { matrixSignal = "STRONG BEARISH"; matrixColor = "text-red-400"; }
  else { matrixSignal = "NEUTRAL"; matrixColor = "text-zinc-400"; }

  // Sector accumulation/distribution
  const sectorSignals = (sectors?.sectors || []).map((s: any) => ({
    name: s.name,
    signal: s.avgChangePct > 0.5 ? "ACCUMULATION" : s.avgChangePct < -0.5 ? "DISTRIBUTION" : "NEUTRAL",
    changePct: s.avgChangePct,
    color: s.avgChangePct > 0.5 ? "text-emerald-400" : s.avgChangePct < -0.5 ? "text-red-400" : "text-zinc-400",
  }));

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <Activity className="h-3 w-3" />
          CAS — ACCUMULATION / DISTRIBUTION
          <DataFreshnessBadge meta={breadth?.data} className="ml-1" showReason />
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {/* CAS Score */}
        <div className="text-center mb-3">
          <div className={`text-3xl font-black ${casColor}`}>{casScore == null ? "—" : casScore}</div>
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
                {avgChange == null ? "NO DATA" : priceUp ? "↑ UP" : priceDown ? "↓ DOWN" : "→ FLAT"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">CAS Signal</span>
              <span className={accumulating ? "text-emerald-400" : distributing ? "text-red-400" : "text-zinc-400"}>
                {casScore == null ? "NO DATA" : accumulating ? "↑ ACCUM" : distributing ? "↓ DISTRIB" : "→ NEUTRAL"}
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
