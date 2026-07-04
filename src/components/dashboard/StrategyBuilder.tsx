// Strategy Builder UI — payoff diagram, risk analysis, pre-built strategies

"use client";

import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Target,
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  AlertTriangle,
} from "lucide-react";
import {
  type Strategy,
  type StrategyAnalysis,
  analyzeStrategy,
  buildStraddle,
  buildStrangle,
  buildIronCondor,
  buildBullCallSpread,
  buildBearPutSpread,
} from "@/lib/strategy-builder";

interface StrategyBuilderProps {
  spotPrice: number;
  chainData: any[];
  symbol: string;
}

const STRATEGY_PRESETS = [
  { name: "Long Straddle", icon: Zap, view: "volatile" as const },
  { name: "Long Strangle", icon: Zap, view: "volatile" as const },
  { name: "Iron Condor", icon: Minus, view: "neutral" as const },
  { name: "Bull Call Spread", icon: TrendingUp, view: "bullish" as const },
  { name: "Bear Put Spread", icon: TrendingDown, view: "bearish" as const },
];

function PayoffChart({ curve, spotPrice }: { curve: { price: number; pnl: number }[]; spotPrice: number }) {
  if (!curve.length) return null;

  const maxPnL = Math.max(...curve.map((c) => c.pnl));
  const minPnL = Math.min(...curve.map((c) => c.pnl));
  const absMax = Math.max(Math.abs(maxPnL), Math.abs(minPnL), 1);
  const width = 400;
  const height = 160;
  const pad = { top: 20, bottom: 25, left: 50, right: 10 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const xScale = (price: number) => {
    const minP = curve[0].price;
    const maxP = curve[curve.length - 1].price;
    return pad.left + ((price - minP) / (maxP - minP)) * chartW;
  };

  const yScale = (pnl: number) => {
    return pad.top + chartH / 2 - (pnl / absMax) * (chartH / 2);
  };

  const zeroY = yScale(0);

  // Build filled areas
  const profitPoints = curve.filter((c) => c.pnl >= 0);
  const lossPoints = curve.filter((c) => c.pnl <= 0);

  const profitAreaPath = profitPoints.length > 1
    ? `M ${xScale(profitPoints[0].price)} ${zeroY} ` +
      profitPoints.map((c) => `L ${xScale(c.price)} ${yScale(c.pnl)}`).join(" ") +
      ` L ${xScale(profitPoints[profitPoints.length - 1].price)} ${zeroY} Z`
    : "";

  const lossAreaPath = lossPoints.length > 1
    ? `M ${xScale(lossPoints[0].price)} ${zeroY} ` +
      lossPoints.map((c) => `L ${xScale(c.price)} ${yScale(c.pnl)}`).join(" ") +
      ` L ${xScale(lossPoints[lossPoints.length - 1].price)} ${zeroY} Z`
    : "";

  const linePath = curve
    .map((c, i) => `${i === 0 ? "M" : "L"} ${xScale(c.price)} ${yScale(c.pnl)}`)
    .join(" ");

  // Y-axis labels
  const yTicks = [-absMax, -absMax / 2, 0, absMax / 2, absMax];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {/* Y-axis grid + labels */}
      {yTicks.map((tick) => (
        <g key={tick}>
          <line
            x1={pad.left} y1={yScale(tick)} x2={width - pad.right} y2={yScale(tick)}
            stroke="hsl(240 3.7% 44.9% / 0.15)" strokeWidth="0.5"
          />
          <text x={pad.left - 4} y={yScale(tick) + 3} textAnchor="end" fontSize="7" fill="hsl(240 3.7% 44.9% / 0.5)">
            {tick >= 0 ? "+" : ""}{Math.round(tick).toLocaleString("en-IN")}
          </text>
        </g>
      ))}

      {/* Zero line (thicker) */}
      <line x1={pad.left} y1={zeroY} x2={width - pad.right} y2={zeroY} stroke="hsl(240 3.7% 44.9% / 0.4)" strokeWidth="1" />

      {/* Profit area fill */}
      {profitAreaPath && <path d={profitAreaPath} fill="hsl(142 76% 36% / 0.15)" />}
      {/* Loss area fill */}
      {lossAreaPath && <path d={lossAreaPath} fill="hsl(0 84% 60% / 0.15)" />}

      {/* P&L line */}
      <path d={linePath} fill="none" stroke="hsl(220 9% 46%)" strokeWidth="2" />

      {/* Spot price marker */}
      <line x1={xScale(spotPrice)} y1={pad.top} x2={xScale(spotPrice)} y2={height - pad.bottom} stroke="hsl(262 83% 58% / 0.6)" strokeWidth="1" strokeDasharray="4,2" />
      <circle cx={xScale(spotPrice)} cy={yScale(0)} r="4" fill="hsl(262 83% 58%)" />
      <text x={xScale(spotPrice)} y={pad.top - 4} textAnchor="middle" fontSize="8" fontWeight="bold" fill="hsl(262 83% 58%)">
        Spot ₹{spotPrice.toLocaleString("en-IN")}
      </text>

      {/* X-axis labels */}
      {[curve[0], curve[Math.floor(curve.length / 4)], curve[Math.floor(curve.length / 2)], curve[Math.floor(3 * curve.length / 4)], curve[curve.length - 1]].map((c, i) => (
        <text key={i} x={xScale(c.price)} y={height - 5} textAnchor="middle" fontSize="7" fill="hsl(240 3.7% 44.9% / 0.5)">
          {(c.price / 1000).toFixed(1)}k
        </text>
      ))}
    </svg>
  );
}

