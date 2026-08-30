"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";
import { LayoutGrid } from "lucide-react";

function getColor(changePct: number): string {
  if (changePct > 3) return "bg-emerald-600";
  if (changePct > 2) return "bg-emerald-500";
  if (changePct > 1) return "bg-emerald-400/80";
  if (changePct > 0.3) return "bg-emerald-400/50";
  if (changePct > -0.3) return "bg-zinc-600";
  if (changePct > -1) return "bg-red-400/50";
  if (changePct > -2) return "bg-red-400/80";
  if (changePct > -3) return "bg-red-500";
  return "bg-red-600";
}

function getTextColor(changePct: number): string {
  if (Math.abs(changePct) > 1.5) return "text-white";
  return "text-zinc-100";
}

interface HeatmapCellProps {
  stock: any;
  size: "sm" | "md" | "lg";
  onClick: (s: any) => void;
}

function HeatmapCell({ stock, size, onClick }: HeatmapCellProps) {
  const color = getColor(stock.changePct);
  const textColor = getTextColor(stock.changePct);

  const sizeClasses = {
    sm: "min-w-[60px] min-h-[40px] p-1",
    md: "min-w-[80px] min-h-[55px] p-1.5",
    lg: "min-w-[100px] min-h-[70px] p-2",
  };

  return (
    <button
      onClick={() => onClick(stock)}
      className={`${color} ${sizeClasses[size]} ${textColor} rounded-sm flex flex-col justify-between items-center 
        hover:brightness-125 hover:ring-1 hover:ring-white/30 transition-all cursor-pointer text-center`}
    >
      <span className="text-[9px] font-bold leading-tight truncate w-full">{stock.symbol}</span>
      <span className={`text-[10px] font-black ${stock.changePct >= 0 ? "text-emerald-100" : "text-red-100"}`}>
        {stock.changePct >= 0 ? "+" : ""}{stock.changePct}%
      </span>
    </button>
  );
}

export function MarketHeatmap({ onStockClick }: { onStockClick?: (symbol: string) => void }) {
  const [selected, setSelected] = useState<any>(null);
  const [view, setView] = useState<"bySector" | "flat">("bySector");

  const handleStockClick = (stock: any) => {
    setSelected(stock);
    onStockClick?.(stock.symbol);
  };

  const { data, isLoading } = useQuery({
    queryKey: ["market-heatmap"],
    queryFn: () => fetch("/api/market/heatmap").then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading || !data) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-4">
          <div className="animate-pulse grid grid-cols-5 gap-1">
            {Array.from({ length: 20 }).map((_, i) => (
              <div key={i} className="h-12 bg-zinc-800 rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <LayoutGrid className="h-3 w-3" />
          NIFTY 50 HEATMAP
        </CardTitle>
        <div className="flex gap-1">
          <button
            onClick={() => setView("bySector")}
            className={`text-[9px] px-2 py-0.5 rounded ${view === "bySector" ? "bg-zinc-700 text-white" : "text-zinc-500"}`}
          >
            By Sector
          </button>
          <button
            onClick={() => setView("flat")}
            className={`text-[9px] px-2 py-0.5 rounded ${view === "flat" ? "bg-zinc-700 text-white" : "text-zinc-500"}`}
          >
            Flat
          </button>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {view === "bySector" ? (
          <div className="space-y-2">
            {data.sectors?.map((sector: any) => (
              <div key={sector.name}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] font-bold text-zinc-500">{sector.name}</span>
                  <span className={`text-[9px] font-bold ${sector.avgChangePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {sector.avgChangePct >= 0 ? "+" : ""}{sector.avgChangePct}%
                  </span>
                </div>
                <div className="flex flex-wrap gap-0.5">
                  {sector.stocks.map((stock: any) => (
                    <HeatmapCell key={stock.symbol} stock={stock} size="sm" onClick={handleStockClick} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-0.5">
            {data.stocks?.map((stock: any) => (
              <HeatmapCell key={stock.symbol} stock={stock} size="md" onClick={handleStockClick} />
            ))}
          </div>
        )}

        {/* Selected stock detail */}
        {selected && (
          <div className="mt-3 bg-zinc-800/50 border border-zinc-700 rounded p-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-sm font-bold text-white">{selected.symbol}</span>
                <span className="text-[10px] text-zinc-500 ml-2">{selected.name}</span>
              </div>
              <button onClick={() => setSelected(null)} className="text-zinc-500 text-xs">✕</button>
            </div>
            <div className="grid grid-cols-4 gap-2 text-[10px]">
              <div>
                <span className="text-zinc-500">LTP</span>
                <div className="font-bold">₹{selected.ltp?.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500">Change</span>
                <div className={`font-bold ${selected.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {selected.changePct >= 0 ? "+" : ""}{selected.changePct}%
                </div>
              </div>
              <div>
                <span className="text-zinc-500">Sector</span>
                <div className="font-bold">{selected.sector}</div>
              </div>
              <div>
                <span className="text-zinc-500">Volume</span>
                <div className="font-bold">{(selected.volume / 100000).toFixed(1)}L</div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
