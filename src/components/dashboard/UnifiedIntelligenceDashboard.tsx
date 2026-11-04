// Unified Intelligence Dashboard — Phase F
//
// ONE dashboard tab for the Unified Intraday Intelligence Engine.
// Displays the coordinator decision (BUY CE / BUY PE / WAIT) plus all
// 20 spec sections in a single consolidated view.
//
// Reuses existing SDMApp UI conventions (shadcn/ui cards, badges, progress,
// DataFreshnessBadge). Does NOT modify existing tabs or dashboards.
// Research-only — no automatic trading or Telegram integration.

"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Brain, TrendingUp, TrendingDown, AlertTriangle, Activity, BarChart3,
  RefreshCw, Shield, Target, Zap, ChevronDown, ChevronUp, Minus, Clock,
  ArrowUp, ArrowDown, LayoutGrid, List, Timer, Activity as ActivityIcon,
  Users,
} from "lucide-react";
import { DataFreshnessBadge } from "./DataFreshnessBadge";

function fmtPct(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

function fmtMoney(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toFixed(d)}`;
}

function decisionColor(decision: string): string {
  switch (decision) {
    case "BUY_CE": return "bg-emerald-600 text-white";
    case "BUY_PE": return "bg-red-600 text-white";
    case "WAIT": return "bg-amber-600 text-white";
    default: return "bg-zinc-600 text-white";
  }
}

function confidenceColor(c: number): string {
  if (c >= 75) return "text-emerald-500";
  if (c >= 55) return "text-amber-500";
  if (c >= 30) return "text-orange-500";
  return "text-red-500";
}

interface UnifiedIntelligenceDashboardProps {
  symbol?: string;
}

export function UnifiedIntelligenceDashboard({ symbol = "NIFTY" }: UnifiedIntelligenceDashboardProps) {
  const [selectedTab, setSelectedTab] = useState("overview");

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["unified-intelligence", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/unified-intelligence?symbol=${symbol}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error("Unified intelligence failed");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-6 text-center">
          <div className="animate-pulse space-y-3">
            <div className="h-8 w-8 rounded-full bg-zinc-800 mx-auto" />
            <div className="h-1 bg-zinc-800 rounded w-1/2 mx-auto" />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Loading Unified Intelligence Engine…
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data || !data.success) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-6">
          <AlertTriangle className="h-5 w-5 text-amber-500 mb-2" />
          <p className="text-xs text-zinc-400">
            Unified intelligence unavailable — {data?.error || "no data"}
          </p>
        </CardContent>
      </Card>
    );
  }

  const r = data;
  const decision = r.decision;
  const confidence = r.confidence ?? 0;
  const mechanism = r.mechanism;
  const marketContext = r.marketContext;
  const derivatives = r.derivatives;
  const moduleEvidence = r.moduleEvidence ?? [];
  const conflicts = r.conflicts ?? [];
  const tradePlan = r.tradePlan;

  return (
    <div className="space-y-4">
      {/* Header with decision + refresh */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-600 to-teal-600 flex items-center justify-center">
            <Brain className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-sm font-bold">Unified Intraday Intelligence</h2>
            <p className="text-[9px] text-muted-foreground">
              One coordinator · Five modules · BUY CE / BUY PE / WAIT
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge className={`text-[10px] ${decisionColor(decision)} px-3 py-1`}>
            {decision === "BUY_CE" ? "BUY CE" : decision === "BUY_PE" ? "BUY PE" : decision}
          </Badge>
          <Badge className={`text-[10px] ${confidenceColor(confidence)} px-3 py-1`}>
            Confidence {confidence}%
          </Badge>
          <Badge className={`text-[10px] bg-zinc-700 text-zinc-200 px-3 py-1`}>
            {r.evidenceStrength ?? "ABSENT"}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-7 text-[9px] gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ─── Section 1: Overall Market Overview ─── */}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs font-bold flex items-center gap-1">
            <Activity className="h-3 w-3" /> 1. Overall Market Overview
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
            <div>
              <span className="text-muted-foreground">Decision</span>
              <div className={`font-bold ${decisionColor(decision)}`}>
                {decision === "BUY_CE" ? "BUY CE" : decision === "BUY_PE" ? "BUY PE" : "WAIT / NO TRADE"}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Confidence</span>
              <div className={`font-bold ${confidenceColor(confidence)}`}>
                {confidence}%
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Evidence</span>
              <div className={`font-bold ${confidenceColor(confidence)}`}>
                {r.evidenceStrength ?? "ABSENT"}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Context Quality</span>
              <div className={`font-bold ${
                marketContext.contextQuality === "HIGH" ? "text-emerald-500" :
                marketContext.contextQuality === "MEDIUM" ? "text-amber-500" :
                marketContext.contextQuality === "LOW" ? "text-orange-500" : "text-red-500"
              }`}>
                {marketContext.contextQuality}
              </div>
            </div>
          </div>
          {r.missingInputs?.length > 0 && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded p-2">
              <span className="text-[9px] text-amber-500 font-bold">Missing critical inputs:</span>
              <ul className="text-[9px] text-amber-400 mt-1 list-disc list-inside space-y-0.5">
                {r.missingInputs.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Section 2: Unified Market Regime + 3: India VIX + 4: FII/DII ─── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-bold flex items-center gap-1">
              <Zap className="h-3 w-3" /> 2. Market Regime
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            <div className="flex items-center gap-2">
              <Badge className={`px-3 py-1 ${
                mechanism.control === "bullish" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" :
                mechanism.control === "bearish" ? "bg-red-500/20 text-red-400 border-red-500/30" :
                "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
              }`}>
                {mechanism.control.toUpperCase()}
              </Badge>
              <span className="text-muted-foreground">Mechanism:</span>
              <span className="font-bold">{mechanism.mechanism.replace(/_/g, " ").toUpperCase()}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Regime:</span>
              <span className="font-bold">{mechanism.regime}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Confirmation:</span>
              <span className={`font-bold ${
                mechanism.confirmationStatus === "CONFIRMED" ? "text-emerald-500" :
                mechanism.confirmationStatus === "PARTIAL" ? "text-amber-500" : "text-red-500"
              }`}>
                {mechanism.confirmationStatus}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-bold flex items-center gap-1">
              <ActivityIcon className="h-3 w-3" /> 3. India VIX
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            {marketContext.vix.available && marketContext.vix.value ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Value</span>
                  <span className="font-bold">{marketContext.vix.value.value?.toFixed(1)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Change</span>
                  <span className={`font-bold ${
                    (marketContext.vix.value.change ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"
                  }`}>
                    {(marketContext.vix.value.change ?? 0) >= 0 ? "+" : ""}{marketContext.vix.value.change?.toFixed(1)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Regime</span>
                  <span className="font-bold">{marketContext.vix.value.regime?.toUpperCase()}</span>
                </div>
              </>
            ) : (
              <p className="text-[9px] text-zinc-500">India VIX unavailable</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-bold flex items-center gap-1">
              <Users className="h-3 w-3" /> 4. FII / DII Flow
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            {marketContext.fiiDii.available && marketContext.fiiDii.value ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">FII Net</span>
                  <span className={`font-bold ${
                    (marketContext.fiiDii.value.fiiNet ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"
                  }`}>
                    ₹{(marketContext.fiiDii.value.fiiNet ?? 0).toFixed(0)} Cr
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">DII Net</span>
                  <span className={`font-bold ${
                    (marketContext.fiiDii.value.diiNet ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"
                  }`}>
                    ₹{(marketContext.fiiDii.value.diiNet ?? 0).toFixed(0)} Cr
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Flow Trend</span>
                  <span className="font-bold text-zinc-200">
                    {marketContext.fiiDii.value.flowTrend ?? "NEUTRAL"}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-[9px] text-zinc-500">FII/DII unavailable</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Section 5: Sector Rotation Heatmap ─── */}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs font-bold flex items-center gap-1">
            <BarChart3 className="h-3 w-3" /> 5. Sector Rotation Heatmap
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {marketContext.sectorBreadth.available ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-muted-foreground">Advancing</span>
                <span className="font-bold text-emerald-500">{marketContext.sectorBreadth.value?.advancing ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-muted-foreground">Declining</span>
                <span className="font-bold text-red-500">{marketContext.sectorBreadth.value?.declining ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-muted-foreground">Unchanged</span>
                <span className="font-bold text-zinc-400">{marketContext.sectorBreadth.value?.unchanged ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] mb-2">
                <span className="text-muted-foreground">% Advancing</span>
                <span className="font-bold">{marketContext.sectorBreadth.value?.pctAdvancing?.toFixed(0) ?? "—"}%</span>
              </div>
              <div className="text-[9px] text-zinc-500">
                Sector regime: {marketContext.sectorBreadth.value?.regime ?? "—"}
              </div>
            </div>
          ) : (
            <p className="text-[9px] text-zinc-500">Sector breadth unavailable</p>
          )}
        </CardContent>
      </Card>

      {/* ─── Tabs: Details / Conflicts / Trade Plan ─── */}
      <Tabs defaultValue="overview" value={selectedTab} onValueChange={setSelectedTab}>
        <TabsList className="grid w-full grid-cols-3 text-[10px]">
          <TabsTrigger value="overview" className="px-2 py-1">Module Evidence</TabsTrigger>
          <TabsTrigger value="conflicts" className="px-2 py-1">Conflicts</TabsTrigger>
          <TabsTrigger value="tradeplan" className="px-2 py-1">Trade Plan</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="p-3 space-y-3">
          {moduleEvidence.map((m, i) => (
            <Card key={i}>
              <CardHeader className="p-2 pb-1">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-bold">{m.module.replace(/_/g, " ")}</CardTitle>
                  <Badge className={`text-[9px] px-2 ${
                    m.available ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" :
                    "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
                  }`}>
                    {m.available ? "Available" : "Unavailable"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-2 pt-0 space-y-1">
                <div className="flex items-center justify-between text-[9px] mb-1">
                  <span className="text-muted-foreground">Confidence</span>
                  <span className={`font-bold ${confidenceColor(m.confidence)}`}>{m.confidence}%</span>
                </div>
                <div className="space-y-1">
                  {m.keyFindings.map((f, j) => (
                    <div key={j} className="text-[9px] text-zinc-300">• {f}</div>
                  ))}
                </div>
                {m.blockers.length > 0 && (
                  <div className="space-y-0.5 mt-1">
                    <span className="text-[9px] text-amber-500 font-bold">Blockers:</span>
                    {m.blockers.map((b, j) => (
                      <div key={j} className="text-[9px] text-amber-400">⚠ {b}</div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="conflicts" className="p-3 space-y-2">
          {conflicts.length > 0 ? (
            conflicts.map((c, i) => (
              <Card key={i}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[9px] font-bold">{c.type}</span>
                    <Badge className={`text-[9px] px-2 ${
                      c.severity === "HIGH" ? "bg-red-500/20 text-red-400 border-red-500/30" :
                      c.severity === "MEDIUM" ? "bg-amber-500/20 text-amber-400 border-amber-500/30" :
                      "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
                    }`}>
                      {c.severity}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-zinc-300">{c.description}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-[9px] text-muted-foreground">Side:</span>
                    <span className="text-[9px] font-bold">{c.side.toUpperCase()}</span>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <p className="text-[9px] text-zinc-500 text-center py-4">No conflicts detected</p>
          )}
        </TabsContent>

        <TabsContent value="tradeplan" className="p-3 space-y-3">
          {tradePlan && tradePlan.tradable ? (
            <>
              <Card>
                <CardHeader className="p-2 pb-1">
                  <CardTitle className="text-xs font-bold flex items-center gap-1">
                    <Target className="h-3 w-3" /> Trade Plan
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0 space-y-2">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">Option Type</span>
                      <div className="font-bold">{tradePlan.optionType}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Strike</span>
                      <div className="font-bold">{fmtMoney(tradePlan.strike)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Expiry</span>
                      <div className="font-bold">{tradePlan.expiry ?? "—"}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Lots</span>
                      <div className="font-bold">{tradePlan.lots}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Entry Premium</span>
                      <div className="font-bold">{fmtMoney(tradePlan.entryPremium)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Stop Loss</span>
                      <div className="font-bold text-red-500">{fmtMoney(tradePlan.stopLoss)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Deployed</span>
                      <div className="font-bold">{fmtMoney(tradePlan.deployedAmount)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Risk Amount</span>
                      <div className="font-bold text-red-500">{fmtMoney(tradePlan.riskAmount)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">R:R</span>
                      <div className={`font-bold ${
                        (tradePlan.riskReward ?? 0) >= 2 ? "text-emerald-500" : "text-red-500"
                      }`}>
                        {tradePlan.riskReward?.toFixed(2) ?? "—"}
                      </div>
                    </div>
                    {tradePlan.targets.map((t, i) => (
                      <div key={i}>
                        <span className="text-muted-foreground">Target {i + 1}</span>
                        <div className="font-bold text-emerald-500">{fmtMoney(t)}</div>
                      </div>
                    ))}
                  </div>
                  {tradePlan.reason && (
                    <div className="text-[9px] text-zinc-500">{tradePlan.reason}</div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-[9px] text-zinc-500">
                  No trade plan available — decision is {decision === "WAIT" ? "WAIT" : "NO_TRADE"}.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ─── Section 20: Data Quality & Provider Status ─── */}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs font-bold flex items-center gap-1">
            <Shield className="h-3 w-3" /> 20. Data Quality & Provider Status
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">Indicators Sufficient</span>
              <Badge className={`text-[9px] px-2 ${
                r.dataQuality?.indicatorsSufficient ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" :
                "bg-red-500/20 text-red-400 border-red-500/30"
              }`}>
                {r.dataQuality?.indicatorsSufficient ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">SMC Sufficient</span>
              <Badge className={`text-[9px] px-2 ${
                r.dataQuality?.smcSufficient ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" :
                "bg-red-500/20 text-red-400 border-red-500/30"
              }`}>
                {r.dataQuality?.smcSufficient ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">Derivatives Available</span>
              <Badge className={`text-[9px] px-2 ${
                r.dataQuality?.derivativesAvailable ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" :
                "bg-red-500/20 text-red-400 border-red-500/30"
              }`}>
                {r.dataQuality?.derivativesAvailable ? "Yes" : "No"}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2">
        <span className="text-[9px] text-zinc-500">
          Research-only — not financial advice. No automatic execution.
        </span>
        <span className="text-[9px] text-zinc-500">
          {new Date(r.timestamp).toLocaleString("en-IN")}
        </span>
      </div>
    </div>
  );
}
