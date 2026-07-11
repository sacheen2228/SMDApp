"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { createChart, ColorType, AreaSeries, LineSeries, LineStyle, createSeriesMarkers } from "lightweight-charts";
import type { IChartApi, LineData, SeriesMarker } from "lightweight-charts";

interface OptionSide {
  oi: number; oiChg: number; volume: number; iv: number;
  ltp: number; chg: number; delta: number; theta: number; gamma: number; vega: number;
}

interface OptionData {
  strike: number;
  ce: OptionSide | null;
  pe: OptionSide | null;
}

interface FullAnalysis {
  spotPrice: number; expiryDate: string; atmStrike: number; pcr: number; maxPain: number;
  totalCallOI: number; totalPutOI: number; totalCallVolume: number; totalPutVolume: number;
  sentiment: string;
  spot: { spot: number; atmStrike: number; change: number; changePct: number };
  oiAnalysis: { totalCallOI: number; totalPutOI: number; pcr: number; maxPain: number; sentiment: string };
  gammaWalls: { strike: number; type: string; greeks: number; description?: string }[];
  strikes: { strike: number; callOI: number; putOI: number; callVolume: number; putVolume: number }[];
}

interface LegDef {
  id: string; action: "BUY" | "SELL"; type: "CE" | "PE";
  strike: number; premium: number; delta: number; iv: number; lots: number;
}

interface StrategyBuilderProps {
  spotPrice: number;
  symbol: string;
  chainData: OptionData[];
  analysis: FullAnalysis | null;
}

interface StrategyPreset {
  name: string; view: "bullish" | "bearish" | "neutral" | "volatile";
  description: string; legs: number; icon: string;
}

const STRATEGIES: StrategyPreset[] = [
  { name: "Long Call", view: "bullish", description: "Unlimited upside", legs: 1, icon: "▲" },
  { name: "Long Put", view: "bearish", description: "Unlimited upside", legs: 1, icon: "▼" },
  { name: "Bull Call Spread", view: "bullish", description: "Buy lower CE, sell higher CE", legs: 2, icon: "↗" },
  { name: "Bear Put Spread", view: "bearish", description: "Buy higher PE, sell lower PE", legs: 2, icon: "↘" },
  { name: "Bear Call Spread", view: "bearish", description: "Sell lower CE, buy higher CE", legs: 2, icon: "↓" },
  { name: "Bull Put Spread", view: "bullish", description: "Sell higher PE, buy lower PE", legs: 2, icon: "↑" },
  { name: "Iron Condor", view: "neutral", description: "Sell inner, buy outer", legs: 4, icon: "▬" },
  { name: "Short Straddle", view: "neutral", description: "Sell ATM CE + PE", legs: 2, icon: "⊟" },
  { name: "Long Straddle", view: "volatile", description: "Buy ATM CE + PE", legs: 2, icon: "✦" },
  { name: "Long Strangle", view: "volatile", description: "Buy OTM CE + PE", legs: 2, icon: "◈" },
];

function getLotSize(s: string): number { return s === "NIFTY" ? 65 : s === "BANKNIFTY" ? 30 : s === "FINNIFTY" ? 60 : s === "MIDCPNIFTY" ? 120 : 20; }
function getStrikeStep(s: string): number { return s === "NIFTY" ? 50 : s === "BANKNIFTY" ? 100 : s === "FINNIFTY" ? 50 : s === "MIDCPNIFTY" ? 25 : 20; }

