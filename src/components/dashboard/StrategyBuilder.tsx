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
  const range = maxPnL - minPnL || 1;
  const width = 400;
  const height = 120;
  const padding = 10;

  const xScale = (price: number) => {
    const minP = curve[0].price;
    const maxP = curve[curve.length - 1].price;
    return padding + ((price - minP) / (maxP - minP)) * (width - 2 * padding);
  };

  const yScale = (pnl: number) => {
    return padding + ((maxPnL - pnl) / range) * (height - 2 * padding);
  };

  // Build SVG path
  const linePath = curve
    .map((c, i) => `${i === 0 ? "M" : "L"} ${xScale(c.price)} ${yScale(c.pnl)}`)
    .join(" ");

  // Zero line Y
  const zeroY = yScale(0);

  // Profit area (above zero)
  const profitArea = curve
    .filter((c) => c.pnl >= 0)
    .map((c, i, arr) => `${i === 0 ? "M" : "L"} ${xScale(c.price)} ${yScale(Math.max(0, c.pnl))}`)
    .join(" ");

  // Loss area (below zero)
  const lossArea = curve
    .filter((c) => c.pnl <= 0)
    .map((c, i, arr) => `${i === 0 ? "M" : "L"} ${xScale(c.price)} ${yScale(Math.min(0, c.pnl))}`)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {/* Zero line */}
      <line x1={padding} y1={zeroY} x2={width - padding} y2={zeroY} stroke="hsl(240 3.7% 44.9% / 0.3)" strokeWidth="0.5" strokeDasharray="2,2" />

      {/* Spot price line */}
      <line x1={xScale(spotPrice)} y1={padding} x2={xScale(spotPrice)} y2={height - padding} stroke="hsl(240 3.7% 44.9% / 0.5)" strokeWidth="0.5" strokeDasharray="4,2" />
      <text x={xScale(spotPrice)} y={padding - 2} textAnchor="middle" fontSize="7" fill="hsl(240 3.7% 44.9% / 0.7)">
        Spot
      </text>

      {/* P&L line */}
      <path d={linePath} fill="none" stroke="hsl(220 9% 46%)" strokeWidth="1.5" />

      {/* Current price dot */}
      <circle cx={xScale(spotPrice)} cy={yScale(0)} r="3" fill="hsl(220 9% 46%)" />
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
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground font-bold uppercase">Strategy Legs</span>
              </div>
              <div className="space-y-1">
                {analysis.strategy.legs.map((leg, i) => (
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
                    </div>
                    <span className="text-foreground">₹{leg.premium}</span>
                  </div>
                ))}
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
