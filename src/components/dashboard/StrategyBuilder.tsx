"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { createChart, ColorType, LineSeries } from "lightweight-charts";
import type { IChartApi } from "lightweight-charts";

interface StrategyBuilderProps {
  spotPrice: number;
  symbol: string;
}

interface LegDef {
  id: string;
  action: "BUY" | "SELL";
  type: "CE" | "PE";
  strikeOffset: number;
  premium: number;
  lots: number;
}

interface StrategyPreset {
  name: string;
  emoji: string;
  view: "bullish" | "bearish" | "neutral" | "volatile";
  description: string;
  whenToUse: string;
  build: (atm: number) => LegDef[];
}

const STRATEGIES: StrategyPreset[] = [
  {
    name: "Buy Call",
    emoji: "📈",
    view: "bullish",
    description: "Bet market will go UP",
    whenToUse: "When you're confident NIFTY will rise",
    build: (atm) => [
      { id: "lc1", action: "BUY", type: "CE", strikeOffset: 0, premium: 100, lots: 1 },
    ],
  },
  {
    name: "Buy Put",
    emoji: "📉",
    view: "bearish",
    description: "Bet market will go DOWN",
    whenToUse: "When you're confident NIFTY will fall",
    build: (atm) => [
      { id: "lp1", action: "BUY", type: "PE", strikeOffset: 0, premium: 100, lots: 1 },
    ],
  },
  {
    name: "Bull Spread",
    emoji: "🐂",
    view: "bullish",
    description: "Buy cheap call + sell expensive call = lower cost",
    whenToUse: "Market going up but want to reduce risk",
    build: (atm) => [
      { id: "bcs1", action: "BUY", type: "CE", strikeOffset: 0, premium: 120, lots: 1 },
      { id: "bcs2", action: "SELL", type: "CE", strikeOffset: 100, premium: 60, lots: 1 },
    ],
  },
  {
    name: "Bear Spread",
    emoji: "🐻",
    view: "bearish",
    description: "Buy cheap put + sell expensive put = lower cost",
    whenToUse: "Market going down but want to reduce risk",
    build: (atm) => [
      { id: "bps1", action: "BUY", type: "PE", strikeOffset: 0, premium: 110, lots: 1 },
      { id: "bps2", action: "SELL", type: "PE", strikeOffset: -100, premium: 55, lots: 1 },
    ],
  },
  {
    name: "Iron Condor",
    emoji: "🦅",
    view: "neutral",
    description: "Market won't move much = collect premium",
    whenToUse: "Market is calm, no big events expected",
    build: (atm) => [
      { id: "ic1", action: "BUY", type: "PE", strikeOffset: -300, premium: 20, lots: 1 },
      { id: "ic2", action: "SELL", type: "PE", strikeOffset: -100, premium: 55, lots: 1 },
      { id: "ic3", action: "SELL", type: "CE", strikeOffset: 100, premium: 60, lots: 1 },
      { id: "ic4", action: "BUY", type: "CE", strikeOffset: 300, premium: 22, lots: 1 },
    ],
  },
  {
    name: "Straddle",
    emoji: "🎰",
    view: "volatile",
    description: "Buy BOTH call + put = big move in any direction",
    whenToUse: "Expecting big move but don't know direction (budget, results)",
    build: (atm) => [
      { id: "sd1", action: "BUY", type: "CE", strikeOffset: 0, premium: 100, lots: 1 },
      { id: "sd2", action: "BUY", type: "PE", strikeOffset: 0, premium: 95, lots: 1 },
    ],
  },
  {
    name: "Strangle",
    emoji: "🔀",
    view: "volatile",
    description: "Buy OTM call + OTM put = cheaper straddle",
    whenToUse: "Expecting big move but want to pay less",
    build: (atm) => [
      { id: "sg1", action: "BUY", type: "CE", strikeOffset: 100, premium: 60, lots: 1 },
      { id: "sg2", action: "BUY", type: "PE", strikeOffset: -100, premium: 55, lots: 1 },
    ],
  },
  {
    name: "Butterfly",
    emoji: "🦋",
    view: "neutral",
    description: "Market stays at ONE price = max profit",
    whenToUse: "Very confident market won't move at all",
    build: (atm) => [
      { id: "bf1", action: "BUY", type: "CE", strikeOffset: -100, premium: 130, lots: 1 },
      { id: "bf2", action: "SELL", type: "CE", strikeOffset: 0, premium: 100, lots: 2 },
      { id: "bf3", action: "BUY", type: "CE", strikeOffset: 100, premium: 65, lots: 1 },
    ],
  },
];

