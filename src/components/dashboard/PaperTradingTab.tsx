// Hermes Paper Trading — Dashboard UI Component
// Clearly marked as PAPER. No real orders.
"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Play, Pause, RefreshCw, TrendingUp, TrendingDown, AlertTriangle,
  BarChart3, Clock, Target, Shield, Activity, Zap, FileText
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";

// ── Types ──────────────────────────────────────────────────────────────

interface WorkerStatus {
  status: string;
  lastSignalEvaluation: string | null;
  lastTradeMonitor: string | null;
  signalsToday: number;
  noTradeToday: number;
  errorCount: number;
  lastError: string | null;
  startedAt: string | null;
}

interface PaperAccount {
  startingCapital: number;
  currentCapital: number;
  realizedPnL: number;
  totalSignals: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  totalNoTrade: number;
  openTrades: number;
}

interface PaperTrade {
  id: string;
  signalId: string;
  createdAt: string;
  decision: string;
  underlying: string;
  strike: number;
  optionType: string;
  moneyness: string;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  target3?: number;
  status: string;
  exitPrice?: number;
  exitSource?: string;
  realizedPnL?: number;
  score: number;
  grade?: string;
  regime: string;
  provider: string;
  freshness: string;
  highestPremium?: number;
  lowestPremium?: number;
  maxFavorableExcursion?: number;
  maxFavorableExcursionPct?: number;
  maxAdverseExcursion?: number;
  maxAdverseExcursionPct?: number;
  holdingTimeMs?: number;
  spotAtSignal: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  iv?: number;
}

