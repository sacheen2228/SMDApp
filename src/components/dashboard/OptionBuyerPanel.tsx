"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Target, Shield, Zap, RefreshCw, Clock, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Trade {
  symbol: string;
  direction: "CE" | "PE";
  action: "BUY";
  strike: number;
  spotPrice: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  confidence: number;
  score: number;
  expiry: string;
  daysToExpiry: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  iv: number;
  oi: number;
  volume: number;
  confluence: {
    vixRegime: string;
    timeWindow: string;
    gapTrap: boolean;
    correlation: string;
    ivRank: string;
    eventRisk: string;
  };
  reasons: string[];
  timestamp: string;
}

function fmt(n: number | undefined | null, d = 1): string {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function directionColor(dir: string): string {
  return dir === "CE" ? "text-emerald-500" : "text-red-500";
}

function directionBg(dir: string): string {
  return dir === "CE" ? "bg-emerald-500/10 border-emerald-500/30" : "bg-red-500/10 border-red-500/30";
}

function vixRegimeColor(regime: string): string {
  switch (regime) {
    case "COMPLACENT": return "bg-emerald-500/10 text-emerald-500";
    case "CALM": return "bg-blue-500/10 text-blue-500";
    case "NORMAL": return "bg-yellow-500/10 text-yellow-500";
    case "ELEVATED": return "bg-orange-500/10 text-orange-500";
    case "FEAR": return "bg-red-500/10 text-red-500";
    default: return "bg-muted text-muted-foreground";
  }
}

function timeWindowColor(tw: string): string {
  switch (tw) {
    case "WINDOW_1": case "WINDOW_2": return "bg-emerald-500/10 text-emerald-500";
    case "GAP_TRAP": case "LUNCH_CHOP": return "bg-red-500/10 text-red-500";
    case "EXIT_ZONE": return "bg-orange-500/10 text-orange-500";
    default: return "bg-muted text-muted-foreground";
  }
}

function TradeCard({ trade }: { trade: Trade }) {
  const riskAmt = trade.entry - trade.stopLoss;
  const reward1 = trade.tp1 - trade.entry;
  const reward2 = trade.tp2 - trade.entry;
  const riskPct = (riskAmt / trade.entry) * 100;

  return (
    <Card className={`border ${directionBg(trade.direction)} overflow-hidden`}>
      <CardHeader className="p-2 pb-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {trade.direction === "CE" ? (
              <TrendingUp className="w-4 h-4 text-emerald-500" />
            ) : (
              <TrendingDown className="w-4 h-4 text-red-500" />
            )}
            <span className="font-bold text-sm">{trade.symbol}</span>
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${directionColor(trade.direction)}`}>
              {trade.direction} BUY
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${trade.score >= 70 ? "bg-emerald-500/10 text-emerald-500" : trade.score >= 50 ? "bg-yellow-500/10 text-yellow-500" : "bg-red-500/10 text-red-500"}`}>
              {trade.score}/100
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-2 pt-0 space-y-2">
        {/* Strike + Spot */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Strike</span>
          <span className="font-mono font-bold">{fmt(trade.strike, 0)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Spot</span>
          <span className="font-mono">{fmt(trade.spotPrice, 1)}</span>
        </div>

        {/* Entry / SL / TP Grid */}
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          <div className="bg-emerald-500/5 rounded p-1.5">
            <div className="text-muted-foreground flex items-center gap-1">
              <Zap className="w-3 h-3" /> Entry
            </div>
            <div className="font-mono font-bold text-emerald-500">₹{fmt(trade.entry)}</div>
          </div>
          <div className="bg-red-500/5 rounded p-1.5">
            <div className="text-muted-foreground flex items-center gap-1">
              <Shield className="w-3 h-3" /> SL
            </div>
            <div className="font-mono font-bold text-red-500">₹{fmt(trade.stopLoss)}</div>
            <div className="text-[9px] text-red-400">-{fmt(riskPct)}%</div>
          </div>
          <div className="bg-blue-500/5 rounded p-1.5">
            <div className="text-muted-foreground flex items-center gap-1">
              <Target className="w-3 h-3" /> TP1
            </div>
            <div className="font-mono font-bold text-blue-500">₹{fmt(trade.tp1)}</div>
            <div className="text-[9px] text-blue-400">+{fmt((reward1 / trade.entry) * 100)}%</div>
          </div>
          <div className="bg-blue-500/5 rounded p-1.5">
            <div className="text-muted-foreground flex items-center gap-1">
              <Target className="w-3 h-3" /> TP2
            </div>
            <div className="font-mono font-bold text-blue-500">₹{fmt(trade.tp2)}</div>
            <div className="text-[9px] text-blue-400">+{fmt((reward2 / trade.entry) * 100)}%</div>
          </div>
        </div>

        {/* TP3 + R:R */}
        <div className="flex items-center justify-between text-xs">
          <div>
            <span className="text-muted-foreground">TP3: </span>
            <span className="font-mono font-bold text-blue-500">₹{fmt(trade.tp3)}</span>
          </div>
          <Badge variant="outline" className={`text-[10px] ${trade.riskReward >= 2 ? "bg-emerald-500/10 text-emerald-500" : trade.riskReward >= 1.5 ? "bg-yellow-500/10 text-yellow-500" : "bg-red-500/10 text-red-500"}`}>
            R:R 1:{fmt(trade.riskReward)}
          </Badge>
        </div>

        {/* Greeks row */}
        <div className="flex gap-2 text-[10px] text-muted-foreground">
          <span>Δ {fmt(trade.greeks.delta, 2)}</span>
          <span>Γ {fmt(trade.greeks.gamma, 3)}</span>
          <span>Θ {fmt(trade.greeks.theta, 2)}</span>
          <span>V {fmt(trade.greeks.vega, 2)}</span>
        </div>

        {/* Confluence badges */}
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className={`text-[9px] px-1 py-0 ${vixRegimeColor(trade.confluence.vixRegime)}`}>
            VIX: {trade.confluence.vixRegime}
          </Badge>
          <Badge variant="outline" className={`text-[9px] px-1 py-0 ${timeWindowColor(trade.confluence.timeWindow)}`}>
            <Clock className="w-2.5 h-2.5 mr-0.5" /> {trade.confluence.timeWindow.replace("_", " ")}
          </Badge>
          {trade.confluence.gapTrap && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 bg-orange-500/10 text-orange-500">
              <AlertTriangle className="w-2.5 h-2.5 mr-0.5" /> GAP TRAP
            </Badge>
          )}
          <Badge variant="outline" className="text-[9px] px-1 py-0 bg-muted text-muted-foreground">
            IV: {trade.confluence.ivRank}
          </Badge>
        </div>

        {/* Reasons */}
        {trade.reasons.length > 0 && (
          <div className="text-[10px] text-muted-foreground space-y-0.5">
            {trade.reasons.slice(0, 3).map((r, i) => (
              <div key={i}>• {r}</div>
            ))}
          </div>
        )}

        {/* Expiry + Timestamp */}
        <div className="flex items-center justify-between text-[9px] text-muted-foreground pt-1 border-t">
          <span>Exp: {trade.expiry} ({trade.daysToExpiry}d)</span>
          <span>{new Date(trade.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function OptionBuyerPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["option-buyer"],
    queryFn: async () => {
      const res = await fetch("/api/option-buyer");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const trades: Trade[] = data?.trades || [];
  const ceTrades = trades.filter(t => t.direction === "CE");
  const peTrades = trades.filter(t => t.direction === "PE");

  return (
    <Card className="border-border/50">
      <CardHeader className="p-2 pb-1">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-yellow-500" />
            Option Buyer — Live Setups
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[9px] ${data?.isMarketOpen ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>
              {data?.session || "—"}
            </Badge>
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        {isLoading ? (
          <div className="text-center text-xs text-muted-foreground py-4">Loading live option chain...</div>
        ) : error ? (
          <div className="text-center text-xs text-red-400 py-4">Failed to load data</div>
        ) : trades.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-4">
            No qualifying setups (score ≥ 50 required)
          </div>
        ) : (
          <div className="space-y-3">
            {/* CE BUY setups */}
            {ceTrades.length > 0 && (
              <div>
                <div className="text-[10px] font-medium text-emerald-500 mb-1.5 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" /> CE BUY ({ceTrades.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {ceTrades.map((t, i) => <TradeCard key={`ce-${i}`} trade={t} />)}
                </div>
              </div>
            )}

            {/* PE BUY setups */}
            {peTrades.length > 0 && (
              <div>
                <div className="text-[10px] font-medium text-red-500 mb-1.5 flex items-center gap-1">
                  <TrendingDown className="w-3 h-3" /> PE BUY ({peTrades.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {peTrades.map((t, i) => <TradeCard key={`pe-${i}`} trade={t} />)}
                </div>
              </div>
            )}

            {/* Summary */}
            <div className="text-[9px] text-muted-foreground text-center pt-1 border-t">
              {data?.total} setups • Source: {data?.source} • {new Date(data?.timestamp).toLocaleTimeString("en-IN")}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
