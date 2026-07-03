"use client";

import type { TradeRecord } from "@/types/sdm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BookOpen, TrendingUp, TrendingDown, Clock, Award } from "lucide-react";

interface TradeJournalProps {
  trades: TradeRecord[];
  winRate: number;
  avgGrade: string;
  dailyPnL: number;
}

const directionStyle: Record<TradeRecord["direction"], string> = {
  CALL: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  PUT: "bg-red-500/20 text-red-400 border-red-500/30",
  SELL_CALL: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  SELL_PUT: "bg-amber-500/20 text-amber-400 border-amber-500/30",
};

const gradeStyle: Record<string, string> = {
  "A+": "bg-emerald-500/20 text-emerald-400",
  A: "bg-emerald-500/20 text-emerald-400",
  B: "bg-blue-500/20 text-blue-400",
  C: "bg-amber-500/20 text-amber-400",
  D: "bg-red-500/20 text-red-400",
};

const statusLabel: Record<TradeRecord["status"], string> = {
  active: "OPEN",
  tp_hit: "TP_HIT",
  sl_hit: "SL_HIT",
  expired: "EXPIRED",
  partial_exit: "PARTIAL_EXIT",
};

const statusStyle: Record<TradeRecord["status"], string> = {
  active: "bg-amber-500/20 text-amber-400",
  tp_hit: "bg-emerald-500/20 text-emerald-400",
  sl_hit: "bg-red-500/20 text-red-400",
  expired: "bg-gray-500/20 text-gray-400",
  partial_exit: "bg-amber-500/20 text-amber-400",
};

function formatHolding(mins?: number): string {
  if (!mins) return "—";
  if (mins < 60) return `${Math.round(mins)}m`;
  return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
}

export function TradeJournal({ trades, winRate, avgGrade, dailyPnL }: TradeJournalProps) {
  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm text-gray-200">
          <BookOpen className="h-4 w-4 text-blue-400" />
          Trade Journal
        </CardTitle>
        <div className="flex gap-3 text-[10px]">
          <div className="flex items-center gap-1">
            <span className="text-gray-500">Trades:</span>
            <span className="text-white font-medium">{trades.length}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">Win Rate:</span>
            <span className="text-white font-medium">{winRate.toFixed(0)}%</span>
          </div>
          <div className="flex items-center gap-1">
            <Award className="h-3 w-3 text-gray-500" />
            <Badge className={`text-[8px] ${gradeStyle[avgGrade] || "bg-gray-500/20 text-gray-400"}`}>{avgGrade}</Badge>
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-gray-500">P&L:</span>
            <span className={`font-bold ${dailyPnL > 0 ? "text-emerald-400" : dailyPnL < 0 ? "text-red-400" : "text-gray-400"}`}>
              {dailyPnL > 0 ? "+" : ""}₹{dailyPnL.toFixed(0)}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Performance Metrics */}
        <div className="space-y-2 p-2 rounded-lg bg-gray-800/50 border border-gray-700/50">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-gray-400">Win Rate</span>
            <span className="text-white font-medium">{winRate.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${Math.min(winRate, 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] pt-1">
            <div className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-emerald-400" />
              <span className="text-gray-400">Total P&L:</span>
              <span className={`font-bold ${dailyPnL > 0 ? "text-emerald-400" : dailyPnL < 0 ? "text-red-400" : "text-gray-400"}`}>
                {dailyPnL > 0 ? "+" : ""}₹{dailyPnL.toFixed(0)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Award className="h-3 w-3 text-gray-500" />
              <span className="text-gray-400">Avg Grade:</span>
              <Badge className={`text-[8px] ${gradeStyle[avgGrade] || "bg-gray-500/20 text-gray-400"}`}>{avgGrade}</Badge>
            </div>
          </div>
        </div>

        {/* Trade List */}
        <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
          Trades ({trades.length})
        </div>
        <ScrollArea className="max-h-[400px]">
          <div className="space-y-2 pr-2">
            {trades.length === 0 && (
              <div className="text-center text-gray-500 text-[10px] py-4">No trades today</div>
            )}
            {trades.map((trade) => (
              <div key={trade.id} className="p-2 rounded-lg bg-gray-800/50 border border-gray-700/30 space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-gray-500 font-mono w-12">{trade.time.slice(0, 5)}</span>
                  <Badge variant="outline" className={`text-[8px] px-1 py-0 h-4 ${directionStyle[trade.direction]}`}>
                    {trade.direction.replace("_", " ")}
                  </Badge>
                  <span className="text-gray-300">{trade.strike} {trade.direction.includes("CALL") ? "CE" : "PE"}</span>
                  <Badge className={`text-[8px] ${gradeStyle[trade.grade] || "bg-gray-500/20 text-gray-400"}`}>{trade.grade}</Badge>
                  <Badge className={`text-[8px] ${statusStyle[trade.status]}`}>{statusLabel[trade.status]}</Badge>
                  <div className="flex items-center gap-1 ml-auto text-[9px] text-gray-500">
                    <Clock className="h-3 w-3" />
                    {formatHolding(trade.holdingTime)}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-gray-500">Entry:</span>
                  <span className="text-white">₹{trade.entry}</span>
                  <span className="text-gray-600">→</span>
                  <span className="text-gray-400">₹{trade.status === "active" ? trade.entry : trade.exitReason ? "—" : trade.entry}</span>
                  <span
                    className={`ml-auto font-bold ${
                      trade.pnl > 0 ? "text-emerald-400" : trade.pnl < 0 ? "text-red-400" : "text-gray-500"
                    }`}
                  >
                    {trade.pnl > 0 ? "+" : ""}{trade.pnl !== 0 ? `₹${trade.pnl.toFixed(0)}` : "—"}
                  </span>
                </div>

                {/* Partial Exits */}
                {trade.partialExits.length > 0 && (
                  <div className="pl-4 space-y-0.5 border-l border-gray-700/50 ml-2">
                    {trade.partialExits.map((pe, i) => (
                      <div key={i} className="flex gap-2 text-[9px]">
                        <span className="text-gray-500">{pe.time.slice(0, 5)}</span>
                        <span className="text-gray-400">{pe.percent}% @ ₹{pe.price}</span>
                        <span className={`ml-auto ${pe.pnl > 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pe.pnl > 0 ? "+" : ""}₹{pe.pnl.toFixed(0)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
