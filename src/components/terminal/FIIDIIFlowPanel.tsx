"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Building2,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  Activity,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useTerminalStore } from "@/stores/useTerminalStore";

interface FlowData {
  totalCallOI: number;
  totalPutOI: number;
  totalCallOIChg: number;
  totalPutOIChg: number;
  totalCallVolume: number;
  totalPutVolume: number;
  pcr: number;
  spot: number;
  fiiBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  fiiBiasStrength: number;
  fiiReason: string;
  callBuyingIndex: number;
  putBuyingIndex: number;
  netFlowBias: "INFLOWS" | "OUTFLOWS" | "FLAT";
  indexFuturesSignal: string;
  stockFuturesSignal: string;
  cashMarketSignal: string;
  cePeRatio: number;
}

function BiasIndicator({
  bias,
  strength,
}: {
  bias: string;
  strength: number;
}) {
  const isBullish = bias === "BULLISH";
  const isBearish = bias === "BEARISH";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span
          className={`text-[11px] font-bold ${
            isBullish
              ? "text-emerald-400"
              : isBearish
              ? "text-red-400"
              : "text-zinc-400"
          }`}
        >
          {bias}
        </span>
        <span className="text-[10px] font-mono text-zinc-500">
          {strength}%
        </span>
      </div>
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${
            isBullish
              ? "bg-gradient-to-r from-emerald-600 to-emerald-400"
              : isBearish
              ? "bg-gradient-to-r from-red-600 to-red-400"
              : "bg-zinc-600"
          }`}
          style={{ width: `${Math.min(100, strength)}%` }}
        />
      </div>
    </div>
  );
}

function FlowRow({
  label,
  value,
  subtext,
  color,
}: {
  label: string;
  value: string;
  subtext?: string;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <div className="flex items-center gap-1.5">
        {subtext && (
          <span className="text-[9px] text-zinc-600 font-mono">{subtext}</span>
        )}
        <span className={`text-[10px] font-mono font-semibold ${color}`}>
          {value}
        </span>
      </div>
    </div>
  );
}

function StrengthMeter({
  value,
  type,
}: {
  value: number;
  type: "bull" | "bear";
}) {
  const segments = 10;
  const filled = Math.round((value / 100) * segments);
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: segments }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 flex-1 rounded-sm transition-all duration-300 ${
            i < filled
              ? type === "bull"
                ? "bg-emerald-500"
                : "bg-red-500"
              : "bg-white/5"
          }`}
        />
      ))}
    </div>
  );
}

