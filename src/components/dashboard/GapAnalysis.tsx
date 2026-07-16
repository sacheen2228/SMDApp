"use client";

import { useMemo, memo, useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Target, Shield, BarChart3, Activity, Zap, ArrowUp, ArrowDown,
  Minus, AlertTriangle, Clock, Layers, TrendingUp, TrendingDown,
  Info, ChevronDown, ChevronUp,
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
  candles?: any[];
}

function fmtFull(n: number): string {
  if (!n || isNaN(n)) return "0";
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
  "Institutional Flow": "text-indigo-400",
  "Global Cues": "text-sky-400",
  "Expected Move": "text-teal-400",
  "Historical Stats": "text-gray-400",
};

// Aggregate total CE/PE OI change across the option chain (real data).
function aggregateOIChange(analysis: any, chainData: any[] | undefined): { ce: number | null; pe: number | null } {
  if (Array.isArray(analysis?.strikes) && analysis.strikes.length) {
    let ce = 0, pe = 0;
    for (const s of analysis.strikes) {
      ce += typeof s.callOIChange === "number" ? s.callOIChange : 0;
      pe += typeof s.putOIChange === "number" ? s.putOIChange : 0;
    }
    return { ce, pe };
  }
  if (Array.isArray(chainData) && chainData.length) {
    let ce = 0, pe = 0;
    for (const s of chainData) {
      ce += s?.ce?.oiChg ?? 0;
      pe += s?.pe?.oiChg ?? 0;
    }
    return { ce, pe };
  }
  return { ce: null, pe: null };
}

// Derive ATR (% of spot) and VWAP-distance (%) from daily candles (real data).
function deriveVolatility(candles: any[] | undefined, spot: number): { atr: number | null; vwapDistance: number | null } {
  if (!Array.isArray(candles) || candles.length < 2 || !spot) return { atr: null, vwapDistance: null };
  const rows = candles
    .map((c: any) => ({ h: +c.high, l: +c.low, c: +c.close, o: +c.open, v: +c.volume }))
    .filter((r: any) => isFinite(r.h) && isFinite(r.l) && isFinite(r.c) && r.h > 0);
  if (rows.length < 2) return { atr: null, vwapDistance: null };

  const trs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1].c;
    const { h, l, c } = rows[i];
    trs.push(Math.max(h - l, Math.abs(h - p), Math.abs(l - p)));
  }
  const atr = trs.reduce((a: number, b: number) => a + b, 0) / trs.length;

  let pv = 0, pvq = 0;
  for (const r of rows) {
    const typ = (r.h + r.l + r.c) / 3;
    const v = r.v > 0 ? r.v : 1;
    pv += typ * v; pvq += v;
  }
  const vwap = pvq > 0 ? pv / pvq : rows[rows.length - 1].c;

  return {
    atr: atr,
    vwapDistance: ((spot - vwap) / vwap) * 100,
  };
}

function buildGapInput(
  analysis: any, summary: any | undefined,
  spotPrice: number, giftNifty: any,
  chainData: any[] | undefined, candles: any[] | undefined,
  fiiDii: any,
): GapInput {
  const pcr = analysis?.pcr ?? summary?.pcr ?? null;
  const oi = aggregateOIChange(analysis, chainData);
  const vol = deriveVolatility(candles, spotPrice);
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
    ceOIChange: oi.ce,
    peOIChange: oi.pe,
    optionIV: summary?.iv ?? null,
    futuresPremium: analysis?.futuresPremium ?? summary?.futuresPremium ?? null,
    breadth: summary?.breadth ?? null,
    atr: vol.atr,
    vwapDistance: vol.vwapDistance,
    fiiNet: typeof fiiDii?.fiiNet === "number" ? fiiDii.fiiNet : null,
    diiNet: typeof fiiDii?.diiNet === "number" ? fiiDii.diiNet : null,
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
    symbol: analysis?.symbol ?? "NIFTY",
  };
}

