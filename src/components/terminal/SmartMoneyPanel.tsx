"use client";

import { useState, useEffect, useCallback } from "react";
import {
  TrendingUp,
  TrendingDown,
  ArrowUpCircle,
  ArrowDownCircle,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useTerminalStore } from "@/stores/useTerminalStore";

interface SmartMoneySignal {
  type: "long_buildup" | "short_buildup" | "long_unwinding" | "short_covering";
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  strength: number; // 0-100
  description: string;
  strike: number;
  side: "CE" | "PE";
  oiChange: number;
  priceChange: number;
}

function classifyOIPattern(
  priceChg: number,
  oiChg: number
): "long_buildup" | "short_buildup" | "long_unwinding" | "short_covering" | null {
  if (priceChg > 0 && oiChg > 0) return "long_buildup";
  if (priceChg < 0 && oiChg > 0) return "short_buildup";
  if (priceChg < 0 && oiChg < 0) return "long_unwinding";
  if (priceChg > 0 && oiChg < 0) return "short_covering";
  return null;
}

function getSignalConfig(type: string) {
  switch (type) {
    case "long_buildup":
      return {
        label: "Long Build-up",
        icon: <ArrowUpCircle className="size-4" />,
        color: "text-emerald-400",
        bgColor: "bg-emerald-500/10",
        borderColor: "border-emerald-500/30",
        description: "Price ↑ OI ↑ — Fresh buying, bullish",
      };
    case "short_buildup":
      return {
        label: "Short Build-up",
        icon: <ArrowDownCircle className="size-4" />,
        color: "text-red-400",
        bgColor: "bg-red-500/10",
        borderColor: "border-red-500/30",
        description: "Price ↓ OI ↑ — Fresh selling, bearish",
      };
    case "long_unwinding":
      return {
        label: "Long Unwinding",
        icon: <TrendingDown className="size-4" />,
        color: "text-orange-400",
        bgColor: "bg-orange-500/10",
        borderColor: "border-orange-500/30",
        description: "Price ↓ OI ↓ — Longs exiting, bearish",
      };
    case "short_covering":
      return {
        label: "Short Covering",
        icon: <TrendingUp className="size-4" />,
        color: "text-cyan-400",
        bgColor: "bg-cyan-500/10",
        borderColor: "border-cyan-500/30",
        description: "Price ↑ OI ↓ — Shorts exiting, bullish",
      };
    default:
      return {
        label: "Neutral",
        icon: <AlertTriangle className="size-4" />,
        color: "text-zinc-400",
        bgColor: "bg-zinc-500/10",
        borderColor: "border-zinc-500/30",
        description: "No clear pattern",
      };
  }
}

function StrengthBar({ strength, color }: { strength: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            color.includes("emerald")
              ? "bg-emerald-500"
              : color.includes("red")
              ? "bg-red-500"
              : color.includes("orange")
              ? "bg-orange-500"
              : color.includes("cyan")
              ? "bg-cyan-500"
              : "bg-zinc-500"
          }`}
          style={{ width: `${Math.min(100, Math.max(0, strength))}%` }}
        />
      </div>
      <span className="text-[10px] font-mono tabular-nums text-zinc-400 w-8 text-right">
        {strength}%
      </span>
    </div>
  );
}

export function SmartMoneyPanel() {
  const { symbol, expiry } = useTerminalStore();
  const [signals, setSignals] = useState<SmartMoneySignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ symbol });
      if (expiry) params.set('expiry', expiry);
      const res = await fetch(`/api/option-chain?${params.toString()}`);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error("No data");

      const strikes = json.data?.data || [];
      const spot = json.data?.summary?.spotPrice || json.data?.spotPrice || 0;

      const detected: SmartMoneySignal[] = [];

      for (const s of strikes) {
        // Call side analysis
        if (s.ce && s.ce.oiChg !== 0) {
          // Use premium change as proxy for price direction
          const priceProxy = s.ce.ltp > 0 ? (s.ce.oiChg > 0 ? 1 : -1) * s.ce.ltp * 0.01 : 0;
          const pattern = classifyOIPattern(priceProxy, s.ce.oiChg);
          if (pattern && Math.abs(s.ce.oiChg) > 10000) {
            const config = getSignalConfig(pattern);
            const strength = Math.min(100, Math.round((Math.abs(s.ce.oiChg) / 100000) * 100));
            detected.push({
              type: pattern,
              ...config,
              strength,
              strike: s.strike,
              side: "CE",
              oiChange: s.ce.oiChg,
              priceChange: priceProxy,
            });
          }
        }

        // Put side analysis
        if (s.pe && s.pe.oiChg !== 0) {
          const priceProxy = s.pe.ltp > 0 ? (s.pe.oiChg > 0 ? 1 : -1) * s.pe.ltp * 0.01 : 0;
          const pattern = classifyOIPattern(priceProxy, s.pe.oiChg);
          if (pattern && Math.abs(s.pe.oiChg) > 10000) {
            const config = getSignalConfig(pattern);
            const strength = Math.min(100, Math.round((Math.abs(s.pe.oiChg) / 100000) * 100));
            detected.push({
              type: pattern,
              ...config,
              strength,
              strike: s.strike,
              side: "PE",
              oiChange: s.pe.oiChg,
              priceChange: priceProxy,
            });
          }
        }
      }

      // Sort by strength descending, take top 10
      detected.sort((a, b) => b.strength - a.strength);
      setSignals(detected.slice(0, 10));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [symbol, expiry]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <Card className="bg-[#0d1117] border-white/5 h-full flex flex-col overflow-hidden">
      <CardHeader className="py-2 px-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <TrendingUp className="size-3.5 text-blue-400" />
            Smart Money Scanner
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
      <CardContent className="p-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 bg-white/5 animate-pulse rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            Data unavailable
          </div>
        ) : signals.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            No smart money signals detected
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="p-2 space-y-1.5">
              {signals.map((sig, i) => (
                <div
                  key={`${sig.strike}-${sig.side}-${sig.type}-${i}`}
                  className={`${sig.bgColor} border ${sig.borderColor} rounded-md p-2 transition-colors hover:brightness-110`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <span className={sig.color}>{sig.icon}</span>
                      <span className={`text-[11px] font-semibold ${sig.color}`}>
                        {sig.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={`text-[9px] px-1 py-0 h-3.5 ${
                          sig.side === "CE"
                            ? "text-emerald-400 border-emerald-500/30"
                            : "text-red-400 border-red-500/30"
                        }`}
                      >
                        {sig.side}
                      </Badge>
                      <span className="text-[10px] text-zinc-400 font-mono tabular-nums">
                        {sig.strike.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                  <StrengthBar strength={sig.strength} color={sig.color} />
                  <p className="text-[10px] text-zinc-500 mt-1 leading-tight">
                    {sig.description}
                  </p>
                  <div className="flex items-center gap-3 mt-1 text-[9px] font-mono tabular-nums text-zinc-500">
                    <span>
                      OI Chg:{" "}
                      <span className={sig.oiChange > 0 ? "text-emerald-400" : "text-red-400"}>
                        {sig.oiChange > 0 ? "+" : ""}
                        {sig.oiChange.toLocaleString("en-IN")}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
