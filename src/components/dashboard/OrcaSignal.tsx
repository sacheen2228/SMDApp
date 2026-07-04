// ═══════════════════════════════════════════════════════════════════
// ORCA Signal Panel — Live Institutional Trading Terminal
// Displays all 15 modules: Market Bias, Trade, Strike, Greeks,
// OI, Smart Money, Flow, Confidence, Risk, Alerts, 0DTE
// ═══════════════════════════════════════════════════════════════════

"use client";

import { useEffect, useState, useCallback } from "react";
import type { OrcaSignal } from "@/lib/orca-engine";
import { getSymbolConfig } from "@/lib/symbol-config";

interface OrcaSignalPanelProps {
  symbol: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export function OrcaSignalPanel({
  symbol,
  autoRefresh = true,
  refreshInterval = 30000,
}: OrcaSignalPanelProps) {
  const [signal, setSignal] = useState<OrcaSignal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [countdown, setCountdown] = useState(refreshInterval / 1000);

  const fetchSignal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/orca?symbol=${symbol}`);
      const json = await res.json();
      if (json.success && json.signal) {
        setSignal(json.signal);
        setLastUpdate(new Date().toLocaleTimeString());
        setCountdown(refreshInterval / 1000);
      } else {
        setError(json.error || "No signal");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, refreshInterval]);

  useEffect(() => {
    fetchSignal();
  }, [fetchSignal]);

  // Auto-refresh countdown
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          fetchSignal();
          return refreshInterval / 1000;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchSignal, refreshInterval]);

  const config = getSymbolConfig(symbol);

  if (!signal && !error) {
    return (
      <div className="flex items-center justify-center h-64 text-xs text-muted-foreground">
        <div className="text-center">
          <div className="animate-pulse text-lg mb-2">ORCA</div>
          <div>Analyzing market data...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-destructive text-xs">
        <div className="font-bold mb-1">ORCA Error</div>
        <div>{error}</div>
        <button onClick={fetchSignal} className="mt-2 text-primary underline">
          Retry
        </button>
      </div>
    );
  }

  if (!signal) return null;

  const rec = signal.recommendation;
  const conf = signal.confidence;
  const isCall = rec.action === "BUY_CALL";
  const isPut = rec.action === "BUY_PUT";
  const isWait = rec.action === "WAIT" || rec.action === "NO_TRADE";

  // Color helpers
  const biasColor = signal.marketBias.includes("BULLISH")
    ? "text-emerald-400"
    : signal.marketBias.includes("BEARISH")
    ? "text-red-400"
    : "text-yellow-400";

  const confColor =
    conf.total >= 90
      ? "text-emerald-400"
      : conf.total >= 80
      ? "text-blue-400"
      : conf.total >= 70
      ? "text-yellow-400"
      : "text-red-400";

  const actionBg = isCall
    ? "bg-emerald-500/10 border-emerald-500/30"
    : isPut
    ? "bg-red-500/10 border-red-500/30"
    : "bg-yellow-500/10 border-yellow-500/30";

  return (
    <div className="space-y-2 text-xs">
      {/* ═══ HEADER ═══ */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="font-mono font-bold text-sm text-primary">
            ORCA AI LIVE
          </div>
          {signal.zeroDte.active && (
            <span className="px-1.5 py-0.5 bg-orange-500/20 text-orange-400 text-[10px] font-bold rounded">
              EXPIRY MODE
            </span>
          )}
          {loading && (
            <span className="text-muted-foreground animate-pulse">...</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{lastUpdate}</span>
          <span>({countdown}s)</span>
          <button
            onClick={fetchSignal}
            className="text-primary hover:underline"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* ═══ MARKET BIAS + ACTION ═══ */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-2 bg-secondary/50 rounded">
          <div className="text-[10px] text-muted-foreground mb-1">
            MARKET BIAS
          </div>
          <div className={`font-bold ${biasColor}`}>
            {signal.marketBias.replace(/_/g, " ")}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Trend: {signal.marketStructure.trend}
          </div>
        </div>

        <div className={`p-2 rounded border ${actionBg}`}>
          <div className="text-[10px] text-muted-foreground mb-1">TRADE</div>
          <div
            className={`font-bold text-sm ${
              isCall
                ? "text-emerald-400"
                : isPut
                ? "text-red-400"
                : "text-yellow-400"
            }`}
          >
            {rec.action.replace(/_/g, " ")}
          </div>
          {rec.action !== "WAIT" && rec.action !== "NO_TRADE" && (
            <div className="text-[10px] mt-1">
              {rec.strike} {rec.expiry}
            </div>
          )}
        </div>

        <div className="p-2 bg-secondary/50 rounded">
          <div className="text-[10px] text-muted-foreground mb-1">
            CONFIDENCE
          </div>
          <div className={`font-bold text-lg ${confColor}`}>{conf.total}%</div>
          <div className={`text-[10px] ${confColor}`}>{conf.level}</div>
        </div>
      </div>

      {/* ═══ TRADE DETAILS ═══ */}
      {!isWait && (
        <div className="p-2 bg-secondary/30 rounded border border-primary/20">
          <div className="grid grid-cols-4 gap-2 mb-2">
            <div>
              <span className="text-muted-foreground text-[10px]">Strike</span>
              <div className="font-bold">{rec.strike}</div>
            </div>
            <div>
              <span className="text-muted-foreground text-[10px]">CMP</span>
              <div className="font-bold">
                ₹{rec.currentPremium.toFixed(2)}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground text-[10px]">Entry</span>
              <div className="font-bold text-blue-400">
                ₹{rec.entry.toFixed(2)}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground text-[10px]">
                Risk:Reward
              </span>
              <div className="font-bold">1:{rec.riskReward.toFixed(1)}</div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <span className="text-red-400 text-[10px]">Stop Loss</span>
              <div className="text-red-400">₹{rec.stopLoss.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-emerald-400 text-[10px]">TP1</span>
              <div className="text-emerald-400">₹{rec.target1.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-emerald-400 text-[10px]">TP2</span>
              <div className="text-emerald-400">₹{rec.target2.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-emerald-400 text-[10px]">TP3</span>
              <div className="text-emerald-400">₹{rec.target3.toFixed(2)}</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
            <div>
              <span className="text-muted-foreground">Lots</span>{" "}
              {rec.lotSize} x {rec.maxLots}
            </div>
            <div>
              <span className="text-muted-foreground">Capital</span> ₹
              {rec.capitalRequired.toLocaleString()}
            </div>
            <div>
              <span className="text-muted-foreground">Max Loss</span>{" "}
              <span className="text-red-400">₹{rec.maxLoss.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}

      {/* ═══ GREEKS + OI SUMMARY ═══ */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground mb-1 font-bold">
            GREEKS
          </div>
          <div className="space-y-0.5">
            <div>
              Delta:{" "}
              <span
                className={
                  signal.greeks.atmDelta > 0
                    ? "text-emerald-400"
                    : "text-red-400"
                }
              >
                {signal.greeks.atmDelta.toFixed(3)}
              </span>
            </div>
            <div>
              Gamma:{" "}
              <span className="text-blue-400">
                {signal.greeks.atmGamma.toFixed(4)}
              </span>
            </div>
            <div>
              Theta:{" "}
              <span className="text-yellow-400">
                {signal.greeks.atmTheta.toFixed(2)}
              </span>
            </div>
            <div>
              Vega: <span>{signal.greeks.atmVega.toFixed(2)}</span>
            </div>
            <div>
              Dealer:{" "}
              <span
                className={
                  signal.greeks.dealerRegime === "LONG_GAMMA"
                    ? "text-emerald-400"
                    : "text-red-400"
                }
              >
                {signal.greeks.dealerRegime}
              </span>
            </div>
            <div>
              IV %ile: <span>{signal.greeks.ivPercentile.toFixed(0)}%</span>
            </div>
          </div>
        </div>

        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground mb-1 font-bold">
            OPEN INTEREST
          </div>
          <div className="space-y-0.5">
            <div>
              PCR:{" "}
              <span
                className={
                  signal.oi.pcr > 1.2
                    ? "text-emerald-400"
                    : signal.oi.pcr < 0.8
                    ? "text-red-400"
                    : ""
                }
              >
                {signal.oi.pcr.toFixed(2)}
              </span>
            </div>
            <div>
              Max Pain: <span>{signal.oi.maxPain}</span>
            </div>
            <div>
              Call OI:{" "}
              <span>{(signal.oi.totalCallOI / 100000).toFixed(1)}L</span>
            </div>
            <div>
              Put OI:{" "}
              <span>{(signal.oi.totalPutOI / 100000).toFixed(1)}L</span>
            </div>
            <div>
              {signal.oi.callLongBuildup && (
                <span className="text-emerald-400">Call Long Buildup</span>
              )}
              {signal.oi.putLongBuildup && (
                <span className="text-red-400">Put Long Buildup</span>
              )}
              {signal.oi.freshCallWriting && (
                <span className="text-yellow-400">Fresh CE Writing</span>
              )}
              {signal.oi.freshPutWriting && (
                <span className="text-yellow-400">Fresh PE Writing</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ SMART MONEY + FLOW ═══ */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground mb-1 font-bold">
            SMART MONEY
          </div>
          <div className="space-y-0.5">
            <div>
              Sweep:{" "}
              {signal.smartMoney.liquiditySweep.detected ? (
                <span
                  className={
                    signal.smartMoney.liquiditySweep.direction === "BULLISH"
                      ? "text-emerald-400"
                      : "text-red-400"
                  }
                >
                  {signal.smartMoney.liquiditySweep.direction} @{" "}
                  {signal.smartMoney.liquiditySweep.level}
                </span>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </div>
            <div>
              Stop Hunt:{" "}
              {signal.smartMoney.stopHunt.detected ? (
                <span className="text-yellow-400">YES</span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </div>
            <div>
              Fake Breakout:{" "}
              {signal.smartMoney.fakeBreakout.detected ? (
                <span className="text-yellow-400">
                  {signal.smartMoney.fakeBreakout.direction}
                </span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </div>
          </div>
        </div>

        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground mb-1 font-bold">
            OPTION FLOW
          </div>
          <div className="space-y-0.5">
            <div>
              Volume Spike:{" "}
              {signal.flow.volumeSpike ? (
                <span className="text-emerald-400">YES</span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </div>
            <div>
              Institutional:{" "}
              {signal.flow.institutionalOrders ? (
                <span className="text-emerald-400">YES</span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </div>
            <div>
              Aggressive:{" "}
              {signal.flow.aggressiveBuyers ? (
                <span className="text-emerald-400">Buyers</span>
              ) : signal.flow.aggressiveSellers ? (
                <span className="text-red-400">Sellers</span>
              ) : (
                <span className="text-muted-foreground">Balanced</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ CONFIDENCE BREAKDOWN ═══ */}
      <div className="p-2 bg-secondary/30 rounded">
        <div className="text-[10px] text-muted-foreground mb-1 font-bold">
          CONFIDENCE BREAKDOWN
        </div>
        <div className="grid grid-cols-4 gap-1">
          {[
            { label: "Trend", val: conf.trend, max: 20 },
            { label: "OI", val: conf.oi, max: 20 },
            { label: "Greeks", val: conf.greeks, max: 20 },
            { label: "Liquidity", val: conf.liquidity, max: 15 },
            { label: "Volume", val: conf.volume, max: 10 },
            { label: "PA", val: conf.priceAction, max: 10 },
            { label: "Flow", val: conf.institutionalFlow, max: 5 },
          ].map((f) => (
            <div key={f.label} className="text-center">
              <div className="text-[9px] text-muted-foreground">{f.label}</div>
              <div
                className={`font-bold ${
                  f.val >= f.max * 0.8
                    ? "text-emerald-400"
                    : f.val >= f.max * 0.5
                    ? "text-yellow-400"
                    : "text-red-400"
                }`}
              >
                {f.val}/{f.max}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ═══ 0DTE ═══ */}
      {signal.zeroDte.active && (
        <div className="p-2 bg-orange-500/5 border border-orange-500/20 rounded">
          <div className="text-[10px] text-orange-400 font-bold mb-1">
            0DTE EXPIRY ENGINE
          </div>
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div>
              Gamma Squeeze:{" "}
              {signal.zeroDte.gammaSqueeze ? (
                <span className="text-orange-400">ACTIVE</span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </div>
            <div>
              Dealer Hedge:{" "}
              {signal.zeroDte.dealerHedging ? (
                <span className="text-orange-400">YES</span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </div>
            <div>
              Premium Speed:{" "}
              <span className="text-orange-400">
                {signal.zeroDte.premiumSpeed}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ═══ ALERTS ═══ */}
      {signal.alerts.length > 0 && (
        <div className="space-y-1">
          {signal.alerts.slice(0, 5).map((alert, i) => (
            <div
              key={i}
              className={`p-1.5 rounded text-[10px] ${
                alert.severity === "HIGH"
                  ? "bg-red-500/10 text-red-400 border border-red-500/20"
                  : alert.severity === "MEDIUM"
                  ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
                  : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
              }`}
            >
              <span className="font-bold">{alert.type.replace(/_/g, " ")}:</span>{" "}
              {alert.message}
            </div>
          ))}
        </div>
      )}

      {/* ═══ REASONS ═══ */}
      {signal.reasons.length > 0 && (
        <div className="p-2 bg-secondary/30 rounded">
          <div className="text-[10px] text-muted-foreground mb-1 font-bold">
            REASONS
          </div>
          <div className="flex flex-wrap gap-1">
            {signal.reasons.map((r, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] rounded"
              >
                {r}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ═══ MARKET STRUCTURE ═══ */}
      <div className="p-2 bg-secondary/30 rounded">
        <div className="text-[10px] text-muted-foreground mb-1 font-bold">
          MARKET STRUCTURE
        </div>
        <div className="grid grid-cols-4 gap-1 text-[10px]">
          <div>
            VWAP: <span className="text-blue-400">{signal.marketStructure.vwap.toFixed(2)}</span>
          </div>
          <div>
            EMA9: <span>{signal.marketStructure.ema9.toFixed(2)}</span>
          </div>
          <div>
            EMA21: <span>{signal.marketStructure.ema21.toFixed(2)}</span>
          </div>
          <div>
            ATR: <span>{signal.marketStructure.dailyHigh > signal.marketStructure.dailyLow ? ((signal.marketStructure.dailyHigh - signal.marketStructure.dailyLow) / signal.spot * 100).toFixed(2) : "0"}%</span>
          </div>
          <div>
            R1: <span className="text-red-400">{signal.marketStructure.r1.toFixed(2)}</span>
          </div>
          <div>
            S1: <span className="text-emerald-400">{signal.marketStructure.s1.toFixed(2)}</span>
          </div>
          <div>
            HH: <span>{signal.marketStructure.higherHigh ? "✓" : "✗"}</span>
          </div>
          <div>
            HL: <span>{signal.marketStructure.higherLow ? "✓" : "✗"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
