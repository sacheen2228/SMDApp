// Simple Mode - Live Market Dashboard
// Data-driven from live option chain API, not just SDM recommendation

"use client";

import { useState, useEffect, memo } from "react";
import type { SDMRecommendation } from "@/types/sdm";
import type { FullAnalysis } from "@/lib/sdm-engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getCurrentSession } from "@/lib/market-session";
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
}: SimpleModeProps) {
  const rec = recommendation;

  // Live data from summary (falls back to recommendation, then defaults)
  const livePCR = summary?.pcr ?? rec?.marketContext?.pcr ?? 0;
  const liveVIX = summary?.indiaVIX ?? rec?.marketContext?.vix ?? 15;
  const liveMaxPain = rec?.marketContext?.maxPain;
  const liveATM = summary?.atmStrike ?? rec?.strike ?? 0;
  const liveCEOI = summary?.totalCallOI ?? 0;
  const livePEOI = summary?.totalPutOI ?? 0;
  const isLive = dataSource && dataSource !== 'simulation';

  const pivots = computePivots(spotPrice);
  const mood = computeMood(livePCR, liveVIX);

  const isCall = rec?.direction === "CALL";
  const isPut = rec?.direction === "PUT";
  const isWait = rec?.direction === "WAIT";
  const isLoading = !rec;

  const gradeColors: Record<string, string> = {
    "A+": "bg-emerald-500 text-white",
    A: "bg-emerald-600 text-white",
    B: "bg-yellow-500 text-white",
    C: "bg-orange-500 text-white",
    D: "bg-red-500 text-white",
  };

  const actionLabel = isLoading ? "ANALYZING" : isWait ? "NO TRADE" : isCall ? "BUY CALL" : "BUY PUT";
  const actionIcon = isLoading ? <RefreshCw className="w-5 h-5 animate-spin" /> : isWait ? <Pause className="w-5 h-5" /> : isCall ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />;
  const actionColor = isLoading
    ? "border-muted bg-muted/20"
    : isWait
    ? "border-muted bg-muted/30"
    : isCall
    ? "border-emerald-500/50 bg-emerald-500/10"
    : "border-red-500/50 bg-red-500/10";

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
              {fmt(summary.pcr)}
            </span>
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">ATM</span>
            <span className="font-bold tabular-nums text-primary">{summary.atmStrike}</span>
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
                <p className="text-sm text-muted-foreground">{symbol} {rec.strike} {isCall ? "CE" : isPut ? "PE" : "—"} · {isLive ? "Live Data" : "Simulation"}</p>
              )}
            </div>
          </div>
          {!isLoading && (
            <div className="text-right">
              <div className="text-3xl font-black tabular-nums">{rec.confidence}%</div>
              <Badge className={`${gradeColors[rec.tradeGrade]} text-[10px]`}>Grade {rec.tradeGrade}</Badge>
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
          </div>
        )}
        {rec?.reason && (
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{rec.reason}</p>
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
              <span className="font-bold tabular-nums text-base">{liveATM}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Entry Prem</span>
              <span className="font-bold tabular-nums text-base">{rec?.entry && rec.entry > 0 ? fmtCurrency(rec.entry) : "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">IV</span>
              <span className="font-bold tabular-nums text-base">{liveVIX.toFixed(1)}%</span>
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              {liveVIX > 20 ? "IV elevated — options expensive" : liveVIX < 12 ? "IV low — options cheap" : "IV normal range"}
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
            {liveMaxPain != null ? (
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
              <p className="text-sm text-muted-foreground">Awaiting SDM analysis...</p>
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
              <span className="font-bold tabular-nums text-base">{liveVIX.toFixed(1)}</span>
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
                {dataSource || "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── SESSION NOTE ─── */}
      {rec?.session?.notes != null && rec.session.notes.length > 0 && (
        <div className="rounded-lg bg-muted/30 border p-2 text-center">
          <p className="text-xs text-muted-foreground">{rec.session.notes[0]}</p>
        </div>
      )}
    </div>
  );
});
