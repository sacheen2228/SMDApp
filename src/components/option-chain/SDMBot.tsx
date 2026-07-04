// SDM Bot - Main Wrapper Component
// Real-time option chain intelligence with V2 async recommendation engine

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { SDMOptionStrike, SDMRecommendation, CandleData } from "@/types/sdm";
import {
  generateTradeRecommendation,
  validateOptionChain,
} from "@/lib/sdm-recommendation";
import {
  evaluateDataHealth,
  type DataHealthReport,
} from "@/lib/data-health";
import * as tracker from "@/lib/sdm-trade-tracker";
import { getLotSize } from "@/lib/symbol-config";
import { SDMExpiryMode } from "./SDMExpiryMode";
import { SDMNormalMode } from "./SDMNormalMode";
import { SDMScoresPanel } from "./SDMScoresPanel";
import { SDMTradeHistory } from "./SDMTradeHistory";
import { DataHealthStrip } from "./DataHealthStrip";
import { TimeframePanel } from "./TimeframePanel";
import { TradeJournal } from "./TradeJournal";
import { BacktestReport } from "@/components/dashboard/BacktestReport";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronUp,
  Bot,
  AlertTriangle,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const CANDLE_INTERVAL = 5 * 60 * 1000;

interface SDMBotProps {
  optionChainData: any;
  spotPrice: number;
  symbol: string;
  expiryDate: string;
  onRecommendation?: (rec: SDMRecommendation | null) => void;
}

type ExpandedTab = "overview" | "journal";