export function StrategyBuilder({ spotPrice, chainData, symbol }: StrategyBuilderProps) {
  const [selectedPreset, setSelectedPreset] = useState<string>("Long Straddle");

  // Get ATM and nearby strikes
  const strikes = useMemo(() => {
    if (!chainData?.length) return [];
    return chainData
      .filter((s: any) => s.ce || s.pe)
      .map((s: any) => ({
        strike: s.strike,
        cePremium: s.ce?.ltp || 0,
        pePremium: s.pe?.ltp || 0,
        ceOI: s.ce?.oi || 0,
        peOI: s.pe?.oi || 0,
      }))
      .sort((a: any, b: any) => a.strike - b.strike);
  }, [chainData]);

  const atmStrike = useMemo(() => {
    if (!strikes.length) return spotPrice;
    return strikes.reduce((best: any, s: any) =>
      Math.abs(s.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? s : best
    ).strike;
  }, [strikes, spotPrice]);

  const lotSize = symbol === "NIFTY" ? 65 : symbol === "BANKNIFTY" ? 30 : symbol === "FINNIFTY" ? 60 : symbol === "MIDCPNIFTY" ? 120 : 20;

  // Build strategy based on selection
  const strategy = useMemo((): Strategy | null => {
    if (!strikes.length) return null;

    const atmData = strikes.find((s: any) => s.strike === atmStrike);
    const otmCE = strikes.find((s: any) => s.strike > atmStrike);
    const otmPE = strikes.find((s: any) => s.strike < atmStrike);
    const farOTMCE = strikes.find((s: any) => s.strike > atmStrike + (otmCE?.strike - atmStrike || 100));
    const farOTMPE = strikes.find((s: any) => s.strike < atmStrike - (atmStrike - (otmPE?.strike || atmStrike - 100)));

    const cePrem = atmData?.cePremium || 100;
    const pePrem = atmData?.pePremium || 100;

    switch (selectedPreset) {
      case "Long Straddle":
        return buildStraddle(atmStrike, (cePrem + pePrem) / 2, lotSize);
      case "Long Strangle":
        return buildStrangle(
          otmCE?.strike || atmStrike + 100, otmPE?.strike || atmStrike - 100,
          otmCE?.cePremium || cePrem * 0.5, otmPE?.pePremium || pePrem * 0.5, lotSize
        );
      case "Iron Condor":
        return buildIronCondor(
          farOTMPE?.strike || atmStrike - 300, otmPE?.strike || atmStrike - 100,
          otmCE?.strike || atmStrike + 100, farOTMCE?.strike || atmStrike + 300,
          (farOTMPE?.pePremium || pePrem * 0.2), (otmPE?.pePremium || pePrem * 0.5),
          (otmCE?.cePremium || cePrem * 0.5), (farOTMCE?.cePremium || cePrem * 0.2), lotSize
        );
      case "Bull Call Spread":
        return buildBullCallSpread(
          atmStrike, otmCE?.strike || atmStrike + 100,
          cePrem, otmCE?.cePremium || cePrem * 0.5, lotSize
        );
      case "Bear Put Spread":
        return buildBearPutSpread(
          otmPE?.strike || atmStrike - 100, atmStrike,
          otmPE?.pePremium || pePrem * 0.5, pePrem, lotSize
        );
      default:
        return null;
    }
  }, [selectedPreset, strikes, atmStrike, lotSize]);

  const analysis = useMemo((): StrategyAnalysis | null => {
    if (!strategy) return null;
    return analyzeStrategy(strategy, spotPrice);
  }, [strategy, spotPrice]);

  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-foreground">Strategy Builder</h1>
          <p className="text-[10px] text-muted-foreground">
            {symbol} • Spot ₹{spotPrice.toLocaleString("en-IN")} • ATM ₹{atmStrike.toLocaleString("en-IN")}
          </p>
        </div>
      </div>

      {/* Strategy Selector */}
      <div className="flex gap-1 flex-wrap">
        {STRATEGY_PRESETS.map((preset) => (
          <Button
            key={preset.name}
            variant="ghost"
            size="sm"
            className={`h-7 text-[10px] font-bold ${
              selectedPreset === preset.name
                ? "bg-violet-600 text-white"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setSelectedPreset(preset.name)}
          >
            <preset.icon className="h-3 w-3 mr-1" />
            {preset.name}
          </Button>
        ))}
      </div>

      {analysis && (
        <>
          {/* Payoff Diagram */}
          <Card className="border-border bg-card">
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground font-bold uppercase">Payoff Diagram</span>
                <Badge className="text-[8px] bg-violet-500/10 text-violet-400">
                  {analysis.strategy.name}
                </Badge>
              </div>
              <PayoffChart curve={analysis.payoffCurve} spotPrice={spotPrice} />
              <p className="text-[8px] text-muted-foreground mt-1">{analysis.strategy.description}</p>
            </CardContent>
          </Card>

          {/* Risk Metrics */}
          <div className="grid grid-cols-2 gap-2">
            <Card className="border-border bg-card">
              <CardContent className="p-2 text-center">
                <div className="text-[8px] text-muted-foreground">Max Profit</div>
                <div className="text-sm font-bold text-green-500">{analysis.bestCase}</div>
              </CardContent>
            </Card>
            <Card className="border-border bg-card">
              <CardContent className="p-2 text-center">
                <div className="text-[8px] text-muted-foreground">Max Loss</div>
                <div className="text-sm font-bold text-red-500">{analysis.worstCase}</div>
              </CardContent>
            </Card>
            <Card className="border-border bg-card">
              <CardContent className="p-2 text-center">
                <div className="text-[8px] text-muted-foreground">Breakeven</div>
                <div className="text-sm font-bold text-foreground">
                  {analysis.breakevens.length > 0
                    ? analysis.breakevens.map((b) => `₹${b.toLocaleString("en-IN")}`).join(", ")
                    : "—"}
                </div>
              </CardContent>
            </Card>
            <Card className="border-border bg-card">
              <CardContent className="p-2 text-center">
                <div className="text-[8px] text-muted-foreground">Margin Required</div>
                <div className="text-sm font-bold text-foreground">
                  ₹{analysis.marginRequired.toLocaleString("en-IN")}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Legs */}
          <Card className="border-border bg-card">
            <CardContent className="p-2">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[9px] text-muted-foreground font-bold uppercase">Strategy Legs</span>
                </div>
                <span className="text-[8px] text-muted-foreground">Lot: {lotSize} qty</span>
              </div>
              <div className="space-y-1">
                {analysis.strategy.legs.map((leg, i) => {
                  const legCost = leg.premium * leg.lotSize * leg.lots;
                  return (
                    <div
                      key={i}
                      className={`flex items-center justify-between p-1.5 rounded text-[10px] ${
                        leg.action === "BUY" ? "bg-green-500/10" : "bg-red-500/10"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Badge className={`text-[8px] ${leg.action === "BUY" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                          {leg.action}
                        </Badge>
                        <span className="text-foreground font-bold">{leg.strike.toLocaleString("en-IN")}</span>
                        <span className="text-muted-foreground">{leg.type}</span>
                        <span className="text-muted-foreground/60 text-[8px]">×{leg.lots} lot</span>
                      </div>
                      <div className="text-right">
                        <span className="text-foreground">₹{leg.premium}</span>
                        <span className="text-muted-foreground/60 text-[8px] ml-1">₹{legCost.toLocaleString("en-IN")}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Total cost */}
              <div className="flex justify-between mt-2 pt-1 border-t border-border/30 text-[10px]">
                <span className="text-muted-foreground">Total Premium</span>
                <span className="font-bold text-foreground">
                  ₹{analysis.strategy.legs.reduce((sum, leg) => sum + leg.premium * leg.lotSize * leg.lots, 0).toLocaleString("en-IN")}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Market View */}
          <Card className="border-border bg-card">
            <CardContent className="p-2 text-center">
              <div className="text-[8px] text-muted-foreground mb-1">Market View</div>
              <Badge className={`text-[10px] ${
                analysis.strategy.marketView === "bullish" ? "bg-green-500/20 text-green-400" :
                analysis.strategy.marketView === "bearish" ? "bg-red-500/20 text-red-400" :
                analysis.strategy.marketView === "volatile" ? "bg-orange-500/20 text-orange-400" :
                "bg-blue-500/20 text-blue-400"
              }`}>
                {analysis.strategy.marketView.toUpperCase()}
              </Badge>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