function buildLegs(idx: number, chain: OptionData[], atm: number, step: number, spot: number): LegDef[] {
  const atmRow = chain.find(r => r.strike === atm) || chain.find(r => r.strike >= spot) || chain[Math.floor(chain.length / 2)];
  const o1 = chain.find(r => r.strike >= atm + step);
  const o2 = chain.find(r => r.strike >= atm + 2 * step);
  const o3 = chain.find(r => r.strike >= atm + 3 * step);
  const i1 = [...chain].reverse().find(r => r.strike <= atm - step);
  const i2 = [...chain].reverse().find(r => r.strike <= atm - 2 * step);
  const i3 = [...chain].reverse().find(r => r.strike <= atm - 3 * step);

  const p = (r: OptionData | undefined, t: "CE" | "PE", fb: number) => {
    if (!r) return fb; const s = t === "CE" ? r.ce : r.pe; return s?.ltp ?? fb;
  };
  const d = (r: OptionData | undefined, t: "CE" | "PE", fb: number) => {
    if (!r) return fb; const s = t === "CE" ? r.ce : r.pe; return s?.delta ?? fb;
  };
  const v = (r: OptionData | undefined, t: "CE" | "PE", fb: number) => {
    if (!r) return fb; const s = t === "CE" ? r.ce : r.pe; return s?.iv ?? fb;
  };

  const fb = 50;
  const map: Record<number, () => LegDef[]> = {
    0: () => [{ id: "l1", action: "BUY", type: "CE", strike: atm, premium: p(atmRow, "CE", fb), delta: d(atmRow, "CE", 0.5), iv: v(atmRow, "CE", 15), lots: 1 }],
    1: () => [{ id: "l1", action: "BUY", type: "PE", strike: atm, premium: p(atmRow, "PE", fb), delta: d(atmRow, "PE", -0.5), iv: v(atmRow, "PE", 15), lots: 1 }],
    2: () => [
      { id: "l1", action: "BUY", type: "CE", strike: atm, premium: p(atmRow, "CE", fb), delta: d(atmRow, "CE", 0.5), iv: v(atmRow, "CE", 15), lots: 1 },
      { id: "l2", action: "SELL", type: "CE", strike: (o2 || o1)?.strike || atm + 2 * step, premium: p(o2 || o1, "CE", fb / 2), delta: d(o2 || o1, "CE", 0.3), iv: v(o2 || o1, "CE", 15), lots: 1 },
    ],
    3: () => [
      { id: "l1", action: "BUY", type: "PE", strike: atm, premium: p(atmRow, "PE", fb), delta: d(atmRow, "PE", -0.5), iv: v(atmRow, "PE", 15), lots: 1 },
      { id: "l2", action: "SELL", type: "PE", strike: (i2 || i1)?.strike || atm - 2 * step, premium: p(i2 || i1, "PE", fb / 2), delta: d(i2 || i1, "PE", -0.3), iv: v(i2 || i1, "PE", 15), lots: 1 },
    ],
    4: () => [
      { id: "l1", action: "SELL", type: "CE", strike: atm, premium: p(atmRow, "CE", fb), delta: d(atmRow, "CE", 0.5), iv: v(atmRow, "CE", 15), lots: 1 },
      { id: "l2", action: "BUY", type: "CE", strike: (o2 || o1)?.strike || atm + 2 * step, premium: p(o2 || o1, "CE", fb / 2), delta: d(o2 || o1, "CE", 0.3), iv: v(o2 || o1, "CE", 15), lots: 1 },
    ],
    5: () => [
      { id: "l1", action: "SELL", type: "PE", strike: atm, premium: p(atmRow, "PE", fb), delta: d(atmRow, "PE", -0.5), iv: v(atmRow, "PE", 15), lots: 1 },
      { id: "l2", action: "BUY", type: "PE", strike: (i2 || i1)?.strike || atm - 2 * step, premium: p(i2 || i1, "PE", fb / 2), delta: d(i2 || i1, "PE", -0.3), iv: v(i2 || i1, "PE", 15), lots: 1 },
    ],
    6: () => [
      { id: "l1", action: "BUY", type: "PE", strike: (i3 || i2)?.strike || atm - 3 * step, premium: p(i3 || i2, "PE", 20), delta: d(i3 || i2, "PE", -0.1), iv: v(i3 || i2, "PE", 18), lots: 1 },
      { id: "l2", action: "SELL", type: "PE", strike: i1?.strike || atm - step, premium: p(i1, "PE", 50), delta: d(i1, "PE", -0.3), iv: v(i1, "PE", 15), lots: 1 },
      { id: "l3", action: "SELL", type: "CE", strike: o1?.strike || atm + step, premium: p(o1, "CE", 50), delta: d(o1, "CE", 0.3), iv: v(o1, "CE", 15), lots: 1 },
      { id: "l4", action: "BUY", type: "CE", strike: (o3 || o2)?.strike || atm + 3 * step, premium: p(o3 || o2, "CE", 20), delta: d(o3 || o2, "CE", 0.1), iv: v(o3 || o2, "CE", 18), lots: 1 },
    ],
    7: () => [
      { id: "l1", action: "SELL", type: "CE", strike: atm, premium: p(atmRow, "CE", fb), delta: d(atmRow, "CE", 0.5), iv: v(atmRow, "CE", 15), lots: 1 },
      { id: "l2", action: "SELL", type: "PE", strike: atm, premium: p(atmRow, "PE", fb), delta: d(atmRow, "PE", -0.5), iv: v(atmRow, "PE", 15), lots: 1 },
    ],
    8: () => [
      { id: "l1", action: "BUY", type: "CE", strike: atm, premium: p(atmRow, "CE", fb), delta: d(atmRow, "CE", 0.5), iv: v(atmRow, "CE", 15), lots: 1 },
      { id: "l2", action: "BUY", type: "PE", strike: atm, premium: p(atmRow, "PE", fb), delta: d(atmRow, "PE", -0.5), iv: v(atmRow, "PE", 15), lots: 1 },
    ],
    9: () => [
      { id: "l1", action: "BUY", type: "CE", strike: (o2 || o1)?.strike || atm + 2 * step, premium: p(o2 || o1, "CE", 40), delta: d(o2 || o1, "CE", 0.25), iv: v(o2 || o1, "CE", 16), lots: 1 },
      { id: "l2", action: "BUY", type: "PE", strike: (i2 || i1)?.strike || atm - 2 * step, premium: p(i2 || i1, "PE", 35), delta: d(i2 || i1, "PE", -0.25), iv: v(i2 || i1, "PE", 16), lots: 1 },
    ],
  };
  return (map[idx] || map[0])();
}