function getLotSize(symbol: string): number {
  if (symbol === "NIFTY") return 65;
  if (symbol === "BANKNIFTY") return 30;
  if (symbol === "FINNIFTY") return 60;
  if (symbol === "MIDCPNIFTY") return 120;
  return 20;
}

function getStrikeStep(symbol: string): number {
  if (symbol === "NIFTY") return 50;
  if (symbol === "BANKNIFTY") return 100;
  if (symbol === "FINNIFTY") return 50;
  if (symbol === "MIDCPNIFTY") return 25;
  return 20;
}

function computePayoff(legs: LegDef[], spot: number, step: number, lot: number) {
  const range = spot * 0.08;
  const points: { price: number; pnl: number }[] = [];

  // Calculate total premium cost (paid) / credit (received)
  let totalPremium = 0;
  for (const leg of legs) {
    const premiumCost = leg.premium * lot * leg.lots;
    totalPremium += leg.action === "BUY" ? -premiumCost : premiumCost;
  }

  for (let i = 0; i <= 100; i++) {
    const price = spot - range + (2 * range * i) / 100;
    let intrinsicPnl = 0;
    for (const leg of legs) {
      const strike = spot + leg.strikeOffset * step;
      const intrinsic = leg.type === "CE" ? Math.max(0, price - strike) : Math.max(0, strike - price);
      // BUY: profit = intrinsic - premium paid; SELL: profit = premium received - intrinsic
      const legPnl = leg.action === "BUY"
        ? (intrinsic - leg.premium) * lot * leg.lots
        : (leg.premium - intrinsic) * lot * leg.lots;
      intrinsicPnl += legPnl;
    }
    points.push({ price: Math.round(price), pnl: Math.round(intrinsicPnl) });
  }
  return points;
}

function metric(legs: LegDef[], spot: number, step: number, lot: number) {
  const data = computePayoff(legs, spot, step, lot);
  const maxProfit = Math.max(...data.map((d) => d.pnl));
  const maxLoss = Math.min(...data.map((d) => d.pnl));

  // Net cost: positive = debit (you pay), negative = credit (you receive)
  const netCost = legs.reduce((sum, l) => {
    const premiumTotal = l.premium * lot * l.lots;
    return sum + (l.action === "BUY" ? premiumTotal : -premiumTotal);
  }, 0);

  // Breakeven: linear interpolation where P&L crosses zero
  const be: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1].pnl;
    const curr = data[i].pnl;
    if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) {
      const fraction = Math.abs(prev) / (Math.abs(prev) + Math.abs(curr) || 1);
      const bePrice = data[i - 1].price + fraction * (data[i].price - data[i - 1].price);
      be.push(Math.round(bePrice));
    }
  }

  // Stop Loss: exit when loss reaches 50% of max loss (premium-based)
  const stopLossPct = 0.5;
  const stopLossAmount = Math.abs(maxLoss) * stopLossPct;
  // Find stop loss price on the chart (where P&L = -stopLossAmount for BUY, or +stopLossAmount for SELL)
  let stopLossPrice = spot;
  const isCredit = netCost < 0;
  const targetPnl = isCredit ? -stopLossAmount : stopLossAmount;
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1].pnl;
    const curr = data[i].pnl;
    if ((prev <= targetPnl && curr > targetPnl) || (prev >= targetPnl && curr < targetPnl)) {
      const fraction = Math.abs(prev - targetPnl) / (Math.abs(prev - targetPnl) + Math.abs(curr - targetPnl) || 1);
      stopLossPrice = Math.round(data[i - 1].price + fraction * (data[i].price - data[i - 1].price));
      break;
    }
  }

  return { maxProfit, maxLoss, breakeven: be, netCost, stopLossPrice, stopLossAmount: Math.round(stopLossAmount) };
}