export function SDMBot({
  optionChainData,
  spotPrice,
  symbol,
  expiryDate,
  onRecommendation,
}: SDMBotProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<ExpandedTab>("overview");
  const [recommendation, setRecommendation] =
    useState<SDMRecommendation | null>(null);
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const [healthReport, setHealthReport] = useState<DataHealthReport | null>(
    null
  );

  // Anti-repaint state (5-min candle lock)
  const candleTimeRef = useRef(0);
  const lastRecRef = useRef<SDMRecommendation | null>(null);
  const validationIssuesRef = useRef<string[]>([]);
  const healthReportRef = useRef<DataHealthReport | null>(null);
  const recommendationRef = useRef<SDMRecommendation | null>(null);

  // Process option chain data into SDM format (handles both simulation + Breeze)
  const processOptionChain = useCallback(
    (data: any): SDMOptionStrike[] => {
      if (!data) return [];

      // data.data is the combined strikes array [{strike, ce, pe}] (API response format)
      if (Array.isArray(data.data)) {
        return data.data.map((row: any) => ({
          strike: row.strike,
          ce: row.ce ? {
            ltp: row.ce.ltp || 0,
            oi: row.ce.oi || 0,
            oiChg: row.ce.oiChg || 0,
            volume: row.ce.volume || 0,
            iv: row.ce.iv || 0,
            delta: row.ce.delta || 0,
            theta: row.ce.theta || 0,
            gamma: row.ce.gamma || 0,
            vega: row.ce.vega || 0,
            bid: row.ce.bid || 0,
            ask: row.ce.ask || 0,
          } : null,
          pe: row.pe ? {
            ltp: row.pe.ltp || 0,
            oi: row.pe.oi || 0,
            oiChg: row.pe.oiChg || 0,
            volume: row.pe.volume || 0,
            iv: row.pe.iv || 0,
            delta: row.pe.delta || 0,
            theta: row.pe.theta || 0,
            gamma: row.pe.gamma || 0,
            vega: row.pe.vega || 0,
            bid: row.pe.bid || 0,
            ask: row.pe.ask || 0,
          } : null,
        }));
      }

      // Fallback: data.data might be a nested object with calls/puts
      const chainData = data.data || data;
      if (!chainData) return [];

      const rows = chainData.data || chainData.calls || null;

      // Breeze format: calls/puts arrays -> group by strike
      if (chainData.calls && chainData.puts) {
        const callMap = new Map<number, any>();
        const putMap = new Map<number, any>();
        for (const c of chainData.calls) callMap.set(c.strikePrice, c);
        for (const p of chainData.puts) putMap.set(p.strikePrice, p);
        const allStrikes = [...new Set([...callMap.keys(), ...putMap.keys()])].sort((a, b) => a - b);
        return allStrikes.map(strike => ({
          strike,
          ce: callMap.has(strike) ? {
            ltp: callMap.get(strike).ltp || 0,
            oi: callMap.get(strike).openInterest || 0,
            oiChg: callMap.get(strike).oiChange || 0,
            volume: callMap.get(strike).volume || 0,
            iv: callMap.get(strike).iv || 0,
            delta: callMap.get(strike).delta || 0,
            theta: callMap.get(strike).theta || 0,
            gamma: callMap.get(strike).gamma || 0,
            vega: callMap.get(strike).vega || 0,
            bid: callMap.get(strike).bid || 0,
            ask: callMap.get(strike).ask || 0,
          } : null,
          pe: putMap.has(strike) ? {
            ltp: putMap.get(strike).ltp || 0,
            oi: putMap.get(strike).openInterest || 0,
            oiChg: putMap.get(strike).oiChange || 0,
            volume: putMap.get(strike).volume || 0,
            iv: putMap.get(strike).iv || 0,
            delta: putMap.get(strike).delta || 0,
            theta: putMap.get(strike).theta || 0,
            gamma: putMap.get(strike).gamma || 0,
            vega: putMap.get(strike).vega || 0,
            bid: putMap.get(strike).bid || 0,
            ask: putMap.get(strike).ask || 0,
          } : null,
        }));
      }

      // Simulation format: data array with {strike, ce, pe}
      if (Array.isArray(rows)) {
        return rows.map((row: any) => ({
          strike: row.strike,
          ce: row.ce ? {
            ltp: row.ce.ltp || 0,
            oi: row.ce.oi || 0,
            oiChg: row.ce.oiChg || 0,
            volume: row.ce.volume || 0,
            iv: row.ce.iv || 0,
            delta: row.ce.delta || 0,
            theta: row.ce.theta || 0,
            gamma: row.ce.gamma || 0,
            vega: row.ce.vega || 0,
            bid: row.ce.bid || 0,
            ask: row.ce.ask || 0,
          } : null,
          pe: row.pe ? {
            ltp: row.pe.ltp || 0,
            oi: row.pe.oi || 0,
            oiChg: row.pe.oiChg || 0,
            volume: row.pe.volume || 0,
            iv: row.pe.iv || 0,
            delta: row.pe.delta || 0,
            theta: row.pe.theta || 0,
            gamma: row.pe.gamma || 0,
            vega: row.pe.vega || 0,
            bid: row.pe.bid || 0,
            ask: row.pe.ask || 0,
          } : null,
        }));
      }

      return [];
    },
    []
  );

  // ── Main effect: async V2 recommendation engine with anti-repaint ──
  useEffect(() => {
    if (!optionChainData || spotPrice <= 0) return;

    tracker.setLotSize(getLotSize(symbol));

    const chain = processOptionChain(optionChainData);
    if (chain.length === 0) return;

    // Self-validation
    const validation = validateOptionChain(chain, spotPrice, symbol);
    const issues = [...validation.issues, ...validation.warnings];
    // Use ref to avoid cascading renders from synchronous setState in effect
    validationIssuesRef.current = issues;

    // Extract V2 inputs from optionChainData
    const source = optionChainData?.source || "simulation";
    const lastUpdate =
      optionChainData?.lastUpdate || new Date().toISOString();
    const rawCandles = optionChainData?.candles;
    // API returns flat array; wrap into Record<string, CandleData[]> for multi-timeframe engine
    const candles: Record<string, CandleData[]> = Array.isArray(rawCandles) && rawCandles.length > 0
      ? { '5m': rawCandles.map((c: any) => ({
          time: typeof c.time === 'string' ? new Date(c.timestamp || c.time).getTime() : (c.time || 0),
          open: c.open || 0,
          high: c.high || 0,
          low: c.low || 0,
          close: c.close || 0,
          volume: c.volume || 0,
        }))}
      : {};
    const vix = optionChainData?.vix || 15;

    // Compute data health for DataHealthStrip
    const lastUpdateMs = new Date(lastUpdate).getTime();
    const atm = chain.reduce((best: SDMOptionStrike, s: SDMOptionStrike) =>
      Math.abs(s.strike - spotPrice) < Math.abs(best.strike - spotPrice)
        ? s
        : best
    );
    const strikesWithMissing = chain.filter(
      (s) => !s.ce || !s.pe || s.ce.ltp === 0 || s.pe.ltp === 0
    ).length;

    const hr = evaluateDataHealth({
      latencyMs: source === "simulation" ? 0 : 200,
      lastUpdateMs: isNaN(lastUpdateMs) ? Date.now() : lastUpdateMs,
      totalStrikes: chain.length,
      strikesWithMissingData: strikesWithMissing,
      atmHasGreeks: atm
        ? atm.ce?.delta !== undefined && atm.pe?.delta !== undefined
        : false,
      source,
    });
    healthReportRef.current = hr;

    // Anti-repaint: same 5-min candle → use cached recommendation
    const nowMs = Date.now();
    const currentCandleStart =
      Math.floor(nowMs / CANDLE_INTERVAL) * CANDLE_INTERVAL;

    if (
      candleTimeRef.current > 0 &&
      nowMs < candleTimeRef.current + CANDLE_INTERVAL &&
      lastRecRef.current
    ) {
      recommendationRef.current = lastRecRef.current;

      // Still update active trades with current LTP
      const selectedData = chain.find(
        (s: SDMOptionStrike) => s.strike === lastRecRef.current!.strike
      );
      const currentLTP = lastRecRef.current!.direction.includes("CALL")
        ? selectedData?.ce?.ltp || 0
        : selectedData?.pe?.ltp || 0;
      tracker.updateTrades(currentLTP, spotPrice);

      if (
        lastRecRef.current!.isExpiryDay &&
        new Date().getHours() >= 15 &&
        new Date().getMinutes() >= 30
      ) {
        tracker.expireAllActiveTrades();
      }
      return;
    }

    // New candle — generate fresh async recommendation
    let cancelled = false;

    (async () => {
      try {
        const rec = await generateTradeRecommendation(
          chain,
          spotPrice,
          symbol,
          expiryDate,
          candles,
          vix,
          source,
          lastUpdate
        );

        if (cancelled) return;

        // Anti-repaint: allow update if direction flipped
        if (lastRecRef.current) {
          const lastDir = lastRecRef.current.direction;
          const newDir = rec.direction;
          const directionChanged =
            (lastDir !== "WAIT" && newDir === "WAIT") ||
            (lastDir === "CALL" && newDir === "PUT") ||
            (lastDir === "PUT" && newDir === "CALL") ||
            (lastDir === "WAIT" && newDir !== "WAIT");

          if (
            !directionChanged &&
            currentCandleStart === candleTimeRef.current
          ) {
      recommendationRef.current = lastRecRef.current;
      onRecommendation?.(lastRecRef.current);
            return;
          }
        }

        candleTimeRef.current = currentCandleStart;
        lastRecRef.current = rec;
        recommendationRef.current = rec;
        onRecommendation?.(rec);

        // Auto-add trade only if it's a new signal (not duplicate of last trade)
        const existingTrades = tracker.getTradesToday();
        const lastTrade = existingTrades[existingTrades.length - 1];
        const isNewSignal =
          !lastTrade ||
          lastTrade.strike !== rec.strike ||
          lastTrade.direction !== rec.direction;

        if (
          rec.direction !== "WAIT" &&
          rec.entry > 0 &&
          tracker.canTakeTrade(rec.isExpiryDay) &&
          validation.isValid &&
          isNewSignal
        ) {
          const tradeDir = rec.direction as "CALL" | "PUT";
          tracker.addTrade(
            tradeDir,
            rec.strike,
            rec.entry,
            rec.tp1,
            rec.tp2,
            rec.tp3,
            rec.sl,
            rec.isExpiryDay,
            rec.tradeGrade,
            rec.confidence,
            rec.reason
          );
        }

        // Update active trades with current LTP
        const selectedData = chain.find(
          (s: SDMOptionStrike) => s.strike === rec.strike
        );
        const currentLTP = rec.direction.includes("CALL")
          ? selectedData?.ce?.ltp || 0
          : selectedData?.pe?.ltp || 0;
        tracker.updateTrades(currentLTP, spotPrice);

        // Expire all trades after 15:30 on expiry day
        if (
          rec.isExpiryDay &&
          new Date().getHours() >= 15 &&
          new Date().getMinutes() >= 30
        ) {
          tracker.expireAllActiveTrades();
        }
      } catch (err) {
        console.error("SDM recommendation error:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [optionChainData, spotPrice, symbol, expiryDate, processOptionChain]);

  // Sync refs to state (avoids cascading renders in effect)
  useEffect(() => {
    if (validationIssuesRef.current.length > 0) {
      setValidationIssues(validationIssuesRef.current);
    }
  });

  useEffect(() => {
    if (healthReportRef.current) {
      setHealthReport(healthReportRef.current);
    }
  });

  useEffect(() => {
    if (recommendationRef.current) {
      setRecommendation(recommendationRef.current);
    }
  });

  // No data state
  if (!optionChainData || spotPrice <= 0) {
    return (
      <div className="bg-card/80 backdrop-blur-xl border border-border rounded-xl p-4 shadow-2xl">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Bot className="w-4 h-4 animate-pulse" />
          <span>Waiting for data...</span>
        </div>
      </div>
    );
  }

  if (!recommendation) {
    return (
      <div className="bg-card/80 backdrop-blur-xl border border-border rounded-xl p-4 shadow-2xl">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Bot className="w-4 h-4 animate-pulse" />
          <span>Analyzing...</span>
        </div>
      </div>
    );
  }

  // ── Collapsed view ──
  if (!isExpanded) {
    const getDirBadge = () => {
      switch (recommendation.direction) {
        case "CALL":
          return (
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[9px]">
              CALL
            </Badge>
          );
        case "PUT":
          return (
            <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[9px]">
              PUT
            </Badge>
          );
        case "SELL_CALL":
          return (
            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[9px]">
              SELL CALL
            </Badge>
          );
        case "SELL_PUT":
          return (
            <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[9px]">
              SELL PUT
            </Badge>
          );
        default:
          return (
            <Badge className="bg-muted text-muted-foreground border-border text-[9px]">
              WAIT
            </Badge>
          );
      }
    };

    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="bg-card/80 backdrop-blur-xl border border-border rounded-xl px-3 py-2 shadow-2xl hover:bg-card/90 transition-all cursor-pointer w-full"
      >
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-amber-400" />
          {getDirBadge()}
          <span className="text-[10px] text-foreground flex-1 text-left">
            {recommendation.strike}{" "}
            {recommendation.isExpiryDay ? "⚡" : "📅"}
          </span>
          <Badge
            className={`text-[9px] ${
              recommendation.tradeGrade.startsWith("A")
                ? "bg-emerald-500/20 text-emerald-400"
                : recommendation.tradeGrade === "B"
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {recommendation.tradeGrade}
          </Badge>
          <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${recommendation.confidence}%`,
                background:
                  "linear-gradient(to right, #ef4444, #eab308, #22c55e)",
              }}
            />
          </div>
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        </div>
      </button>
    );
  }

  // ── Expanded view ──
  return (
    <div className="bg-card/80 backdrop-blur-xl border border-border rounded-xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-accent/50">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-medium text-white">SDM Bot</span>
          <Badge
            className={`text-[9px] ${
              recommendation.dataHealth.status === "LIVE"
                ? "bg-emerald-500/20 text-emerald-400"
                : recommendation.dataHealth.status === "STALE"
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "bg-red-500/20 text-red-400"
            }`}
          >
            {recommendation.dataHealth.status}
          </Badge>
          <span className="text-[9px] text-muted-foreground">
            Latency: {recommendation.dataHealth.latency}ms
          </span>
        </div>
        <button
          onClick={() => setIsExpanded(false)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      {/* Data Health Strip */}
      <div className="px-3 pt-2">
        <DataHealthStrip
          health={healthReport}
          source={recommendation.dataHealth.source}
          lastUpdate={recommendation.dataHealth.lastUpdate}
        />
      </div>

      {/* Tab Navigation */}
      <div className="flex border-b border-border px-3 mt-2">
        <button
          onClick={() => setActiveTab("overview")}
          className={cn(
            "px-3 py-1.5 text-[10px] font-medium transition-colors border-b-2",
            activeTab === "overview"
              ? "text-amber-400 border-amber-400"
              : "text-muted-foreground border-transparent hover:text-foreground"
          )}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab("journal")}
          className={cn(
            "px-3 py-1.5 text-[10px] font-medium transition-colors border-b-2 flex items-center gap-1",
            activeTab === "journal"
              ? "text-amber-400 border-amber-400"
              : "text-muted-foreground border-transparent hover:text-foreground"
          )}
        >
          <BookOpen className="w-3 h-3" />
          Journal
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeTab === "overview" ? (
          <>
            {recommendation.isExpiryDay ? (
              <SDMExpiryMode recommendation={recommendation} />
            ) : (
              <SDMNormalMode recommendation={recommendation} />
            )}

            {/* Smart Entry / Exit Actions */}
            {recommendation.direction !== "WAIT" && (
              <div className="space-y-1.5">
                <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  Smart Actions
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-accent/50 rounded p-2">
                    <div className="text-[8px] text-muted-foreground">
                      Entry Action
                    </div>
                    <div
                      className={cn(
                        "text-[11px] font-medium",
                        recommendation.smartEntry === "ENTER_NOW"
                          ? "text-emerald-400"
                          : "text-yellow-400"
                      )}
                    >
                      {recommendation.smartEntry.replace(/_/g, " ")}
                    </div>
                  </div>
                  <div className="bg-accent/50 rounded p-2">
                    <div className="text-[8px] text-muted-foreground">
                      Exit Action
                    </div>
                    <div
                      className={cn(
                        "text-[11px] font-medium",
                        recommendation.smartExit === "HOLD"
                          ? "text-emerald-400"
                          : "text-yellow-400"
                      )}
                    >
                      {recommendation.smartExit.replace(/_/g, " ")}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Timeframe Panel */}
            <TimeframePanel
              consensus={recommendation.consensus || null}
            />

            {/* 14-Factor Quality Score Breakdown */}
            {recommendation.qualityScore &&
              recommendation.qualityScore.factors.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
                    14-Factor Quality Score ({recommendation.qualityScore.overall} — Grade{" "}
                    {recommendation.qualityScore.grade})
                  </div>
                  <div className="space-y-1">
                    {recommendation.qualityScore.factors.map((factor) => (
                      <div
                        key={factor.name}
                        className="flex items-center gap-2"
                      >
                        <span className="text-[9px] text-muted-foreground w-24 truncate">
                          {factor.name}
                        </span>
                        <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-500",
                              factor.score >= 70
                                ? "bg-emerald-500"
                                : factor.score >= 50
                                  ? "bg-yellow-500"
                                  : "bg-red-500"
                            )}
                            style={{ width: `${factor.score}%` }}
                          />
                        </div>
                        <span
                          className={cn(
                            "text-[9px] w-6 text-right font-mono",
                            factor.score >= 60
                              ? "text-emerald-400"
                              : factor.score >= 40
                                ? "text-yellow-400"
                                : "text-red-400"
                          )}
                        >
                          {factor.score}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            <SDMScoresPanel
              scores={recommendation.sdmScores}
              confidence={recommendation.confidence}
              direction={recommendation.direction}
            />

            <SDMTradeHistory
              trades={tracker.getTradesToday()}
              pnl={tracker.getDailyPnL()}
              winRate={tracker.getWinRate()}
              avgGrade={tracker.getAverageGrade()}
            />
          </>
        ) : (
          <div className="space-y-3">
            <TradeJournal
              trades={tracker.getTradesToday()}
              winRate={tracker.getWinRate()}
              avgGrade={tracker.getAverageGrade()}
              dailyPnL={tracker.getDailyPnL()}
            />
            <BacktestReport
              trades={tracker.getTradesToday()}
              symbol={symbol}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-border bg-accent/50">
        <div className="text-[8px] text-muted-foreground truncate">
          {recommendation.reason}
        </div>
        {validationIssues.length > 0 && (
          <div className="flex items-center gap-1 mt-1">
            <AlertTriangle className="w-3 h-3 text-yellow-400" />
            <span className="text-[8px] text-yellow-400 truncate">
              {validationIssues[0]}
              {validationIssues.length > 1 &&
                ` (+${validationIssues.length - 1} more)`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
