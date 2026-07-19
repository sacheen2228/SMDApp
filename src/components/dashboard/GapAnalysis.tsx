"use client";

import { useMemo, memo, useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Target, Shield, BarChart3, Activity, Zap, ArrowUp, ArrowDown,
  Minus, AlertTriangle, Clock, Layers, TrendingUp, TrendingDown,
  Info, ChevronDown, ChevronUp, Globe, DollarSign,
} from "lucide-react";
import { predictGap } from "@/lib/gap-analysis/gap-engine";
import { DEFAULT_WEIGHTS } from "@/lib/gap-analysis/types";
import type { GapInput, GapPrediction } from "@/lib/gap-analysis/types";

interface GapAnalysisProps {
  analysis: any;
  summary?: any;
  spotPrice: number;
  symbol: string;
  expiryDate: string;
  chainData?: any[];
}

function fmtFull(n: number): string {
  if (!n || isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-IN");
}

function fmtCr(n: number): string {
  if (Math.abs(n) >= 100000) return (n / 1000).toFixed(1) + "K";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n).toLocaleString("en-IN");
}

function computePivots(spot: number) {
  const range = spot * 0.012;
  return {
    r3: spot + range * 3, r2: spot + range * 2, r1: spot + range,
    pivot: spot,
    s1: spot - range, s2: spot - range * 2, s3: spot - range * 3,
  };
}

const factorColors: Record<string, string> = {
  "Gift Nifty": "text-blue-400",
  "Futures Premium": "text-cyan-400",
  "PCR OI": "text-violet-400",
  "OI Buildup": "text-fuchsia-400",
  "Max Pain": "text-amber-400",
  "VWAP": "text-emerald-400",
  "ATR": "text-orange-400",
  "India VIX": "text-red-400",
  "Breadth": "text-pink-400",
  "Global Cues": "text-sky-400",
  "Expected Move": "text-teal-400",
  "Historical Stats": "text-gray-400",
};

function buildGapInput(
  analysis: any, summary: any | undefined,
  spotPrice: number, giftNifty: any, fiiDii: any,
): GapInput {
  const pcr = analysis?.pcr ?? summary?.pcr ?? null;
  return {
    prevClose: typeof summary?.prevClose === "number" ? summary.prevClose : null,
    currentSpot: spotPrice || null,
    currentFutures: analysis?.futuresPrice ?? summary?.futuresPrice ?? null,
    giftNiftyPrice: giftNifty?.price ?? null,
    giftNiftyPrevClose: giftNifty?.previousClose ?? null,
    indiaVIX: typeof summary?.indiaVIX === "number" ? summary.indiaVIX : null,
    pcrOI: pcr,
    pcrVolume: summary?.pcrVolume ?? null,
    maxPain: analysis?.maxPain ?? summary?.maxPain ?? null,
    ceOIChange: analysis?.ceOIChg ?? summary?.callOiChange ?? null,
    peOIChange: analysis?.peOIChg ?? summary?.putOiChange ?? null,
    optionIV: summary?.iv ?? null,
    futuresPremium: analysis?.futuresPremium ?? summary?.futuresPremium ?? null,
    breadth: summary?.breadth ?? null,
    atr: summary?.atr ?? null,
    vwapDistance: summary?.vwapDistance ?? null,
    fiiNet: fiiDii?.fiiNet ?? summary?.fiiNet ?? null,
    diiNet: fiiDii?.diiNet ?? summary?.diiNet ?? null,
    usMarketChange: summary?.usMarketChange ?? null,
    asianMarketChange: summary?.asianMarketChange ?? null,
    usdinr: summary?.usdinr ?? null,
    crudeChange: summary?.crudeChange ?? null,
    newsRiskScore: summary?.newsRiskScore ?? null,
    economicCalendarRisk: summary?.economicRisk ?? null,
    historicalGapUpPct: null,
    historicalGapDownPct: null,
    historicalGapStats: null,
    timestamp: new Date().toISOString(),
    symbol: "NIFTY",
  };
}

