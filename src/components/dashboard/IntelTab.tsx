// Intel Tab — Market Decision Intelligence Center
// Preserves all existing panels + adds NSE OI, Derivative Flow, relative strength, research commentary
"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Brain, TrendingUp, TrendingDown, AlertTriangle, Activity, BarChart3,
  RefreshCw, Shield, Target, Zap, ChevronDown, ChevronUp, Minus
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarketRegimePanel } from "./MarketRegimePanel";
import { MarketBreadth } from "./MarketBreadth";
import { SectorRotation } from "./SectorRotation";
import { CASPanel } from "./CASPanel";
import { AlertCenter } from "./AlertCenter";
import { BestTradesNow } from "./BestTradesNow";
import { MarketHeatmap } from "./MarketHeatmap";
import { OptionBuyerPanel } from "./OptionBuyerPanel";

// ── Helpers ──────────────────────────────────────────────────────────

function fmt(n: number | undefined | null, d = 1): string {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function biasColor(bias: string): string {
  switch (bias) {
    case "BULLISH": return "text-emerald-500";
    case "BEARISH": return "text-red-500";
    case "MIXED": return "text-yellow-500";
    default: return "text-muted-foreground";
  }
}

function biasBadge(bias: string): string {
  switch (bias) {
    case "BULLISH": return "bg-emerald-500/10 text-emerald-500 border-emerald-500/30";
    case "BEARISH": return "bg-red-500/10 text-red-500 border-red-500/30";
    case "MIXED": return "bg-yellow-500/10 text-yellow-500 border-yellow-500/30";
    default: return "bg-muted text-muted-foreground";
  }
}

function confirmationColor(c: string): string {
  switch (c) {
    case "CONFIRMED": return "bg-emerald-500/10 text-emerald-500";
    case "PARTIAL": return "bg-yellow-500/10 text-yellow-500";
    case "CONFLICTING": return "bg-red-500/10 text-red-500";
    default: return "bg-muted text-muted-foreground";
  }
}

function regimeColor(r: string): string {
  switch (r) {
    case "LOW": return "text-emerald-500";
    case "NORMAL": return "text-blue-500";
    case "HIGH": return "text-orange-500";
    case "EXTREME": return "text-red-500";
    default: return "text-muted-foreground";
  }
}

function freshnessBadge(f: string): string {
  switch (f) {
    case "LIVE": return "bg-emerald-500/10 text-emerald-500";
    case "FRESH": return "bg-blue-500/10 text-blue-500";
    case "DELAYED": return "bg-yellow-500/10 text-yellow-500";
    case "STALE": return "bg-red-500/10 text-red-500";
    default: return "bg-muted text-muted-foreground";
  }
}

// ── Intel Summary Header ─────────────────────────────────────────────

function IntelSummary({ regime, breadth, derivative, cas }: {
  regime: any; breadth: any; derivative: any; cas: any;
}) {
  const regimeLabel = regime?.regime || "—";
  const breadthLabel = breadth ? (breadth.label || (breadth.score > 60 ? "BULLISH" : breadth.score < 40 ? "BEARISH" : "NEUTRAL")) : "—";
  const derivLabel = derivative?.bias || "—";
  const casLabel = cas?.casScore > 60 ? "ACCUMULATION" : cas?.casScore < 40 ? "DISTRIBUTION" : "NEUTRAL";

  // Overall conviction
  let overall = "NEUTRAL";
  let overallScore = 50;
  const biases = [regimeLabel, breadthLabel, derivLabel].filter(b => b && b !== "—");
  const bullish = biases.filter(b => b.includes("BULL")).length;
  const bearish = biases.filter(b => b.includes("BEAR")).length;
  if (bullish >= 2 && bearish === 0) { overall = "BULLISH"; overallScore = 72; }
  else if (bearish >= 2 && bullish === 0) { overall = "BEARISH"; overallScore = 28; }
  else if (bullish > 0 && bearish > 0) { overall = "CONFLICTING"; overallScore = 50; }

  const action = overall === "BULLISH" ? "FAVOR CE BUY AFTER CONFIRMATION"
    : overall === "BEARISH" ? "FAVOR PE BUY AFTER CONFIRMATION"
    : "NO TRADE — WAIT FOR ALIGNMENT";

  return (
    <Card className="border-border/50 bg-gradient-to-r from-amber-500/5 to-orange-500/5">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <Brain className="h-4 w-4 text-amber-500" />
          <span className="text-[11px] font-bold text-amber-500">HERMES MARKET INTELLIGENCE</span>
        </div>
        <div className="grid grid-cols-4 md:grid-cols-8 gap-2 text-[9px]">
          <div>
            <div className="text-muted-foreground uppercase">Market</div>
            <div className={`font-bold ${biasColor(regimeLabel)}`}>{regimeLabel}</div>
          </div>
          <div>
            <div className="text-muted-foreground uppercase">Breadth</div>
            <div className={`font-bold ${biasColor(breadthLabel)}`}>{breadthLabel}</div>
          </div>
          <div>
            <div className="text-muted-foreground uppercase">Derivative</div>
            <div className={`font-bold ${biasColor(derivLabel)}`}>{derivLabel}</div>
          </div>
          <div>
            <div className="text-muted-foreground uppercase">CAS</div>
            <div className={`font-bold ${casLabel === "ACCUMULATION" ? "text-emerald-500" : casLabel === "DISTRIBUTION" ? "text-red-500" : "text-muted-foreground"}`}>{casLabel}</div>
          </div>
          <div>
            <div className="text-muted-foreground uppercase">VIX</div>
            <div className="font-bold">{fmt(typeof regime?.vix === "object" ? regime?.vix?.value : regime?.vix, 0)}</div>
          </div>
          <div>
            <div className="text-muted-foreground uppercase">Index-Breadth</div>
            <div className={`font-bold ${bullish > 0 && bearish > 0 ? "text-red-500" : "text-emerald-500"}`}>
              {bullish > 0 && bearish > 0 ? "DIVERGENCE" : "ALIGNED"}
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-muted-foreground uppercase">Overall Conviction</div>
            <div className={`font-bold text-[11px] ${biasColor(overall)}`}>{overall} — {overallScore}/100</div>
          </div>
        </div>
        <div className="mt-2 text-[9px] text-muted-foreground border-t pt-2">
          <span className="font-semibold text-amber-500">Best Action:</span> {action}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Derivative Flow Panel ────────────────────────────────────────────

function DerivativeFlowPanel({ data }: { data: any }) {
  if (!data) return null;
  const { score, bias, components, putSupport, callResistance, gammaState, interpretation, confirmation } = data;

  return (
    <Card className="border-border/50">
      <CardHeader className="p-2 pb-1">
        <CardTitle className="text-[10px] font-bold flex items-center gap-1">
          <Zap className="h-3 w-3 text-amber-500" />
          NSE DERIVATIVE FLOW
          <Badge variant="outline" className={`text-[8px] ml-auto ${biasBadge(bias)}`}>{bias}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2 pt-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[9px] text-muted-foreground">Flow Score</span>
          <span className={`text-[11px] font-bold ${score >= 60 ? "text-emerald-500" : score <= 40 ? "text-red-500" : "text-yellow-500"}`}>{score}/100</span>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Put Support</span>
            <span className={putSupport === "STRONG" ? "text-emerald-500" : putSupport === "WEAKENING" ? "text-red-500" : ""}>{putSupport}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Call Resistance</span>
            <span className={callResistance === "HIGH" ? "text-red-500" : callResistance === "INCREASING" ? "text-orange-500" : ""}>{callResistance}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Gamma</span>
            <span>{gammaState}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Confirmation</span>
            <Badge variant="outline" className={`text-[8px] ${confirmationColor(confirmation)}`}>{confirmation}</Badge>
          </div>
        </div>

        {/* Component scores */}
        <div className="space-y-1">
          {Object.entries(components || {}).map(([key, comp]: [string, any]) => (
            <div key={key} className="flex items-center gap-1">
              <span className="text-[8px] text-muted-foreground w-16 truncate">{key}</span>
              <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${comp.score >= 60 ? "bg-emerald-500" : comp.score <= 40 ? "bg-red-500" : "bg-yellow-500"}`} style={{ width: `${comp.score}%` }} />
              </div>
              <span className="text-[8px] w-6 text-right">{comp.score}</span>
            </div>
          ))}
        </div>

        {interpretation && (
          <div className="text-[8px] text-muted-foreground border-t pt-1">{interpretation}</div>
        )}
      </CardContent>
    </Card>
  );
}

// ── OI Spurts Panel ──────────────────────────────────────────────────

function OISpurtPanel({ data }: { data: any }) {
  if (!data || data.totalSpurts === 0) {
    return (
      <Card className="border-border/50">
        <CardHeader className="p-2 pb-1">
          <CardTitle className="text-[10px] font-bold flex items-center gap-1">
            <Activity className="h-3 w-3 text-blue-500" />
            NSE OI SPURTS
          </CardTitle>
        </CardHeader>
        <CardContent className="p-2 pt-0">
          <div className="text-[9px] text-muted-foreground">No OI spurt data available</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="p-2 pb-1">
        <CardTitle className="text-[10px] font-bold flex items-center gap-1">
          <Activity className="h-3 w-3 text-blue-500" />
          NSE OI SPURTS
          <Badge variant="outline" className={`text-[8px] ml-auto ${biasBadge(data.overallBias)}`}>{data.overallBias}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2 pt-0 space-y-1.5">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Spurt Score</span>
            <span className="font-bold">{data.spurtScore}/100</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total Spurts</span>
            <span>{data.totalSpurts}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Long Buildup</span>
            <span className="text-emerald-500">{data.longBuildupCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Short Buildup</span>
            <span className="text-red-500">{data.shortBuildupCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Short Covering</span>
            <span className="text-blue-500">{data.shortCoveringCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Long Unwinding</span>
            <span className="text-orange-500">{data.longUnwindingCount}</span>
          </div>
        </div>

        {/* Top 5 OI Spurts */}
        {data.topSpurts?.length > 0 && (
          <div className="border-t pt-1 space-y-0.5">
            <div className="text-[8px] text-muted-foreground font-semibold">TOP OI SPURTS</div>
            {data.topSpurts.slice(0, 5).map((sp: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-[8px]">
                <div className="flex items-center gap-1">
                  <span className="font-bold">{sp.symbol}</span>
                  <Badge variant="outline" className={`text-[7px] ${sp.optionType === "CE" ? "text-blue-500" : "text-rose-500"}`}>{sp.optionType}</Badge>
                  <span className={sp.classification === "LONG_BUILDUP" ? "text-emerald-500" : sp.classification === "SHORT_BUILDUP" ? "text-red-500" : "text-muted-foreground"}>
                    {sp.classification.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span>Score {sp.spurtScore}</span>
                  <span>Vol {fmt(sp.volume / 1000, 0)}K</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Index-Breadth Divergence ─────────────────────────────────────────

function DivergencePanel({ regime, breadth }: { regime: any; breadth: any }) {
  if (!regime || !breadth) return null;

  const indexChange = regime?.niftyChange ?? 0;
  const adv = breadth.advances || 0;
  const dec = breadth.declines || 0;
  const isDivergent = (indexChange > 0.3 && dec > adv) || (indexChange < -0.3 && adv > dec);

  if (!isDivergent) return null;

  return (
    <Card className="border-red-500/30 bg-red-500/5">
      <CardContent className="p-2">
        <div className="flex items-center gap-1 mb-1">
          <AlertTriangle className="h-3 w-3 text-red-500" />
          <span className="text-[10px] font-bold text-red-500">INDEX-BREADTH DIVERGENCE</span>
        </div>
        <div className="text-[9px] text-muted-foreground">
          {indexChange > 0 ? `NIFTY +${fmt(indexChange)}%` : `NIFTY ${fmt(indexChange)}%`}
          {" "}but{" "}
          {adv > dec ? `${adv} advances` : `${dec} declines`} dominate.
          Index strength is not broadly supported by constituents. Directional continuation requires confirmation.
        </div>
      </CardContent>
    </Card>
  );
}

// ── Research Commentary ──────────────────────────────────────────────

function ResearchCommentary({ regime, breadth, derivative, oi, sector }: {
  regime: any; breadth: any; derivative: any; oi: any; sector: any;
}) {
  const parts: string[] = [];

  const regimeLabel = regime?.regime || "NEUTRAL";
  const breadthScore = breadth?.score || 50;
  const adv = breadth?.advances || 0;
  const dec = breadth?.declines || 0;
  const derivBias = derivative?.bias || "NEUTRAL";
  const oiBias = oi?.overallBias || "NEUTRAL";

  // Market
  parts.push(`Market regime is ${regimeLabel} with breadth at ${breadthScore}/100.`);
  parts.push(`${adv} constituents advancing against ${dec} declining.`);

  // Derivative
  if (derivBias !== "NEUTRAL") {
    parts.push(`Derivative flow shows ${derivBias.toLowerCase()} positioning.`);
  }

  // OI
  if (oiBias !== "NEUTRAL") {
    parts.push(`NSE OI spurts indicate ${oiBias.toLowerCase().replace(/_/g, " ")} activity.`);
  }

  // Action
  if (regimeLabel.includes("BEARISH") && derivBias === "BEARISH") {
    parts.push("Current preference: WAIT for confirmation or FAVOR PE BUY after structure confirmation.");
  } else if (regimeLabel.includes("BULLISH") && derivBias === "BULLISH") {
    parts.push("Current preference: FAVOR CE BUY after confirmation with defined risk.");
  } else {
    parts.push("Current preference: NO TRADE — conflicting signals. Wait for alignment.");
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="p-2 pb-1">
        <CardTitle className="text-[10px] font-bold flex items-center gap-1">
          <Brain className="h-3 w-3 text-amber-500" />
          HERMES RESEARCH VIEW
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        <div className="text-[9px] text-muted-foreground leading-relaxed space-y-1">
          {parts.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Intel Tab ───────────────────────────────────────────────────

export default function IntelTab({ onStockClick }: { onStockClick?: (s: string) => void }) {
  const [activeTab, setActiveTab] = useState("overview");

  // Fetch all data
  const { data: regimeData } = useQuery({
    queryKey: ["market-regime-intel"],
    queryFn: () => fetch("/api/market/regime").then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: breadthData } = useQuery({
    queryKey: ["market-breadth-intel"],
    queryFn: () => fetch("/api/market/breadth").then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: sectorData } = useQuery({
    queryKey: ["market-sectors-intel"],
    queryFn: () => fetch("/api/market/sectors").then(r => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const { data: oiData } = useQuery({
    queryKey: ["nse-oi-spurts"],
    queryFn: () => fetch("/api/nse/oi-spurts").then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: fiiDiiData } = useQuery({
    queryKey: ["fii-dii-intel"],
    queryFn: () => fetch("/api/fii-dii").then(r => r.json()),
    refetchInterval: 300_000,
    staleTime: 120_000,
  });

  const { data: foData } = useQuery({
    queryKey: ["intel-index-fo"],
    queryFn: () => fetch("/api/market/heatmap/fo").then(r => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // Response shapes (verified against live APIs): regime is top-level,
  // breadth nests under `.breadth` with `score`/`label`, sectors are
  // top-level, fii-dii is flat — `.data` on these returned undefined and
  // silently defaulted the whole header to NEUTRAL/0.
  const regime = regimeData;
  const breadth = breadthData?.breadth;
  const sectors = sectorData?.sectors || [];
  const oi = oiData?.data;
  const fiiDii = fiiDiiData;
  const niftyFo = foData?.indexFO?.find((i: any) => i.symbol === "NIFTY");
  const vixValue = typeof regime?.vix === "object" ? regime?.vix?.value : regime?.vix;

  const derivativeInput = {
    oiBias: (oi?.overallBias || "NEUTRAL") as any,
    oiSpurtScore: oi?.spurtScore || 0,
    longBuildupPct: oi?.totalSpurts > 0 ? (oi.longBuildupCount / oi.totalSpurts) * 100 : 50,
    shortBuildupPct: oi?.totalSpurts > 0 ? (oi.shortBuildupCount / oi.totalSpurts) * 100 : 50,
    fiiNet: fiiDii?.fiiNet || 0,
    diiNet: fiiDii?.diiNet || 0,
    fiiBias: (fiiDii?.fiiNet > 0 ? "BULLISH" : fiiDii?.fiiNet < 0 ? "BEARISH" : "NEUTRAL") as any,
    fiiOi: 0,
    clientOi: 0,
    participantBias: "NEUTRAL" as any,
    pcr: niftyFo?.pcr,
    callWall: 0,
    putWall: 0,
    maxPain: niftyFo?.maxPain || 0,
    gammaRegime: "NEUTRAL" as any,
    dealerGammaExposure: 0,
    vix: vixValue || 15,
    vixRegime: (vixValue > 25 ? "HIGH" : vixValue > 18 ? "NORMAL" : "LOW") as any,
    breadthScore: breadth?.score || 50,
    advances: breadth?.advances || 0,
    declines: breadth?.declines || 0,
  };

  // Compute derivative flow (client-side deterministic)
  const derivativeFlow = computeDerivativeFlow(derivativeInput);

  // CAS score (from existing breadth/sector data)
  const casScore = breadth ? Math.round(
    (breadth.score || 50) * 0.5 +
    ((breadth.volRatio || 1) > 1.2 ? 70 : 50) * 0.15 +
    (sectors.length > 0 ? sectors.filter((s: any) => (s.avgChangePct || 0) > 0).length / sectors.length * 100 : 50) * 0.15 +
    (regime?.regime?.includes("BULL") ? 70 : regime?.regime?.includes("BEAR") ? 30 : 50) * 0.2
  ) : 50;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b bg-amber-500/5">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-amber-500" />
          <span className="text-[11px] font-bold text-amber-500">MARKET DECISION INTELLIGENCE CENTER</span>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2 space-y-2">
        {/* Intel Summary */}
        <IntelSummary regime={regime} breadth={breadth} derivative={derivativeFlow} cas={{ casScore }} />

        {/* Index-Breadth Divergence */}
        <DivergencePanel regime={regime} breadth={breadth} />

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="h-7">
            <TabsTrigger value="overview" className="text-[9px] h-5">Overview</TabsTrigger>
            <TabsTrigger value="option-buyer" className="text-[9px] h-5 text-yellow-500 font-bold">⚡ Option Buyer</TabsTrigger>
            <TabsTrigger value="derivative" className="text-[9px] h-5">Derivative Flow</TabsTrigger>
            <TabsTrigger value="oi" className="text-[9px] h-5">OI Spurts</TabsTrigger>
            <TabsTrigger value="sectors" className="text-[9px] h-5">Sectors</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              <MarketRegimePanel />
              <MarketBreadth />
              <CASPanel />
              <DerivativeFlowPanel data={derivativeFlow} />
              <OISpurtPanel data={oi} />
              <AlertCenter />
              <BestTradesNow />
              <ResearchCommentary regime={regime} breadth={breadth} derivative={derivativeFlow} oi={oi} sector={sectors} />
            </div>
            <div className="md:col-span-2 lg:col-span-3">
              <MarketHeatmap onStockClick={onStockClick} />
            </div>
          </TabsContent>

          {/* Option Buyer Tab */}
          <TabsContent value="option-buyer" className="space-y-2">
            <OptionBuyerPanel />
          </TabsContent>

          {/* Derivative Flow Tab */}
          <TabsContent value="derivative" className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <DerivativeFlowPanel data={derivativeFlow} />
              <OISpurtPanel data={oi} />
            </div>
          </TabsContent>

          {/* OI Spurts Tab */}
          <TabsContent value="oi" className="space-y-2">
            <OISpurtPanel data={oi} />
          </TabsContent>

          {/* Sectors Tab */}
          <TabsContent value="sectors" className="space-y-2">
            <SectorRotation />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ── Client-side Derivative Flow computation ───────────────────────────

function computeDerivativeFlow(input: any) {
  const weights = { oi: 0.25, optionPositioning: 0.20, participantOi: 0.15, fiiDii: 0.15, gamma: 0.05, vix: 0.05, breadth: 0.15 };

  let oiScore = 50;
  if (input.oiBias === "BULLISH") oiScore = 70 + Math.min(30, input.oiSpurtScore * 0.3);
  else if (input.oiBias === "BEARISH") oiScore = 30 - Math.min(30, input.oiSpurtScore * 0.3);

  let optionScore = 50;
  if (input.pcr > 1.2) optionScore = 70 + Math.min(30, (input.pcr - 1.2) * 50);
  else if (input.pcr < 0.8) optionScore = 30 - Math.min(30, (0.8 - input.pcr) * 50);

  let participantScore = 50;
  if (input.participantBias === "BULLISH") participantScore = 70;
  else if (input.participantBias === "BEARISH") participantScore = 30;

  let fiiDiiScore = 50;
  if (input.fiiBias === "BULLISH") fiiDiiScore = 70 + Math.min(30, Math.abs(input.fiiNet) / 1000);
  else if (input.fiiBias === "BEARISH") fiiDiiScore = 30 - Math.min(30, Math.abs(input.fiiNet) / 1000);

  let gammaScore = 50;
  if (input.gammaRegime === "PINNING") gammaScore = 50;
  else if (input.gammaRegime === "EXPANSION") gammaScore = 60;

  let vixScore = 50;
  if (input.vixRegime === "LOW") vixScore = 65;
  else if (input.vixRegime === "NORMAL") vixScore = 55;
  else if (input.vixRegime === "HIGH") vixScore = 35;
  else if (input.vixRegime === "EXTREME") vixScore = 20;

  const composite = Math.round(
    oiScore * weights.oi + optionScore * weights.optionPositioning +
    participantScore * weights.participantOi + fiiDiiScore * weights.fiiDii +
    gammaScore * weights.gamma + vixScore * weights.vix +
    input.breadthScore * weights.breadth
  );

  let bias = "NEUTRAL";
  if (composite >= 65) bias = "BULLISH";
  else if (composite <= 35) bias = "BEARISH";
  else if (Math.abs(composite - 50) < 10) bias = "MIXED";

  const putSupport = input.pcr > 1.1 ? "STRONG" : input.pcr > 0.9 ? "NEUTRAL" : "WEAKENING";
  const callResistance = input.pcr < 0.9 ? "HIGH" : input.pcr < 1.1 ? "NEUTRAL" : "INCREASING";

  const biases = [input.oiBias, input.fiiBias, input.participantBias];
  const bullish = biases.filter((b: string) => b === "BULLISH").length;
  const bearish = biases.filter((b: string) => b === "BEARISH").length;
  let confirmation = "INSUFFICIENT_DATA";
  if (bullish >= 2 || bearish >= 2) confirmation = "CONFIRMED";
  else if (bullish === 1 && bearish === 1) confirmation = "CONFLICTING";
  else confirmation = "PARTIAL";

  return {
    score: Math.max(0, Math.min(100, composite)),
    bias,
    components: {
      oi: { score: Math.round(oiScore), weight: weights.oi, bias: input.oiBias },
      optionPositioning: { score: Math.round(optionScore), weight: weights.optionPositioning, bias: input.pcr > 1.1 ? "BULLISH" : input.pcr < 0.9 ? "BEARISH" : "NEUTRAL" },
      participantOi: { score: Math.round(participantScore), weight: weights.participantOi, bias: input.participantBias },
      fiiDii: { score: Math.round(fiiDiiScore), weight: weights.fiiDii, bias: input.fiiBias },
      gamma: { score: Math.round(gammaScore), weight: weights.gamma, regime: input.gammaRegime },
      vix: { score: Math.round(vixScore), weight: weights.vix, regime: input.vixRegime },
      breadth: { score: Math.round(input.breadthScore), weight: weights.breadth, bias: input.breadthScore > 60 ? "BULLISH" : input.breadthScore < 40 ? "BEARISH" : "NEUTRAL" },
    },
    putSupport,
    callResistance,
    gammaState: input.gammaRegime,
    interpretation: `OI: ${input.oiBias} | FII: ${input.fiiBias} | VIX: ${input.vixRegime} | Breadth: ${input.breadthScore > 60 ? "Strong" : input.breadthScore < 40 ? "Weak" : "Neutral"}`,
    confirmation,
  };
}
