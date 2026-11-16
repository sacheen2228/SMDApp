// Simple Mode - Live Market Dashboard
// Data-driven from live option chain API, not just SDM recommendation

"use client";

import { useState, useEffect, memo } from "react";
import { OIChangePanel } from "./OIChangePanel";
import type { SDMRecommendation } from "@/types/sdm";
import type { FullAnalysis } from "@/lib/sdm-engine";
import { Badge } from "@/components/ui/badge";
import { confirmSummary } from "@/lib/signal-persistence";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getCurrentSession } from "@/lib/market-session";
import { dataSourceBadge } from "@/lib/data-source-label";
import { readPcr } from "@/lib/pcr-reading";
import { type SMCResult } from "@/lib/smc-layer";
import {
  Atom,
  Clock,
  Shield,
  Target,
  TrendingUp,
  TrendingDown,
  Pause,
  Activity,
  Zap,
  BarChart3,
  Brain,
  Layers,
  Gauge,
  ArrowRightLeft,
  RefreshCw,
  Minus,
  Calendar,
  Info,
} from "lucide-react";

interface ExpiryInfo {
  date: string;
  label: string;
  daysToExpiry: number;
}

interface MarketSummary {
  spotPrice: number;
  spotChange: number;
  spotChangePct: number;
  indiaVIX: number | null;
  pcr: number;
  atmStrike: number;
  totalCallOI: number;
  totalPutOI: number;
  callOiChange?: number | null;
  putOiChange?: number | null;
  maxPain?: number;
}

interface OptionSide {
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  ltp: number;
  chg: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
}

interface OptionData {
  strike: number;
  ce: OptionSide | null;
  pe: OptionSide | null;
}

interface OISummary {
  freshWriting: any[];
  traps: any[];
  supportResistance: any;
  classifications: any[];
  pcrOI: number;
  maxPain: number;
  /** Full OIAnalysis slice for the 14-factor quality score. */
  full?: unknown;
}

interface SimpleModeProps {
  recommendation: SDMRecommendation | null;
  spotPrice: number;
  symbol: string;
  onSwitchToPro?: () => void;
  summary?: MarketSummary | null;
  analysis?: FullAnalysis | null;
  expiries?: ExpiryInfo[];
  chainData?: OptionData[];
  dataSource?: string;
  selectedExpiry?: string;
  onExpiryChange?: (expiry: string) => void;
  oiSummary?: OISummary | null;
  /** Real ATR from the tech-cache snapshots (informational — volatility, not a direction check). */
  atrInfo?: { tf15?: number | null; tf5?: number | null; close?: number | null };
  /** The contract selectStrike picked (real gate rules) — or null when none. */
  strikeInfo?: { strike: number; otmSteps: number; isAtm: boolean; reason: string } | null;
  /** Real greeks of the traded leg (live chain row). */
  greeks?: { delta: number | null; theta: number | null; gamma: number | null; vega: number | null; iv: number | null; premium: number } | null;
  /** Timestamp of the candle the verdict was judged on (from the tech snapshot). */
  barStamp?: { asOf5m?: number | null; asOf15m?: number | null; fresh5m?: boolean };
  /** True when the market session is closed — label the verdict, never hide it. */
  marketClosed?: boolean;
  /** Quant toolkit block (forward/EM/VRP/skew/scorecard) from /api/option-chain analysis. */
  quant?: import("@/lib/quant-toolkit").QuantBlock | null;
  /** SMC layer result (sweep + CHoCH + displacement + FVG + order block). */
  smc?: SMCResult | null;
  /** Real freshness from the API (LIVE | FRESH | DELAYED | STALE | UNAVAILABLE).
   *  The old isLive = dataSource !== 'simulation' badge claimed LIVE on closed /
   *  stale / weekend chains — the exchange's own freshness label is the truth. */
  freshness?: string | null;
}

function fmt(n: number | undefined | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function fmtCurrency(n: number | undefined | null): string {
  if (n == null) return "—";
  return "₹" + n.toFixed(1);
}

function formatIndian(num: number | undefined | null): string {
  if (num == null) return "—";
  if (num >= 10000000) return (num / 10000000).toFixed(2) + " Cr";
  if (num >= 100000) return (num / 100000).toFixed(2) + " L";
  if (num >= 1000) return num.toLocaleString("en-IN");
  return num.toString();
}

// ─── Market Mood (1-5 scale) ────────────────────────────────────
// Uses the CANONICAL PCR bands (lib/pcr-reading) so the mood never
// contradicts the PCR caption on the same card (the old copy used its own
// cut-offs: 1.30/0.70 here vs 1.20/0.80 in the caption).
function computeMood(pcr: number, vix: number): { score: number; label: string; color: string } {
  let score = 3;
  const pcrBias = readPcr(pcr).bias;
  if (pcrBias === "bullish") score += 1;
  else if (pcrBias === "bearish") score -= 1;
  if (vix > 20) score -= 1;
  else if (vix < 12) score += 1;
  score = Math.max(1, Math.min(5, score));

  const moods = [
    { score: 1, label: "Extreme Fear", color: "text-red-500" },
    { score: 2, label: "Fear", color: "text-orange-500" },
    { score: 3, label: "Neutral", color: "text-yellow-500" },
    { score: 4, label: "Greed", color: "text-emerald-400" },
    { score: 5, label: "Extreme Greed", color: "text-emerald-500" },
  ];
  return moods.find((m) => m.score === score)!;
}

function SessionTimer() {
  const [time, setTime] = useState("");
  const [session, setSession] = useState(getCurrentSession());

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
      const ist = new Date(istMs);
      setTime(
        ist.getUTCHours().toString().padStart(2, "0") +
          ":" +
          ist.getUTCMinutes().toString().padStart(2, "0") +
          ":" +
          ist.getUTCSeconds().toString().padStart(2, "0")
      );
      setSession(getCurrentSession());
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Clock className="w-3 h-3" />
      <span className="tabular-nums font-mono">{time}</span>
      <Badge
        className={`text-[9px] ${
          session.confidenceMultiplier >= 0.8
            ? "bg-emerald-600"
            : session.confidenceMultiplier >= 0.5
            ? "bg-yellow-600"
            : "bg-gray-600"
        } text-white`}
      >
        {session.label}
      </Badge>
    </div>
  );
}

