"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Layers, TrendingUp, TrendingDown } from "lucide-react";

function RotationBadge({ rotation }: { rotation: string }) {
  const colors: Record<string, string> = {
    LEADING: "bg-emerald-600/20 text-emerald-400 border-emerald-500/30",
    IMPROVING: "bg-blue-600/20 text-blue-400 border-blue-500/30",
    NEUTRAL: "bg-zinc-600/20 text-zinc-400 border-zinc-500/30",
    WEAKENING: "bg-orange-600/20 text-orange-400 border-orange-500/30",
    LAGGING: "bg-red-600/20 text-red-400 border-red-500/30",
  };
  return (
    <Badge variant="outline" className={`${colors[rotation] || ""} text-[9px] font-bold`}>
      {rotation}
    </Badge>
  );
}

export function SectorRotation() {
  const { data, isLoading } = useQuery({
    queryKey: ["sector-rotation"],
    queryFn: () => fetch("/api/market/sectors").then(r => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  if (isLoading || !data) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-4">
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-zinc-800 rounded w-1/3" />
            {[1,2,3].map(i => <div key={i} className="h-6 bg-zinc-800 rounded" />)}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <Layers className="h-3 w-3" />
          SECTOR ROTATION
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {/* Rotation Matrix */}
        <div className="grid grid-cols-2 gap-2 mb-3 text-[10px]">
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded p-2">
            <div className="font-bold text-emerald-400 mb-1">LEADING</div>
            {data.rotationMatrix?.leading?.map((s: string) => (
              <div key={s} className="text-zinc-300">{s}</div>
            )) || <div className="text-zinc-500">—</div>}
          </div>
          <div className="bg-blue-500/10 border border-blue-500/20 rounded p-2">
            <div className="font-bold text-blue-400 mb-1">IMPROVING</div>
            {data.rotationMatrix?.improving?.map((s: string) => (
              <div key={s} className="text-zinc-300">{s}</div>
            )) || <div className="text-zinc-500">—</div>}
          </div>
          <div className="bg-orange-500/10 border border-orange-500/20 rounded p-2">
            <div className="font-bold text-orange-400 mb-1">WEAKENING</div>
            {data.rotationMatrix?.weakening?.map((s: string) => (
              <div key={s} className="text-zinc-300">{s}</div>
            )) || <div className="text-zinc-500">—</div>}
          </div>
          <div className="bg-red-500/10 border border-red-500/20 rounded p-2">
            <div className="font-bold text-red-400 mb-1">LAGGING</div>
            {data.rotationMatrix?.lagging?.map((s: string) => (
              <div key={s} className="text-zinc-300">{s}</div>
            )) || <div className="text-zinc-500">—</div>}
          </div>
        </div>

        {/* Sector List */}
        <div className="space-y-1">
          {data.sectors?.map((s: any) => (
            <div key={s.key} className="flex items-center justify-between text-xs py-1 border-b border-zinc-800/50 last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-zinc-300 font-medium w-20">{s.name}</span>
                <RotationBadge rotation={s.rotation} />
              </div>
              <span className={`font-bold ${s.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {s.changePct >= 0 ? "+" : ""}{s.changePct}%
              </span>
            </div>
          ))}
        </div>

        {data.sectorStrengthScore && (
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-zinc-500">Sector Strength</span>
            <span className={`font-bold ${data.sectorStrengthScore >= 60 ? "text-emerald-400" : data.sectorStrengthScore >= 40 ? "text-yellow-400" : "text-red-400"}`}>
              {data.sectorStrengthScore}/100
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