function computePayoff(legs: LegDef[], spot: number, lot: number) {
  const range = spot * 0.08;
  const points: { price: number; pnl: number }[] = [];
  for (let i = 0; i <= 100; i++) {
    const price = spot - range + (2 * range * i) / 100;
    let pnl = 0;
    for (const leg of legs) {
      const intrinsic = leg.type === "CE" ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price);
      pnl += leg.action === "BUY"
        ? (intrinsic - leg.premium) * lot * leg.lots
        : (leg.premium - intrinsic) * lot * leg.lots;
    }
    points.push({ price: Math.round(price), pnl: Math.round(pnl) });
  }
  return points;
}

function metric(legs: LegDef[], spot: number, lot: number) {
  const data = computePayoff(legs, spot, lot);
  const maxP = Math.max(...data.map(d => d.pnl));
  const maxL = Math.min(...data.map(d => d.pnl));
  const netCost = legs.reduce((s, l) => s + (l.action === "BUY" ? 1 : -1) * l.premium * lot * l.lots, 0);
  const be: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1].pnl, curr = data[i].pnl;
    if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) {
      const f = Math.abs(prev) / (Math.abs(prev) + Math.abs(curr) || 1);
      be.push(Math.round(data[i - 1].price + f * (data[i].price - data[i - 1].price)));
    }
  }
  const totalDelta = legs.reduce((s, l) => s + (l.action === "BUY" ? l.delta : -l.delta) * lot * l.lots, 0);
  const closest = data.reduce((best, p) => Math.abs(p.price - spot) < Math.abs(best.price - spot) ? p : best, data[0]);
  return { maxProfit: maxP, maxLoss: maxL, breakeven: be, netCost, totalDelta, pnlAtSpot: closest.pnl, rr: maxL < 0 && maxP > 0 ? (maxP / Math.abs(maxL)).toFixed(2) : "∞" };
}

