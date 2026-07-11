"use client";

import { useState, useEffect, useCallback } from "react";
import {
  History,
  TrendingUp,
  TrendingDown,
  Minus,
  Trophy,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { useTerminalStore } from "@/stores/useTerminalStore";

interface Trade {
  tradeId: string;
  symbol: string;
  strike: number;
  optionType: string;
  direction: string;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  status: string;
  entryTime: string;
  exitTime: string | null;
}

interface TradeStats {
  total: number;
  open: number;
  closed: number;
  winRate: number;
  totalPnL: number;
}

function formatIST(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    OPEN: { label: "OPEN", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    TP_HIT: { label: "TP", className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    SL_HIT: { label: "SL", className: "bg-red-500/20 text-red-400 border-red-500/30" },
    EXPIRED: { label: "EXP", className: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30" },
    CLOSED: { label: "CLS", className: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30" },
  };
  const c = config[status] || config.CLOSED;
  return (
    <Badge variant="outline" className={`text-[8px] px-1 py-0 h-3 font-mono ${c.className}`}>
      {c.label}
    </Badge>
  );
}

export function TradeHistory() {
  const { symbol, expiry } = useTerminalStore();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ symbol });
      if (expiry) params.set('expiry', expiry);
      const res = await fetch(`/api/trade-journal?${params.toString()}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error("No data");

      setTrades((json.trades || []).slice(0, 20));
      setStats(json.stats || null);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [symbol, expiry]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const bestTrade = trades.reduce(
    (best, t) => ((t.pnl ?? 0) > (best?.pnl ?? -Infinity) ? t : best),
    trades[0]
  );
  const worstTrade = trades.reduce(
    (worst, t) => ((t.pnl ?? 0) < (worst?.pnl ?? Infinity) ? t : worst),
    trades[0]
  );

  return (
    <Card className="bg-[#0d1117] border-white/5 h-full flex flex-col overflow-hidden">
      <CardHeader className="py-2 px-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <History className="size-3.5 text-amber-400" />
            Trade History
          </CardTitle>
          <button
            onClick={() => {
              setLoading(true);
              fetchData();
            }}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden flex flex-col">
        {loading ? (
          <div className="p-3 space-y-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-7 bg-white/5 animate-pulse rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">Data unavailable</div>
        ) : trades.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">No trades recorded</div>
        ) : (
          <>
            <ScrollArea className="flex-1">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/5 hover:bg-transparent">
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1">Date</TableHead>
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1">Sym</TableHead>
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1">Stk</TableHead>
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1">Type</TableHead>
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1 text-right">Entry</TableHead>
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1 text-right">Exit</TableHead>
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1 text-right">P&L</TableHead>
                    <TableHead className="text-[8px] text-zinc-500 h-5 px-1">St</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.map((t) => (
                    <TableRow key={t.tradeId} className="border-white/5 text-[9px] font-mono tabular-nums">
                      <TableCell className="px-1 py-0.5 text-zinc-500">
                        {formatIST(t.entryTime)}
                      </TableCell>
                      <TableCell className="px-1 py-0.5 text-zinc-300 font-semibold">
                        {t.symbol?.slice(0, 4) || "-"}
                      </TableCell>
                      <TableCell className="px-1 py-0.5 text-zinc-400">
                        {t.strike ? Math.round(t.strike) : "-"}
                      </TableCell>
                      <TableCell className="px-1 py-0.5">
                        <Badge
                          variant="outline"
                          className={`text-[7px] px-1 py-0 h-3 font-mono ${
                            t.optionType === "CE" || t.direction?.includes("CALL")
                              ? "text-emerald-400 border-emerald-500/30"
                              : "text-red-400 border-red-500/30"
                          }`}
                        >
                          {t.optionType || t.direction?.slice(-2) || "?"}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-1 py-0.5 text-zinc-300 text-right">
                        ₹{t.entryPrice?.toFixed(1) || "-"}
                      </TableCell>
                      <TableCell className="px-1 py-0.5 text-zinc-400 text-right">
                        {t.exitPrice ? "₹" + t.exitPrice.toFixed(1) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-right font-semibold ${
                        (t.pnl ?? 0) > 0 ? "text-emerald-400" : (t.pnl ?? 0) < 0 ? "text-red-400" : "text-zinc-500"
                      }`}>
                        {t.pnl != null ? (t.pnl > 0 ? "+" : "") + "₹" + t.pnl.toFixed(0) : "-"}
                      </TableCell>
                      <TableCell className="px-1 py-0.5">
                        <StatusBadge status={t.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>

            {/* Stats Footer */}
            {stats && (
              <>
                <Separator className="bg-white/5" />
                <div className="p-2 grid grid-cols-2 gap-2 text-[9px]">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Total P&L</span>
                    <span className={`font-mono font-semibold tabular-nums ${
                      stats.totalPnL > 0 ? "text-emerald-400" : stats.totalPnL < 0 ? "text-red-400" : "text-zinc-400"
                    }`}>
                      {stats.totalPnL > 0 ? "+" : ""}₹{stats.totalPnL.toLocaleString("en-IN")}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Win Rate</span>
                    <span className={`font-mono font-semibold tabular-nums ${
                      stats.winRate >= 50 ? "text-emerald-400" : "text-red-400"
                    }`}>
                      {stats.winRate}%
                    </span>
                  </div>
                  {bestTrade && bestTrade.pnl != null && bestTrade.pnl > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500 flex items-center gap-0.5">
                        <Trophy className="size-2 text-amber-400" /> Best
                      </span>
                      <span className="text-emerald-400 font-mono tabular-nums">
                        +₹{bestTrade.pnl.toFixed(0)}
                      </span>
                    </div>
                  )}
                  {worstTrade && worstTrade.pnl != null && worstTrade.pnl < 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500 flex items-center gap-0.5">
                        <AlertTriangle className="size-2 text-red-400" /> Worst
                      </span>
                      <span className="text-red-400 font-mono tabular-nums">
                        ₹{worstTrade.pnl.toFixed(0)}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