export function FIIDIIFlowPanel() {
  const { symbol, expiry } = useTerminalStore();
  const [flow, setFlow] = useState<FlowData | null>(null);
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

      let totalCallOI = 0;
      let totalPutOI = 0;
      let totalCallOIChg = 0;
      let totalPutOIChg = 0;
      let totalCallVolume = 0;
      let totalPutVolume = 0;

      for (const s of strikes) {
        if (s.ce) {
          totalCallOI += s.ce.oi || 0;
          totalCallOIChg += s.ce.oiChg || 0;
          totalCallVolume += s.ce.volume || 0;
        }
        if (s.pe) {
          totalPutOI += s.pe.oi || 0;
          totalPutOIChg += s.pe.oiChg || 0;
          totalPutVolume += s.pe.volume || 0;
        }
      }

      const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

      // FII bias derivation:
      // FIs sell puts (bullish) when call OI increases more than put OI
      // FIs sell calls (bearish) when put OI increases more than call OI
      const netCallOIDelta = totalCallOIChg;
      const netPutOIDelta = totalPutOIChg;
      const oiDeltaDiff = netCallOIDelta - netPutOIDelta;
      const totalOIDelta = Math.abs(netCallOIDelta) + Math.abs(netPutOIDelta);

      let fiiBias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
      let fiiBiasStrength = 50;
      let fiiReason = "";

      if (totalOIDelta > 0) {
        const ratio = oiDeltaDiff / totalOIDelta;
        if (ratio > 0.1) {
          fiiBias = "BULLISH";
          fiiBiasStrength = Math.round(50 + ratio * 50);
          fiiReason = `Call OI building (+${(
            netCallOIDelta / 100000
          ).toFixed(1)}L) — FIs selling puts, bullish`;
        } else if (ratio < -0.1) {
          fiiBias = "BEARISH";
          fiiBiasStrength = Math.round(50 + Math.abs(ratio) * 50);
          fiiReason = `Put OI building (+${(
            netPutOIDelta / 100000
          ).toFixed(1)}L) — FIs selling calls, bearish`;
        } else {
          fiiBias = "NEUTRAL";
          fiiBiasStrength = 50;
          fiiReason = "Balanced OI build-up — no clear FI bias";
        }
      }

      // Call buying index: CE volume relative to total volume
      const totalVolume = totalCallVolume + totalPutVolume;
      const cePeRatio = totalPutVolume > 0 ? totalCallVolume / totalPutVolume : 1;
      const callBuyingIndex = totalVolume > 0 ? (totalCallVolume / totalVolume) * 100 : 50;
      const putBuyingIndex = totalVolume > 0 ? (totalPutVolume / totalVolume) * 100 : 50;

      // Net flow bias
      let netFlowBias: "INFLOWS" | "OUTFLOWS" | "FLAT" = "FLAT";
      if (totalCallVolume > totalPutVolume * 1.3) netFlowBias = "INFLOWS";
      else if (totalPutVolume > totalCallVolume * 1.3) netFlowBias = "OUTFLOWS";

      // Derive index futures signal from ATM + near ATM OI patterns
      let indexFuturesSignal = "Neutral";
      let stockFuturesSignal = "Neutral";
      let cashMarketSignal = "Neutral";

      const atmIdx = strikes.findIndex((s: any) => {
        const diff = Math.abs(s.strike - spot);
        return diff < (strikes[1]?.strike - strikes[0]?.strike || 50) / 2;
      });

      if (atmIdx >= 0) {
        // Near ATM OI build-up pattern
        const nearCE = strikes[atmIdx]?.ce;
        const nearPE = strikes[atmIdx]?.pe;
        if (nearCE?.oiChg > 50000) indexFuturesSignal = "Long Build-up";
        else if (nearPE?.oiChg > 50000) indexFuturesSignal = "Short Build-up";

        // OTM call selling (high strike CE OI) = FII bullish
        const otmCalls = strikes.slice(atmIdx + 2);
        const otmCallOI = otmCalls.reduce(
          (sum: number, s: any) => sum + (s.ce?.oiChg || 0),
          0
        );
        const otmPuts = strikes.slice(0, Math.max(0, atmIdx - 2));
        const otmPutOI = otmPuts.reduce(
          (sum: number, s: any) => sum + (s.pe?.oiChg || 0),
          0
        );

        if (otmCallOI > 100000) stockFuturesSignal = "Bullish Flow";
        else if (otmPutOI > 100000) stockFuturesSignal = "Bearish Flow";

        cashMarketSignal =
          fiiBias === "BULLISH"
            ? "Net Inflows"
            : fiiBias === "BEARISH"
            ? "Net Outflows"
            : "Balanced";
      }

      setFlow({
        totalCallOI,
        totalPutOI,
        totalCallOIChg,
        totalPutOIChg,
        totalCallVolume,
        totalPutVolume,
        pcr,
        spot,
        fiiBias,
        fiiBiasStrength,
        fiiReason,
        callBuyingIndex,
        putBuyingIndex,
        netFlowBias,
        indexFuturesSignal,
        stockFuturesSignal,
        cashMarketSignal,
        cePeRatio,
      });
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
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const fmt = (n: number) => {
    if (n >= 10000000) return (n / 10000000).toFixed(2) + " Cr";
    if (n >= 100000) return (n / 100000).toFixed(1) + " L";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return n.toString();
  };

  return (
    <Card className="bg-[#0d1117] border-white/5 h-full flex flex-col overflow-hidden">
      <CardHeader className="py-2 px-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <Building2 className="size-3.5 text-indigo-400" />
            FII / DII Flow
          </CardTitle>
          <div className="flex items-center gap-2">
            {flow && (
              <Badge
                variant="outline"
                className={`text-[9px] px-1.5 py-0 h-3.5 font-mono ${
                  flow.fiiBias === "BULLISH"
                    ? "text-emerald-400 border-emerald-500/30"
                    : flow.fiiBias === "BEARISH"
                    ? "text-red-400 border-red-500/30"
                    : "text-zinc-400 border-zinc-500/30"
                }`}
              >
                {flow.fiiBias}
              </Badge>
            )}
            <button
              onClick={() => {
                setLoading(true);
                fetchData();
              }}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <RefreshCw
                className={`size-3 ${loading ? "animate-spin" : ""}`}
              />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 space-y-3">
            <div className="h-8 bg-white/5 animate-pulse rounded" />
            <div className="h-16 bg-white/5 animate-pulse rounded" />
            <div className="h-12 bg-white/5 animate-pulse rounded" />
          </div>
        ) : error || !flow ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            Flow data unavailable
          </div>
        ) : (
          <div className="p-2.5 space-y-2.5">
            {/* Net FII Bias */}
            <div className="bg-white/[0.02] rounded-md p-2 border border-white/5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Activity className="size-3 text-indigo-400" />
                <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Net FII Bias
                </span>
              </div>
              <BiasIndicator
                bias={flow.fiiBias}
                strength={flow.fiiBiasStrength}
              />
              <p className="text-[9px] text-zinc-600 mt-1.5 leading-relaxed">
                {flow.fiiReason}
              </p>
            </div>

            {/* PCR + Volume Ratio */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white/[0.02] rounded-md p-2 border border-white/5">
                <span className="text-[9px] text-zinc-500 uppercase tracking-wider block mb-1">
                  PCR (OI)
                </span>
                <div className="flex items-baseline gap-1">
                  <span
                    className={`text-sm font-bold font-mono ${
                      flow.pcr > 1.2
                        ? "text-emerald-400"
                        : flow.pcr < 0.8
                        ? "text-red-400"
                        : "text-zinc-300"
                    }`}
                  >
                    {flow.pcr.toFixed(2)}
                  </span>
                  {flow.pcr > 1.2 ? (
                    <ArrowUpRight className="size-3 text-emerald-400" />
                  ) : flow.pcr < 0.8 ? (
                    <ArrowDownRight className="size-3 text-red-400" />
                  ) : null}
                </div>
                <span className="text-[8px] text-zinc-600">
                  {flow.pcr > 1.2
                    ? "Bullish"
                    : flow.pcr < 0.8
                    ? "Bearish"
                    : "Neutral"}
                </span>
              </div>
              <div className="bg-white/[0.02] rounded-md p-2 border border-white/5">
                <span className="text-[9px] text-zinc-500 uppercase tracking-wider block mb-1">
                  CE/PE Ratio
                </span>
                <span
                  className={`text-sm font-bold font-mono ${
                    flow.cePeRatio > 1.2
                      ? "text-emerald-400"
                      : flow.cePeRatio < 0.8
                      ? "text-red-400"
                      : "text-zinc-300"
                  }`}
                >
                  {flow.cePeRatio.toFixed(2)}
                </span>
                <span className="text-[8px] text-zinc-600 block">
                  {flow.netFlowBias === "INFLOWS"
                    ? "Call dominated"
                    : flow.netFlowBias === "OUTFLOWS"
                    ? "Put dominated"
                    : "Balanced"}
                </span>
              </div>
            </div>

            <Separator className="bg-white/5" />

            {/* Flow Breakdown */}
            <div className="space-y-0.5">
              <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-1">
                Institutional Flow Breakdown
              </div>
              <FlowRow
                label="Index Futures"
                value={flow.indexFuturesSignal}
                color={
                  flow.indexFuturesSignal.includes("Long")
                    ? "text-emerald-400"
                    : flow.indexFuturesSignal.includes("Short")
                    ? "text-red-400"
                    : "text-zinc-400"
                }
              />
              <FlowRow
                label="Stock Futures"
                value={flow.stockFuturesSignal}
                color={
                  flow.stockFuturesSignal.includes("Bull")
                    ? "text-emerald-400"
                    : flow.stockFuturesSignal.includes("Bear")
                    ? "text-red-400"
                    : "text-zinc-400"
                }
              />
              <FlowRow
                label="Cash Market"
                value={flow.cashMarketSignal}
                color={
                  flow.cashMarketSignal.includes("Inflow")
                    ? "text-emerald-400"
                    : flow.cashMarketSignal.includes("Outflow")
                    ? "text-red-400"
                    : "text-zinc-400"
                }
              />
              <FlowRow
                label="Options Flow"
                value={`${fmt(flow.totalCallVolume)} CE / ${fmt(
                  flow.totalPutVolume
                )} PE`}
                subtext={
                  flow.netFlowBias === "INFLOWS"
                    ? "▲"
                    : flow.netFlowBias === "OUTFLOWS"
                    ? "▼"
                    : ""
                }
                color={
                  flow.netFlowBias === "INFLOWS"
                    ? "text-emerald-400"
                    : flow.netFlowBias === "OUTFLOWS"
                    ? "text-red-400"
                    : "text-zinc-400"
                }
              />
            </div>

            <Separator className="bg-white/5" />

            {/* OI Build-up Bars */}
            <div className="space-y-1.5">
              <div className="text-[9px] text-zinc-600 uppercase tracking-wider">
                OI Build-up Direction
              </div>
              <div className="space-y-1">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[9px] text-emerald-500">
                      Call OI Chg
                    </span>
                    <span className="text-[9px] font-mono text-zinc-400">
                      {flow.totalCallOIChg > 0 ? "+" : ""}
                      {fmt(flow.totalCallOIChg)}
                    </span>
                  </div>
                  <StrengthMeter
                    value={Math.min(
                      100,
                      Math.abs(flow.totalCallOIChg) / 200000
                    )}
                    type="bull"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[9px] text-red-500">
                      Put OI Chg
                    </span>
                    <span className="text-[9px] font-mono text-zinc-400">
                      {flow.totalPutOIChg > 0 ? "+" : ""}
                      {fmt(flow.totalPutOIChg)}
                    </span>
                  </div>
                  <StrengthMeter
                    value={Math.min(
                      100,
                      Math.abs(flow.totalPutOIChg) / 200000
                    )}
                    type="bear"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