export const GapAnalysis = memo(function GapAnalysis({
  analysis, summary, spotPrice, symbol, expiryDate, chainData, candles,
}: GapAnalysisProps) {
  const [giftNifty, setGiftNifty] = useState<any>(null);
  const [fiiDii, setFiiDii] = useState<any>(null);
  const [showFactors, setShowFactors] = useState(true);

  useEffect(() => {
    fetch(`/api/gift-nifty?spot=${spotPrice}`)
      .then(r => r.json())
      .then(d => { if (d.success) setGiftNifty(d); })
      .catch(() => {});
  }, [spotPrice]);

  useEffect(() => {
    fetch(`/api/fii-dii`)
      .then(r => r.json())
      .then(d => { if (d.success) setFiiDii(d); })
      .catch(() => {});
  }, []);

  const gapInput = useMemo(
    () => buildGapInput(analysis, summary, spotPrice, giftNifty, chainData, candles, fiiDii),
    [analysis, summary, spotPrice, giftNifty, chainData, candles, fiiDii],
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
  const cePct = ceOI / oiTotal;
  const expectedMovePts = gapInput.indiaVIX != null && spotPrice > 0
    ? Math.round(spotPrice * gapInput.indiaVIX / 100 * Math.sqrt(4 / 365))
    : null;

  const predColor = gapResult.prediction === "UP" ? "text-emerald-400" 
    : gapResult.prediction === "DOWN" ? "text-red-400" 
    : "text-yellow-400";

  // Direction categories for factor breakdown
  const bullFactors = gapResult.factors.filter(f => f.score > 0);
  const bearFactors = gapResult.factors.filter(f => f.score < 0);
  const neutralFactors = gapResult.factors.filter(f => f.score === 0);

  // Heatmap
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

  function fmt(n: number): string {
    if (Math.abs(n) >= 100000) return (n / 1000).toFixed(1) + "K";
    return n.toFixed(0);
  }

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
          <p className="text-xs text-muted-foreground">Institutional 12-Factor Gap Engine — Factor Breakdown Below</p>
        </div>

        {/* ═══════ TOP METRICS BAR (13 columns) ═══════ */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-13 gap-1.5">
          <MetricPill label="Spot" value={fmtFull(spotPrice)} />
          <MetricPill label="Gift Nifty" value={giftNifty ? fmtFull(giftNifty.price) : "—"}
            color={giftNifty ? (giftNifty.price > (prevClose || 0) ? "text-emerald-500" : giftNifty.price < (prevClose || 0) ? "text-red-500" : "") : "text-muted-foreground"}
            sub={giftNifty && prevClose ? `${giftNifty.price - prevClose > 0 ? "+" : ""}${(giftNifty.price - prevClose).toFixed(0)}` : ""} />
          <MetricPill label="PCR" value={pcr.toFixed(2)} color={pcr > 1.2 ? "text-emerald-500" : pcr < 0.8 ? "text-red-500" : ""} />
          <MetricPill label="VIX" value={gapInput.indiaVIX != null ? gapInput.indiaVIX.toFixed(1) : "—"} color={vixLive ? "text-violet-400" : "text-muted-foreground"} sub={vixLive ? "live" : "no feed"} />
          <MetricPill label="Max Pain" value={maxPain != null ? fmtFull(maxPain) : "—"} color="text-amber-500" />
          <MetricPill label="Sentiment" value={analysis?.sentiment ? analysis.sentiment.toUpperCase() : "—"} color={analysis?.sentiment === "bullish" ? "text-emerald-500" : analysis?.sentiment === "bearish" ? "text-red-500" : "text-muted-foreground"} />
          <MetricPill label="Expected Move" value={expectedMovePts != null ? `±${expectedMovePts} pts` : "—"} color="text-teal-400" />
          <MetricPill label="OI Bias" value={`${peOI > ceOI ? "BULL" : ceOI > peOI ? "BEAR" : "NEUTRAL"}`}
            color={peOI > ceOI ? "text-emerald-500" : ceOI > peOI ? "text-red-500" : "text-muted-foreground"} />
        </div>

        {gapResult.insufficientData && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-400/90">
            Insufficient data for prediction. Missing: {gapResult.missingFields.join(", ")}.
            Showing factor diagnostics without a final prediction.
          </div>
        )}

        {/* ═══════ 3-COLUMN LAYOUT ═══════ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ─── LEFT: Market Snapshot ─── */}
          <div className="space-y-4">
            {/* ATM Straddle */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Layers className="w-3.5 h-3.5 text-violet-500" />} text="ATM Straddle" />
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-black tabular-nums">{fmtFull(rec?.strike ?? Math.round(spotPrice / 50) * 50)}</span>
                  <span className="text-sm text-muted-foreground">Strike</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><p className="text-muted-foreground">Entry Premium</p><p className="font-bold">{rec?.entryPrice ? `₹${rec.entryPrice.toFixed(1)}` : "—"}</p></div>
                  <div><p className="text-muted-foreground">VIX Level</p><p className="font-bold">{gapInput.indiaVIX != null ? `${gapInput.indiaVIX.toFixed(1)}%` : "—"}</p></div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {gapInput.indiaVIX == null ? "Live VIX unavailable" : gapInput.indiaVIX > 20 ? "VIX elevated — premium selling favorable" : gapInput.indiaVIX < 12 ? "VIX low — options cheap" : "VIX in normal range"}
                </p>
              </CardContent>
            </Card>

            {/* Max Pain */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Target className="w-3.5 h-3.5 text-amber-500" />} text="Max Pain" />
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-black tabular-nums text-amber-500">{maxPain != null ? fmtFull(maxPain) : "—"}</span>
                  <span className={`text-xs font-medium ${maxPain != null && spotPrice > maxPain ? "text-emerald-500" : "text-red-500"}`}>
                    {maxPain != null ? `${spotPrice > maxPain ? "+" : ""}${((spotPrice - maxPain) / maxPain * 100).toFixed(2)}% from spot` : "no chain"}
                  </span>
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
                <MoodGauge pcr={pcr} vix={gapInput.indiaVIX} />
              </CardContent>
            </Card>

            {/* FII / DII Institutional Flow */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Activity className="w-3.5 h-3.5 text-indigo-400" />} text="FII / DII Flow" />
                {fiiDii?.fiiNet != null || fiiDii?.diiNet != null ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">FII Net</span>
                      <span className={`font-bold ${fiiDii.fiiNet < 0 ? "text-red-400" : "text-emerald-400"}`}>
                        {fiiDii.fiiNet > 0 ? "+" : ""}{fiiDii.fiiNet?.toLocaleString("en-IN")} Cr
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">DII Net</span>
                      <span className={`font-bold ${fiiDii.diiNet < 0 ? "text-red-400" : "text-emerald-400"}`}>
                        {fiiDii.diiNet > 0 ? "+" : ""}{fiiDii.diiNet?.toLocaleString("en-IN")} Cr
                      </span>
                    </div>
                    {fiiDii.regime && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Regime</span>
                        <span className="font-semibold text-indigo-300">{fiiDii.regime}</span>
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {fiiDii.stale ? "Stale (last known) · " : ""}{fiiDii.asOf ?? ""}
                    </p>
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground">FII/DII feed unavailable</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ─── CENTER: Gap Prediction ─── */}
          <div className="space-y-4">
            {/* Gap Prediction Card */}
            <Card className="border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-violet-500/5">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <CardTitle icon={<Zap className="w-3.5 h-3.5 text-purple-500" />} text="Institutional Gap Prediction" />
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Info className="w-3 h-3" />
                    {gapResult.confidenceCapped ? "Confidence capped" : "Raw confidence"}
                  </div>
                </div>

                {/* Prediction Badge */}
                <div className="text-center">
                  <Badge variant="outline" className={`${predColor} border-current text-xs px-3 py-1`}>
                    {gapResult.insufficientData ? "INSUFFICIENT DATA" : gapResult.prediction === "UP" ? "GAP UP ▲" : gapResult.prediction === "DOWN" ? "GAP DOWN ▼" : "FLAT —"}
                  </Badge>
                  <div className="mt-2 flex items-center justify-center gap-4 text-xs text-muted-foreground">
                    <span>Bull Score: <span className="text-emerald-400 font-bold">{gapResult.bullScore}</span></span>
                    <span>Bear Score: <span className="text-red-400 font-bold">{gapResult.bearScore}</span></span>
                  </div>
                </div>

                {/* Probability bars */}
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

                {/* Confidence */}
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

                {/* Quick Factor Summary */}
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

            {/* Factor Breakdown Table */}
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
                          <th className="text-right py-1 px-1">Weight</th>
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
                              {row.ceOiChg > 0 ? "+" : ""}{fmt(row.ceOiChg)}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono ${row.peOiChg > 0 ? "text-emerald-500" : row.peOiChg < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                              {row.peOiChg > 0 ? "+" : ""}{fmt(row.peOiChg)}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono font-bold ${row.net > 0 ? "text-emerald-500" : row.net < 0 ? "text-red-500" : ""}`}>
                              {row.net > 0 ? "+" : ""}{fmt(row.net)}
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

          {/* ─── RIGHT: Setups + Reference ─── */}
          <div className="space-y-4">
            {/* Gap Trading Setups */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-3">
                <CardTitle icon={<Shield className="w-3.5 h-3.5 text-amber-500" />} text="Gap Trading Setups" />
                {computeSetups(spotPrice, maxPain, gapInput.indiaVIX).map((setup, i) => (
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
                <CardTitle icon={<Clock className="w-3.5 h-3.5 text-blue-500" />} text="Expiry & Expected Move" />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><p className="text-muted-foreground">Days to Expiry</p><p className="font-bold text-lg">{analysis?.expiry?.daysToExpiry ?? "—"}</p></div>
                  <div><p className="text-muted-foreground">Mode</p><p className="font-bold">{rec?.riskLevel ?? "—"}</p></div>
                  <div><p className="text-muted-foreground">Theta/Day</p><p className="font-bold">{gapInput.indiaVIX != null ? `~₹${(gapInput.indiaVIX * 0.16).toFixed(1)}` : "—"}</p></div>
                  <div>
                    <p className="text-muted-foreground">Expected Move</p>
                    <p className="font-bold">
                      {gapInput.indiaVIX != null && spotPrice > 0
                        ? `±${Math.round(spotPrice * gapInput.indiaVIX / 100 * Math.sqrt(4 / 365))} pts`
                        : "—"}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Quick Reference */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-orange-500" />} text="Quick Reference" />
                <div className="space-y-1.5 text-[10px]">
                  <div className="flex items-start gap-2"><span className="text-emerald-500 mt-0.5">●</span><span><strong>Long Buildup:</strong> Price ↑ + OI ↑ = New buying</span></div>
                  <div className="flex items-start gap-2"><span className="text-red-500 mt-0.5">●</span><span><strong>Short Buildup:</strong> Price ↓ + OI ↑ = New selling</span></div>
                  <div className="flex items-start gap-2"><span className="text-amber-500 mt-0.5">●</span><span><strong>Short Covering:</strong> Price ↑ + OI ↓ = Shorts exiting</span></div>
                  <div className="flex items-start gap-2"><span className="text-blue-500 mt-0.5">●</span><span><strong>Long Unwinding:</strong> Price ↓ + OI ↓ = Longs exiting</span></div>
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

function MoodGauge({ pcr, vix }: { pcr: number; vix: number | null }) {
  let score = 3;
  if (pcr > 1.3) score += 1;
  else if (pcr < 0.7) score -= 1;
  if (typeof vix === "number") {
    if (vix > 20) score -= 1;
    else if (vix < 12) score += 1;
  }
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
    </div>
  );
}

function computeSetups(spot: number, maxPain: number | null, vix: number | null) {
  const atm = Math.round(spot / 50) * 50;
  const entryUp = vix != null ? `~₹${Math.round(vix * 0.5 + 40)}` : "—";
  const entryDown = vix != null ? `~₹${Math.round(vix * 0.5 + 35)}` : "—";
  return [
    {
      name: "Gap Up > 50 pts", color: "emerald" as const,
      action: `Buy ${atm} PE`, entry: entryUp,
      sl: `${atm + 50}`, target: `${atm - 50}`, rr: "1:2",
      note: "Fade the gap at resistance",
    },
    {
      name: "Gap Up 20-50 pts", color: "yellow" as const,
      action: "Wait for confirmation", entry: "—", sl: "—", target: "—", rr: "—",
      note: "Watch for 15-min candle close",
    },
    {
      name: "Gap Down > 50 pts", color: "red" as const,
      action: `Buy ${atm} CE`, entry: entryDown,
      sl: `${atm - 50}`, target: `${atm + 50}`, rr: "1:2",
      note: "Buy the dip at support",
    },
    {
      name: "Gap Down 20-50 pts", color: "orange" as const,
      action: "Wait for confirmation", entry: "—", sl: "—", target: "—", rr: "—",
      note: "Watch for 15-min candle close",
    },
  ];
}
