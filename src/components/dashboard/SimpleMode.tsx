// Simple Mode - Live Market Dashboard
// Data-driven from live option chain API, not just SDM recommendation

"use client";

import { useState, useEffect, memo } from "react";
import { OIChangePanel } from "./OIChangePanel";
import type { SDMRecommendation } from "@/types/sdm";
import type { FullAnalysis } from "@/lib/sdm-engine";
import { Badge } from "@/components/ui/badge";
import { confirmSummary, confirmTradeGate } from "@/lib/signal-persistence";
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
import {
  ArrowUp,
  ArrowDown,
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

// ─── Pivot Points (Camarilla-style) ──────────────────────────────
function computePivots(spot: number) {
  const range = spot * 0.012;
  return {
    r3: spot + range * 3,
    r2: spot + range * 2,
    r1: spot + range,
    pivot: spot,
    s1: spot - range,
    s2: spot - range * 2,
    s3: spot - range * 3,
  };
}

// ─── Market Mood (1-5 scale) ────────────────────────────────────
function computeMood(pcr: number, vix: number): { score: number; label: string; color: string } {
  let score = 3;
  if (pcr > 1.3) score += 1;
  else if (pcr < 0.7) score -= 1;
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
}: SimpleModeProps) {
  const rec = recommendation;
  const confirmations = confirmationsProp || rec?.confirmations || [];
  const { pass: confirmPass, total: confirmTotal, pct: confirmPct } = confirmSummary(confirmations);
  // The BUY/WAIT verdict follows the playbook gate on REAL reads only:
  // a closed-bar trigger fires AND (real trend agrees OR real VWAP side
  // agrees). Unavailable checks never count as passes — no fabricated BUY.
  const gate = confirmTradeGate(confirmations);
  const confirmedEnough = gate.tradeable;
  const gateReason = gate.rule;

  // Live data from summary (falls back to recommendation, then defaults)
  const livePCR = summary?.pcr ?? rec?.marketContext?.pcr ?? 0;
  // `liveVIXRaw` is numeric for computation; `vixLive` gates DISPLAY — never
  // fabricate a live VIX reading when the exchange didn't publish one.
  const liveVIXRaw = summary?.indiaVIX ?? (rec?.marketContext?.vix > 0 ? rec.marketContext.vix : undefined);
  const vixLive = liveVIXRaw != null && Number.isFinite(liveVIXRaw) && liveVIXRaw > 0;
  const liveVIX = liveVIXRaw ?? 15;
  const liveMaxPain = rec?.marketContext?.maxPain;
  const liveATM = summary?.atmStrike ?? rec?.strike ?? 0;
  const liveATMValid = liveATM != null && Number.isFinite(liveATM) && liveATM > 0;
  const liveCEOI = summary?.totalCallOI ?? 0;
  const livePEOI = summary?.totalPutOI ?? 0;
  const isLive = dataSource && dataSource !== 'simulation';

  const pivots = computePivots(spotPrice);
  const mood = computeMood(livePCR, liveVIX);

  // Derive direction from the VOTED direction first (D-1: optionType only
  // exists for a real CALL/PUT). WAIT always wins — never fall through to BUY.
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

  const actionLabel = isLoading
    ? "ANALYZING"
    : isWait
      ? "NO TRADE"
      : !confirmedEnough && confirmTotal > 0
        ? "WATCH"
        : isCall
          ? "BUY CALL"
          : isPut
            ? "BUY PUT"
            : "NO TRADE";
  const actionIcon = isLoading ? <RefreshCw className="w-5 h-5 animate-spin" /> : isWait ? <Pause className="w-5 h-5" /> : isCall ? <ArrowUp className="w-5 h-5" /> : isPut ? <ArrowDown className="w-5 h-5" /> : <Pause className="w-5 h-5" />;
  const actionColor = isLoading
    ? "border-muted bg-muted/20"
    : isWait
    ? "border-muted bg-muted/30"
    : isCall
    ? "border-emerald-500/50 bg-emerald-500/10"
    : isPut
    ? "border-red-500/50 bg-red-500/10"
    : "border-muted bg-muted/30";

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
          <span className="text-muted-foreground font-semibold uppercase tracking-wider text-[10px]">LIVE</span>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">VIX</span>
            <span className="font-bold tabular-nums">{summary.indiaVIX != null ? `${fmt(summary.indiaVIX)}%` : "—"}</span>
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">PCR</span>
            <span className={`font-bold tabular-nums ${summary.pcr > 1.2 ? "text-emerald-500" : summary.pcr < 0.7 ? "text-red-500" : ""}`}>
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
            <div className={`p-2 rounded-lg ${isLoading ? "bg-muted" : isWait ? "bg-muted" : isCall ? "bg-emerald-500/20" : "bg-red-500/20"}`}>
              {actionIcon}
            </div>
            <div>
              <h2 className="text-xl font-black tracking-tight">{actionLabel}</h2>
              {isLoading ? (
                <p className="text-sm text-muted-foreground">AI is scanning {symbol} market data...</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {symbol} {rec.strike} {isCall ? "CE" : isPut ? "PE" : "—"}
                  {strikeInfo ? ` · ${strikeInfo.isAtm ? "ATM" : `${strikeInfo.otmSteps} OTM`}` : ""}
                  {greeks?.delta != null ? ` · Δ ${greeks.delta.toFixed(2)}` : ""}
                  {` · ${isLive ? "Live Data" : "Simulation"}`}
                </p>
              )}
            </div>
          </div>
          {!isLoading && (
            <div className="text-right">
              <div className="text-3xl font-black tabular-nums">{rec.confidence}%</div>
              <Badge className={`${gradeColors[rec.tradeGrade]} text-[10px]`}>Grade {rec.tradeGrade}</Badge>
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
              {confirmTotal > 0 && (
                <Badge
                  className={`text-[10px] ${
                    confirmedEnough
                      ? "bg-emerald-600 text-white"
                      : confirmPass === 0
                        ? "bg-red-600 text-white"
                        : "bg-yellow-600 text-white"
                  }`}
                >
                  {`Confirm: ${confirmPass}/${confirmTotal}`}
                </Badge>
              )}
            </div>
          )}
        </div>
        {!isLoading && rec.entry > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-border/50 text-xs">
            <span>Entry <span className="font-bold">{fmtCurrency(rec.entry)}</span></span>
            <span className="text-red-500">SL <span className="font-bold">{fmtCurrency(rec.sl)}</span></span>
            <span className="text-emerald-500">T1 <span className="font-bold">{fmtCurrency(rec.tp1)}</span></span>
            <span className="text-emerald-500">T2 <span className="font-bold">{fmtCurrency(rec.tp2)}</span></span>
            {rec.riskReward > 0 && <span className="text-muted-foreground">R:R 1:{rec.riskReward}</span>}
            {/* REAL sizing from the plan builder — lots / ₹ deployed / ₹ at risk. */}
            {(() => {
              const ps: any = rec?.positionSizing;
              if (!ps || ps.lots == null) return null;
              if (ps.tradable) return (
                <span className="text-blue-400 font-bold">
                  {ps.lots} lot{ps.lots > 1 ? "s" : ""} · ₹{Math.round(ps.deployed).toLocaleString("en-IN")} · risk ₹{Math.round(ps.riskAmount).toLocaleString("en-IN")}
                </span>
              );
              return (
                <span className="text-orange-400 font-bold">0 lots — 1 lot ₹{Math.round(ps.lotCost).toLocaleString("en-IN")} over budget → NO TRADE</span>
              );
            })()}
            {oiSummary && oiSummary.freshWriting.length > 0 && (
              <span className="text-blue-500 font-bold">📊 OI Writing</span>
            )}
            {oiSummary && oiSummary.traps.length > 0 && (
              <span className="text-orange-500 font-bold">⚠️ OI Trap</span>
            )}
          </div>
        )}
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
                <span className={`font-bold tabular-nums ${oiSummary.pcrOI > 1 ? "text-emerald-500" : oiSummary.pcrOI < 0.9 ? "text-red-500" : "text-yellow-500"}`}>
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
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Confirmation</span>
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
                confirmedEnough
                  ? "bg-emerald-600 text-white"
                  : confirmPass === 0
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
              {!confirmedEnough && confirmTotal > 0 && (
                <p className="text-[10px] text-red-500/80 mt-1">
                  {gateReason === "trigger + context aligned"
                    ? "Not enough confirmations to trade — wait for structure + trigger alignment"
                    : `WAIT: ${gateReason}`}
                </p>
              )}
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
              <span className="text-muted-foreground">Entry Prem</span>
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

        {/* 3. Key Levels */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Key Levels</span>
          </div>
          <div className="space-y-0.5 text-xs tabular-nums">
            {(["r3", "r2", "r1", "pivot", "s1", "s2", "s3"] as const).map((level) => (
              <div key={level} className={`flex justify-between ${level === "pivot" ? "font-bold text-primary border-t border-border pt-0.5" : ""}`}>
                <span className={level.startsWith("r") ? "text-emerald-500 font-medium" : level.startsWith("s") ? "text-red-500 font-medium" : "text-muted-foreground"}>
                  {level.toUpperCase()}
                </span>
                <span className="font-semibold">{fmt(pivots[level])}</span>
              </div>
            ))}
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
              <span className={`font-bold tabular-nums text-base ${livePCR > 1.2 ? "text-emerald-500" : livePCR < 0.8 ? "text-red-500" : ""}`}>
                {livePCR.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">VIX</span>
              <span className="font-bold tabular-nums text-base">{vixLive ? liveVIX.toFixed(1) : "—"}</span>
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              {livePCR > 1.2 ? "Bullish — put writing dominates" : livePCR < 0.8 ? "Bearish — call writing dominates" : "Balanced market"}
            </p>
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
              <span className={`font-bold tabular-nums text-base ${livePCR > 1.1 ? "text-emerald-500" : livePCR < 0.9 ? "text-red-500" : "text-yellow-500"}`}>
                {livePCR.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Direction</span>
              <span className={`font-bold text-base ${livePCR > 1.1 ? "text-emerald-500" : livePCR < 0.9 ? "text-red-500" : "text-yellow-500"}`}>
                {livePCR > 1.1 ? "Bullish Flow" : livePCR < 0.9 ? "Bearish Flow" : "Neutral"}
              </span>
            </div>
          </div>
        </div>

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
              <span>Grade</span>
              <Badge className={`${rec?.tradeGrade ? gradeColors[rec.tradeGrade] : "bg-gray-500 text-white"} text-[10px] px-1.5`}>{rec?.tradeGrade || "—"}</Badge>
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
                {dataSource ? dataSourceBadge(dataSource).display : "—"}
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
            <Badge className="text-[9px] bg-emerald-600 text-white">LIVE</Badge>
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