export const GapAnalysis = memo(function GapAnalysis({
  analysis, summary, spotPrice, symbol, expiryDate, chainData,
}: GapAnalysisProps) {
  const [giftNifty, setGiftNifty] = useState<any>(null);
  const [fiiDii, setFiiDii] = useState<any>(null);
  const [showFactors, setShowFactors] = useState(true);

  useEffect(() => {
    fetch(`/api/gift-nifty?spot=${spotPrice}`)
      .then(r => r.json())
      .then(d => { if (d.success) setGiftNifty(d); })
      .catch(() => {});
    fetch(`/api/fii-dii`)
      .then(r => r.json())
      .then(d => { if (d.success) setFiiDii(d); })
      .catch(() => {});
  }, [spotPrice]);

  const gapInput = useMemo(
    () => buildGapInput(analysis, summary, spotPrice, giftNifty, fiiDii),
    [analysis, summary, spotPrice, giftNifty, fiiDii],
  );

  const gapResult: GapPrediction = useMemo(
    () => predictGap(gapInput, DEFAULT_WEIGHTS),
    [gapInput],
  );

  const pcr = analysis?.pcr ?? summary?.pcr ?? 0;
  const vixLive = summary?.vixLive ?? false;
  const prevClose = typeof summary?.prevClose === "number" ? summary.prevClose : null;
  const maxPain = analysis?.maxPain ?? summary?.maxPain ?? null;
  const ceOI = analysis?.totalCallOI ?? summary?.totalCallOI ?? 0;
  const peOI = analysis?.totalPutOI ?? summary?.totalPutOI ?? 0;
  const pivots = useMemo(() => computePivots(spotPrice), [spotPrice]);
  const rec = analysis?.recommendation;
  const oiTotal = ceOI + peOI || 1;
  const daysToExpiry = typeof analysis?.expiry?.daysToExpiry === "number" ? analysis.expiry.daysToExpiry : 4;

  // ATM info from live chain
  const atmInfo = useMemo(() => {
    if (!chainData?.length || !spotPrice) return { strike: null, ce: null, pe: null, ceOc: null, peOc: null };
    let atm = chainData[0], best = Infinity;
    for (const s of chainData) {
      const dd = Math.abs(s.strike - spotPrice);
      if (dd < best) { best = dd; atm = s; }
    }
    return {
      strike: atm.strike ?? null,
      ce: atm.ce?.ltp ?? null,
      pe: atm.pe?.ltp ?? null,
      ceOc: atm.ce?.oiChg ?? null,
      peOc: atm.pe?.oiChg ?? null,
    };
  }, [chainData, spotPrice]);

  const expectedMovePts = gapInput.indiaVIX != null && spotPrice > 0
    ? Math.round(spotPrice * gapInput.indiaVIX / 100 * Math.sqrt(Math.max(1, daysToExpiry) / 365))
    : null;

  const straddleCost = (atmInfo.ce ?? 0) + (atmInfo.pe ?? 0);
  const gap = giftNifty && prevClose ? giftNifty.price - prevClose : null;

  const predColor = gapResult.prediction === "UP" ? "text-emerald-400"
    : gapResult.prediction === "DOWN" ? "text-red-400"
    : "text-yellow-400";

  const bullFactors = gapResult.factors.filter(f => f.score > 0);
  const bearFactors = gapResult.factors.filter(f => f.score < 0);
  const neutralFactors = gapResult.factors.filter(f => f.score === 0);

  const heatmap = useMemo(() => {
    if (!chainData?.length) return [];
    const atm = Math.round(spotPrice / 50) * 50;
    return chainData
      .filter((s: any) => Math.abs(s.strike - atm) <= 250)
      .map((s: any) => ({
        strike: s.strike,
        ceOiChg: s.ce?.oiChg ?? 0,
        peOiChg: s.pe?.oiChg ?? 0,
        net: (s.pe?.oiChg ?? 0) - (s.ce?.oiChg ?? 0),
        isATM: s.strike === atm,
      }));
  }, [chainData, spotPrice]);

  // FII/DII last 5 days
  const fiiHistory = useMemo(() => {
    const h = fiiDii?.history ?? [];
    return h.slice(0, 5);
  }, [fiiDii]);

  // FII/DII trend
  const fiiTrend = useMemo(() => {
    if (fiiHistory.length < 2) return "—";
    const recent3 = fiiHistory.slice(0, 3);
    const avg = recent3.reduce((s: number, r: any) => s + r.fiiNet, 0) / recent3.length;
    return avg > 200 ? "BUYING" : avg < -200 ? "SELLING" : "MIXED";
  }, [fiiHistory]);

  const diiTrend = useMemo(() => {
    if (fiiHistory.length < 2) return "—";
    const recent3 = fiiHistory.slice(0, 3);
    const avg = recent3.reduce((s: number, r: any) => s + r.diiNet, 0) / recent3.length;
    return avg > 200 ? "BUYING" : avg < -200 ? "SELLING" : "MIXED";
  }, [fiiHistory]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        {/* ═══════ HEADER ═══════ */}
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center shadow-lg shadow-purple-500/25">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-2xl font-black tracking-tight">GAP INTELLIGENCE</h1>
          </div>
          <p className="text-xs text-muted-foreground">Institutional 12-Factor Gap Engine — {symbol} {expiryDate}</p>
        </div>

        {/* ═══════ TOP METRICS BAR ═══════ */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-13 gap-1.5">
          <MetricPill label="Spot" value={fmtFull(spotPrice)} />
          <MetricPill label="Gift Nifty" value={giftNifty ? fmtFull(giftNifty.price) : "—"}
            color={gap != null ? (gap > 0 ? "text-emerald-500" : "text-red-500") : "text-muted-foreground"}
            sub={gap != null ? `${gap > 0 ? "+" : ""}${gap.toFixed(0)} pts` : ""} />
          <MetricPill label="PCR" value={pcr.toFixed(2)} color={pcr > 1.2 ? "text-emerald-500" : pcr < 0.8 ? "text-red-500" : ""} />
          <MetricPill label="VIX" value={gapInput.indiaVIX != null ? gapInput.indiaVIX.toFixed(1) : "—"} color={vixLive ? "text-violet-400" : "text-muted-foreground"} sub={vixLive ? "live" : "est"} />
          <MetricPill label="Max Pain" value={maxPain != null ? fmtFull(maxPain) : "—"} color="text-amber-500" sub={maxPain != null ? `${spotPrice > maxPain ? "+" : ""}${((spotPrice - maxPain) / maxPain * 100).toFixed(2)}%` : ""} />
          <MetricPill label="Sentiment" value={analysis?.sentiment ? analysis.sentiment.toUpperCase() : "—"} color={analysis?.sentiment === "bullish" ? "text-emerald-500" : analysis?.sentiment === "bearish" ? "text-red-500" : "text-muted-foreground"} />
          <MetricPill label="Expected Move" value={expectedMovePts != null ? `±${expectedMovePts} pts` : "—"} color="text-teal-400" />
          <MetricPill label="OI Bias" value={`${peOI > ceOI ? "BULL" : ceOI > peOI ? "BEAR" : "NEUTRAL"}`}
            color={peOI > ceOI ? "text-emerald-500" : ceOI > peOI ? "text-red-500" : "text-muted-foreground"} />
          <MetricPill label="Call OI" value={fmtCr(ceOI)} color="text-red-400" sub={summary?.callOiChange != null ? `${summary.callOiChange >= 0 ? "+" : ""}${fmtCr(summary.callOiChange)}` : ""} />
          <MetricPill label="Put OI" value={fmtCr(peOI)} color="text-emerald-400" sub={summary?.putOiChange != null ? `${summary.putOiChange >= 0 ? "+" : ""}${fmtCr(summary.putOiChange)}` : ""} />
          <MetricPill label="FII" value={gapInput.fiiNet != null ? `${gapInput.fiiNet >= 0 ? "+" : ""}${fmtCr(gapInput.fiiNet)}` : "—"}
            color={gapInput.fiiNet != null ? (gapInput.fiiNet >= 0 ? "text-emerald-500" : "text-red-500") : "text-muted-foreground"} sub={fiiTrend !== "—" ? fiiTrend : ""} />
          <MetricPill label="DII" value={gapInput.diiNet != null ? `${gapInput.diiNet >= 0 ? "+" : ""}${fmtCr(gapInput.diiNet)}` : "—"}
            color={gapInput.diiNet != null ? (gapInput.diiNet >= 0 ? "text-emerald-500" : "text-red-500") : "text-muted-foreground"} sub={diiTrend !== "—" ? diiTrend : ""} />
          <MetricPill label="Straddle" value={straddleCost > 0 ? `₹${straddleCost.toFixed(0)}` : "—"} color="text-cyan-400" sub={atmInfo.strike ? `${fmtFull(atmInfo.strike)} ATM` : ""} />
        </div>

        {gapResult.insufficientData && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-400/90">
            Insufficient data for prediction. Missing: {gapResult.missingFields.join(", ")}.
            Showing factor diagnostics without a final prediction.
          </div>
        )}

        {/* ═══════ 3-COLUMN LAYOUT ═══════ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ─── LEFT COLUMN ─── */}
          <div className="space-y-4">
            {/* ATM Straddle */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Layers className="w-3.5 h-3.5 text-violet-500" />} text="ATM Straddle" />
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-black tabular-nums">{atmInfo.strike ? fmtFull(atmInfo.strike) : fmtFull(Math.round(spotPrice / 50) * 50)}</span>
                  <span className="text-sm text-muted-foreground">Strike</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-violet-500/10 p-2">
                    <p className="text-muted-foreground text-[9px]">CE Premium</p>
                    <p className="font-bold text-violet-400">{atmInfo.ce != null ? `₹${atmInfo.ce.toFixed(1)}` : "—"}</p>
                  </div>
                  <div className="rounded bg-violet-500/10 p-2">
                    <p className="text-muted-foreground text-[9px]">PE Premium</p>
                    <p className="font-bold text-violet-400">{atmInfo.pe != null ? `₹${atmInfo.pe.toFixed(1)}` : "—"}</p>
                  </div>
                </div>
                {straddleCost > 0 && (
                  <div className="rounded bg-muted/30 p-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Straddle Cost</span>
                      <span className="font-bold">₹{straddleCost.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">% of Spot</span>
                      <span className="font-bold">{spotPrice > 0 ? (straddleCost / spotPrice * 100).toFixed(2) : "—"}%</span>
                    </div>
                    {expectedMovePts != null && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Expected Move</span>
                        <span className="font-bold text-teal-400">±{expectedMovePts} pts ({spotPrice > 0 ? (expectedMovePts / spotPrice * 100).toFixed(2) : "—"}%)</span>
                      </div>
                    )}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">
                  {gapInput.indiaVIX == null ? "Live VIX unavailable"
                    : gapInput.indiaVIX > 20 ? "VIX elevated — premium selling favorable"
                    : gapInput.indiaVIX < 12 ? "VIX low — options cheap"
                    : "VIX in normal range"}
                </p>
              </CardContent>
            </Card>

            {/* Max Pain + OI Summary */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Target className="w-3.5 h-3.5 text-amber-500" />} text="Max Pain & OI" />
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-black tabular-nums text-amber-500">{maxPain != null ? fmtFull(maxPain) : "—"}</span>
                  <span className={`text-xs font-medium ${maxPain != null && spotPrice > maxPain ? "text-emerald-500" : "text-red-500"}`}>
                    {maxPain != null ? `${spotPrice > maxPain ? "+" : ""}${Math.abs(spotPrice - maxPain).toFixed(0)} pts (${(Math.abs(spotPrice - maxPain) / maxPain * 100).toFixed(2)}%)` : "no data"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-emerald-500/10 p-2">
                    <p className="text-muted-foreground text-[9px]">Total Put OI</p>
                    <p className="font-bold text-emerald-400">{fmtCr(peOI)}</p>
                    {summary?.putOiChange != null && (
                      <p className={`text-[9px] ${summary.putOiChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {summary.putOiChange >= 0 ? "+" : ""}{fmtCr(summary.putOiChange)}
                      </p>
                    )}
                  </div>
                  <div className="rounded bg-red-500/10 p-2">
                    <p className="text-muted-foreground text-[9px]">Total Call OI</p>
                    <p className="font-bold text-red-400">{fmtCr(ceOI)}</p>
                    {summary?.callOiChange != null && (
                      <p className={`text-[9px] ${summary.callOiChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {summary.callOiChange >= 0 ? "+" : ""}{fmtCr(summary.callOiChange)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="rounded bg-muted/30 p-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PCR (OI)</span>
                    <span className={`font-bold ${pcr > 1.2 ? "text-emerald-500" : pcr < 0.8 ? "text-red-500" : ""}`}>{pcr.toFixed(3)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Put/Call Ratio</span>
                    <span className="text-[9px] text-muted-foreground">{pcr > 1.2 ? "Bullish — put writing dominant" : pcr < 0.8 ? "Bearish — call writing dominant" : "Balanced OI"}</span>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">Market gravitates toward Max Pain near expiry</p>
              </CardContent>
            </Card>

            {/* Key Levels */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-1.5">
                <CardTitle icon={<BarChart3 className="w-3.5 h-3.5 text-blue-500" />} text="Key Levels (Pivot)" />
                {(["r3", "r2", "r1", "pivot", "s1", "s2", "s3"] as const).map((level) => {
                  const val = pivots[level];
                  const isRes = level.startsWith("r");
                  const isPivot = level === "pivot";
                  const dist = ((val - spotPrice) / spotPrice * 100);
                  return (
                    <div key={level} className={`flex items-center justify-between text-xs ${isPivot ? "border-t border-border pt-1 font-bold" : ""}`}>
                      <span className={`w-12 ${isRes ? "text-emerald-500" : isPivot ? "text-primary" : "text-red-500"}`}>{level.toUpperCase()}</span>
                      <span className="tabular-nums font-mono">{fmtFull(val)}</span>
                      <span className={`w-16 text-right text-[10px] ${dist > 0 ? "text-emerald-500" : dist < 0 ? "text-red-500" : ""}`}>
                        {dist > 0 ? "+" : ""}{dist.toFixed(2)}%
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Market Mood */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Activity className="w-3.5 h-3.5 text-rose-500" />} text="Market Mood" />
                <MoodGauge pcr={pcr} vix={gapInput.indiaVIX} fiiNet={gapInput.fiiNet} diiNet={gapInput.diiNet} />
              </CardContent>
            </Card>
          </div>

          {/* ─── CENTER COLUMN ─── */}
          <div className="space-y-4">
            {/* Gap Prediction */}
            <Card className="border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-violet-500/5">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <CardTitle icon={<Zap className="w-3.5 h-3.5 text-purple-500" />} text="Institutional Gap Prediction" />
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Info className="w-3 h-3" />
                    {gapResult.confidenceCapped ? "Confidence capped" : "Raw confidence"}
                  </div>
                </div>

                <div className="text-center">
                  <Badge variant="outline" className={`${predColor} border-current text-xs px-3 py-1`}>
                    {gapResult.insufficientData ? "INSUFFICIENT DATA" : gapResult.prediction === "UP" ? "GAP UP ▲" : gapResult.prediction === "DOWN" ? "GAP DOWN ▼" : "FLAT —"}
                  </Badge>
                  <div className="mt-2 flex items-center justify-center gap-4 text-xs text-muted-foreground">
                    <span>Bull: <span className="text-emerald-400 font-bold">{gapResult.bullScore}</span></span>
                    <span>Bear: <span className="text-red-400 font-bold">{gapResult.bearScore}</span></span>
                  </div>
                </div>

                <div className="space-y-2">
                  <GapBar label="Gap Up" pct={gapResult.probability} color="bg-emerald-500" icon={<ArrowUp className="w-3 h-3" />}
                    act={gapResult.prediction === "UP"} />
                  <GapBar label="Gap Down" pct={100 - gapResult.probability > 50 ? 100 - gapResult.probability : 50}
                    color="bg-red-500" icon={<ArrowDown className="w-3 h-3" />}
                    act={gapResult.prediction === "DOWN"} />
                  <GapBar label="Neutral" pct={gapResult.prediction === "FLAT" ? gapResult.probability : Math.max(5, 100 - gapResult.probability - (100 - gapResult.probability > 50 ? 100 - gapResult.probability : 50))}
                    color="bg-yellow-500" icon={<Minus className="w-3 h-3" />}
                    act={gapResult.prediction === "FLAT"} />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Confidence</span>
                    <span className={`font-bold tabular-nums ${gapResult.confidence >= 70 ? "text-emerald-400" : gapResult.confidence >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                      {gapResult.confidence}%
                      {gapResult.confidenceCapped && <span className="text-[9px] text-muted-foreground ml-1">(capped at {gapResult.maxConfidence})</span>}
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted/50 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${
                      gapResult.confidence >= 70 ? "bg-emerald-500"
                      : gapResult.confidence >= 50 ? "bg-yellow-500"
                      : "bg-red-500"
                    }`} style={{ width: `${gapResult.confidence}%` }} />
                  </div>
                </div>

                <Separator />

                <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
                  <div className="rounded bg-emerald-500/10 p-1.5">
                    <p className="text-emerald-400 font-bold">{bullFactors.length}</p>
                    <p className="text-muted-foreground">Bullish</p>
                  </div>
                  <div className="rounded bg-red-500/10 p-1.5">
                    <p className="text-red-400 font-bold">{bearFactors.length}</p>
                    <p className="text-muted-foreground">Bearish</p>
                  </div>
                  <div className="rounded bg-muted/20 p-1.5">
                    <p className="text-muted-foreground font-bold">{neutralFactors.length}</p>
                    <p className="text-muted-foreground">Neutral</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Factor Breakdown */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <button
                  className="flex items-center justify-between w-full"
                  onClick={() => setShowFactors(!showFactors)}
                >
                  <CardTitle icon={<Info className="w-3.5 h-3.5 text-blue-500" />} text={`Factor Breakdown (${gapResult.factors.length} factors)`} />
                  {showFactors ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>

                {showFactors && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/50">
                          <th className="text-left py-1 pr-2">Factor</th>
                          <th className="text-right py-1 px-1">Wt</th>
                          <th className="text-right py-1 px-1">Score</th>
                          <th className="text-right py-1 px-1">Wtd</th>
                          <th className="text-left py-1 pl-2">Explanation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gapResult.factors.map((f, i) => {
                          const colorClass = f.score > 0 ? "text-emerald-500" : f.score < 0 ? "text-red-500" : "text-muted-foreground";
                          return (
                            <tr key={i} className="border-b border-border/20 hover:bg-muted/10">
                              <td className={`py-1.5 pr-2 font-medium ${factorColors[f.name] || "text-foreground"}`}>
                                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
                                  f.dataStatus === "AVAILABLE" ? "bg-green-500"
                                  : f.dataStatus === "ESTIMATED" ? "bg-yellow-500"
                                  : "bg-red-500"
                                }`} />
                                {f.name}
                              </td>
                              <td className={`py-1.5 px-1 text-right tabular-nums ${f.dataStatus === "MISSING" ? "text-muted-foreground" : ""}`}>
                                {(f.weight * 100).toFixed(0)}%
                              </td>
                              <td className={`py-1.5 px-1 text-right tabular-nums font-mono font-bold ${colorClass}`}>
                                {f.score > 0 ? "+" : ""}{f.score}
                              </td>
                              <td className={`py-1.5 px-1 text-right tabular-nums font-mono ${colorClass}`}>
                                {f.weightedScore > 0 ? "+" : ""}{f.weightedScore.toFixed(1)}
                              </td>
                              <td className={`py-1.5 pl-2 text-[9px] leading-tight ${
                                f.dataStatus === "MISSING" ? "text-muted-foreground italic" : "text-muted-foreground"
                              }`}>
                                {f.explanation}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* OI Heatmap */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<BarChart3 className="w-3.5 h-3.5 text-cyan-500" />} text="OI Change Heatmap" />
                {heatmap.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No chain data available</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/50">
                          <th className="text-left py-1 px-1">Strike</th>
                          <th className="text-right py-1 px-1">CE OI Chg</th>
                          <th className="text-right py-1 px-1">PE OI Chg</th>
                          <th className="text-right py-1 px-1">Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {heatmap.map((row: any) => (
                          <tr key={row.strike} className={`border-b border-border/30 ${row.isATM ? "bg-primary/5" : ""}`}>
                            <td className={`py-1 px-1 tabular-nums font-mono ${row.isATM ? "font-bold text-primary" : ""}`}>
                              {fmtFull(row.strike)}
                              {row.isATM && <span className="text-[8px] ml-1 text-primary/70">ATM</span>}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono ${row.ceOiChg > 0 ? "text-red-500" : row.ceOiChg < 0 ? "text-emerald-500" : "text-muted-foreground"}`}>
                              {row.ceOiChg > 0 ? "+" : ""}{fmtFull(row.ceOiChg)}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono ${row.peOiChg > 0 ? "text-emerald-500" : row.peOiChg < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                              {row.peOiChg > 0 ? "+" : ""}{fmtFull(row.peOiChg)}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono font-bold ${row.net > 0 ? "text-emerald-500" : row.net < 0 ? "text-red-500" : ""}`}>
                              {row.net > 0 ? "+" : ""}{fmtFull(row.net)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-[9px] text-muted-foreground text-center">Green = PE writing (support) | Red = CE writing (resistance)</p>
              </CardContent>
            </Card>
          </div>

          {/* ─── RIGHT COLUMN ─── */}
          <div className="space-y-4">
            {/* FII/DII Flow Card */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-3">
                <CardTitle icon={<Globe className="w-3.5 h-3.5 text-sky-500" />} text="Institutional Flows (FII/DII)" />
                {fiiDii ? (
                  <>
                    {/* Today's flow */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className={`rounded p-2 border ${gapInput.fiiNet != null && gapInput.fiiNet >= 0 ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20"}`}>
                        <p className="text-muted-foreground text-[9px]">FII Net (Today)</p>
                        <p className={`font-bold text-lg ${gapInput.fiiNet != null && gapInput.fiiNet >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                          {gapInput.fiiNet != null ? `${gapInput.fiiNet >= 0 ? "+" : ""}₹${fmtCr(gapInput.fiiNet)} Cr` : "—"}
                        </p>
                      </div>
                      <div className={`rounded p-2 border ${gapInput.diiNet != null && gapInput.diiNet >= 0 ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20"}`}>
                        <p className="text-muted-foreground text-[9px]">DII Net (Today)</p>
                        <p className={`font-bold text-lg ${gapInput.diiNet != null && gapInput.diiNet >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                          {gapInput.diiNet != null ? `${gapInput.diiNet >= 0 ? "+" : ""}₹${fmtCr(gapInput.diiNet)} Cr` : "—"}
                        </p>
                      </div>
                    </div>

                    {/* Trend badges */}
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="text-muted-foreground">3-day trend:</span>
                      <Badge variant="outline" className={`text-[9px] ${
                        fiiTrend === "BUYING" ? "text-emerald-400 border-emerald-500/30" :
                        fiiTrend === "SELLING" ? "text-red-400 border-red-500/30" :
                        "text-yellow-400 border-yellow-500/30"
                      }`}>FII {fiiTrend}</Badge>
                      <Badge variant="outline" className={`text-[9px] ${
                        diiTrend === "BUYING" ? "text-emerald-400 border-emerald-500/30" :
                        diiTrend === "SELLING" ? "text-red-400 border-red-500/30" :
                        "text-yellow-400 border-yellow-500/30"
                      }`}>DII {diiTrend}</Badge>
                    </div>

                    {/* Last 5 days mini-table */}
                    {fiiHistory.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[9px]">
                          <thead>
                            <tr className="text-muted-foreground border-b border-border/50">
                              <th className="text-left py-1">Date</th>
                              <th className="text-right py-1">FII Net</th>
                              <th className="text-right py-1">DII Net</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fiiHistory.map((r: any, i: number) => (
                              <tr key={i} className="border-b border-border/20">
                                <td className="py-1 text-muted-foreground">{r.date?.replace(/-\d{4}$/, "")}</td>
                                <td className={`py-1 text-right tabular-nums font-mono ${r.fiiNet >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                  {r.fiiNet >= 0 ? "+" : ""}{fmtCr(r.fiiNet)}
                                </td>
                                <td className={`py-1 text-right tabular-nums font-mono ${r.diiNet >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                  {r.diiNet >= 0 ? "+" : ""}{fmtCr(r.diiNet)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="text-[9px] text-muted-foreground text-center">Source: {fiiDii.source === "nse" ? "NSE India" : "MrChartist"} | {fiiDii.date}</p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-4">Loading FII/DII data...</p>
                )}
              </CardContent>
            </Card>

            {/* Gap Trading Setups */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-3">
                <CardTitle icon={<Shield className="w-3.5 h-3.5 text-amber-500" />} text="Gap Trading Setups" />
                {computeSetups(atmInfo.strike, atmInfo.ce, atmInfo.pe, expectedMovePts, spotPrice).map((setup, i) => (
                  <div key={i} className="rounded-lg border border-border/50 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={`text-[9px] ${
                        setup.color === "emerald" ? "text-emerald-500 border-emerald-500/30" :
                        setup.color === "red" ? "text-red-500 border-red-500/30" :
                        setup.color === "yellow" ? "text-yellow-500 border-yellow-500/30" :
                        "text-orange-500 border-orange-500/30"
                      }`}>
                        {setup.name}
                      </Badge>
                      {setup.rr !== "—" && <span className="text-[9px] text-cyan-500 font-medium">R:R {setup.rr}</span>}
                    </div>
                    <p className="text-xs font-bold">{setup.action}</p>
                    {setup.entry !== "—" && (
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        <div><p className="text-muted-foreground">Entry</p><p className="font-medium">{setup.entry}</p></div>
                        <div><p className="text-muted-foreground">Stop Loss</p><p className="font-medium text-red-500">{setup.sl}</p></div>
                        <div><p className="text-muted-foreground">Target</p><p className="font-medium text-emerald-500">{setup.target}</p></div>
                      </div>
                    )}
                    <p className="text-[9px] text-muted-foreground italic">{setup.note}</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Expiry & Expected Move */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Clock className="w-3.5 h-3.5 text-blue-500" />} text="Expiry & Decay" />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-blue-500/10 p-2">
                    <p className="text-muted-foreground text-[9px]">Days to Expiry</p>
                    <p className="font-bold text-lg">{daysToExpiry}</p>
                  </div>
                  <div className="rounded bg-blue-500/10 p-2">
                    <p className="text-muted-foreground text-[9px]">Risk Level</p>
                    <p className="font-bold">{rec?.riskLevel ?? "—"}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-muted/30 p-2">
                    <p className="text-muted-foreground text-[9px]">Theta / Day</p>
                    <p className="font-bold">
                      {straddleCost > 0 && daysToExpiry > 0 ? `~₹${(straddleCost / daysToExpiry).toFixed(1)}` : "—"}
                    </p>
                  </div>
                  <div className="rounded bg-muted/30 p-2">
                    <p className="text-muted-foreground text-[9px]">Expected Move</p>
                    <p className="font-bold text-teal-400">
                      {expectedMovePts != null ? `±${expectedMovePts} pts` : "—"}
                    </p>
                  </div>
                </div>
                {straddleCost > 0 && daysToExpiry > 0 && (
                  <div className="rounded bg-muted/20 p-2 text-[10px]">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Total decay by expiry</span>
                      <span className="font-medium">~₹{straddleCost.toFixed(0)} (100%)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Daily decay rate</span>
                      <span className="font-medium">{(straddleCost / daysToExpiry).toFixed(1)}/day ({(100 / daysToExpiry).toFixed(1)}%/day)</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Quick Reference */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-orange-500" />} text="Quick Reference" />
                <div className="space-y-1.5 text-[10px]">
                  <div className="flex items-start gap-2"><span className="text-emerald-500 mt-0.5">●</span><span><strong>Long Buildup:</strong> Price + OI + Volume = New buying</span></div>
                  <div className="flex items-start gap-2"><span className="text-red-500 mt-0.5">●</span><span><strong>Short Buildup:</strong> Price - OI + Volume = New selling</span></div>
                  <div className="flex items-start gap-2"><span className="text-amber-500 mt-0.5">●</span><span><strong>Short Covering:</strong> Price + OI - Volume = Shorts exiting</span></div>
                  <div className="flex items-start gap-2"><span className="text-blue-500 mt-0.5">●</span><span><strong>Long Unwinding:</strong> Price - OI - Volume = Longs exiting</span></div>
                </div>
                <Separator />
                <div className="space-y-1.5 text-[10px]">
                  <div className="flex items-start gap-2"><span className="text-sky-500 mt-0.5">●</span><span><strong>FII Buying:</strong> Foreign inflows = Bullish for India</span></div>
                  <div className="flex items-start gap-2"><span className="text-rose-500 mt-0.5">●</span><span><strong>FII Selling:</strong> Foreign outflows = Bearish for India</span></div>
                  <div className="flex items-start gap-2"><span className="text-violet-500 mt-0.5">●</span><span><strong>DII Buying:</strong> Domestic support = Floor under market</span></div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── Sub-Components ─────────────────────────────────────────────

function CardTitle({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-1">
      {icon}
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{text}</span>
    </div>
  );
}

function MetricPill({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card p-2 text-center min-w-0">
      <p className="text-[9px] text-muted-foreground uppercase tracking-wider truncate">{label}</p>
      <p className={`text-sm font-bold tabular-nums truncate ${color ?? ""}`}>{value}</p>
      {sub && <p className={`text-[9px] truncate ${color ?? "text-muted-foreground"}`}>{sub}</p>}
    </div>
  );
}

function GapBar({ label, pct, color, icon, act }: { label: string; pct: number; color: string; icon: React.ReactNode; act?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className={`flex items-center gap-1.5 ${act ? "font-bold text-foreground" : "text-muted-foreground"}`}>
          {icon} {label}
        </span>
        <span className="font-bold tabular-nums">{pct}%</span>
      </div>
      <div className="h-2 bg-muted/50 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all ${act ? "opacity-100" : "opacity-40"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MoodGauge({ pcr, vix, fiiNet, diiNet }: { pcr: number; vix: number | null; fiiNet: number | null; diiNet: number | null }) {
  let score = 3;
  if (pcr > 1.3) score += 1;
  else if (pcr < 0.7) score -= 1;
  if (typeof vix === "number") {
    if (vix > 20) score -= 1;
    else if (vix < 12) score += 1;
  }
  // FII/DII adjust mood
  if (fiiNet != null && fiiNet > 500) score += 1;
  else if (fiiNet != null && fiiNet < -500) score -= 1;
  if (diiNet != null && diiNet > 500) score += 1;
  else if (diiNet != null && diiNet < -500) score -= 1;
  score = Math.max(1, Math.min(5, score));

  const moods = [
    { s: 1, label: "Extreme\nFear", color: "bg-red-500", textColor: "text-red-500" },
    { s: 2, label: "Fear", color: "bg-orange-500", textColor: "text-orange-500" },
    { s: 3, label: "Neutral", color: "bg-yellow-500", textColor: "text-yellow-500" },
    { s: 4, label: "Greed", color: "bg-emerald-400", textColor: "text-emerald-400" },
    { s: 5, label: "Extreme\nGreed", color: "bg-emerald-500", textColor: "text-emerald-500" },
  ];

  const active = moods.find((m) => m.s === score)!;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-2">
        {moods.map((m) => (
          <div key={m.s} className="flex flex-col items-center gap-1">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
              m.s === score ? `${m.color} text-white` : "bg-muted/50 text-muted-foreground"
            }`}>{m.s}</div>
            <span className={`text-[8px] whitespace-pre-line ${m.s === score ? m.textColor : "text-muted-foreground"}`}>{m.label}</span>
          </div>
        ))}
      </div>
      <div className="text-center">
        <Badge variant="outline" className={`${active.textColor} text-[10px]`}>
          Current: {active.label.replace("\n", " ")} (PCR {pcr.toFixed(2)})
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[9px] text-muted-foreground">
        <div className="rounded bg-muted/20 p-1.5 text-center">
          <span>VIX: </span>
          <span className={vix != null && vix > 20 ? "text-red-400" : vix != null && vix < 12 ? "text-emerald-400" : ""}>{vix != null ? vix.toFixed(1) : "—"}</span>
        </div>
        <div className="rounded bg-muted/20 p-1.5 text-center">
          <span>FII: </span>
          <span className={fiiNet != null && fiiNet >= 0 ? "text-emerald-400" : "text-red-400"}>{fiiNet != null ? `${fiiNet >= 0 ? "+" : ""}${fmtCr(fiiNet)}` : "—"}</span>
        </div>
      </div>
    </div>
  );
}

function computeSetups(
  atmStrike: number | null,
  atmCE: number | null,
  atmPE: number | null,
  expectedMovePts: number | null,
  spotPrice: number,
) {
  const atm = atmStrike ?? Math.round(spotPrice / 50) * 50;
  const em = expectedMovePts ?? 0;
  const slBand = Math.round(em * 0.33);
  const tpBand = Math.round(em * 0.66);

  const entryUp = atmPE != null ? `~₹${atmPE.toFixed(1)} PE` : "—";
  const entryDown = atmCE != null ? `~₹${atmCE.toFixed(1)} CE` : "—";
  const lvl = (n: number) => (n ? Math.round(n).toLocaleString("en-IN") : "—");

  return [
    {
      name: "Gap Up > 50 pts", color: "emerald" as const,
      action: `Buy ${atm} PE (fade the gap)`, entry: entryUp,
      sl: lvl(atm + slBand), target: lvl(atm - tpBand), rr: "1:2",
      note: "Sell into gap up at resistance, target reversion to mean",
    },
    {
      name: "Gap Up 20-50 pts", color: "yellow" as const,
      action: "Wait for confirmation candle", entry: "—", sl: "—", target: "—", rr: "—",
      note: "Watch 15-min candle close — no blind entry",
    },
    {
      name: "Gap Down > 50 pts", color: "red" as const,
      action: `Buy ${atm} CE (buy the dip)`, entry: entryDown,
      sl: lvl(atm - slBand), target: lvl(atm + tpBand), rr: "1:2",
      note: "Buy into gap down at support, target bounce to resistance",
    },
    {
      name: "Gap Down 20-50 pts", color: "orange" as const,
      action: "Wait for confirmation candle", entry: "—", sl: "—", target: "—", rr: "—",
      note: "Watch 15-min candle close — no blind entry",
    },
  ];
}