function recommendStrategy(pcr: number, maxPain: number, spot: number, atmIV: number, chain: OptionData[]): { idx: number; reason: string; confidence: number } {
  const ivHigh = atmIV > 20; const ivLow = atmIV < 13;
  const pcrLow = pcr < 0.85; const pcrHigh = pcr > 1.15;
  const near = Math.abs(spot - maxPain) / spot < 0.005;
  const far = Math.abs(spot - maxPain) / spot > 0.01;
  const topCall = [...chain].map(r => r.ce?.oi || 0).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0);
  const topPut = [...chain].map(r => r.pe?.oi || 0).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0);
  const dom = (topCall - topPut) / (topCall + topPut || 1);
  const b = (pcrLow ? 2 : pcrHigh ? -2 : 0) + (far && maxPain < spot ? 1 : 0) + (dom < -0.2 ? 2 : dom > 0.2 ? -1 : 0);
  const be = (pcrHigh ? 2 : pcrLow ? -2 : 0) + (far && maxPain > spot ? 1 : 0) + (dom > 0.2 ? 2 : dom < -0.2 ? -1 : 0);
  const n = (pcr >= 0.85 && pcr <= 1.15 ? 2 : 0) + (near ? 2 : 0) + (ivHigh ? 1 : 0);
  const v = (ivLow ? 2 : ivHigh ? -1 : 0) + (far ? 1 : 0);
  const best = Math.max(b, be, n, v);
  const conf = Math.min(Math.round(best / 5 * 100), 100);
  if (ivHigh && n >= 1) return { idx: 6, reason: `High IV ${atmIV.toFixed(1)}% → Sell premium via Iron Condor`, confidence: conf };
  if (ivHigh && be >= 2) return { idx: 4, reason: `High IV + bearish → Bear Call Spread`, confidence: conf };
  if (ivHigh && b >= 2) return { idx: 5, reason: `High IV + bullish → Bull Put Spread`, confidence: conf };
  if (v >= 3 && ivLow) return { idx: 8, reason: `Low IV ${atmIV.toFixed(1)}% → Buy premium via Long Straddle`, confidence: conf };
  if (b >= 3) return { idx: 2, reason: `Strong bullish PCR ${pcr.toFixed(2)} → Bull Call Spread`, confidence: conf };
  if (be >= 3) return { idx: 3, reason: `Strong bearish PCR ${pcr.toFixed(2)} → Bear Put Spread`, confidence: conf };
  if (b >= 1) return { idx: 0, reason: `Mild bullish → Long Call`, confidence: conf };
  if (be >= 1) return { idx: 1, reason: `Mild bearish → Long Put`, confidence: conf };
  if (n >= 2) return { idx: 7, reason: `Neutral near maxPain → Short Straddle`, confidence: conf };
  return { idx: 6, reason: `Mixed signals → Iron Condor (defined risk)`, confidence: conf };
}

function fmt(n: number): string {
  if (n >= 10000000) return (n / 10000000).toFixed(2) + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(2) + 'L';
  return n.toLocaleString('en-IN');
}

const VIEW = {
  bullish: { border: "border-l-emerald-500", bg: "bg-emerald-500/10", badge: "bg-emerald-600 text-white", label: "BULLISH ▲", text: "text-emerald-400" },
  bearish: { border: "border-l-red-500", bg: "bg-red-500/10", badge: "bg-red-600 text-white", label: "BEARISH ▼", text: "text-red-400" },
  neutral: { border: "border-l-blue-500", bg: "bg-blue-500/10", badge: "bg-blue-600 text-white", label: "NEUTRAL ▬", text: "text-blue-400" },
  volatile: { border: "border-l-amber-500", bg: "bg-amber-500/10", badge: "bg-amber-600 text-white", label: "VOLATILE ⚡", text: "text-amber-400" },
};