interface NoTradeObs {
  id: string;
  createdAt: string;
  underlying: string;
  spotAtObservation: number;
  score: number;
  regime: string;
  classification?: string;
  provider: string;
  freshness: string;
  blockingConditions: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmt(n: number | undefined | null, decimals = 2): string {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pnlColor(n: number | undefined | null): string {
  if (n == null) return "text-muted-foreground";
  return n >= 0 ? "text-emerald-500" : "text-red-500";
}

function statusBadge(status: string): { color: string; label: string } {
  switch (status) {
    case "OPEN": return { color: "bg-blue-500/10 text-blue-500 border-blue-500/30", label: "OPEN" };
    case "TP1_HIT": return { color: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30", label: "TP1 ✓" };
    case "TP2_HIT": return { color: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30", label: "TP2 ✓" };
    case "TP3_HIT": return { color: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30", label: "TP3 ✓" };
    case "SL_HIT": return { color: "bg-red-500/10 text-red-500 border-red-500/30", label: "SL ✗" };
    case "TIME_EXIT": return { color: "bg-amber-500/10 text-amber-500 border-amber-500/30", label: "TIME" };
    case "EXPIRED": return { color: "bg-orange-500/10 text-orange-500 border-orange-500/30", label: "EXPIRED" };
    default: return { color: "bg-muted text-muted-foreground", label: status };
  }
}

function classBadge(cls?: string): { color: string; label: string } {
  switch (cls) {
    case "GOOD_AVOIDANCE": return { color: "bg-emerald-500/10 text-emerald-500", label: "GOOD AVOIDANCE" };
    case "MISSED_OPPORTUNITY": return { color: "bg-red-500/10 text-red-500", label: "MISSED OPP" };
    case "NEUTRAL": return { color: "bg-muted text-muted-foreground", label: "NEUTRAL" };
    case "INSUFFICIENT_DATA": return { color: "bg-amber-500/10 text-amber-500", label: "NO DATA" };
    default: return { color: "bg-blue-500/10 text-blue-500", label: "PENDING" };
  }
}

// ── Main Component ─────────────────────────────────────────────────────

export default function PaperTradingTab() {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [openTrades, setOpenTrades] = useState<PaperTrade[]>([]);
  const [closedTrades, setClosedTrades] = useState<PaperTrade[]>([]);
  const [noTradeObs, setNoTradeObs] = useState<NoTradeObs[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("active");
  const [filterDays, setFilterDays] = useState<"today" | "7" | "30" | "all">("today");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/hermes/paper");
      const json = await res.json();
      if (json.success) {
        setStatus(json.data.status);
        setAccount(json.data.account);
      }

      const openRes = await fetch("/api/hermes/paper/open");
      const openJson = await openRes.json();
      if (openJson.success) setOpenTrades(openJson.data);

      const histRes = await fetch("/api/hermes/paper/history?limit=200");
      const histJson = await histRes.json();
      if (histJson.success) setClosedTrades(histJson.data);

      const ntRes = await fetch("/api/hermes/paper/no-trade");
      const ntJson = await ntRes.json();
      if (ntJson.success) setNoTradeObs(ntJson.data);
    } catch (err) {
      console.error("Failed to fetch paper data:", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000); // refresh every 10s
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleStart = async () => {
    setLoading(true);
    try {
      await fetch("/api/hermes/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await fetch("/api/hermes/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  // Filter closed trades by time
  const filteredClosed = closedTrades.filter((t) => {
    if (filterDays === "all") return true;
    const d = new Date(t.createdAt);
    const now = new Date();
    if (filterDays === "today") {
      return d.toDateString() === now.toDateString();
    }
    const days = parseInt(filterDays);
    const cutoff = new Date(now.getTime() - days * 86400_000);
    return d >= cutoff;
  });

  const isRunning = status?.status === "RUNNING";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-amber-500/5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold text-amber-500 tracking-wider">🟡 HERMES PAPER TRADING</span>
          <Badge variant="outline" className={`text-[9px] ${isRunning ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30" : "bg-muted text-muted-foreground"}`}>
            {isRunning ? "● RUNNING" : "○ STOPPED"}
          </Badge>
          <Badge variant="outline" className="text-[9px] bg-amber-500/10 text-amber-500 border-amber-500/30">
            PAPER ONLY — NO REAL ORDERS
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant={isRunning ? "destructive" : "default"}
            size="sm"
            className="h-6 text-[9px] px-2"
            onClick={isRunning ? handleStop : handleStart}
            disabled={loading}
          >
            {isRunning ? <Pause className="h-2.5 w-2.5 mr-1" /> : <Play className="h-2.5 w-2.5 mr-1" />}
            {isRunning ? "STOP" : "START"}
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-[9px] px-2" onClick={fetchData}>
            <RefreshCw className="h-2.5 w-2.5" />
          </Button>
        </div>
      </div>

      {/* ── Account Summary ── */}
      {account && (
        <div className="grid grid-cols-6 gap-2 px-3 py-2 border-b">
          <div className="text-center">
            <div className="text-[8px] text-muted-foreground uppercase">Starting</div>
            <div className="text-[11px] font-bold tabular-nums">₹{fmt(account.startingCapital, 0)}</div>
          </div>
          <div className="text-center">
            <div className="text-[8px] text-muted-foreground uppercase">Current</div>
            <div className="text-[11px] font-bold tabular-nums">₹{fmt(account.currentCapital, 0)}</div>
          </div>
          <div className="text-center">
            <div className="text-[8px] text-muted-foreground uppercase">Total P&L</div>
            <div className={`text-[11px] font-bold tabular-nums ${pnlColor(account.realizedPnL)}`}>
              {account.realizedPnL >= 0 ? "+" : ""}₹{fmt(account.realizedPnL)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[8px] text-muted-foreground uppercase">Open</div>
            <div className="text-[11px] font-bold tabular-nums">{account.openTrades}</div>
          </div>
          <div className="text-center">
            <div className="text-[8px] text-muted-foreground uppercase">Win Rate</div>
            <div className="text-[11px] font-bold tabular-nums">
              {account.totalWins + account.totalLosses > 0
                ? `${((account.totalWins / (account.totalWins + account.totalLosses)) * 100).toFixed(0)}%`
                : "—"}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[8px] text-muted-foreground uppercase">NO_TRADE</div>
            <div className="text-[11px] font-bold tabular-nums">{account.totalNoTrade}</div>
          </div>
        </div>
      )}

      {/* ── Tabs ── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 overflow-hidden flex flex-col">
        <TabsList className="mx-3 mt-1 h-7">
          <TabsTrigger value="active" className="text-[9px] h-5">
            Active ({openTrades.length})
          </TabsTrigger>
          <TabsTrigger value="closed" className="text-[9px] h-5">
            Closed ({closedTrades.length})
          </TabsTrigger>
          <TabsTrigger value="notrade" className="text-[9px] h-5">
            NO_TRADE ({noTradeObs.length})
          </TabsTrigger>
        </TabsList>

        {/* ── Active Trades ── */}
        <TabsContent value="active" className="flex-1 overflow-auto px-3 pb-2">
          {openTrades.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[10px] text-muted-foreground">
              No active paper trades
            </div>
          ) : (
            <div className="space-y-1.5">
              {openTrades.map((trade) => {
                const badge = statusBadge(trade.status);
                return (
                  <Card key={trade.signalId} className="border-border/50">
                    <CardContent className="p-2">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold">{trade.underlying}</span>
                          <Badge variant="outline" className={`text-[8px] ${trade.optionType === "CE" ? "text-blue-500" : "text-rose-500"}`}>
                            {trade.optionType}
                          </Badge>
                          <span className="text-[9px] text-muted-foreground">{trade.strike}</span>
                          <Badge variant="outline" className={`text-[8px] ${badge.color}`}>{badge.label}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-muted-foreground">Score: {trade.score}</span>
                          <span className="text-[8px] text-muted-foreground">{trade.regime}</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-8 gap-1 text-[9px] tabular-nums">
                        <div>
                          <span className="text-muted-foreground">Entry </span>
                          <span className="font-bold">₹{fmt(trade.entryPrice)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">SL </span>
                          <span className="text-red-500">₹{fmt(trade.stopLoss)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">TP1 </span>
                          <span className="text-emerald-500">₹{fmt(trade.target1)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">TP2 </span>
                          <span className="text-emerald-500">₹{fmt(trade.target2)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">MFE </span>
                          <span className="text-emerald-500">+₹{fmt(trade.maxFavorableExcursion)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">MAE </span>
                          <span className="text-red-500">-₹{fmt(Math.abs(trade.maxAdverseExcursion || 0))}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Provider </span>
                          <span>{trade.provider}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Data </span>
                          <span>{trade.freshness}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Closed Trades ── */}
        <TabsContent value="closed" className="flex-1 overflow-auto px-3 pb-2">
          <div className="flex items-center gap-1 mb-2">
            {(["today", "7", "30", "all"] as const).map((d) => (
              <Button
                key={d}
                variant={filterDays === d ? "default" : "ghost"}
                size="sm"
                className="h-5 text-[8px] px-1.5"
                onClick={() => setFilterDays(d)}
              >
                {d === "today" ? "Today" : d === "all" ? "All" : `${d}D`}
              </Button>
            ))}
          </div>
          {filteredClosed.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[10px] text-muted-foreground">
              No closed paper trades
            </div>
          ) : (
            <div className="space-y-1">
              {filteredClosed.map((trade) => {
                const badge = statusBadge(trade.status);
                return (
                  <Card key={trade.signalId} className="border-border/50">
                    <CardContent className="p-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] text-muted-foreground w-12">
                            {new Date(trade.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span className="text-[10px] font-bold">{trade.underlying}</span>
                          <Badge variant="outline" className={`text-[8px] ${trade.optionType === "CE" ? "text-blue-500" : "text-rose-500"}`}>
                            {trade.optionType}
                          </Badge>
                          <span className="text-[9px] text-muted-foreground">{trade.strike}</span>
                          <Badge variant="outline" className={`text-[8px] ${badge.color}`}>{badge.label}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[9px]">₹{fmt(trade.entryPrice)} → ₹{fmt(trade.exitPrice)}</span>
                          <span className={`text-[10px] font-bold ${pnlColor(trade.realizedPnL)}`}>
                            {trade.realizedPnL != null ? (trade.realizedPnL >= 0 ? "+" : "") + `₹${fmt(trade.realizedPnL)}` : "—"}
                          </span>
                          <span className="text-[8px] text-muted-foreground">{trade.provider}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── NO_TRADE Observations ── */}
        <TabsContent value="notrade" className="flex-1 overflow-auto px-3 pb-2">
          {noTradeObs.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[10px] text-muted-foreground">
              No NO_TRADE observations
            </div>
          ) : (
            <div className="space-y-1">
              {noTradeObs.map((obs) => {
                const cls = classBadge(obs.classification);
                let reasons: string[] = [];
                try { reasons = JSON.parse(obs.blockingConditions || "[]"); } catch {}
                return (
                  <Card key={obs.id} className="border-border/50">
                    <CardContent className="p-2">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] text-muted-foreground w-12">
                            {new Date(obs.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span className="text-[10px] font-bold">{obs.underlying}</span>
                          <Badge variant="outline" className="text-[8px] bg-muted text-muted-foreground">NO_TRADE</Badge>
                          <span className="text-[9px] text-muted-foreground">Score: {obs.score}</span>
                          <Badge variant="outline" className={`text-[8px] ${cls.color}`}>{cls.label}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-muted-foreground">{obs.regime}</span>
                          <span className="text-[8px] text-muted-foreground">{obs.provider}</span>
                        </div>
                      </div>
                      {reasons.length > 0 && (
                        <div className="text-[8px] text-muted-foreground ml-12">
                          {reasons.slice(0, 3).map((r: string, i: number) => (
                            <span key={i}>• {r} </span>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