export const SimpleMode = memo(function SimpleMode({
  recommendation,
  spotPrice,
  symbol,
  onSwitchToPro,
  summary,
  analysis,
  expiries,
  chainData,
  dataSource,
  selectedExpiry,
  onExpiryChange,
  oiSummary,
  confirmations: confirmationsProp,
  atrInfo,
  strikeInfo,
  greeks,
  barStamp,
  marketClosed,
  quant,
  smc,
  freshness,
}: SimpleModeProps) {
  const rec = recommendation;
  const confirmations = confirmationsProp || rec?.confirmations || [];
  const { pass: confirmPass, total: confirmTotal } = confirmSummary(confirmations);

  // Live data from summary (falls back to recommendation, then defaults)
  const livePCR = summary?.pcr ?? rec?.marketContext?.pcr ?? 0;
  // `liveVIXRaw` is numeric for computation; `vixLive` gates DISPLAY — never
  // fabricate a live VIX reading when the exchange didn't publish one.
  const liveVIXRaw = summary?.indiaVIX ?? (rec?.marketContext?.vix > 0 ? rec.marketContext.vix : undefined);
  const vixLive = liveVIXRaw != null && Number.isFinite(liveVIXRaw) && liveVIXRaw > 0;
  const liveVIX = liveVIXRaw ?? 15;
  const dte = selectedExpiry ? expiries?.find((e) => e.date === selectedExpiry)?.daysToExpiry ?? rec?.daysToExpiry ?? 0 : rec?.daysToExpiry ?? 0;
  const liveMaxPain = rec?.marketContext?.maxPain;
  const liveATM = summary?.atmStrike ?? rec?.strike ?? 0;
  const liveATMValid = liveATM != null && Number.isFinite(liveATM) && liveATM > 0;
  const liveCEOI = summary?.totalCallOI ?? 0;
  const livePEOI = summary?.totalPutOI ?? 0;
  const isLive = freshness === "LIVE";

  // ONE PCR reading for every card on this tab (canonical bands) — the old
  // code had four different cut-offs, so the same PCR could read "Neutral"
  // on one card and "Bearish Flow" on another.
  const pcrReading = readPcr(livePCR);
  const oiPcrReading = readPcr(oiSummary?.pcrOI);
  const mood = computeMood(livePCR, liveVIX);

  // Derive direction from the VOTED direction first (D-1: optionType only
  // exists for a real CALL/PUT). This is the engine's BIAS — it is shown as
  // information only. The Simple tab issues no trade action.
  const isCall = rec?.direction === "CALL" || rec?.optionType === "CE";
  const isPut = rec?.direction === "PUT" || rec?.optionType === "PE";
  const isWait = rec?.direction === "WAIT" || (!isCall && !isPut);
  const isLoading = !rec;

  const gradeColors: Record<string, string> = {
    "A+": "bg-emerald-500 text-white",
    A: "bg-emerald-600 text-white",
    B: "bg-yellow-500 text-white",
    C: "bg-orange-500 text-white",
    D: "bg-red-500 text-white",
  };

  // The Simple tab is READ-ONLY ANALYSIS. It never renders a BUY CALL /
  // BUY PUT action and never arms a trade: there is no trigger gate, no
  // trigger confirmation and no trade plan on this tab. The engine's
  // directional read is still reported as a BIAS (what it is watching),
  // but the verdict itself is always NO TRADE here.
  const actionLabel = isLoading ? "ANALYZING" : "NO TRADE";
  const actionIcon = isLoading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Pause className="w-5 h-5" />;
  const actionColor = isLoading
    ? "border-muted bg-muted/20"
    : "border-muted bg-muted/30";
  // The bias label is informational — it names the leg the engine watches,
  // it is not an instruction to trade it.
  const biasLabel = isWait ? "NO BIAS" : isCall ? "CALL BIAS" : "PUT BIAS";

  return (
    <div className="flex flex-col gap-4 p-4 max-w-4xl mx-auto overflow-auto">
      {/* ─── TOP BAR ─── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">{symbol}</span>
          <span className="text-xl font-black tabular-nums">{fmt(spotPrice)}</span>
          <Badge variant="outline" className="text-[10px]">{symbol === "NIFTY" ? "NIFTY 50" : symbol}</Badge>
          {isLive && (
            <Badge className="text-[9px] bg-emerald-600 text-white h-5 px-1.5">LIVE</Badge>
          )}
          {!isLive && freshness && freshness !== "LIVE" && (
            <Badge
              className={`text-[9px] text-white h-5 px-1.5 ${
                freshness === "STALE" || freshness === "UNAVAILABLE"
                  ? "bg-red-600"
                  : freshness === "DELAYED"
                    ? "bg-orange-600"
                    : "bg-zinc-600"
              }`}
              title={`Data freshness: ${freshness}`}
            >
              {freshness}
            </Badge>
          )}
          {marketClosed && (
            <Badge className="text-[9px] bg-zinc-600 text-white h-5 px-1.5">CLOSED</Badge>
          )}
          {rec?.isExpiryDay && (
            <Badge className="text-[9px] bg-orange-600 text-white h-5 px-1.5">EXPIRY DAY — no option buys</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {expiries && expiries.length > 0 && (
            <Select value={selectedExpiry} onValueChange={(v) => onExpiryChange?.(v)}>
              <SelectTrigger className="h-7 text-[10px] w-[130px]">
                <Calendar className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {expiries.map((exp) => (
                  <SelectItem key={exp.date} value={exp.date} className="text-xs">
                    {exp.label} ({exp.daysToExpiry}d)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <SessionTimer />
        </div>
      </div>

      {/* ─── LIVE MARKET STATS STRIP ─── */}
      {summary && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-muted/30 border text-xs overflow-x-auto">
          <span
            className={`text-muted-foreground font-semibold uppercase tracking-wider text-[10px] ${
              isLive ? "text-emerald-500" : ""
            }`}
            title={freshness ? `Data freshness: ${freshness}` : undefined}
          >
            {isLive ? "LIVE" : freshness || "DATA"}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">VIX</span>
            <span className="font-bold tabular-nums">{summary.indiaVIX != null ? `${fmt(summary.indiaVIX)}%` : "—"}</span>
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">PCR</span>
            <span className={`font-bold tabular-nums ${pcrReading.bias === "neutral" ? "" : pcrReading.tone}`}>
              {summary.pcr?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">ATM</span>
            <span className="font-bold tabular-nums text-primary">{liveATMValid ? liveATM : "—"}</span>
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">CE OI</span>
            <span className="font-bold tabular-nums text-red-500">{formatIndian(summary.totalCallOI)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">PE OI</span>
            <span className="font-bold tabular-nums text-emerald-500">{formatIndian(summary.totalPutOI)}</span>
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center gap-1">
            <span className={`font-bold tabular-nums ${(summary.spotChange || 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {(summary.spotChange || 0) >= 0 ? "+" : ""}{fmt(summary.spotChange)} ({(summary.spotChange || 0) >= 0 ? "+" : ""}{fmt(summary.spotChangePct)}%)
            </span>
          </div>
        </div>
      )}

      {/* ─── AI SIGNAL CARD ─── */}
      <div className={`rounded-xl border ${actionColor} p-4`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted">
              {actionIcon}
            </div>
            <div>
              <h2 className="text-xl font-black tracking-tight">{actionLabel}</h2>
              {isLoading ? (
                <p className="text-sm text-muted-foreground">AI is scanning {symbol} market data...</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {symbol} {rec.strike} {isCall ? "CE" : isPut ? "PE" : "—"}
                  {` · ${biasLabel}`}
                  {strikeInfo ? ` · ${strikeInfo.isAtm ? "ATM" : `${strikeInfo.otmSteps} OTM`}` : ""}
                  {greeks?.delta != null ? ` · Δ ${greeks.delta.toFixed(2)}` : ""}
                  {` · ${isLive ? "Live Data" : freshness ? `${freshness} data` : dataSource || "Data"}`}
                </p>
              )}
            </div>
          </div>
          {!isLoading && (
            <div className="text-right">
              {/* This tab issues no trade action, so it shows no trade
                  confidence and no trade grade. The quant scorecard's verdict
                  and score are the real read; with no scorecard, say so. */}
              <div className="text-xl font-black tabular-nums">—</div>
              <Badge className="bg-muted text-muted-foreground text-[10px]">
                {quant?.scorecard?.verdict === "SKIP" ? "SKIP" : "NO SETUP"}
              </Badge>
              {quant?.scorecard && (
                <div className="mt-1">
                  <Badge variant="outline" className="text-[10px]">
                    {quant.scorecard.total}/{quant.scorecard.maxTotal} · {quant.scorecard.confidence}
                  </Badge>
                </div>
              )}
              {rec.qualityScore && (
                <div className="mt-1">
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${
                      rec.qualityScore.overall >= 70
                        ? "border-emerald-500 text-emerald-400"
                        : rec.qualityScore.overall >= 50
                          ? "border-yellow-500 text-yellow-400"
                          : "border-red-500 text-red-400"
                    }`}
                    title={rec.qualityScore.status === "DEGRADED" ? "Some factors degraded (missing engines → neutral)" : "14-factor quality"}
                  >
                    Quality {rec.qualityScore.overall} · {rec.qualityScore.grade}
                    {rec.qualityScore.status === "DEGRADED" ? " · partial" : ""}
                  </Badge>
                </div>
              )}
              {/* Context reads only — a tally of what the market is doing,
                  not a gate and not a confirmation of a trade. */}
              {confirmTotal > 0 && (
                <Badge
                  className={`text-[10px] ${
                    confirmPass === 0
                      ? "bg-red-600 text-white"
                      : "bg-yellow-600 text-white"
                  }`}
                >
                  {`Context ${confirmPass}/${confirmTotal}`}
                </Badge>
              )}
            </div>
          )}
        </div>
        {/* The Entry / SL / T1 / T2 / R:R / lot-sizing strip is deliberately
            NOT rendered here: those are a trade plan, and this tab issues no
            trade. The live levels live in the Pro tab and in the alerts. */}
        {!isLoading && (oiSummary?.freshWriting.length || oiSummary?.traps.length) ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-border/50 text-xs">
            {oiSummary && oiSummary.freshWriting.length > 0 && (
              <span className="text-blue-500 font-bold">📊 OI Writing</span>
            )}
            {oiSummary && oiSummary.traps.length > 0 && (
              <span className="text-orange-500 font-bold">⚠️ OI Trap</span>
            )}
          </div>
        ) : null}
        {rec?.reason && (
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{rec.reason}</p>
        )}
        {/* 14-Factor Quality Score — same engine as Pro (sdm-scores). */}
        {rec?.qualityScore && rec.qualityScore.factors.length > 0 && (
          <div className="mt-3 p-3 rounded-lg bg-muted/40 border border-border/50 text-xs">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-3 h-3 text-purple-500" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                14-Factor Quality ({rec.qualityScore.overall} — Grade {rec.qualityScore.grade})
              </span>
              {rec.qualityScore.status === "DEGRADED" && (
                <span className="text-[9px] text-yellow-500">partial data</span>
              )}
            </div>
            <div className="space-y-1">
              {rec.qualityScore.factors.map((factor) => (
                <div key={factor.name} className="flex items-center gap-2" title={`${factor.detail} · ${factor.source}`}>
                  <span className="text-[9px] text-muted-foreground w-24 truncate">
                    {factor.name}
                  </span>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        factor.score >= 70 ? "bg-emerald-500" :
                        factor.score >= 50 ? "bg-yellow-500" :
                        "bg-red-500"
                      }`}
                      style={{ width: `${factor.score}%` }}
                    />
                  </div>
                  <span className={`text-[9px] w-6 text-right font-mono ${
                    factor.score >= 60 ? "text-emerald-400" :
                    factor.score >= 40 ? "text-yellow-400" :
                    "text-red-400"
                  }`}>
                    {factor.score}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* REAL greeks of the traded leg — live chain row, "—" when the provider didn't publish a field. */}
        {greeks && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Delta <span className="font-bold text-foreground">{greeks.delta != null ? greeks.delta.toFixed(2) : "—"}</span></span>
            <span>
              Theta <span className="font-bold text-foreground">{greeks.theta != null ? greeks.theta.toFixed(2) : "—"}</span>
              {greeks.theta != null && greeks.premium > 0 && (
                <span className="text-[10px]"> ({((Math.abs(greeks.theta) / greeks.premium) * 100).toFixed(1)}%/day)</span>
              )}
            </span>
            <span>IV <span className="font-bold text-foreground">{greeks.iv != null ? `${greeks.iv.toFixed(1)}` : "—"}</span></span>
            <span>Gamma <span className="font-bold text-foreground">{greeks.gamma != null ? greeks.gamma.toFixed(4) : "—"}</span></span>
            <span>Vega <span className="font-bold text-foreground">{greeks.vega != null ? greeks.vega.toFixed(2) : "—"}</span></span>
          </div>
        )}
        {oiSummary && (
          <div className="mt-3 p-3 rounded-lg bg-muted/40 border border-border/50 text-xs">
            <div className="flex items-center gap-2 mb-1">
              <Layers className="w-3 h-3 text-blue-500" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">OI Analysis</span>
            </div>
            <div className="space-y-0.5">
              <div className="flex justify-between">
                <span className="text-muted-foreground">PCR (OI)</span>
                <span className={`font-bold tabular-nums ${oiPcrReading.bias === "neutral" ? "text-yellow-500" : oiPcrReading.tone}`}>
                  {oiSummary.pcrOI.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Max Pain</span>
                <span className="font-bold tabular-nums">{fmt(oiSummary.maxPain)}</span>
              </div>
              {oiSummary.freshWriting.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fresh Writing</span>
                  <span className="font-bold tabular-nums text-blue-500">
                    CE {oiSummary.freshWriting.filter((f:any)=>f.side==='CE').length} · PE {oiSummary.freshWriting.filter((f:any)=>f.side==='PE').length}
                  </span>
                </div>
              )}
              {oiSummary.traps.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">OI Traps</span>
                  <span className="font-bold tabular-nums text-orange-500">{oiSummary.traps.length}</span>
                </div>
              )}
              {oiSummary.supportResistance?.resistance?.[0] && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Resistance (CE wall)</span>
                  <span className="font-bold tabular-nums">
                    {fmt(oiSummary.supportResistance.resistance[0].strike)}
                    <span className="text-[9px] text-muted-foreground ml-1">
                      {(oiSummary.supportResistance.resistance[0].oi / 1000).toFixed(0)}K OI
                    </span>
                  </span>
                </div>
              )}
              {oiSummary.supportResistance?.support?.[0] && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Support (PE wall)</span>
                  <span className="font-bold tabular-nums">
                    {fmt(oiSummary.supportResistance.support[0].strike)}
                    <span className="text-[9px] text-muted-foreground ml-1">
                      {(oiSummary.supportResistance.support[0].oi / 1000).toFixed(0)}K OI
                    </span>
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        {confirmTotal > 0 && (
          <div className="mt-3 p-3 rounded-lg bg-muted/40 border border-border/50 text-xs">
            <div className="flex items-center gap-2 mb-1">
              <Shield className="w-3 h-3 text-blue-500" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Market Context</span>
              {barStamp?.asOf5m ? (
                <span className="text-[9px] text-muted-foreground">
                  {new Date(barStamp.asOf5m).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })} {barStamp.fresh5m ? "5m" : "15m"} candle
                </span>
              ) : barStamp?.asOf15m ? (
                <span className="text-[9px] text-muted-foreground">
                  {new Date(barStamp.asOf15m).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })} 15m candle
                </span>
              ) : null}
              <span className={`ml-2 text-[10px] ${
                confirmPass === 0
                  ? "bg-red-600 text-white"
                  : "bg-yellow-600 text-white"
              } px-1.5`}>
                {confirmPass}/{confirmTotal}
              </span>
            </div>
            <div className="space-y-0.5">
              {(atrInfo?.tf15 != null || atrInfo?.tf5 != null) && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">ATR</span>
                  <span className="text-[10px] font-bold tabular-nums text-blue-400">
                    {atrInfo?.tf15 != null && (
                      <>15m {atrInfo.tf15.toFixed(1)}{atrInfo.close ? ` (${((atrInfo.tf15 / atrInfo.close) * 100).toFixed(2)}%)` : ""}</>
                    )}
                    {atrInfo?.tf15 != null && atrInfo?.tf5 != null && <span className="text-muted-foreground"> · </span>}
                    {atrInfo?.tf5 != null && <>5m {atrInfo.tf5.toFixed(1)}</>}
                  </span>
                </div>
              )}
              {confirmations.map((c) => (
                <div key={c.name} className="flex justify-between">
                  <span className="text-muted-foreground">{c.name}</span>
                  <span
                    className={`text-[10px] font-bold ${
                      !c.available
                        ? "text-gray-500"
                        : c.pass
                          ? "text-emerald-500"
                          : "text-red-500"
                    }`}
                  >
                    {!c.available ? "—" : c.pass ? "✓" : "✗"} {c.detail}
                  </span>
                </div>
              ))}
              {/* These are READ-ONLY context reads. Nothing here confirms,
                  arms or triggers a trade — the tab issues no trade action. */}
              <p className="text-[9px] text-muted-foreground/70 mt-1">
                Context reads only — no trigger, no trade action on this tab.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ─── 6-CARD GRID ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {/* 1. ATM Straddle */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Layers className="w-4 h-4 text-violet-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">ATM Straddle</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Strike</span>
              <span className="font-bold tabular-nums text-base">{liveATMValid ? liveATM : "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Leg Prem</span>
              <span className="font-bold tabular-nums text-base">{rec?.entry && rec.entry > 0 ? fmtCurrency(rec.entry) : "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">IV</span>
              <span className="font-bold tabular-nums text-base">{vixLive ? `${liveVIX.toFixed(1)}%` : "—"}</span>
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              {!vixLive ? "" : liveVIX > 20 ? "IV elevated — options expensive" : liveVIX < 12 ? "IV low — options cheap" : "IV normal range"}
            </p>
          </div>
        </div>

        {/* 2. Max Pain */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Target className="w-4 h-4 text-amber-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Max Pain</span>
          </div>
          <div className="space-y-1.5">
            {liveMaxPain != null && Number.isFinite(liveMaxPain) ? (
              <>
                <div className="text-2xl font-black tabular-nums">{fmt(liveMaxPain)}</div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Spot</span>
                  <span className="font-bold tabular-nums text-base">{fmt(spotPrice)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Distance</span>
                  <span className={`font-bold tabular-nums text-base ${spotPrice > liveMaxPain ? "text-emerald-500" : "text-red-500"}`}>
                    {spotPrice > liveMaxPain ? "+" : ""}{((spotPrice - liveMaxPain) / (liveMaxPain || 1) * 100).toFixed(2)}%
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground/70 mt-1">Market often gravitates here</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
        </div>

        {/* 3. Key Levels — REAL structures only: OI walls + Max Pain + session VWAP.
            The old spot±1.2% "Camarilla" grid invented levels the market never priced. */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Key Levels</span>
          </div>
          <div className="space-y-0.5 text-xs tabular-nums">
            {(() => {
              // A wall is only shown on the CORRECT side of spot: resistance
              // above, support below. A "support" printed above spot is
              // unreachable and a "resistance" below it is already broken —
              // both are fake levels, so they are dropped, not relabelled.
              const rawResistance = rec?.gammaWallResistance || quant?.walls?.resistanceK || null;
              const rawSupport = rec?.gammaWallSupport || quant?.walls?.supportK || null;
              const resistance = rawResistance != null && rawResistance > spotPrice ? rawResistance : null;
              const support = rawSupport != null && rawSupport < spotPrice ? rawSupport : null;
              // Wall STRENGTH (open interest) is only known for walls the
              // quant toolkit measured; the gamma walls carry no OI, so their
              // strength is honestly absent rather than invented.
              const fmtOi = (oi: number | null | undefined) =>
                oi == null ? "" : ` · OI ${(oi / 1000).toFixed(0)}k`;
              const rows: Array<{ label: string; value: number | null; tone: string; suffix?: string }> = [
                { label: "R — CE WALL", value: resistance, tone: "text-emerald-500 font-medium", suffix: fmtOi(quant?.walls?.resistanceK === resistance ? quant?.walls?.resistanceOi : null) },
                { label: "PIVOT (SPOT)", value: spotPrice || null, tone: "font-bold text-primary border-t border-border pt-0.5" },
                { label: "S — PE WALL", value: support, tone: "text-red-500 font-medium", suffix: fmtOi(quant?.walls?.supportK === support ? quant?.walls?.supportOi : null) },
                { label: "MAX PAIN", value: rec?.marketContext?.maxPain || null, tone: "text-muted-foreground" },
                { label: "SESSION VWAP", value: quant?.vwapZ?.vwap ?? null, tone: "text-muted-foreground" },
              ];
              const visible = rows.filter((r) => r.value != null && r.value > 0);
              if (!visible.length) {
                return <p className="text-muted-foreground text-[10px]">No real levels available (no walls / no chain)</p>;
              }
              return visible.map((r) => (
                <div key={r.label} className={`flex justify-between ${r.tone}`}>
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className="font-semibold">{fmt(r.value)}{r.suffix ? <span className="text-[9px] font-normal text-muted-foreground">{r.suffix}</span> : null}</span>
                </div>
              ));
            })()}
          </div>
        </div>

        {/* 4. Market Mood */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Gauge className="w-4 h-4 text-rose-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Market Mood</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className={`w-4 h-4 rounded-sm ${
                      i <= mood.score
                        ? mood.score <= 2
                          ? "bg-red-500"
                          : mood.score === 3
                          ? "bg-yellow-500"
                          : "bg-emerald-500"
                        : "bg-muted"
                    }`}
                  />
                ))}
              </div>
              <span className={`text-sm font-bold ${mood.color}`}>{mood.label}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">PCR</span>
              <span className={`font-bold tabular-nums text-base ${pcrReading.bias === "neutral" ? "" : pcrReading.tone}`}>
                {livePCR.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">VIX</span>
              <span className="font-bold tabular-nums text-base">{vixLive ? liveVIX.toFixed(1) : "—"}</span>
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1">{pcrReading.detail}</p>
          </div>
        </div>

        {/* 5. Money Flow (live OI from summary) */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <ArrowRightLeft className="w-4 h-4 text-cyan-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Money Flow</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">CE OI</span>
              <span className="font-bold tabular-nums text-base text-red-500">{formatIndian(liveCEOI)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">PE OI</span>
              <span className="font-bold tabular-nums text-base text-emerald-500">{formatIndian(livePEOI)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">PCR</span>
              <span className={`font-bold tabular-nums text-base ${pcrReading.bias === "neutral" ? "text-yellow-500" : pcrReading.tone}`}>
                {livePCR.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Direction</span>
              <span className={`font-bold text-base ${pcrReading.bias === "neutral" ? "text-yellow-500" : pcrReading.tone}`}>
                {pcrReading.bias === "bullish" ? "Bullish Flow" : pcrReading.bias === "bearish" ? "Bearish Flow" : "Neutral"}
              </span>
            </div>
          </div>
        </div>

        {/* 5b. Quant Toolkit — REAL math on real chain + candles. Missing data
            shows "unavailable"; every baseline is labeled as a baseline. */}
        {quant && (
          <div className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Activity className="w-4 h-4 text-violet-500" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Quant Toolkit</span>
              {quant.scorecard && (
                <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  quant.scorecard.verdict === "SKIP" ? "bg-muted text-muted-foreground" : "bg-emerald-500/15 text-emerald-500"
                }`}>
                  {quant.scorecard.verdict.replace("_", " ")} · {quant.scorecard.total}/{quant.scorecard.maxTotal} · {quant.scorecard.confidence}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Implied Fwd</span><span className="font-semibold tabular-nums">{quant.forward ? fmt(quant.forward.f) : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Basis vs spot</span><span className="font-semibold tabular-nums">{quant.forward ? `${quant.forward.basisPct >= 0 ? "+" : ""}${quant.forward.basisPct.toFixed(2)}%` : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">EM (25m)</span><span className="font-semibold tabular-nums">{quant.expectedMove ? `±${quant.expectedMove.emPct.toFixed(2)}%` : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">ATM IV</span><span className="font-semibold tabular-nums">{quant.atmIv ? `${quant.atmIv.toFixed(1)}%` : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">RV (5m)</span><span className="font-semibold tabular-nums">{quant.rvPct != null ? `${quant.rvPct.toFixed(1)}%` : "—"}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">VRP</span>
                <span className={`font-semibold ${quant.vrp?.verdict === "expensive" ? "text-red-500" : quant.vrp?.verdict === "cheap" ? "text-emerald-500" : ""}`}>
                  {quant.vrp ? quant.vrp.verdict : "—"}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">Skew (PC)</span><span className="font-semibold tabular-nums">{quant.skew ? `${quant.skew.skewIv >= 0 ? "+" : ""}${quant.skew.skewIv.toFixed(1)}` : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">VWAP z</span><span className="font-semibold tabular-nums">{quant.vwapZ ? quant.vwapZ.z.toFixed(2) : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">BB %B</span><span className="font-semibold tabular-nums">{quant.bb ? quant.bb.percentB.toFixed(2) : "—"}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">BB regime</span>
                <span className="font-semibold">{quant.bb ? `${quant.bb.regime === "trending" ? "TREND" : "REVERT"}${quant.bb.squeeze ? " · squeeze" : ""}` : "—"}</span>
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">RN mass (walls)</span><span className="font-semibold tabular-nums">{quant.rnMass ? `${(quant.rnMass.mass * 100).toFixed(0)}%${quant.rnMass.negativeCount ? ` (${quant.rnMass.negativeCount} noisy)` : ""}` : "—"}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Timing</span>
                <span className={`font-semibold ${quant.timing.ok ? "text-emerald-500" : "text-red-500"}`}>{quant.timing.ok ? "OK" : "BLOCKED"}</span>
              </div>
            </div>

            {/* Scorecard — every row shown; unknown = null shown honestly */}
            {quant.scorecard && (
              <div className="mt-2 pt-2 border-t border-border">
                {/* The row count comes from the scorecard itself — the label
                    used to say "× 9" while 10 rows rendered (SMC was added
                    as the 10th factor). */}
                <p className="text-[10px] font-bold text-muted-foreground uppercase mb-1">
                  Scorecard (0-2 × {quant.scorecard.rows.length})
                </p>
                <div className="space-y-0.5">
                  {quant.scorecard.rows.map((r) => (
                    <div key={r.factor} className="flex justify-between text-[10px]">
                      <span className="text-muted-foreground truncate mr-2">{r.factor}</span>
                      <span className={`font-bold ${r.score == null ? "text-muted-foreground/50" : r.score >= 2 ? "text-emerald-500" : r.score === 1 ? "text-yellow-500" : "text-red-500"}`}>
                        {r.score == null ? "n/a" : `${r.score}/2`}
                      </span>
                    </div>
                  ))}
                </div>
                {quant.scorecard.notes.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {quant.scorecard.notes.map((n, i) => (
                      <p key={i} className="text-[10px] text-orange-400">⚠ {n}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Honest unavailability + assumptions */}
            {(quant.unavailableReasons.length > 0 || !quant.timing.ok) && (
              <p className="text-[10px] text-muted-foreground/70 mt-2">
                {quant.unavailableReasons.length > 0 ? `Unavailable: ${quant.unavailableReasons.slice(0, 3).join("; ")}` : ""}
              </p>
            )}
            <p className="text-[9px] text-muted-foreground/60 mt-1">
              Baselines are zero-drift references, not forecasts. No win probability is produced.
            </p>
          </div>
        )}

        {/* 5c. SMC Layer (objective price/volume/OI behaviour only) */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              SMC Layer ({smc?.scorePoints ?? 0}/2)
            </span>
            <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded ${
              !smc ? "bg-muted text-muted-foreground" :
              smc.scorePoints >= 2 ? "bg-emerald-500/15 text-emerald-500" :
              smc.scorePoints === 1 ? "bg-yellow-500/15 text-yellow-500" :
              "bg-muted text-muted-foreground"
            }`}>
              {!smc ? "N/A" : smc.scorePoints === 2 ? "STRONG" : smc.scorePoints === 1 ? "WEAK" : "NONE"}
            </span>
          </div>

          {!smc && (
            <div className="h-32 flex flex-col items-center justify-center text-muted-foreground">
              <p className="text-[10px]">No candle data available</p>
              <p className="text-[9px] text-muted-foreground/60 mt-1">
                SMC needs real 5m candles (Breeze/NSE). The chain response carried no
                usable intraday series — market closed or the feed was down.
              </p>
            </div>
          )}

          {smc && (
            <>
              {/* Structure timeline + trend + premium/discount + liquidity grabs */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] mb-2">
                <span className="font-bold text-muted-foreground">Trend</span>
                <span className={`font-bold ${smc.structureTrend === "UP" ? "text-emerald-500" : smc.structureTrend === "DOWN" ? "text-red-500" : "text-yellow-500"}`}>
                  {smc.structureTrend === "UP" ? "▲ UP (HH/HL)" : smc.structureTrend === "DOWN" ? "▼ DOWN (LH/LL)" : "— SIDEWAYS"}
                </span>
                <span className="text-muted-foreground">Zone</span>
                <span className={`font-bold ${smc.premiumDiscount.zone === "premium" ? "text-red-500" : smc.premiumDiscount.zone === "discount" ? "text-emerald-500" : "text-muted-foreground"}`}>
                  {smc.premiumDiscount.zone === "none" ? "—" : `${smc.premiumDiscount.zone.toUpperCase()}${smc.premiumDiscount.positionPct != null ? ` ${smc.premiumDiscount.positionPct.toFixed(0)}%` : ""}`}
                </span>
                <span className="text-muted-foreground">Grabs</span>
                <span className="font-bold text-blue-400">{smc.liquidityGrabs}</span>
                <span className="text-muted-foreground">EQ H/L</span>
                <span className="font-bold text-blue-400">{smc.equalLevels.length}</span>
              </div>

              {/* Premium/discount visual bar */}
              {smc.premiumDiscount.mid != null && smc.premiumDiscount.swingLow != null && smc.premiumDiscount.swingHigh != null && (
                <div className="mb-2">
                  <div className="flex justify-between text-[8px] text-muted-foreground mb-0.5">
                    <span>Low {smc.premiumDiscount.swingLow.toFixed(0)}</span>
                    <span>Mid {smc.premiumDiscount.mid.toFixed(0)}</span>
                    <span>High {smc.premiumDiscount.swingHigh.toFixed(0)}</span>
                  </div>
                  <div className="relative h-2 rounded bg-muted overflow-hidden">
                    <div className="absolute inset-y-0 left-0 w-1/2 bg-emerald-500/25" />
                    <div className="absolute inset-y-0 right-0 w-1/2 bg-red-500/25" />
                    {smc.premiumDiscount.positionPct != null && (
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-foreground"
                        style={{ left: `${smc.premiumDiscount.positionPct}%` }}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Structure timeline chips */}
              {smc.structure.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {smc.structure.slice(-8).map((e, i) => (
                    <span
                      key={`${e.type}-${e.price}-${i}`}
                      className={`text-[8px] px-1 py-0.5 rounded font-bold ${
                        e.type === "BOS" || e.type === "CHOCH"
                          ? e.dir === "bullish" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
                          : e.type === "HH" || e.type === "HL"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-red-500/10 text-red-500"
                      }`}
                      title={`${e.type} @${e.price.toFixed(2)} ${e.time}`}
                    >
                      {e.type} {e.price.toFixed(0)}
                    </span>
                  ))}
                </div>
              )}

              {/* Equal highs/lows */}
              {smc.equalLevels.length > 0 && (
                <div className="mb-2">
                  <p className="text-[9px] font-bold text-muted-foreground mb-0.5">Equal Levels (liquidity pools)</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px]">
                    {smc.equalLevels.map((eq) => (
                      <span key={`${eq.side}-${eq.price}`} className={eq.swept ? "text-orange-400" : "text-blue-400"}>
                        {eq.side === "high" ? "EQH" : "EQL"} {eq.price.toFixed(0)} ×{eq.count}
                        {eq.swept ? " ⚡swept" : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Order blocks + FVGs with distance */}
              {(smc.orderBlocks.length > 0 || smc.fvgs.some((f) => !f.filled)) && (
                <div className="mb-2">
                  <p className="text-[9px] font-bold text-muted-foreground mb-0.5">Zones (OB / FVG)</p>
                  <div className="space-y-0.5">
                    {smc.orderBlocks.slice(0, 3).map((ob, i) => {
                      const mid = (ob.lo + ob.hi) / 2;
                      const dist = ((mid - smc.spot) / smc.spot * 100);
                      return (
                        <div key={`ob-${i}`} className="flex justify-between text-[9px]">
                          <span className="text-muted-foreground">OB {ob.dir} {ob.lo.toFixed(0)}–{ob.hi.toFixed(0)}</span>
                          <span className={`font-bold ${dist >= 0 ? "text-red-400" : "text-emerald-400"}`}>
                            {dist >= 0 ? "+" : ""}{dist.toFixed(2)}%
                          </span>
                        </div>
                      );
                    })}
                    {smc.fvgs.filter((f) => !f.filled).slice(0, 3).map((f, i) => {
                      const mid = (f.lo + f.hi) / 2;
                      const dist = ((mid - smc.spot) / smc.spot * 100);
                      return (
                        <div key={`fvg-${i}`} className="flex justify-between text-[9px]">
                          <span className="text-muted-foreground">FVG {f.dir} {f.lo.toFixed(0)}–{f.hi.toFixed(0)}</span>
                          <span className={`font-bold ${dist >= 0 ? "text-red-400" : "text-emerald-400"}`}>
                            {dist >= 0 ? "+" : ""}{dist.toFixed(2)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Gates table */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mb-2">
                <div className="flex justify-between border-b pb-0.5">
                  <span className="text-muted-foreground">G16 Sweep+CHOCH+Disp</span>
                  <span className={`font-bold ${smc.g16.passed ? "text-emerald-500" : "text-red-500"}`}>
                    {smc.g16.passed ? "PASS" : "FAIL"}
                  </span>
                </div>
                <div className="flex justify-between border-b pb-0.5">
                  <span className="text-muted-foreground">G17 Level Confluence</span>
                  <span className={`font-bold ${smc.g17.passed ? "text-emerald-500" : "text-red-500"}`}>
                    {smc.g17.passed ? "PASS" : "FAIL"}
                  </span>
                </div>
                <div className="flex justify-between border-b pb-0.5">
                  <span className="text-muted-foreground">G18 Retest+Zone</span>
                  <span className={`font-bold ${smc.g18.passed ? "text-emerald-500" : "text-red-500"}`}>
                    {smc.g18.passed ? "PASS" : "FAIL"}
                  </span>
                </div>
                <div className="flex justify-between border-b pb-0.5">
                  <span className="text-muted-foreground">G19 Stop Placement</span>
                  <span className={`font-bold ${smc.g19.passed ? "text-emerald-500" : "text-red-500"}`}>
                    {smc.g19.passed ? "PASS" : "FAIL"}
                  </span>
                </div>
              </div>

              {/* Score reason */}
              <p className="text-[9px] text-muted-foreground/70 mb-2">{smc.scoreReason}</p>

              {/* Marked levels table */}
              <div className="overflow-x-auto mb-2">
                <table className="w-full text-[9px]">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="text-left pb-1">Level</th>
                      <th className="text-right pb-1">Price</th>
                      <th className="text-right pb-1">Dist</th>
                      <th className="text-right pb-1">Swept</th>
                      <th className="text-right pb-1">Close-Back</th>
                      <th className="text-right pb-1">Vol</th>
                    </tr>
                  </thead>
                  <tbody>
                    {smc.tableRows.map((r, i) => (
                      <tr key={`${r.level}-${r.price}-${i}`} className="border-b border-border/50">
                        <td className="text-left pb-0.5">{r.level}</td>
                        <td className="text-right pb-0.5 tabular-nums">{r.price.toFixed(0)}</td>
                        <td className="text-right pb-0.5 tabular-nums">{r.distPts.toFixed(0)} ({r.distPct})</td>
                        <td className={`text-right pb-0.5 ${r.swept === "YES" ? "text-emerald-500" : "text-muted-foreground"}`}>{r.swept}</td>
                        <td className={`text-right pb-0.5 ${r.closeBack === "YES" ? "text-emerald-500" : "text-muted-foreground"}`}>{r.closeBack}</td>
                        <td className="text-right pb-0.5 tabular-nums">{r.volVsAvg}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Sweeps */}
              {smc.sweeps.length > 0 && (
                <div className="mb-2">
                  <p className="text-[9px] font-bold text-muted-foreground mb-1">Sweeps</p>
                  <div className="space-y-0.5">
                    {smc.sweeps.map((s, i) => (
                      <div key={`${s.levelKind}-${s.breakBarIdx}-${s.levelPrice}`} className="flex justify-between text-[9px]">
                        <span className="text-muted-foreground">{`${s.levelKind} @${s.levelPrice.toFixed(0)}`}</span>
                        <span className={`font-bold ${s.closeBackInside ? "text-emerald-500" : "text-red-500"}`}>
                          {`break ${(s.breakPct * 100).toFixed(3)}% | close-back ${s.closeBackInside ? "YES" : "NO"} | vol ${(s.volumeVsAvg ?? 0).toFixed(2)}x | ${s.barsAgo} bars ago`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Footprints */}
              {smc.footprints.length > 0 && (
                <p className="text-[9px] text-emerald-500 mb-1">
                  Footprints: {smc.footprints.join(", ")}
                </p>
              )}

              {/* CHoCH after sweep */}
              {smc.choch.length > 0 && (
                <p className="text-[9px] text-blue-400 mb-1">
                  CHoCH: {smc.choch.map((c) => `${c.dir} @${c.swingPrice.toFixed(0)} (${c.barsAgo} bars ago)`).join(", ")}
                </p>
              )}

              {/* Honest note */}
              <p className="text-[9px] text-muted-foreground/60 mt-1">
                SMC describes observable price/volume/OI behaviour only. No "operator" or "smart money" intent inferred.
              </p>
            </>
          )}
        </div>

        {/* 5d. OI Buildup + Mini Chain + Greek Logic */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="w-4 h-3 text-indigo-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">OI / Chain / Greeks</span>
          </div>

          {/* Net OI change (session) */}
          {summary && (summary.callOiChange != null || summary.putOiChange != null) && (
            <div className="grid grid-cols-2 gap-2 text-[10px] mb-2">
              <div className="flex justify-between border-b pb-0.5">
                <span className="text-muted-foreground">CE ΔOI (session)</span>
                <span className={`font-bold tabular-nums ${(summary.callOiChange ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {(summary.callOiChange ?? 0) >= 0 ? "+" : ""}{formatIndian(summary.callOiChange ?? 0)}
                </span>
              </div>
              <div className="flex justify-between border-b pb-0.5">
                <span className="text-muted-foreground">PE ΔOI (session)</span>
                <span className={`font-bold tabular-nums ${(summary.putOiChange ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {(summary.putOiChange ?? 0) >= 0 ? "+" : ""}{formatIndian(summary.putOiChange ?? 0)}
                </span>
              </div>
            </div>
          )}

          {/* OI buildup classification (per-strike patterns aggregated) */}
          {oiSummary && oiSummary.classifications.length > 0 && (() => {
            let lb = 0, sb = 0, sc = 0, lu = 0;
            for (const c of oiSummary.classifications) {
              if (c.callPattern === "LONG_BUILDUP") lb++;
              if (c.callPattern === "SHORT_BUILDUP") sb++;
              if (c.callPattern === "SHORT_COVERING") sc++;
              if (c.callPattern === "LONG_UNWINDING") lu++;
              if (c.putPattern === "LONG_BUILDUP") lb++;
              if (c.putPattern === "SHORT_BUILDUP") sb++;
              if (c.putPattern === "SHORT_COVERING") sc++;
              if (c.putPattern === "LONG_UNWINDING") lu++;
            }
            const total = lb + sb + sc + lu;
            if (total === 0) return null;
            return (
              <div className="mb-2">
                <p className="text-[9px] font-bold text-muted-foreground mb-1">OI Buildup ({total} classified strikes)</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                  <div className="flex justify-between"><span className="text-emerald-500">Long Buildup</span><span className="font-bold">{lb}</span></div>
                  <div className="flex justify-between"><span className="text-red-400">Short Buildup</span><span className="font-bold">{sb}</span></div>
                  <div className="flex justify-between"><span className="text-emerald-400">Short Covering</span><span className="font-bold">{sc}</span></div>
                  <div className="flex justify-between"><span className="text-red-500">Long Unwinding</span><span className="font-bold">{lu}</span></div>
                </div>
              </div>
            );
          })()}

          {/* Fresh writing + traps detail */}
          {oiSummary && (oiSummary.freshWriting.length > 0 || oiSummary.traps.length > 0) && (
            <div className="mb-2 space-y-0.5">
              {oiSummary.freshWriting.slice(0, 3).map((f: any, i: number) => (
                <div key={`fw-${i}`} className="flex justify-between text-[9px]">
                  <span className="text-muted-foreground">Fresh writing {f.side} {f.strike}</span>
                  <span className="font-bold text-blue-400">+{formatIndian(f.oiChange)}</span>
                </div>
              ))}
              {oiSummary.traps.slice(0, 3).map((t: any, i: number) => (
                <div key={`tr-${i}`} className="flex justify-between text-[9px]">
                  <span className="text-muted-foreground">{t.type === "CE_TRAP" ? "CE trap" : "PE trap"} {t.strike}</span>
                  <span className="font-bold text-orange-400">{formatIndian(t.trappedOI)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Mini chain ATM±2 */}
          {chainData && chainData.length > 0 && summary?.atmStrike ? (() => {
            const atm = summary.atmStrike;
            const rows = chainData
              .filter((r) => Math.abs(r.strike - atm) <= 1000)
              .sort((a, b) => a.strike - b.strike)
              .slice(0, 5);
            if (!rows.length) return null;
            return (
              <div className="overflow-x-auto">
                <p className="text-[9px] font-bold text-muted-foreground mb-1">Chain ATM±2 (live)</p>
                <table className="w-full text-[9px]">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="text-right pb-1">CE OI</th>
                      <th className="text-right pb-1">CE Δ</th>
                      <th className="text-right pb-1">LTP</th>
                      <th className="text-center pb-1">Strike</th>
                      <th className="text-left pb-1">LTP</th>
                      <th className="text-right pb-1">PE Δ</th>
                      <th className="text-right pb-1">PE OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const isAtm = r.strike === atm;
                      return (
                        <tr key={r.strike} className={`border-b border-border/50 ${isAtm ? "bg-muted/40 font-bold" : ""}`}>
                          <td className="text-right pb-0.5 tabular-nums text-red-400">{r.ce ? formatIndian(r.ce.oi) : "—"}</td>
                          <td className={`text-right pb-0.5 tabular-nums ${(r.ce?.oiChg ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                            {r.ce ? `${(r.ce.oiChg ?? 0) >= 0 ? "+" : ""}${formatIndian(r.ce.oiChg)}` : "—"}
                          </td>
                          <td className="text-right pb-0.5 tabular-nums">{r.ce?.ltp?.toFixed(1) ?? "—"}</td>
                          <td className="text-center pb-0.5 tabular-nums">{r.strike}</td>
                          <td className="text-left pb-0.5 tabular-nums">{r.pe?.ltp?.toFixed(1) ?? "—"}</td>
                          <td className={`text-right pb-0.5 tabular-nums ${(r.pe?.oiChg ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                            {r.pe ? `${(r.pe.oiChg ?? 0) >= 0 ? "+" : ""}${formatIndian(r.pe.oiChg)}` : "—"}
                          </td>
                          <td className="text-right pb-0.5 tabular-nums text-emerald-400">{r.pe ? formatIndian(r.pe.oi) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })() : (
            <p className="text-[9px] text-muted-foreground/60">Chain data unavailable — mini chain needs live option chain.</p>
          )}

          {/* Greek logic summary */}
          {greeks && (
            <div className="mt-2 pt-2 border-t border-border/50">
              <p className="text-[9px] font-bold text-muted-foreground mb-1">Greek Logic (traded leg)</p>
              <div className="grid grid-cols-3 gap-x-2 text-[9px]">
                <div className="flex justify-between"><span className="text-muted-foreground">Δ</span><span className="font-bold">{greeks.delta != null ? greeks.delta.toFixed(2) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Θ%</span><span className="font-bold">{greeks.theta != null && greeks.premium > 0 ? ((Math.abs(greeks.theta) / greeks.premium) * 100).toFixed(1) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">IV</span><span className="font-bold">{greeks.iv != null ? greeks.iv.toFixed(1) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Γ</span><span className="font-bold">{greeks.gamma != null ? greeks.gamma.toFixed(4) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">V</span><span className="font-bold">{greeks.vega != null ? greeks.vega.toFixed(2) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Prem</span><span className="font-bold">{greeks.premium > 0 ? greeks.premium.toFixed(1) : "—"}</span></div>
              </div>
              <p className="text-[8px] text-muted-foreground/60 mt-1">
                Δ = direction risk · Θ% = theta decay %/day · Γ = gamma accel · V = vol sensitivity. Black-Scholes on exchange IV.
              </p>
            </div>
          )}
        </div>

        {/* 5e. India VIX & Math */}
        {liveVIXRaw != null && Number.isFinite(liveVIXRaw) && liveVIXRaw > 0 ? (
          <div className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Atom className="w-4 h-3 text-orange-500" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">India VIX & Math</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Live VIX</span>
                <span className="font-bold tabular-nums text-base">{liveVIX.toFixed(1)}%</span>
                <Badge
                  className={`${liveVIX > 25 ? "bg-red-500 text-white" : liveVIX > 20 ? "bg-orange-500 text-white" : liveVIX > 15 ? "bg-yellow-400 text-black" : liveVIX > 12 ? "bg-green-100 text-black" : "bg-emerald-500 text-white"} text-[9px] px-1.5`}
                >
                  {liveVIX > 25
                    ? "FEAR"
                    : liveVIX > 20
                      ? "Elevated"
                      : liveVIX > 15
                        ? "Normal"
                        : liveVIX > 12
                          ? "Complacent"
                          : "Low Vol"}
                </Badge>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Today's move (1d)</span>
                <span className="font-bold tabular-nums text-base">
                  {spotPrice != null ? (spotPrice * liveVIX / 100 * Math.sqrt(1 / 365)).toFixed(0) : "—"} ₹
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Exp move ({dte}d)</span>
                <span className="font-bold tabular-nums text-base">
                  {spotPrice != null && dte > 0 ? (spotPrice * liveVIX / 100 * Math.sqrt(dte / 365)).toFixed(0) : "—"} ₹
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                Today's move (1d) = spot × VIX/100 × √(1/365) · Exp move = spot × VIX/100 × √(DTE/365) · one annualized VIX → both consistent (1d move ≤ exp move for DTE ≥ 1) · Source: NSE India VIX
              </p>
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">India VIX not published — derived values hidden</p>
        )}

        {/* 6. Quick Actions */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Zap className="w-4 h-4 text-amber-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Quick Actions</span>
          </div>
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs gap-1.5 justify-start"
              onClick={onSwitchToPro}
            >
              <Brain className="w-3 h-3" />
              Switch to Pro Chain
            </Button>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Setup Grade</span>
              <Badge className={`${rec?.tradeGrade && rec.tradeGrade !== "—" ? gradeColors[rec.tradeGrade] : "bg-gray-500 text-white"} text-[10px] px-1.5`}>{rec?.tradeGrade || "—"}</Badge>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Mode</span>
              <span className="font-semibold">{rec?.mode || "—"}</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Expiry</span>
              <span className="font-semibold">{rec?.daysToExpiry ? rec.daysToExpiry + "d" : "—"}</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Data</span>
              <span className={`font-semibold ${isLive ? "text-emerald-500" : "text-yellow-500"}`}>
                {dataSource ? dataSourceBadge(dataSource, freshness).display : "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── OI NIFTY DASHBOARD ─── */}
      <div className="rounded-xl border bg-card p-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">OI NIFTY</span>
            <Badge
              className={`text-[9px] text-white ${isLive ? "bg-emerald-600" : "bg-zinc-600"}`}
              title={freshness ? `Data freshness: ${freshness}` : undefined}
            >
              {isLive ? "LIVE" : freshness || "DATA"}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground">{symbol} {spotPrice.toLocaleString("en-IN")}</div>
        </div>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-xs">
          <div><span className="text-muted-foreground">VIX</span><div className="font-bold">{vixLive ? `${liveVIX.toFixed(1)}%` : "—"}</div></div>
          <div><span className="text-muted-foreground">PCR</span><div className="font-bold">{livePCR.toFixed(2)}</div></div>
          <div><span className="text-muted-foreground">ATM</span><div className="font-bold">{liveATMValid ? liveATM : "—"}</div></div>
          <div><span className="text-muted-foreground">CE OI</span><div className="font-bold text-red-500">{formatIndian(liveCEOI)}</div></div>
          <div><span className="text-muted-foreground">PE OI</span><div className="font-bold text-emerald-500">{formatIndian(livePEOI)}</div></div>
          <div><span className="text-muted-foreground">Max Pain</span><div className="font-bold">{liveMaxPain ? fmt(liveMaxPain) : '—'}</div></div>
        </div>
      </div>

      {/* ─── OI CHANGE CHART ─── */}
      <OIChangePanel
        symbol={symbol}
        spot={spotPrice}
        vix={vixLive ? liveVIX : null}
        pcr={livePCR}
        expiries={expiries}
        selectedExpiry={selectedExpiry}
      />

      {/* ─── SESSION NOTE ─── */}
      {rec?.session?.notes != null && rec.session.notes.length > 0 && (
        <div className="rounded-lg bg-muted/30 border p-2 text-center">
          <p className="text-xs text-muted-foreground">{rec.session.notes[0]}</p>
        </div>
      )}
    </div>
  );
});