export function StrategyBuilder({ spotPrice, symbol, chainData, analysis }: StrategyBuilderProps) {
  const [selected, setSelected] = useState(0);
  const [lots, setLots] = useState(1);
  const [slPrice, setSlPrice] = useState<number | null>(null);
  const [tpPrice, setTpPrice] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const lot = getLotSize(symbol);
  const step = getStrikeStep(symbol);

  const atmStrike = useMemo(() => {
    if (analysis?.atmStrike) return analysis.atmStrike;
    if (chainData.length > 0) return chainData.reduce((best, r) => Math.abs(r.strike - spotPrice) < Math.abs(best - spotPrice) ? r.strike : best, chainData[0].strike);
    return spotPrice;
  }, [analysis, chainData, spotPrice]);

  const pcr = analysis?.pcr ?? 1;
  const maxPain = analysis?.maxPain ?? spotPrice;
  const totalCallOI = analysis?.totalCallOI ?? 0;
  const totalPutOI = analysis?.totalPutOI ?? 0;
  const sentiment = analysis?.sentiment ?? "neutral";
  const expiryDate = analysis?.expiryDate ?? "—";

  const atmRow = useMemo(() => chainData.find(r => r.strike === atmStrike) || chainData.find(r => r.strike >= spotPrice) || chainData[Math.floor(chainData.length / 2)], [chainData, atmStrike, spotPrice]);

  const atmIV = useMemo(() => {
    if (!atmRow) return 15;
    const ceIV = atmRow.ce?.iv ?? 0; const peIV = atmRow.pe?.iv ?? 0;
    if (ceIV && peIV) return (ceIV + peIV) / 2;
    return ceIV || peIV || 15;
  }, [atmRow]);

  const recommendation = useMemo(() => recommendStrategy(pcr, maxPain, spotPrice, atmIV, chainData), [pcr, maxPain, spotPrice, atmIV, chainData]);

  useEffect(() => { if (recommendation.idx !== selected) setSelected(recommendation.idx); }, [recommendation.idx]);

  const legs = useMemo(() => buildLegs(selected, chainData, atmStrike, step, spotPrice), [selected, chainData, atmStrike, step, spotPrice]);
  const payoffs = useMemo(() => computePayoff(legs, spotPrice, lot), [legs, spotPrice, lot]);
  const m = useMemo(() => metric(legs, spotPrice, lot), [legs, spotPrice, lot]);

  const isUncapped = [0, 1, 8, 9].includes(selected);

  const slPnl = useMemo(() => {
    if (slPrice == null) return null;
    const point = payoffs.find(p => p.price === Math.round(slPrice));
    return point?.pnl ?? null;
  }, [payoffs, slPrice]);

  const tpPnl = useMemo(() => {
    if (tpPrice == null) return null;
    const point = payoffs.find(p => p.price === Math.round(tpPrice));
    return point?.pnl ?? null;
  }, [payoffs, tpPrice]);

  const maxCallOIStrike = useMemo(() => {
    if (chainData.length === 0) return null;
    return chainData.reduce((best, r) => (r.ce?.oi || 0) > (best.ce?.oi || 0) ? r : best, chainData[0]);
  }, [chainData]);
  const maxPutOIStrike = useMemo(() => {
    if (chainData.length === 0) return null;
    return chainData.reduce((best, r) => (r.pe?.oi || 0) > (best.pe?.oi || 0) ? r : best, chainData[0]);
  }, [chainData]);

  const scenarios = useMemo(() => {
    return [-3, -2, -1, 0, 1, 2, 3].map(pct => {
      const price = Math.round(spotPrice * (1 + pct / 100));
      const point = payoffs.find(p => p.price === price);
      return { label: `${pct > 0 ? "+" : ""}${pct}%`, pnl: point?.pnl ?? 0 };
    });
  }, [payoffs, spotPrice]);

  useEffect(() => {
    if (!chartRef.current) return;
    if (chartApi.current) { chartApi.current.remove(); chartApi.current = null; }
    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth,
      height: 280,
      layout: { background: { type: ColorType.Solid, color: "#131722" }, textColor: "#9ca3af", fontSize: 13 },
      grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
      rightPriceScale: { borderColor: "#2a2e39", scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: "#2a2e39", visible: false },
    });
    const s = chart.addSeries(AreaSeries, {
      topColor: "rgba(34, 211, 238, 0.35)", bottomColor: "rgba(34, 211, 238, 0.02)",
      lineColor: "#22d3ee", lineWidth: 3, lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: true, crosshairMarkerRadius: 6,
    });
    s.setData(payoffs.map((p, i) => ({ time: i as any, value: p.pnl })) as LineData[]);
    const z = chart.addSeries(LineSeries, {
      color: "#4b5563", lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    z.setData(payoffs.map((p, i) => ({ time: i as any, value: 0 })) as LineData[]);
    const range = spotPrice * 0.08;
    const step = (2 * range) / 100;
    const fi = (price: number) => Math.round((price - (spotPrice - range)) / step);
    const markers: SeriesMarker<number>[] = [];
    for (const be of m.breakeven) {
      const bi = fi(be);
      if (bi >= 0 && bi <= 100) markers.push({ time: bi, position: "inBar", shape: "circle", color: "#22c55e", text: `BE ${be.toLocaleString("en-IN")}`, size: 1 });
    }
    const si = fi(spotPrice);
    if (si >= 0 && si <= 100) markers.push({ time: si, position: "belowBar", shape: "arrowUp", color: "#a78bfa", text: `Spot ${spotPrice.toLocaleString("en-IN")}`, size: 1 });
    if (slPrice != null) {
      const sli = fi(slPrice);
      if (sli >= 0 && sli <= 100) markers.push({ time: sli, position: "belowBar", shape: "arrowDown", color: "#ef4444", text: `SL`, size: 1 });
    }
    if (tpPrice != null) {
      const tpi = fi(tpPrice);
      if (tpi >= 0 && tpi <= 100) markers.push({ time: tpi, position: "aboveBar", shape: "arrowUp", color: "#22c55e", text: `TP`, size: 1 });
    }
    createSeriesMarkers(s, markers as any);
    chart.timeScale().fitContent();
    chartApi.current = chart;
    const ro = new ResizeObserver(e => { if (chartApi.current && e[0]?.contentRect.width) chartApi.current.applyOptions({ width: e[0].contentRect.width }); });
    ro.observe(chartRef.current);
    return () => { ro.disconnect(); chartApi.current?.remove(); chartApi.current = null; };
  }, [payoffs, spotPrice, m.breakeven, slPrice, tpPrice]);

  const strategy = STRATEGIES[selected];
  const vc = VIEW[strategy.view];

  return (
    <div className="space-y-4 p-1">
      {/* Header */}
      <div className="flex items-center justify-between bg-muted/30 rounded-xl px-4 py-3 border border-border">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold tracking-tight">Strategy Builder</span>
          <span className="text-sm text-muted-foreground bg-muted/50 px-3 py-1 rounded-full border border-border">OI · Chain · Greeks</span>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="font-bold text-foreground">{symbol}</span>
          <span className="w-px h-5 bg-border" />
          <span>Lot {lot}</span>
          <span className="w-px h-5 bg-border" />
          <span>Exp {expiryDate.slice(0, 10)}</span>
        </div>
      </div>

      {/* AI Recommendation */}
      <div className={`rounded-xl border ${vc.bg} ${VIEW[strategy.view].border.replace("border-l", "border")} border-l-4 px-4 py-3`}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold uppercase tracking-widest text-muted-foreground">AI Recommendation</span>
            <span className={`text-base font-bold ${recommendation.confidence >= 70 ? "text-emerald-400" : recommendation.confidence >= 40 ? "text-amber-400" : "text-muted-foreground"}`}>
              {recommendation.confidence}% confidence
            </span>
          </div>
          {analysis?.gammaWalls?.length ? (
            <span className="text-sm text-muted-foreground">
              γ-walls: {analysis.gammaWalls.map(g => `${g.strike}(${g.type})`).join(", ")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-3 py-1 rounded-lg text-sm font-bold ${VIEW[strategy.view].badge}`}>
            {STRATEGIES[recommendation.idx].name}
          </span>
          <span className="text-base text-muted-foreground">{recommendation.reason}</span>
        </div>
      </div>

      {/* Market Dashboard */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "SPOT", value: spotPrice.toLocaleString("en-IN"), color: "text-foreground text-2xl" },
          { label: "PCR", value: pcr.toFixed(2), color: `text-xl font-bold ${pcr < 0.85 ? "text-emerald-400" : pcr > 1.15 ? "text-red-400" : "text-amber-400"}` },
          { label: "MAX PAIN", value: maxPain.toLocaleString("en-IN"), color: "text-foreground text-2xl" },
          { label: "ATM IV", value: `${atmIV.toFixed(1)}%`, color: `text-xl font-bold ${atmIV > 20 ? "text-amber-400" : atmIV < 13 ? "text-emerald-400" : "text-blue-400"}` },
        ].map(s => (
          <div key={s.label} className="bg-muted/20 rounded-xl border border-border px-4 py-3">
            <div className="text-sm text-muted-foreground uppercase tracking-wider font-medium">{s.label}</div>
            <div className={s.color}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* OI Walls */}
      {(maxCallOIStrike || maxPutOIStrike) && (
        <div className="grid grid-cols-2 gap-3">
          {maxPutOIStrike && (
            <div className="bg-emerald-500/[0.03] rounded-xl border border-emerald-500/20 px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-sm text-emerald-400 font-bold uppercase tracking-wider">Support</span>
                <span className="text-sm text-muted-foreground">Max Put OI</span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-bold">{maxPutOIStrike.strike.toLocaleString("en-IN")}</span>
                <span className="text-base text-muted-foreground">OI {fmt(maxPutOIStrike.pe?.oi || 0)}</span>
              </div>
            </div>
          )}
          {maxCallOIStrike && (
            <div className="bg-red-500/[0.03] rounded-xl border border-red-500/20 px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-red-400" />
                <span className="text-sm text-red-400 font-bold uppercase tracking-wider">Resistance</span>
                <span className="text-sm text-muted-foreground">Max Call OI</span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-bold">{maxCallOIStrike.strike.toLocaleString("en-IN")}</span>
                <span className="text-base text-muted-foreground">OI {fmt(maxCallOIStrike.ce?.oi || 0)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Strategy Grid */}
      <div className="grid grid-cols-5 gap-2">
        {STRATEGIES.map((s, i) => {
          const vb = VIEW[s.view];
          return (
            <button
              key={s.name}
              onClick={() => setSelected(i)}
              className={`border-l-4 rounded-xl bg-muted/20 border-y border-r text-left transition-all hover:bg-muted/40 ${
                selected === i ? `ring-2 ring-${s.view === "bullish" ? "emerald" : s.view === "bearish" ? "red" : s.view === "neutral" ? "blue" : "amber"}-500/40 shadow-lg` : "border-border"
              } ${vb.border}`}
            >
              <div className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{s.icon}</span>
                  <span className={`text-sm font-bold ${selected === i ? "text-foreground" : "text-muted-foreground"}`}>{s.name}</span>
                </div>
                <div className={`text-xs mt-1 ${selected === i ? "text-muted-foreground" : "text-muted-foreground/60"}`}>{s.legs}L · {s.description}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Legs + Metrics */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 bg-muted/20 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <span className="text-base font-bold text-muted-foreground uppercase tracking-wider">Trade Legs</span>
              <span className="text-sm text-muted-foreground bg-muted/50 px-2.5 py-1 rounded-full">Live LTP from chain</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-base text-muted-foreground font-medium">Lots</span>
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg border border-border">
                <button onClick={() => setLots(Math.max(1, lots - 1))} className="px-3 py-1.5 text-lg hover:bg-muted transition-colors">−</button>
                <span className="text-lg font-mono w-8 text-center font-bold">{lots}</span>
                <button onClick={() => setLots(Math.min(20, lots + 1))} className="px-3 py-1.5 text-lg hover:bg-muted transition-colors">+</button>
              </div>
              <span className="text-sm text-muted-foreground">Qty: {(lot * lots).toLocaleString("en-IN")}</span>
            </div>
          </div>
          <div className="space-y-2">
            {legs.map(leg => {
              const isBuy = leg.action === "BUY";
              const distPct = ((leg.strike - spotPrice) / spotPrice * 100);
              return (
                <div key={leg.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm border ${
                  isBuy ? "bg-emerald-500/[0.03] border-emerald-500/20" : "bg-red-500/[0.03] border-red-500/20"
                }`}>
                  <div className={`px-2.5 py-1 rounded-lg text-sm font-black ${isBuy ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>
                    {leg.action}
                  </div>
                  <span className="text-lg font-black">{leg.type}</span>
                  <span className="text-lg font-mono font-black">{leg.strike.toLocaleString("en-IN")}</span>
                  <span className={`text-sm font-bold ${distPct > 0 ? "text-red-400" : "text-emerald-400"}`}>
                    ({distPct > 0 ? "+" : ""}{distPct.toFixed(1)}%)
                  </span>
                  <div className="w-px h-6 bg-border" />
                  <span className="text-muted-foreground">₹</span>
                  <span className="text-lg font-bold">{leg.premium}</span>
                  <div className="w-px h-6 bg-border" />
                  <span className="text-muted-foreground">Δ</span>
                  <span className={`text-base font-bold ${Math.abs(leg.delta) > 0.4 ? "text-foreground" : "text-muted-foreground"}`}>
                    {leg.delta.toFixed(2)}
                  </span>
                  <span className="text-muted-foreground">IV</span>
                  <span className="text-base font-bold text-muted-foreground">{leg.iv.toFixed(1)}%</span>
                  <span className="ml-auto text-lg font-black">
                    ₹{fmt(leg.premium * lot * lots)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-muted/20 rounded-xl border border-border p-4 space-y-2">
          <div className="text-base font-bold text-muted-foreground uppercase tracking-wider mb-2">Key Metrics</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-emerald-500/[0.04] border border-emerald-500/15 rounded-xl p-3 text-center">
              <div className="text-sm text-muted-foreground uppercase font-medium">{isUncapped ? "Max (theoretical)" : "Max (at +8%)"}</div>
              <div className="text-xl font-black text-emerald-400">{isUncapped ? "∞" : m.maxProfit > 0 ? `₹${fmt(m.maxProfit)}` : "∞"}</div>
            </div>
            <div className="bg-red-500/[0.04] border border-red-500/15 rounded-xl p-3 text-center">
              <div className="text-sm text-muted-foreground uppercase font-medium">Max Loss</div>
              <div className="text-xl font-black text-red-400">{m.maxLoss < 0 ? `₹${fmt(Math.abs(m.maxLoss))}` : "₹0"}</div>
            </div>
            <div className="bg-blue-500/[0.04] border border-blue-500/15 rounded-xl p-3 text-center">
              <div className="text-sm text-muted-foreground uppercase font-medium">Breakeven</div>
              <div className="text-lg font-black text-blue-400">{m.breakeven.length > 0 ? m.breakeven.map(b => b.toLocaleString("en-IN")).join(", ") : "—"}</div>
            </div>
            <div className="bg-purple-500/[0.04] border border-purple-500/15 rounded-xl p-3 text-center">
              <div className="text-sm text-muted-foreground uppercase font-medium">Net Cost</div>
              <div className="text-xl font-black text-purple-400">₹{fmt(Math.abs(m.netCost))}</div>
              <div className="text-xs text-purple-400/60 mt-0.5">{m.netCost > 0 ? "Debit" : "Credit"}</div>
            </div>
            <div className="bg-cyan-500/[0.04] border border-cyan-500/15 rounded-xl p-3 text-center">
              <div className="text-sm text-muted-foreground uppercase font-medium">Net Delta</div>
              <div className={`text-xl font-black ${m.totalDelta > 0.3 ? "text-emerald-400" : m.totalDelta < -0.3 ? "text-red-400" : "text-cyan-400"}`}>{m.totalDelta.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{m.totalDelta > 0.3 ? "Bullish" : m.totalDelta < -0.3 ? "Bearish" : "Neutral"}</div>
            </div>
            <div className="bg-orange-500/[0.04] border border-orange-500/15 rounded-xl p-3 text-center">
              <div className="text-sm text-muted-foreground uppercase font-medium">R:R</div>
              <div className={`text-xl font-black ${parseFloat(m.rr as string) >= 2 ? "text-emerald-400" : parseFloat(m.rr as string) >= 1 ? "text-amber-400" : "text-red-400"}`}>{m.rr}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Risk:Reward</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border mt-2">
            <div className="bg-red-500/[0.04] border border-red-500/15 rounded-xl p-2.5 text-center">
              <div className="flex items-center justify-center gap-1.5 mb-1">
                <span className="text-sm text-muted-foreground uppercase font-medium">Stop Loss</span>
                <span className="text-[10px] text-muted-foreground/50">(price)</span>
              </div>
              <input
                type="number"
                placeholder="—"
                value={slPrice ?? ""}
                onChange={e => setSlPrice(e.target.value ? Number(e.target.value) : null)}
                className="w-full bg-transparent text-center text-lg font-black text-red-400 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              {slPnl != null && (
                <div className={`text-xs font-bold mt-1 ${slPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {slPnl >= 0 ? "+" : ""}₹{fmt(slPnl)}
                </div>
              )}
            </div>
            <div className="bg-emerald-500/[0.04] border border-emerald-500/15 rounded-xl p-2.5 text-center">
              <div className="flex items-center justify-center gap-1.5 mb-1">
                <span className="text-sm text-muted-foreground uppercase font-medium">Target</span>
                <span className="text-[10px] text-muted-foreground/50">(price)</span>
              </div>
              <input
                type="number"
                placeholder="—"
                value={tpPrice ?? ""}
                onChange={e => setTpPrice(e.target.value ? Number(e.target.value) : null)}
                className="w-full bg-transparent text-center text-lg font-black text-emerald-400 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              {tpPnl != null && (
                <div className={`text-xs font-bold mt-1 ${tpPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {tpPnl >= 0 ? "+" : ""}₹{fmt(tpPnl)}
                </div>
              )}
            </div>
          </div>
          <div className="text-center pt-2 border-t border-border mt-2">
            <span className="text-base text-muted-foreground">P&L at current spot: </span>
            <span className={`text-xl font-black ${m.pnlAtSpot >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {m.pnlAtSpot >= 0 ? "+" : ""}₹{fmt(m.pnlAtSpot)}
            </span>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-[#131722] rounded-xl border border-[#2a2e39] overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">P&L at expiry · {legs.length} legs · {symbol}</span>
            <span className="text-sm text-muted-foreground">Lot {lot} × {lots} = {(lot * lots).toLocaleString("en-IN")} qty</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-0.5 bg-emerald-400/60 inline-block" />
            <span className="text-xs text-emerald-400/60">Profit</span>
            <span className="w-3 h-0.5 bg-red-400/60 inline-block ml-1" />
            <span className="text-xs text-red-400/60">Loss</span>
          </div>
        </div>
        <div ref={chartRef} className="w-full" />
        <div className="flex gap-2 justify-center pb-3 pt-1">
          {scenarios.map(sc => (
            <div
              key={sc.label}
              className={`px-3 py-1 rounded-lg text-sm font-mono font-bold border ${
                sc.pnl >= 0 ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300" : "bg-red-500/15 border-red-500/30 text-red-300"
              }`}
            >
              {sc.label} {sc.pnl >= 0 ? "+" : ""}₹{fmt(sc.pnl)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
