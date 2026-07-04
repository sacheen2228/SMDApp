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
  expired: "bg-gray-500/20 text-muted-foreground",
  partial_exit: "bg-amber-500/20 text-amber-400",
};

function formatHolding(mins?: number): string {
  if (!mins) return "—";
  if (mins < 60) return `${Math.round(mins)}m`;
  return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
}

export function TradeJournal({ trades, winRate, avgGrade, dailyPnL }: TradeJournalProps) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm text-gray-200">
          <BookOpen className="h-4 w-4 text-blue-400" />
          Trade Journal
        </CardTitle>
        <div className="flex gap-3 text-[10px]">
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Trades:</span>
            <span className="text-foreground font-medium">{trades.length}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Win Rate:</span>
            <span className="text-foreground font-medium">{winRate.toFixed(0)}%</span>
          </div>
          <div className="flex items-center gap-1">
            <Award className="h-3 w-3 text-muted-foreground" />
            <Badge className={`text-[8px] ${gradeStyle[avgGrade] || "bg-gray-500/20 text-muted-foreground"}`}>{avgGrade}</Badge>
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-muted-foreground">P&L:</span>
            <span className={`font-bold ${dailyPnL > 0 ? "text-emerald-400" : dailyPnL < 0 ? "text-red-400" : "text-muted-foreground"}`}>
              {dailyPnL > 0 ? "+" : ""}₹{dailyPnL.toFixed(0)}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Performance Metrics */}
        <div className="space-y-2 p-2 rounded-lg bg-accent/50 border border-border">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Win Rate</span>
            <span className="text-foreground font-medium">{winRate.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${Math.min(winRate, 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] pt-1">
            <div className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-emerald-400" />
              <span className="text-muted-foreground">Total P&L:</span>
              <span className={`font-bold ${dailyPnL > 0 ? "text-emerald-400" : dailyPnL < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                {dailyPnL > 0 ? "+" : ""}₹{dailyPnL.toFixed(0)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Award className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">Avg Grade:</span>
              <Badge className={`text-[8px] ${gradeStyle[avgGrade] || "bg-gray-500/20 text-muted-foreground"}`}>{avgGrade}</Badge>
            </div>
          </div>
        </div>

        {/* Trade List */}
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
          Trades ({trades.length})
        </div>
        <ScrollArea className="max-h-[400px]">
          <div className="space-y-2 pr-2">
            {trades.length === 0 && (
              <div className="text-center text-muted-foreground text-[10px] py-4">No trades today</div>
            )}
            {trades.map((trade) => (
              <div key={trade.id} className="p-2 rounded-lg bg-accent/50 border border-border space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-muted-foreground font-mono w-12">{trade.time.slice(0, 5)}</span>
                  <Badge variant="outline" className={`text-[8px] px-1 py-0 h-4 ${directionStyle[trade.direction]}`}>
                    {trade.direction.replace("_", " ")}
                  </Badge>
                  <span className="text-foreground">{trade.strike} {trade.direction.includes("CALL") ? "CE" : "PE"}</span>
                  <Badge className={`text-[8px] ${gradeStyle[trade.grade] || "bg-gray-500/20 text-muted-foreground"}`}>{trade.grade}</Badge>
                  <Badge className={`text-[8px] ${statusStyle[trade.status]}`}>{statusLabel[trade.status]}</Badge>
                  <div className="flex items-center gap-1 ml-auto text-[9px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {formatHolding(trade.holdingTime)}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-muted-foreground">Entry:</span>
                  <span className="text-foreground">₹{trade.entry}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="text-muted-foreground">₹{trade.status === "active" ? trade.entry : trade.exitReason ? "—" : trade.entry}</span>
                  <span
                    className={`ml-auto font-bold ${
                      trade.pnl > 0 ? "text-emerald-400" : trade.pnl < 0 ? "text-red-400" : "text-muted-foreground"
                    }`}
                  >
                    {trade.pnl > 0 ? "+" : ""}{trade.pnl !== 0 ? `₹${trade.pnl.toFixed(0)}` : "—"}
                  </span>
                </div>

                {/* Partial Exits */}
                {trade.partialExits.length > 0 && (
                  <div className="pl-4 space-y-0.5 border-l border-border ml-2">
                    {trade.partialExits.map((pe, i) => (
                      <div key={i} className="flex gap-2 text-[9px]">
                        <span className="text-muted-foreground">{pe.time.slice(0, 5)}</span>
                        <span className="text-muted-foreground">{pe.percent}% @ ₹{pe.price}</span>
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
