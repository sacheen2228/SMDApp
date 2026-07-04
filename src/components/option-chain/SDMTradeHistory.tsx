// SDM Trade History Component
// Shows today's trades, daily PnL, win rate, and average grade

import type { TradeRecord } from "@/types/sdm";
import { Badge } from "@/components/ui/badge";

interface SDMTradeHistoryProps {
  trades: TradeRecord[];
  pnl: number;
  winRate?: number;
  avgGrade?: string;
}

export function SDMTradeHistory({ trades, pnl, winRate, avgGrade }: SDMTradeHistoryProps) {
  if (trades.length === 0) return null;

  const getDirectionColor = (dir: TradeRecord["direction"]) => {
    switch (dir) {
      case "CALL":
        return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case "PUT":
        return "bg-red-500/20 text-red-400 border-red-500/30";
      case "SELL_CALL":
        return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "SELL_PUT":
        return "bg-purple-500/20 text-purple-400 border-purple-500/30";
    }
  };

  const getStatusDisplay = (status: TradeRecord["status"]) => {
    switch (status) {
      case "tp_hit":
        return <span className="text-emerald-400 text-[10px]">TP HIT ✓</span>;
      case "sl_hit":
        return <span className="text-red-400 text-[10px]">SL HIT ✗</span>;
      case "partial_exit":
        return <span className="text-yellow-400 text-[10px]">PARTIAL</span>;
      case "active":
        return (
          <span className="text-amber-400 text-[10px] animate-pulse">
            ACTIVE...
          </span>
        );
      case "expired":
        return <span className="text-muted-foreground text-[10px]">EXPIRED</span>;
    }
  };

  const getGradeColor = (grade: string) => {
    if (grade.startsWith("A")) return "bg-emerald-500/20 text-emerald-400";
    if (grade === "B") return "bg-yellow-500/20 text-yellow-400";
    return "bg-muted text-muted-foreground";
  };

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        ── Today&apos;s Trades ──
      </div>

      {/* Stats Bar */}
      <div className="flex gap-3 text-[9px]">
        <span className="text-muted-foreground">Win Rate: <span className="text-foreground">{winRate?.toFixed(0) || 0}%</span></span>
        <span className="text-muted-foreground">Avg Grade: <Badge className={`text-[8px] ${getGradeColor(avgGrade || "C")}`}>{avgGrade || "N/A"}</Badge></span>
        <span className="text-muted-foreground">Trades: <span className="text-foreground">{trades.length}</span></span>
      </div>

      {trades.map((trade) => (
        <div
          key={trade.id}
          className="flex items-center gap-1.5 text-[10px]"
        >
          <span className="text-muted-foreground font-mono w-14">{trade.time}</span>
          <Badge
            variant="outline"
            className={`text-[8px] px-1 py-0 h-4 ${getDirectionColor(trade.direction)}`}
          >
            {trade.direction.replace("_", " ")}
          </Badge>
          <span className="text-foreground w-16">
            {trade.strike} {trade.direction.includes("CALL") ? "CE" : "PE"}
          </span>
          <span className="text-muted-foreground w-10">₹{trade.entry}</span>
          <Badge className={`text-[8px] ${getGradeColor(trade.grade)}`}>
            {trade.grade}
          </Badge>
          {getStatusDisplay(trade.status)}
          <span
            className={`ml-auto font-mono ${
              trade.pnl > 0
                ? "text-emerald-400"
                : trade.pnl < 0
                  ? "text-red-400"
                  : "text-muted-foreground"
            }`}
          >
            {trade.pnl > 0 ? "+" : ""}
            {trade.pnl !== 0 ? `₹${trade.pnl.toFixed(0)}` : "—"}
          </span>
        </div>
      ))}

      {/* Partial Exits */}
      {trades.some(t => t.partialExits.length > 0) && (
        <div className="text-[9px] text-muted-foreground space-y-0.5">
          {trades.filter(t => t.partialExits.length > 0).map(t => (
            <div key={t.id} className="flex gap-2">
              <span>{t.strike} {t.direction.includes("CALL") ? "CE" : "PE"}:</span>
              {t.partialExits.map((pe, i) => (
                <span key={i} className={pe.pnl > 0 ? "text-emerald-400" : "text-red-400"}>
                  {pe.percent}% @ ₹{pe.price} (PnL: ₹{pe.pnl.toFixed(0)})
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-border pt-1 flex justify-between text-[10px]">
        <span className="text-muted-foreground">Daily P&L</span>
        <span
          className={`font-bold ${
            pnl > 0
              ? "text-emerald-400"
              : pnl < 0
                ? "text-red-400"
                : "text-muted-foreground"
          }`}
        >
          {pnl > 0 ? "+" : ""}
          ₹{pnl.toFixed(0)}
        </span>
      </div>
    </div>
  );
}
