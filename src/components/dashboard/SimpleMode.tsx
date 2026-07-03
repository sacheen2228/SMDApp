// Simple Mode - Clean AI Trading Recommendation
// Designed for instant comprehension: < 10 seconds to understand

"use client";

import { useState, useEffect, memo } from "react";
import type { SDMRecommendation } from "@/types/sdm";
import { Badge } from "@/components/ui/badge";
import { getCurrentSession } from "@/lib/market-session";
import {
  ArrowUp,
  ArrowDown,
  Clock,
  Shield,
  Target,
  TrendingUp,
  AlertTriangle,
  Pause,
  Activity,
} from "lucide-react";

interface SimpleModeProps {
  recommendation: SDMRecommendation | null;
  spotPrice: number;
  symbol: string;
}

function fmt(n: number): string {
  if (n >= 100000) return (n / 100000).toFixed(1) + "L";
  return n.toFixed(1);
}

function fmtCurrency(n: number): string {
  return "₹" + n.toFixed(1);
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

export const SimpleMode = memo(function SimpleMode({ recommendation, spotPrice, symbol }: SimpleModeProps) {
  const rec = recommendation;

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
  const isTrading = isCall || isPut;

  const gradeColors: Record<string, string> = {
    "A+": "bg-emerald-500 text-white",
    A: "bg-emerald-600 text-white",
    B: "bg-yellow-500 text-white",
    C: "bg-orange-500 text-white",
    D: "bg-red-500 text-white",
  };

  // Plain language explanation
  const plainReason = isWait
    ? "The market doesn't have a clear direction right now. Wait for a better setup."
    : isCall
    ? `The market is showing buying pressure. ${symbol} ${rec.strike} CE looks ready to move up.`
    : `The market is showing selling pressure. ${symbol} ${rec.strike} PE looks ready to move down.`;

  return (
    <div className="flex flex-col gap-5 p-6 max-w-2xl mx-auto">
      {/* ─── TOP: Session + Spot ─── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{symbol}</span>
          <span className="text-lg font-bold tabular-nums">{fmt(spotPrice)}</span>
        </div>
        <SessionTimer />
      </div>

      {/* ─── MAIN RECOMMENDATION ─── */}
      {isWait ? (
        <div className="rounded-2xl border-2 border-yellow-500/50 bg-gradient-to-br from-yellow-600 to-yellow-800 p-8 text-white shadow-xl text-center">
          <div className="flex justify-center mb-3">
            <div className="p-3 bg-white/20 rounded-2xl">
              <Pause className="w-10 h-10" />
            </div>
          </div>
          <h2 className="text-3xl font-black tracking-tight mb-2">WAIT</h2>
          <p className="text-sm opacity-90 max-w-md mx-auto">{plainReason}</p>
          <div className="flex items-center justify-center gap-3 mt-4">
            <Badge variant="outline" className="text-white border-white/30">
              Confidence: {rec.confidence}%
            </Badge>
            {rec.session && (
              <Badge variant="outline" className="text-white border-white/30">
                {rec.session.label}
              </Badge>
            )}
          </div>
        </div>
      ) : (
        <div
          className={`rounded-2xl border-2 ${
            isCall ? "border-emerald-500/50 bg-gradient-to-br from-emerald-600 to-emerald-800" : "border-red-500/50 bg-gradient-to-br from-red-600 to-red-800"
          } p-8 text-white shadow-xl`}
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-white/20 rounded-2xl">
                {isCall ? <ArrowUp className="w-10 h-10" /> : <ArrowDown className="w-10 h-10" />}
              </div>
              <div>
                <h2 className="text-3xl font-black tracking-tight">
                  {isCall ? "BUY CALL" : "BUY PUT"}
                </h2>
                <p className="text-lg opacity-90 font-medium">
                  {symbol} {rec.strike} {isCall ? "CE" : "PE"}
                </p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-5xl font-black tabular-nums">{rec.confidence}%</div>
              <p className="text-xs opacity-70">AI Confidence</p>
            </div>
          </div>

          {/* Grade */}
          <div className="flex items-center gap-2 mb-4">
            <Badge className={`${gradeColors[rec.tradeGrade]} text-sm px-3 py-1`}>
              Grade {rec.tradeGrade}
            </Badge>
            <Badge variant="outline" className="text-white border-white/30 text-sm">
              R:R 1:{rec.riskReward}
            </Badge>
            {rec.session && (
              <Badge variant="outline" className="text-white border-white/30 text-xs">
                {rec.session.label}
              </Badge>
            )}
          </div>

          {/* Plain Language */}
          <p className="text-sm leading-relaxed opacity-90">{plainReason}</p>
        </div>
      )}

      {/* ─── TRADE SETUP ─── */}
      {isTrading && rec.entry > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border bg-card p-5 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
              <TrendingUp className="w-3 h-3" /> Entry
            </p>
            <p className="text-3xl font-black tabular-nums">{fmtCurrency(rec.entry)}</p>
          </div>
          <div className="rounded-xl border bg-card p-5 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
              <Shield className="w-3 h-3" /> Stop Loss
            </p>
            <p className="text-3xl font-black tabular-nums text-red-500">{fmtCurrency(rec.sl)}</p>
            <p className="text-[10px] text-muted-foreground">
              Risk: {fmtCurrency(rec.entry - rec.sl)} per share
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
              <Target className="w-3 h-3" /> Target 1
            </p>
            <p className="text-xl font-bold tabular-nums text-emerald-500">{fmtCurrency(rec.tp1)}</p>
          </div>
          <div className="rounded-xl border bg-card p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
              <Target className="w-3 h-3" /> Target 2
            </p>
            <p className="text-xl font-bold tabular-nums text-emerald-500">{fmtCurrency(rec.tp2)}</p>
          </div>
        </div>
      )}

      {/* ─── POSITION SIZING ─── */}
      {isTrading && rec.positionSizing && rec.positionSizing.lots > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <h3 className="text-xs font-semibold text-muted-foreground mb-3 text-center">Recommended Position</h3>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <p className="text-2xl font-bold">{rec.positionSizing.lots}</p>
              <p className="text-[10px] text-muted-foreground">Lots</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{rec.positionSizing.quantity}</p>
              <p className="text-[10px] text-muted-foreground">Qty</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{fmtCurrency(rec.positionSizing.positionValue)}</p>
              <p className="text-[10px] text-muted-foreground">Value</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-500">{fmtCurrency(rec.positionSizing.maxLoss)}</p>
              <p className="text-[10px] text-muted-foreground">Max Loss</p>
            </div>
          </div>
        </div>
      )}

      {/* ─── KEY METRICS ─── */}
      <div className="grid grid-cols-4 gap-2 text-center text-xs text-muted-foreground">
        <div className="rounded-lg bg-muted/50 p-2">
          <p className="font-semibold">PCR</p>
          <p className="font-bold tabular-nums">{rec.marketContext.pcr.toFixed(2)}</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <p className="font-semibold">VIX</p>
          <p className="font-bold tabular-nums">{rec.marketContext.vix.toFixed(1)}</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <p className="font-semibold">Max Pain</p>
          <p className="font-bold tabular-nums">{fmt(rec.marketContext.maxPain)}</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <p className="font-semibold">Grade</p>
          <p className="font-bold">{rec.tradeGrade}</p>
        </div>
      </div>

      {/* ─── SESSION NOTE ─── */}
      {rec.session && rec.session.notes.length > 0 && (
        <div className="rounded-lg bg-muted/50 p-3 text-center">
          <p className="text-xs text-muted-foreground">{rec.session.notes[0]}</p>
        </div>
      )}
    </div>
  );
});
