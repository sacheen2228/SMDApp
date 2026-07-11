"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Brain,
  Target,
  Shield,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface Recommendation {
  action: "BUY_CALL" | "BUY_PUT" | "WAIT" | "NO_TRADE";
  strike: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  lotSize: number;
  capitalRequired: number;
  maxProfit: number;
  riskReward: number;
  reason: string;
  marketBias: string;
  reasons: string[];
  expiry: string;
}

function formatINR(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function AIRecommendation() {
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/sdm-signal?symbol=NIFTY");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success || !json.signal) throw new Error("No signal");

      const signal = json.signal;
      const r = signal.recommendation || {};

      setRec({
        action: r.action || "WAIT",
        strike: r.strike || 0,
        entry: r.entry || r.currentPremium || 0,
        stopLoss: r.stopLoss || 0,
        tp1: r.target1 || 0,
        tp2: r.target2 || 0,
        tp3: r.target3 || 0,
        confidence: typeof signal.confidence === "object" ? signal.confidence.total || 0 : signal.confidence || r.confidence || 0,
        lotSize: r.lotSize || 75,
        capitalRequired: r.capitalRequired || 0,
        maxProfit: r.maxProfit || 0,
        riskReward: r.riskReward || 0,
        reason: r.reason || "Analyzing market conditions...",
        marketBias: signal.marketBias || "NEUTRAL",
        reasons: signal.reasons || [],
        expiry: r.expiry || "",
      });
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <Card className="bg-[#0d1117] border-white/5 h-full flex flex-col overflow-hidden">
      <CardHeader className="py-2 px-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <Brain className="size-3.5 text-purple-400" />
            AI Trade Recommendation
          </CardTitle>
          <button
            onClick={() => {
              setLoading(true);
              fetchData();
            }}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="p-3 flex-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3">
            <div className="h-12 bg-white/5 animate-pulse rounded" />
            <div className="h-20 bg-white/5 animate-pulse rounded" />
            <div className="h-16 bg-white/5 animate-pulse rounded" />
          </div>
        ) : error || !rec ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-500 text-xs">
            <AlertCircle className="size-5" />
            <span>Data unavailable</span>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Action Badge */}
            <div className="flex items-center justify-center">
              <Badge
                className={`text-sm px-4 py-1.5 font-bold font-mono ${
                  rec.action === "BUY_CALL"
                    ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                    : rec.action === "BUY_PUT"
                    ? "bg-red-500/20 text-red-400 border border-red-500/40"
                    : "bg-zinc-500/20 text-zinc-400 border border-zinc-500/40"
                }`}
              >
                {rec.action === "BUY_CALL" && <TrendingUp className="size-3.5 mr-1" />}
                {rec.action === "BUY_PUT" && <TrendingDown className="size-3.5 mr-1" />}
                {rec.action === "WAIT" && <Clock className="size-3.5 mr-1" />}
                {rec.action}
              </Badge>
            </div>

            {/* Market Bias */}
            <div className="text-center">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Market Bias</span>
              <p className={`text-xs font-semibold font-mono ${
                rec.marketBias.includes("BULL") ? "text-emerald-400" :
                rec.marketBias.includes("BEAR") ? "text-red-400" : "text-zinc-400"
              }`}>
                {rec.marketBias.replace("_", " ")}
              </p>
            </div>

            {rec.action !== "WAIT" && rec.action !== "NO_TRADE" && (
              <>
                <Separator className="bg-white/5" />

                {/* Entry / SL / TP Grid */}
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div className="bg-white/5 rounded p-1.5">
                    <span className="text-zinc-500 block">Entry</span>
                    <span className="text-zinc-200 font-mono font-semibold tabular-nums">
                      ₹{rec.entry.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-white/5 rounded p-1.5">
                    <span className="text-zinc-500 block">Strike</span>
                    <span className="text-zinc-200 font-mono font-semibold tabular-nums">
                      {rec.strike.toLocaleString("en-IN")}
                    </span>
                  </div>
                  <div className="bg-red-500/10 rounded p-1.5">
                    <span className="text-red-400/70 block">Stop Loss</span>
                    <span className="text-red-400 font-mono font-semibold tabular-nums">
                      ₹{rec.stopLoss.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-emerald-500/10 rounded p-1.5">
                    <span className="text-emerald-400/70 block">TP1 (1:1)</span>
                    <span className="text-emerald-400 font-mono font-semibold tabular-nums">
                      ₹{rec.tp1.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-emerald-500/10 rounded p-1.5">
                    <span className="text-emerald-400/70 block">TP2 (1:2)</span>
                    <span className="text-emerald-400 font-mono font-semibold tabular-nums">
                      ₹{rec.tp2.toFixed(2)}
                    </span>
                  </div>
                  <div className="bg-emerald-500/10 rounded p-1.5">
                    <span className="text-emerald-400/70 block">TP3 (1:3)</span>
                    <span className="text-emerald-400 font-mono font-semibold tabular-nums">
                      ₹{rec.tp3.toFixed(2)}
                    </span>
                  </div>
                </div>

                <Separator className="bg-white/5" />

                {/* Metrics */}
                <div className="grid grid-cols-3 gap-2 text-[10px]">
                  <div className="text-center">
                    <span className="text-zinc-500 block">Confidence</span>
                    <span className={`font-mono font-bold tabular-nums text-sm ${
                      rec.confidence >= 70 ? "text-emerald-400" : rec.confidence >= 50 ? "text-amber-400" : "text-red-400"
                    }`}>
                      {rec.confidence}%
                    </span>
                  </div>
                  <div className="text-center">
                    <span className="text-zinc-500 block">Risk:Reward</span>
                    <span className="text-zinc-200 font-mono font-bold tabular-nums text-sm">
                      {rec.riskReward.toFixed(1)}
                    </span>
                  </div>
                  <div className="text-center">
                    <span className="text-zinc-500 block">Lot Size</span>
                    <span className="text-zinc-200 font-mono font-bold tabular-nums text-sm">
                      {rec.lotSize}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div className="bg-white/5 rounded p-1.5 text-center">
                    <span className="text-zinc-500 block">Capital Required</span>
                    <span className="text-amber-400 font-mono font-semibold tabular-nums">
                      {formatINR(rec.capitalRequired)}
                    </span>
                  </div>
                  <div className="bg-white/5 rounded p-1.5 text-center">
                    <span className="text-zinc-500 block">Expected Profit</span>
                    <span className="text-emerald-400 font-mono font-semibold tabular-nums">
                      {formatINR(rec.maxProfit)}
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Reasons */}
            {rec.reasons.length > 0 && (
              <>
                <Separator className="bg-white/5" />
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    Analysis
                  </span>
                  {rec.reasons.slice(0, 4).map((r, i) => (
                    <p key={i} className="text-[10px] text-zinc-400 leading-tight flex items-start gap-1">
                      <span className="text-zinc-600 shrink-0">•</span>
                      {r}
                    </p>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
