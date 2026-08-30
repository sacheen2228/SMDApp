// Unified Stock Analysis Drawer — slide-out panel with full stock intelligence
// Click a stock from heatmap/opportunities to see technicals, CAS, F&O, trade setup

"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X, TrendingUp, TrendingDown, Activity, BarChart3, Target, Shield, ChevronRight } from "lucide-react";

interface StockAnalysisDrawerProps {
  symbol: string | null;
  onClose: () => void;
}

function ScoreBar({ label, score, max = 100 }: { label: string; score: number; max?: number }) {
  const pct = (score / max) * 100;
  const color = score >= 70 ? "bg-emerald-500" : score >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="text-zinc-500 w-16">{label}</span>
      <div className="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-bold w-6 text-right">{score}</span>
    </div>
  );
}

export function StockAnalysisDrawer({ symbol, onClose }: StockAnalysisDrawerProps) {
  // Fetch stock-specific data from multiple sources
  const { data: heatmapData } = useQuery({
    queryKey: ["heatmap"],
    queryFn: () => fetch("/api/market/heatmap").then(r => r.json()),
    refetchInterval: 60_000,
  });

  const stock = heatmapData?.stocks?.find((s: any) => s.symbol === symbol);

  if (!symbol || !stock) return null;

  // Compute derived scores from available data
  const momentumScore = Math.min(100, Math.max(0, 50 + stock.changePct * 15));
  const volumeScore = stock.volume > 5000000 ? 80 : stock.volume > 2000000 ? 60 : 40;
  const range = stock.dayHigh - stock.dayLow;
  const rangePosition = range > 0 ? ((stock.ltp - stock.dayLow) / range) * 100 : 50;
  const rangeScore = Math.min(100, Math.round(rangePosition));
  const overallScore = Math.round(momentumScore * 0.3 + volumeScore * 0.3 + rangeScore * 0.4);

  // ATR estimation from day range
  const atr = range > 0 ? range : stock.ltp * 0.015;
  const entry = stock.ltp;
  const sl = entry - atr * 1.5;
  const tp1 = entry + atr * 2;
  const tp2 = entry + atr * 3;
  const risk = entry - sl;
  const rr = risk > 0 ? ((tp1 - entry) / risk).toFixed(1) : "0";

  // 52W position
  const week52Range = stock.weekHigh52 - stock.weekLow52;
  const week52Position = week52Range > 0 ? ((stock.ltp - stock.weekLow52) / week52Range) * 100 : 50;

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-96 bg-[#0a0e14] border-l border-zinc-800 z-50 overflow-y-auto shadow-2xl">
      {/* Header */}
      <div className="sticky top-0 bg-[#0a0e14] border-b border-zinc-800 p-4 z-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-white">{stock.symbol}</span>
              <Badge className="text-[9px] bg-zinc-700">{stock.sector}</Badge>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xl font-black">₹{stock.ltp}</span>
              <span className={`text-sm font-bold ${stock.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {stock.changePct >= 0 ? "+" : ""}{stock.changePct}%
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white p-2">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Stock Score */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="p-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-zinc-400">STOCK STRENGTH</span>
              <Badge className={`text-xs font-bold ${
                overallScore >= 70 ? "bg-emerald-600" : overallScore >= 50 ? "bg-yellow-600/30 text-yellow-400" : "bg-red-600/30 text-red-400"
              }`}>
                {overallScore}/100
              </Badge>
            </div>
            <div className="space-y-2">
              <ScoreBar label="Momentum" score={Math.round(momentumScore)} />
              <ScoreBar label="Volume" score={volumeScore} />
              <ScoreBar label="Range" score={rangeScore} />
            </div>
          </CardContent>
        </Card>

        {/* Key Levels */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="p-3">
            <span className="text-xs font-bold text-zinc-400">KEY LEVELS</span>
            <div className="grid grid-cols-2 gap-3 mt-2 text-[10px]">
              <div>
                <span className="text-zinc-500">Day High</span>
                <div className="font-bold">₹{stock.dayHigh}</div>
              </div>
              <div>
                <span className="text-zinc-500">Day Low</span>
                <div className="font-bold">₹{stock.dayLow}</div>
              </div>
              <div>
                <span className="text-zinc-500">52W High</span>
                <div className="font-bold">₹{stock.weekHigh52}</div>
              </div>
              <div>
                <span className="text-zinc-500">52W Low</span>
                <div className="font-bold">₹{stock.weekLow52}</div>
              </div>
              <div>
                <span className="text-zinc-500">Prev Close</span>
                <div className="font-bold">₹{stock.prevClose}</div>
              </div>
              <div>
                <span className="text-zinc-500">52W Position</span>
                <div className={`font-bold ${week52Position > 70 ? "text-emerald-400" : week52Position < 30 ? "text-red-400" : "text-yellow-400"}`}>
                  {week52Position.toFixed(0)}%
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Trade Setup */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="p-3">
            <span className="text-xs font-bold text-zinc-400">TRADE SETUP</span>
            <div className="grid grid-cols-2 gap-3 mt-2 text-[10px]">
              <div>
                <span className="text-zinc-500">Entry</span>
                <div className="font-bold text-white">₹{entry.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500">Stop Loss</span>
                <div className="font-bold text-red-400">₹{sl.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500">Target 1</span>
                <div className="font-bold text-emerald-400">₹{tp1.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500">Target 2</span>
                <div className="font-bold text-emerald-400">₹{tp2.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500">Risk/Share</span>
                <div className="font-bold text-red-400">₹{risk.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500">Risk:Reward</span>
                <div className={`font-bold ${parseFloat(rr) >= 2 ? "text-emerald-400" : parseFloat(rr) >= 1.5 ? "text-yellow-400" : "text-red-400"}`}>
                  1:{rr}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Volume */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="p-3">
            <span className="text-xs font-bold text-zinc-400">VOLUME</span>
            <div className="mt-2 text-[10px]">
              <div className="flex justify-between">
                <span className="text-zinc-500">Today's Volume</span>
                <span className="font-bold">{(stock.volume / 100000).toFixed(1)}L</span>
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-zinc-500">Volume Rating</span>
                <Badge className={`text-[8px] ${
                  stock.volume > 5000000 ? "bg-emerald-600" : stock.volume > 2000000 ? "bg-yellow-600/30 text-yellow-400" : "bg-zinc-700"
                }`}>
                  {stock.volume > 5000000 ? "HIGH" : stock.volume > 2000000 ? "MODERATE" : "LOW"}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Disclaimer */}
        <div className="text-[9px] text-zinc-600 text-center">
          AI-generated analysis based on real market data. Not financial advice.
        </div>
      </div>
    </div>
  );
}
