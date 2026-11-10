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
import { DataFreshnessBadge } from "./DataFreshnessBadge";
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
import IndustryHeatmapPanel from "./IndustryHeatmapPanel";

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
  const derivLabel = derivative?.bias || (derivative?.bias === "UNKNOWN" ? "UNKNOWN" : "—");
  const casLabel =
    cas?.casScore == null
      ? "NO DATA"
      : cas.casScore > 60
      ? "ACCUMULATION"
      : cas.casScore < 40
      ? "DISTRIBUTION"
      : "NEUTRAL";

  // Overall conviction — only count real (non-neutral/non-unknown) biases.
  let overall = "NEUTRAL";
  let overallScore = 50;
  const biases = [regimeLabel, breadthLabel, derivLabel].filter(b => b && b !== "—" && b !== "UNKNOWN");
  const bullish = biases.filter(b => b.includes("BULL")).length;
  const bearish = biases.filter(b => b.includes("BEAR")).length;
  if (bullish >= 2 && bearish === 0) { overall = "BULLISH"; overallScore = 72; }
  else if (bearish >= 2 && bullish === 0) { overall = "BEARISH"; overallScore = 28; }
  else if (bullish > 0 && bearish > 0) { overall = "CONFLICTING"; overallScore = 50; }
  else if (bullish === 1 && bearish === 0) { overall = "LEAN BULLISH"; overallScore = 60; }
  else if (bearish === 1 && bullish === 0) { overall = "LEAN BEARISH"; overallScore = 40; }

  const action = overall === "BULLISH" ? "FAVOR CE BUY AFTER CONFIRMATION"
    : overall === "BEARISH" ? "FAVOR PE BUY AFTER CONFIRMATION"
    : overall === "LEAN BULLISH" ? "LEAN LONG — WAIT FOR CONFIRMATION"
    : overall === "LEAN BEARISH" ? "LEAN SHORT — WAIT FOR CONFIRMATION"
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
            <div className={`font-bold ${bullish > 0 && bearish > 0 ? "text-red-500" : bullish > 0 || bearish > 0 ? "text-yellow-500" : "text-emerald-500"}`}>
              {bullish > 0 && bearish > 0 ? "DIVERGENCE" : bullish > 0 || bearish > 0 ? "PARTIAL" : "NEUTRAL"}
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
  const { data: regimeData, isError: regimeError } = useQuery({
    queryKey: ["market-regime-intel"],
    queryFn: () => fetch("/api/market/regime").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "regime failed");
      return json;
    }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: breadthData, isError: breadthError } = useQuery({
    queryKey: ["market-breadth-intel"],
    queryFn: () => fetch("/api/market/breadth").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "breadth failed");
      return json;
    }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: sectorData, isError: sectorError } = useQuery({
    queryKey: ["market-sectors-intel"],
    queryFn: () => fetch("/api/market/sectors").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "sectors failed");
      return json;
    }),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const { data: oiData, isError: oiError } = useQuery({
    queryKey: ["nse-oi-spurts"],
    queryFn: () => fetch("/api/nse/oi-spurts").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "oi-spurts failed");
      return json;
    }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: fiiDiiData, isError: fiiDiiError } = useQuery({
    queryKey: ["fii-dii-intel"],
    queryFn: () => fetch("/api/fii-dii").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "fii-dii failed");
      return json;
    }),
    refetchInterval: 300_000,
    staleTime: 120_000,
  });

  const { data: foData, isError: foError } = useQuery({
    queryKey: ["intel-index-fo"],
    queryFn: () => fetch("/api/market/heatmap/fo").then(async (r) => {
      const json = await r.json();
      if (!r.ok || json.success === false) throw new Error(json.error || "index-fo failed");
      return json;
    }),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const anyError = regimeError || breadthError || sectorError || oiError || fiiDiiError || foError;

  // Response shapes: regime is top-level, breadth nests under `.breadth`,
  // sectors top-level, fii-dii flat, indexFO nested under `.indexFO`.
  const regime = regimeData;
  const breadth = breadthData?.breadth;
  const sectors = sectorData?.sectors || [];
  const oi = oiData?.data;
  const fiiDii = fiiDiiData;
  const niftyFo = foData?.indexFO?.find((i: any) => i.symbol === "NIFTY");
  const vixValue = typeof regime?.vix === "object" ? regime?.vix?.value : regime?.vix;

  const derivativeInput = {
    oiBias: (oi?.overallBias || "UNKNOWN") as any,
    oiSpurtScore: oi?.spurtScore ?? null,
    longBuildupPct: oi?.totalSpurts > 0 ? (oi.longBuildupCount / oi.totalSpurts) * 100 : null,
    shortBuildupPct: oi?.totalSpurts > 0 ? (oi.shortBuildupCount / oi.totalSpurts) * 100 : null,
    fiiNet: fiiDii?.fiiNet ?? null,
    diiNet: fiiDii?.diiNet ?? null,
    fiiBias: (fiiDii?.fiiNet == null
      ? "UNKNOWN"
      : fiiDii.fiiNet > 0
      ? "BULLISH"
      : fiiDii.fiiNet < 0
      ? "BEARISH"
      : "NEUTRAL") as any,
    fiiOi: null,
    clientOi: null,
    participantBias: "UNKNOWN" as any,
    pcr: niftyFo?.pcr ?? null,
    callWall: niftyFo?.callWall ?? null,
    putWall: niftyFo?.putWall ?? null,
    maxPain: niftyFo?.maxPain ?? null,
    gammaRegime: "UNKNOWN" as any,
    dealerGammaExposure: null,
    vix: vixValue ?? null,
    vixRegime: (vixValue == null ? "UNKNOWN" : vixValue > 25 ? "HIGH" : vixValue > 18 ? "NORMAL" : "LOW") as any,
    breadthScore: breadth?.score ?? null,
    advances: breadth?.advances ?? null,
    declines: breadth?.declines ?? null,
  };

  // Compute derivative flow (client-side deterministic)
  const derivativeFlow = computeDerivativeFlow(derivativeInput);

  // CAS score — only over real inputs. Missing breadth/sector/regime
  // contribute nothing; when no input is available the score is null.
  let casScore: number | null = null;
  if (breadth || sectors.length > 0 || regime) {
    const bScore = breadth?.score ?? null;
    const volRatio = breadth?.volRatio ?? null;
    const sectorBullish = sectors.length > 0 ? sectors.filter((s: any) => (s.avgChangePct || 0) > 0).length / sectors.length : null;
    const casParts: Array<{ w: number; v: number }> = [];
    if (bScore != null) casParts.push({ w: 0.5, v: bScore });
    if (volRatio != null) casParts.push({ w: 0.15, v: volRatio > 1.2 ? 70 : 50 });
    if (sectorBullish != null) casParts.push({ w: 0.15, v: sectorBullish * 100 });
    if (regime?.regime) casParts.push({ w: 0.2, v: regime.regime.includes("BULL") ? 70 : regime.regime.includes("BEAR") ? 30 : 50 });
    if (casParts.length > 0) {
      const wSum = casParts.reduce((s, p) => s + p.w, 0);
      const vSum = casParts.reduce((s, p) => s + p.v * p.w, 0);
      casScore = Math.round(vSum / wSum);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b bg-amber-500/5">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-amber-500" />
          <span className="text-[11px] font-bold text-amber-500">MARKET DECISION INTELLIGENCE CENTER</span>
        </div>
      </div>

      {/* Error banner when any feed failed */}
      {anyError && (
        <Card className="border-red-500/30 bg-red-500/5 mb-2">
          <CardContent className="p-2">
            <div className="flex items-center gap-1 text-[9px] text-red-400">
              <AlertTriangle className="h-3 w-3" />
              <span className="font-bold">Some intel feeds unavailable</span>
              <span>— market conviction shown only for live data sources; missing inputs are excluded, not guessed.</span>
            </div>
          </CardContent>
        </Card>
      )}

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
              <MarketRegimePanel regimeData={regime} />
              <MarketBreadth breadthData={breadthData} />
              <CASPanel breadthData={breadthData} sectorData={sectorData} regimeData={regime} />
              <DerivativeFlowPanel data={derivativeFlow} />
              <OISpurtPanel data={oi} />
              <AlertCenter />
              <BestTradesNow />
              <ResearchCommentary regime={regime} breadth={breadth} derivative={derivativeFlow} oi={oi} sector={sectors} />
            </div>
            <div className="md:col-span-2 lg:col-span-3">
              <IndustryHeatmapPanel />
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

  // OI score — null/unknown bias stays neutral 50
  let oiScore = 50;
  if (input.oiBias === "BULLISH") oiScore = 70 + Math.min(30, (input.oiSpurtScore ?? 0) * 0.3);
  else if (input.oiBias === "BEARISH") oiScore = 30 - Math.min(30, (input.oiSpurtScore ?? 0) * 0.3);

  // Option positioning (PCR) — null PCR stays neutral 50
  let optionScore = 50;
  if (input.pcr != null && input.pcr > 1.2) optionScore = 70 + Math.min(30, (input.pcr - 1.2) * 50);
  else if (input.pcr != null && input.pcr < 0.8) optionScore = 30 - Math.min(30, (0.8 - input.pcr) * 50);

  // Participant OI — unknown stays neutral
  let participantScore = 50;
  if (input.participantBias === "BULLISH") participantScore = 70;
  else if (input.participantBias === "BEARISH") participantScore = 30;

  // FII/DII — unknown stays neutral
  let fiiDiiScore = 50;
  if (input.fiiBias === "BULLISH") fiiDiiScore = 70 + Math.min(30, Math.abs(input.fiiNet ?? 0) / 1000);
  else if (input.fiiBias === "BEARISH") fiiDiiScore = 30 - Math.min(30, Math.abs(input.fiiNet ?? 0) / 1000);

  // Gamma — unknown stays neutral
  let gammaScore = 50;
  if (input.gammaRegime === "PINNING") gammaScore = 50;
  else if (input.gammaRegime === "EXPANSION") gammaScore = 60;

  // VIX — unknown stays neutral
  let vixScore = 50;
  if (input.vixRegime === "LOW") vixScore = 65;
  else if (input.vixRegime === "NORMAL") vixScore = 55;
  else if (input.vixRegime === "HIGH") vixScore = 35;
  else if (input.vixRegime === "EXTREME") vixScore = 20;

  // Breadth — only included when real data exists; weight is renormalized below
  let breadthComponent = null;
  if (input.breadthScore != null) {
    breadthComponent = input.breadthScore > 60 ? "BULLISH" : input.breadthScore < 40 ? "BEARISH" : "NEUTRAL";
  }

  // Build weighted parts only from inputs that have real data
  const parts: Array<{ w: number; v: number }> = [
    { w: weights.oi, v: oiScore },
    { w: weights.optionPositioning, v: optionScore },
    { w: weights.participantOi, v: participantScore },
    { w: weights.fiiDii, v: fiiDiiScore },
    { w: weights.gamma, v: gammaScore },
    { w: weights.vix, v: vixScore },
  ];
  if (breadthComponent != null) {
    parts.push({ w: weights.breadth, v: input.breadthScore });
  }

  const wSum = parts.reduce((s, p) => s + p.w, 0);
  const vSum = parts.reduce((s, p) => s + p.v * p.w, 0);
  const composite = wSum > 0 ? Math.round(vSum / wSum) : 50;

  let bias = "NEUTRAL";
  if (composite >= 65) bias = "BULLISH";
  else if (composite <= 35) bias = "BEARISH";
  else if (Math.abs(composite - 50) < 10) bias = "MIXED";

  const putSupport = input.pcr != null && input.pcr > 1.1 ? "STRONG" : input.pcr != null && input.pcr > 0.9 ? "NEUTRAL" : "WEAKENING";
  const callResistance = input.pcr != null && input.pcr < 0.9 ? "HIGH" : input.pcr != null && input.pcr < 1.1 ? "NEUTRAL" : "INCREASING";

  const biases = [input.oiBias, input.fiiBias, input.participantBias].filter((b: string) => b === "BULLISH" || b === "BEARISH");
  const bullish = biases.filter((b: string) => b === "BULLISH").length;
  const bearish = biases.filter((b: string) => b === "BEARISH").length;
  let confirmation = "INSUFFICIENT_DATA";
  if (bullish >= 2 || bearish >= 2) confirmation = "CONFIRMED";
  else if (bullish === 1 && bearish === 1) confirmation = "CONFLICTING";
  else if (bullish === 1 || bearish === 1) confirmation = "PARTIAL";

  return {
    score: Math.max(0, Math.min(100, composite)),
    bias,
    components: {
      oi: { score: Math.round(oiScore), weight: weights.oi, bias: input.oiBias },
      optionPositioning: { score: Math.round(optionScore), weight: weights.optionPositioning, bias: input.pcr != null && input.pcr > 1.1 ? "BULLISH" : input.pcr != null && input.pcr < 0.9 ? "BEARISH" : "NEUTRAL" },
      participantOi: { score: Math.round(participantScore), weight: weights.participantOi, bias: input.participantBias },
      fiiDii: { score: Math.round(fiiDiiScore), weight: weights.fiiDii, bias: input.fiiBias },
      gamma: { score: Math.round(gammaScore), weight: weights.gamma, regime: input.gammaRegime },
      vix: { score: Math.round(vixScore), weight: weights.vix, regime: input.vixRegime },
      ...(breadthComponent != null ? { breadth: { score: Math.round(input.breadthScore), weight: weights.breadth, bias: breadthComponent } } : {}),
    },
    putSupport,
    callResistance,
    gammaState: input.gammaRegime,
    interpretation: `OI: ${input.oiBias} | FII: ${input.fiiBias} | VIX: ${input.vixRegime} | Breadth: ${input.breadthScore != null ? (input.breadthScore > 60 ? "Strong" : input.breadthScore < 40 ? "Weak" : "Neutral") : "no data"}`,
    confirmation,
  };
}
