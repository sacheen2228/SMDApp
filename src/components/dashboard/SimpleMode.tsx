// Simple Mode - Market Dashboard
// 6-card layout: ATM Straddle, Max Pain, Key Levels, Quick Actions, Market Mood, FII/DII Flow
// Plus trade setup always visible

"use client";

import { useState, useEffect, memo } from "react";
import type { SDMRecommendation } from "@/types/sdm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";

interface SimpleModeProps {
  recommendation: SDMRecommendation | null;
  spotPrice: number;
  symbol: string;
  onSwitchToPro?: () => void;
}

function fmt(n: number): string {
  if (n >= 100000) return (n / 100000).toFixed(1) + "L";
  return n.toFixed(0);
}

function fmtCurrency(n: number): string {
  return "₹" + n.toFixed(1);
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
}: SimpleModeProps) {
  const rec = recommendation;
  const pcr = rec?.marketContext?.pcr ?? 0;
  const vix = rec?.marketContext?.vix ?? 15;
  const maxPain = rec?.marketContext?.maxPain ?? spotPrice;
  const pivots = computePivots(spotPrice);
  const mood = computeMood(pcr, vix);

  if (!rec) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Activity className="w-12 h-12 mb-4 animate-pulse text-primary" />
        <p className="text-lg font-medium">AI is analyzing the market...</p>
        <p className="text-sm mt-1">Processing live data from ICICI Breeze</p>
        <div className="mt-6 flex items-center gap-4 text-xs">
          <span>Spot: {fmt(spotPrice)}</span>
          <SessionTimer />
        </div>
      </div>
    );
  }

  const isCall = rec.direction === "CALL";
  const isPut = rec.direction === "PUT";
  const isWait = rec.direction === "WAIT";

  const gradeColors: Record<string, string> = {
    "A+": "bg-emerald-500 text-white",
    A: "bg-emerald-600 text-white",
    B: "bg-yellow-500 text-white",
    C: "bg-orange-500 text-white",
    D: "bg-red-500 text-white",
  };

  const actionLabel = isWait ? "NO TRADE" : isCall ? "BUY CALL" : "BUY PUT";
  const actionIcon = isWait ? <Pause className="w-5 h-5" /> : isCall ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />;
  const actionColor = isWait
    ? "border-muted bg-muted/30"
    : isCall
    ? "border-emerald-500/50 bg-emerald-500/10"
    : "border-red-500/50 bg-red-500/10";

  return (
    <div className="flex flex-col gap-4 p-4 max-w-3xl mx-auto overflow-auto">
      {/* ─── TOP BAR ─── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">{symbol}</span>
          <span className="text-lg font-bold tabular-nums">{fmt(spotPrice)}</span>
          <Badge variant="outline" className="text-[10px]">{symbol === "NIFTY" ? "NIFTY 50" : symbol}</Badge>
        </div>
        <SessionTimer />
      </div>

      {/* ─── 1. AI SIGNAL CARD ─── */}
      <div className={`rounded-xl border ${actionColor} p-4`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isWait ? "bg-muted" : isCall ? "bg-emerald-500/20" : "bg-red-500/20"}`}>
              {actionIcon}
            </div>
            <div>
              <h2 className="text-xl font-black tracking-tight">{actionLabel}</h2>
              <p className="text-xs text-muted-foreground">{symbol} {rec.strike} {isCall ? "CE" : isPut ? "PE" : "—"}</p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-black tabular-nums">{rec.confidence}%</div>
            <Badge className={`${gradeColors[rec.tradeGrade]} text-[10px]`}>Grade {rec.tradeGrade}</Badge>
          </div>
        </div>
        {rec.entry > 0 && (
          <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border/50 text-xs">
            <span>Entry <span className="font-bold">{fmtCurrency(rec.entry)}</span></span>
            <span className="text-red-500">SL <span className="font-bold">{fmtCurrency(rec.sl)}</span></span>
            <span className="text-emerald-500">T1 <span className="font-bold">{fmtCurrency(rec.tp1)}</span></span>
            <span className="text-emerald-500">T2 <span className="font-bold">{fmtCurrency(rec.tp2)}</span></span>
            {rec.riskReward > 0 && <span className="text-muted-foreground">R:R 1:{rec.riskReward}</span>}
          </div>
        )}
        {rec.reason && (
          <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">{rec.reason}</p>
        )}
      </div>

      {/* ─── 6-CARD GRID ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {/* 1. ATM Straddle */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Layers className="w-3.5 h-3.5 text-violet-500" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">ATM Straddle</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Strike</span>
              <span className="font-bold tabular-nums">{rec.strike}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Entry Prem</span>
              <span className="font-bold tabular-nums">{rec.entry > 0 ? fmtCurrency(rec.entry) : "—"}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">IV</span>
              <span className="font-bold tabular-nums">{vix.toFixed(1)}%</span>
            </div>
            <p className="text-[9px] text-muted-foreground/70 mt-1">
              {vix > 20 ? "IV elevated — options expensive" : vix < 12 ? "IV low — options cheap" : "IV normal range"}
            </p>
          </div>
        </div>

        {/* 2. Max Pain */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Target className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Max Pain</span>
          </div>
          <div className="space-y-1.5">
            <div className="text-2xl font-black tabular-nums">{fmt(maxPain)}</div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Spot</span>
              <span className="font-bold tabular-nums">{fmt(spotPrice)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Distance</span>
              <span className={`font-bold tabular-nums ${spotPrice > maxPain ? "text-emerald-500" : "text-red-500"}`}>
                {spotPrice > maxPain ? "+" : ""}{((spotPrice - maxPain) / maxPain * 100).toFixed(2)}%
              </span>
            </div>
            <p className="text-[9px] text-muted-foreground/70 mt-1">Market often gravitates here</p>
          </div>
        </div>

        {/* 3. Key Levels */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="w-3.5 h-3.5 text-blue-500" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Key Levels</span>
          </div>
          <div className="space-y-0.5 text-[11px] tabular-nums">
            {(["r3", "r2", "r1", "pivot", "s1", "s2", "s3"] as const).map((level) => (
              <div key={level} className={`flex justify-between ${level === "pivot" ? "font-bold text-primary border-t border-border pt-0.5" : ""}`}>
                <span className={level.startsWith("r") ? "text-emerald-500" : level.startsWith("s") ? "text-red-500" : "text-muted-foreground"}>
                  {level.toUpperCase()}
                </span>
                <span>{fmt(pivots[level])}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 4. Market Mood */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Gauge className="w-3.5 h-3.5 text-rose-500" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Market Mood</span>
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
              <span className={`text-xs font-bold ${mood.color}`}>{mood.label}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">PCR</span>
              <span className={`font-bold tabular-nums ${pcr > 1.2 ? "text-emerald-500" : pcr < 0.8 ? "text-red-500" : ""}`}>
                {pcr.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">VIX</span>
              <span className="font-bold tabular-nums">{vix.toFixed(1)}</span>
            </div>
            <p className="text-[9px] text-muted-foreground/70 mt-1">
              {pcr > 1.2 ? "Bullish — put writing dominates" : pcr < 0.8 ? "Bearish — call writing dominates" : "Balanced market"}
            </p>
          </div>
        </div>

        {/* 5. FII/DII Proxy (OI-based) */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <ArrowRightLeft className="w-3.5 h-3.5 text-cyan-500" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Money Flow</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">CE OI</span>
              <span className="font-bold tabular-nums text-red-500">{fmt(rec.sdmScores?.oiConcentration || 0)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">PE OI</span>
              <span className="font-bold tabular-nums text-emerald-500">{fmt(rec.sdmScores?.oiChange || 0)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Direction</span>
              <span className={`font-bold ${pcr > 1.1 ? "text-emerald-500" : pcr < 0.9 ? "text-red-500" : "text-yellow-500"}`}>
                {pcr > 1.1 ? "Bullish Flow" : pcr < 0.9 ? "Bearish Flow" : "Neutral"}
              </span>
            </div>
            <p className="text-[9px] text-muted-foreground/70 mt-1">Based on OI buildup analysis</p>
          </div>
        </div>

        {/* 6. Quick Actions */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Zap className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Quick Actions</span>
          </div>
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-[10px] gap-1.5 justify-start"
              onClick={onSwitchToPro}
            >
              <Brain className="w-3 h-3" />
              Skip Analysis → Show Raw Chain
            </Button>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Grade</span>
              <Badge className={`${gradeColors[rec.tradeGrade]} text-[9px] px-1.5`}>{rec.tradeGrade}</Badge>
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Mode</span>
              <span className="font-medium">{rec.mode}</span>
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Expiry</span>
              <span className="font-medium">{rec.daysToExpiry}d</span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── SESSION NOTE ─── */}
      {rec.session && rec.session.notes.length > 0 && (
        <div className="rounded-lg bg-muted/30 border p-2 text-center">
          <p className="text-[10px] text-muted-foreground">{rec.session.notes[0]}</p>
        </div>
      )}
    </div>
  );
});