export function StrategyBuilder({ spotPrice, symbol }: StrategyBuilderProps) {
  const [selected, setSelected] = useState(0);
  const [editingPremiums, setEditingPremiums] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const lot = getLotSize(symbol);
  const step = getStrikeStep(symbol);
  const preset = STRATEGIES[selected];
  const legs = useMemo(() => preset.build(spotPrice), [selected, spotPrice]);
  const payoffs = useMemo(() => computePayoff(legs, spotPrice, step, lot), [legs, spotPrice, step, lot]);
  const m = useMemo(() => metric(legs, spotPrice, step, lot), [legs, spotPrice, step, lot]);

  useEffect(() => {
    if (!chartRef.current) return;
    if (chartApi.current) { chartApi.current.remove(); chartApi.current = null; }
    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth,
      height: 200,
      layout: { background: { type: ColorType.Solid, color: "#131722" }, textColor: "#d1d4dc", fontSize: 10 },
      grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
      rightPriceScale: { borderColor: "#2a2e39" },
      timeScale: { borderColor: "#2a2e39", visible: false },
    });
    const s = chart.addSeries(LineSeries, {
      color: "#22d3ee",
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    s.setData(payoffs.map((p, i) => ({ time: i as any, value: p.pnl })));
    chart.timeScale().fitContent();
    chartApi.current = chart;
    const ro = new ResizeObserver((e) => { if (chartApi.current && e[0]?.contentRect.width) chartApi.current.applyOptions({ width: e[0].contentRect.width }); });
    ro.observe(chartRef.current);
    return () => { ro.disconnect(); chartApi.current?.remove(); chartApi.current = null; };
  }, [payoffs]);

  const viewColor = { bullish: "emerald", bearish: "red", neutral: "blue", volatile: "amber" }[preset.view];
  const viewLabel = { bullish: "BULLISH", bearish: "BEARISH", neutral: "NEUTRAL", volatile: "VOLATILE" }[preset.view];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="font-mono font-bold text-sm">Strategy Builder</span>
        <span className="text-[10px] text-muted-foreground">Pick a strategy → see payoff → take trade</span>
      </div>

      {/* Strategy Cards */}
      <div className="grid grid-cols-4 gap-2">
        {STRATEGIES.map((s, i) => (
          <button
            key={s.name}
            onClick={() => setSelected(i)}
            className={`p-3 rounded-lg border text-left transition-all ${
              selected === i
                ? "bg-primary/10 border-primary/50 ring-1 ring-primary/30"
                : "bg-muted/30 border-border hover:border-primary/30"
            }`}
          >
            <div className="text-lg mb-1">{s.emoji}</div>
            <div className="text-[11px] font-bold">{s.name}</div>
            <div className="text-[9px] text-muted-foreground mt-0.5">{s.description}</div>
          </button>
        ))}
      </div>

      {/* Selected Strategy Detail */}
      <div className="bg-muted/30 rounded-lg p-4 border">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">{preset.emoji}</span>
              <span className="font-bold text-lg">{preset.name}</span>
              <span className={`px-2 py-0.5 rounded text-[9px] font-bold bg-${viewColor}-500/20 text-${viewColor}-400`}>
                {viewLabel}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              When to use: <span className="text-foreground">{preset.whenToUse}</span>
            </div>
          </div>
          <div className="text-right text-[10px] text-muted-foreground">
            Lot size: {lot} | Step: {step}
          </div>
        </div>

        {/* Legs */}
        <div className="space-y-2 mb-4">
          <div className="text-[10px] text-muted-foreground font-bold">YOUR TRADE</div>
          {legs.map((leg) => {
            const strike = spotPrice + leg.strikeOffset * step;
            const isBuy = leg.action === "BUY";
            return (
              <div key={leg.id} className={`flex items-center gap-3 p-2 rounded ${isBuy ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
                <span className={`px-2 py-1 rounded text-[10px] font-bold ${isBuy ? "bg-emerald-500 text-white" : "bg-red-500 text-white"}`}>
                  {leg.action}
                </span>
                <span className="font-bold text-sm">{leg.type}</span>
                <span className="text-muted-foreground">Strike:</span>
                <span className="font-mono font-bold">{strike.toLocaleString("en-IN")}</span>
                <span className="text-muted-foreground">Premium:</span>
                <span className="font-mono">₹{leg.premium}</span>
                <span className="text-muted-foreground">× {leg.lots} lot</span>
                <span className="ml-auto font-mono font-bold">
                  ₹{(leg.premium * lot * leg.lots).toLocaleString("en-IN")}
                </span>
              </div>
            );
          })}
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-5 gap-3 mb-4">
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded p-2 text-center">
            <div className="text-[9px] text-muted-foreground">MAX PROFIT</div>
            <div className="text-sm font-bold text-emerald-400">
              {m.maxProfit > 0 ? `₹${m.maxProfit.toLocaleString("en-IN")}` : "Unlimited"}
            </div>
          </div>
          <div className="bg-red-500/10 border border-red-500/20 rounded p-2 text-center">
            <div className="text-[9px] text-muted-foreground">MAX LOSS</div>
            <div className="text-sm font-bold text-red-400">
              {m.maxLoss < 0 ? `₹${Math.abs(m.maxLoss).toLocaleString("en-IN")}` : "₹0"}
            </div>
          </div>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded p-2 text-center">
            <div className="text-[9px] text-muted-foreground">STOP LOSS</div>
            <div className="text-sm font-bold text-amber-400">
              {m.stopLossPrice.toLocaleString("en-IN")}
            </div>
            <div className="text-[8px] text-amber-400/70">Exit if spot hits this</div>
          </div>
          <div className="bg-blue-500/10 border border-blue-500/20 rounded p-2 text-center">
            <div className="text-[9px] text-muted-foreground">BREAKEVEN</div>
            <div className="text-sm font-bold text-blue-400">
              {m.breakeven.length > 0 ? m.breakeven.map((b) => b.toLocaleString("en-IN")).join(", ") : "—"}
            </div>
          </div>
          <div className="bg-purple-500/10 border border-purple-500/20 rounded p-2 text-center">
            <div className="text-[9px] text-muted-foreground">NET COST</div>
            <div className="text-sm font-bold text-purple-400">
              ₹{Math.abs(m.netCost).toLocaleString("en-IN")}
            </div>
            <div className="text-[8px] text-purple-400/70">{m.netCost > 0 ? "Debit" : "Credit"}</div>
          </div>
        </div>

        {/* Payoff Chart */}
        <div className="bg-[#131722] rounded-lg p-3 border border-[#2a2e39]">
          <div className="text-[10px] text-muted-foreground mb-2">
            Green = Profit zone | Red = Loss zone | Dotted line = Breakeven
          </div>
          <div ref={chartRef} className="w-full" />
        </div>

        {/* Action */}
        <div className="flex gap-3 mt-4">
          <button className="flex-1 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm transition-colors">
            Place Order →
          </button>
          <button className="px-6 py-3 rounded-lg bg-muted hover:bg-muted/80 text-sm transition-colors">
            Save Strategy
          </button>
        </div>
      </div>
    </div>
  );
}
