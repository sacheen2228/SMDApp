// Gap Analysis Tab - Indian F&O Market Dashboard

"use client";

import { useMemo, memo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Target,
  Shield,
  BarChart3,
  Activity,
  Zap,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
  Clock,
  Layers,
} from "lucide-react";

interface GapAnalysisProps {
  analysis: any;
  summary?: any;
  spotPrice: number;
  symbol: string;
  expiryDate: string;
  chainData?: any[];
}

// ─── Helpers ──────────────────────────────────────────────────────
function fmt(n: number): string {
  if (Math.abs(n) >= 100000) return (n / 1000).toFixed(1) + "K";
  return n.toFixed(0);
}

function fmtFull(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

// ─── Pivot Points ─────────────────────────────────────────────────
function computePivots(spot: number) {
  const range = spot * 0.012;
  return {
    r3: spot + range * 3,
    r2: spot + range * 2,
    r1: spot + range,
    pivot: spot,
    s1: spot - range,
    s2: spot - range * 2,
    s3: spot - range * 3,
  };
}

// ─── Gap Prediction Engine ────────────────────────────────────────
function predictGap(analysis: any, spot: number, pcr: number, vix: number) {
  let upScore = 50;
  const factors: { factor: string; impact: "bullish" | "bearish" | "neutral"; pts: number }[] = [];

  if (pcr > 1.2) { upScore += 12; factors.push({ factor: `PCR ${pcr.toFixed(2)} — bullish`, impact: "bullish", pts: 12 }); }
  else if (pcr < 0.8) { upScore -= 12; factors.push({ factor: `PCR ${pcr.toFixed(2)} — bearish`, impact: "bearish", pts: -12 }); }
  else { factors.push({ factor: `PCR ${pcr.toFixed(2)} — neutral`, impact: "neutral", pts: 0 }); }

  if (vix > 18) { upScore += 3; factors.push({ factor: `VIX ${vix.toFixed(1)} — elevated vol`, impact: "neutral", pts: 3 }); }
  else if (vix < 12) { upScore -= 2; factors.push({ factor: `VIX ${vix.toFixed(1)} — low vol`, impact: "neutral", pts: -2 }); }

  const rec = analysis?.recommendation;
  if (rec?.oibuildup === "long-buildup") { upScore += 10; factors.push({ factor: "OI buildup bullish", impact: "bullish", pts: 10 }); }
  else if (rec?.oibuildup === "short-buildup") { upScore -= 10; factors.push({ factor: "OI buildup bearish", impact: "bearish", pts: -10 }); }

  const maxPain = analysis?.maxPain || spot;
  if (spot < maxPain) { upScore += 5; factors.push({ factor: "Spot below Max Pain — pull up likely", impact: "bullish", pts: 5 }); }
  else if (spot > maxPain) { upScore -= 5; factors.push({ factor: "Spot above Max Pain — pull down likely", impact: "bearish", pts: -5 }); }

  if (analysis?.sentiment === "bullish") { upScore += 8; factors.push({ factor: "Overall sentiment bullish", impact: "bullish", pts: 8 }); }
  else if (analysis?.sentiment === "bearish") { upScore -= 8; factors.push({ factor: "Overall sentiment bearish", impact: "bearish", pts: -8 }); }

  upScore = Math.max(10, Math.min(90, upScore));
  const downScore = Math.max(5, Math.min(80, 100 - upScore - 10));
  const flatScore = Math.max(5, 100 - upScore - downScore);

  const avgGapUp = Math.round(20 + vix * 2.5);
  const avgGapDown = Math.round(15 + vix * 2);

  return { upScore, downScore, flatScore, factors, avgGapUp, avgGapDown };
}

// ─── Gap Trading Setups ───────────────────────────────────────────
function computeSetups(spot: number, maxPain: number, vix: number) {
  const atm = Math.round(spot / 50) * 50;

  return [
    {
      name: "Gap Up > 50 pts",
      color: "emerald" as const,
      action: `Buy ${atm} PE`,
      entry: `~₹${Math.round(vix * 0.5 + 40)}`,
      sl: `${atm + 50}`,
      target: `${atm - 50}`,
      rr: "1:2",
      note: "Fade the gap at resistance",
    },
    {
      name: "Gap Up 20-50 pts",
      color: "yellow" as const,
      action: `Wait for confirmation`,
      entry: "—",
      sl: "—",
      target: "—",
      rr: "—",
      note: "Watch for 15-min candle close",
    },
    {
      name: "Gap Down > 50 pts",
      color: "red" as const,
      action: `Buy ${atm} CE`,
      entry: `~₹${Math.round(vix * 0.5 + 35)}`,
      sl: `${atm - 50}`,
      target: `${atm + 50}`,
      rr: "1:2",
      note: "Buy the dip at support",
    },
    {
      name: "Gap Down 20-50 pts",
      color: "orange" as const,
      action: `Wait for confirmation`,
      entry: "—",
      sl: "—",
      target: "—",
      rr: "—",
      note: "Watch for 15-min candle close",
    },
  ];
}

// ─── OI Heatmap Data ──────────────────────────────────────────────
function buildHeatmapData(chainData: any[], spot: number) {
  if (!chainData?.length) return [];
  const atm = Math.round(spot / 50) * 50;
  return chainData
    .filter((s) => Math.abs(s.strike - atm) <= 250)
    .map((s) => ({
      strike: s.strike,
      ceOiChg: s.ce?.oiChg ?? 0,
      peOiChg: s.pe?.oiChg ?? 0,
      net: (s.pe?.oiChg ?? 0) - (s.ce?.oiChg ?? 0),
      isATM: s.strike === atm,
    }));
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════
export const GapAnalysis = memo(function GapAnalysis({
  analysis,
  summary,
  spotPrice,
  symbol,
  expiryDate,
  chainData,
}: GapAnalysisProps) {
  // Use summary as primary source (available immediately), analysis as enrichment
  const pcr = analysis?.pcr ?? summary?.pcr ?? 0;
  const vix = analysis?.greeks?.vix ?? summary?.indiaVIX ?? 15;
  const maxPain = analysis?.maxPain ?? summary?.maxPain ?? spotPrice;
  const ceOI = analysis?.totalCallOI ?? summary?.totalCallOI ?? 0;
  const peOI = analysis?.totalPutOI ?? summary?.totalPutOI ?? 0;

  const pivots = useMemo(() => computePivots(spotPrice), [spotPrice]);
  const gap = useMemo(() => predictGap(analysis, spotPrice, pcr, vix), [analysis, spotPrice, pcr, vix]);
  const setups = useMemo(() => computeSetups(spotPrice, maxPain, vix), [spotPrice, maxPain, vix]);
  const heatmap = useMemo(() => buildHeatmapData(chainData, spotPrice), [chainData, spotPrice]);
  const rec = analysis?.recommendation;

  const oiTotal = ceOI + peOI || 1;
  const cePct = ceOI / oiTotal;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        {/* ═══════ HEADER ═══════ */}
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center shadow-lg shadow-purple-500/25">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-2xl font-black tracking-tight">GAP ANALYSIS</h1>
          </div>
          <p className="text-xs text-muted-foreground">Next-Day Gap Prediction & Trading Setups</p>
        </div>

        {/* ═══════ TOP METRICS BAR ═══════ */}
        <div className="grid grid-cols-6 gap-2">
          <MetricPill label="Spot" value={fmtFull(spotPrice)} />
          <MetricPill label="PCR" value={pcr.toFixed(2)} color={pcr > 1.2 ? "text-emerald-500" : pcr < 0.8 ? "text-red-500" : ""} />
          <MetricPill label="VIX" value={vix.toFixed(1)} />
          <MetricPill label="Max Pain" value={fmtFull(maxPain)} color="text-amber-500" />
          <MetricPill label="CE OI" value={`${(ceOI / 100000).toFixed(1)}L`} color="text-red-500" />
          <MetricPill label="PE OI" value={`${(peOI / 100000).toFixed(1)}L`} color="text-emerald-500" />
        </div>

        {/* ═══════ 3-COLUMN LAYOUT ═══════ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ─── LEFT: Market Snapshot ─── */}
          <div className="space-y-4">
            {/* ATM Straddle */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Layers className="w-3.5 h-3.5 text-violet-500" />} text="ATM Straddle" />
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-black tabular-nums">{fmtFull(rec?.strike ?? Math.round(spotPrice / 50) * 50)}</span>
                  <span className="text-sm text-muted-foreground">Strike</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">Entry Premium</p>
                    <p className="font-bold">{rec?.entryPrice ? `₹${rec.entryPrice.toFixed(1)}` : "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">IV Level</p>
                    <p className="font-bold">{vix.toFixed(1)}%</p>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {vix > 20 ? "IV elevated — premium selling favorable" : vix < 12 ? "IV low — options cheap, buying favorable" : "IV in normal range"}
                </p>
              </CardContent>
            </Card>

            {/* Max Pain */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Target className="w-3.5 h-3.5 text-amber-500" />} text="Max Pain" />
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-black tabular-nums text-amber-500">{fmtFull(maxPain)}</span>
                  <span className={`text-xs font-medium ${spotPrice > maxPain ? "text-emerald-500" : "text-red-500"}`}>
                    {spotPrice > maxPain ? "+" : ""}{((spotPrice - maxPain) / maxPain * 100).toFixed(2)}% from spot
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground">Market gravitates toward Max Pain near expiry</p>
              </CardContent>
            </Card>

            {/* Key Levels */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-1.5">
                <CardTitle icon={<BarChart3 className="w-3.5 h-3.5 text-blue-500" />} text="Key Levels (Pivot)" />
                {(["r3", "r2", "r1", "pivot", "s1", "s2", "s3"] as const).map((level) => {
                  const val = pivots[level];
                  const isRes = level.startsWith("r");
                  const isPivot = level === "pivot";
                  const dist = ((val - spotPrice) / spotPrice * 100);
                  return (
                    <div key={level} className={`flex items-center justify-between text-xs ${isPivot ? "border-t border-border pt-1 font-bold" : ""}`}>
                      <span className={`w-12 ${isRes ? "text-emerald-500" : isPivot ? "text-primary" : "text-red-500"}`}>
                        {level.toUpperCase()}
                      </span>
                      <span className="tabular-nums font-mono">{fmtFull(val)}</span>
                      <span className={`w-16 text-right text-[10px] ${dist > 0 ? "text-emerald-500" : dist < 0 ? "text-red-500" : ""}`}>
                        {dist > 0 ? "+" : ""}{dist.toFixed(2)}%
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Market Mood */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Activity className="w-3.5 h-3.5 text-rose-500" />} text="Market Mood" />
                <MoodGauge pcr={pcr} vix={vix} />
              </CardContent>
            </Card>
          </div>

          {/* ─── CENTER: Gap Prediction ─── */}
          <div className="space-y-4">
            {/* Gap Prediction */}
            <Card className="border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-violet-500/5">
              <CardContent className="p-4 space-y-3">
                <CardTitle icon={<Zap className="w-3.5 h-3.5 text-purple-500" />} text="Tomorrow Gap Prediction" />
                <div className="text-center">
                  <Badge variant="outline" className="text-purple-500 border-purple-500/30 mb-2">AI Engine</Badge>
                </div>

                {/* Probability bars */}
                <div className="space-y-2">
                  <GapBar label="Gap Up" pct={gap.upScore} color="bg-emerald-500" icon={<ArrowUp className="w-3 h-3" />} />
                  <GapBar label="Gap Down" pct={gap.downScore} color="bg-red-500" icon={<ArrowDown className="w-3 h-3" />} />
                  <GapBar label="Flat" pct={gap.flatScore} color="bg-muted-foreground" icon={<Minus className="w-3 h-3" />} />
                </div>

                <Separator />

                {/* Key Factors */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Key Factors</p>
                  {gap.factors.slice(0, 5).map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${f.impact === "bullish" ? "bg-emerald-500" : f.impact === "bearish" ? "bg-red-500" : "bg-yellow-500"}`} />
                        <span className="text-muted-foreground">{f.factor}</span>
                      </span>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/50">
                  <span>Avg Gap Up: +{gap.avgGapUp} pts</span>
                  <span>Avg Gap Down: -{gap.avgGapDown} pts</span>
                </div>
              </CardContent>
            </Card>

            {/* OI Heatmap */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<BarChart3 className="w-3.5 h-3.5 text-cyan-500" />} text="OI Change Heatmap" />
                {heatmap.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No chain data available</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/50">
                          <th className="text-left py-1 px-1">Strike</th>
                          <th className="text-right py-1 px-1">CE OI Chg</th>
                          <th className="text-right py-1 px-1">PE OI Chg</th>
                          <th className="text-right py-1 px-1">Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {heatmap.map((row) => (
                          <tr key={row.strike} className={`border-b border-border/30 ${row.isATM ? "bg-primary/5" : ""}`}>
                            <td className={`py-1 px-1 tabular-nums font-mono ${row.isATM ? "font-bold text-primary" : ""}`}>
                              {fmtFull(row.strike)}
                              {row.isATM && <span className="text-[8px] ml-1 text-primary/70">ATM</span>}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono ${row.ceOiChg > 0 ? "text-red-500" : row.ceOiChg < 0 ? "text-emerald-500" : "text-muted-foreground"}`}>
                              {row.ceOiChg > 0 ? "+" : ""}{fmt(row.ceOiChg)}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono ${row.peOiChg > 0 ? "text-emerald-500" : row.peOiChg < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                              {row.peOiChg > 0 ? "+" : ""}{fmt(row.peOiChg)}
                            </td>
                            <td className={`py-1 px-1 text-right tabular-nums font-mono font-bold ${row.net > 0 ? "text-emerald-500" : row.net < 0 ? "text-red-500" : ""}`}>
                              {row.net > 0 ? "+" : ""}{fmt(row.net)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-[9px] text-muted-foreground text-center">
                  Green = PE writing (support) | Red = CE writing (resistance)
                </p>
              </CardContent>
            </Card>

            {/* OI Stacked Bar */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Layers className="w-3.5 h-3.5 text-amber-500" />} text="OI Distribution" />
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-red-500 w-12">CE OI</span>
                    <div className="flex-1 h-4 bg-muted/50 rounded overflow-hidden">
                      <div className="h-full bg-red-500/60 rounded-l" style={{ width: `${cePct * 100}%` }} />
                    </div>
                    <span className="text-[10px] tabular-nums w-12 text-right text-red-500">{(cePct * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-emerald-500 w-12">PE OI</span>
                    <div className="flex-1 h-4 bg-muted/50 rounded overflow-hidden">
                      <div className="h-full bg-emerald-500/60 rounded-r ml-auto" style={{ width: `${(1 - cePct) * 100}%` }} />
                    </div>
                    <span className="text-[10px] tabular-nums w-12 text-right text-emerald-500">{((1 - cePct) * 100).toFixed(1)}%</span>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground text-center">
                  {peOI > ceOI ? "PE > CE — Bullish sentiment" : "CE > PE — Bearish sentiment"} | PCR: {pcr.toFixed(2)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* ─── RIGHT: Gap Trading Setups ─── */}
          <div className="space-y-4">
            {/* Gap Trading Setups */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-3">
                <CardTitle icon={<Shield className="w-3.5 h-3.5 text-amber-500" />} text="Gap Trading Setups" />
                {setups.map((setup, i) => (
                  <div key={i} className="rounded-lg border border-border/50 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={`text-[9px] ${
                        setup.color === "emerald" ? "text-emerald-500 border-emerald-500/30" :
                        setup.color === "red" ? "text-red-500 border-red-500/30" :
                        setup.color === "yellow" ? "text-yellow-500 border-yellow-500/30" :
                        "text-orange-500 border-orange-500/30"
                      }`}>
                        {setup.name}
                      </Badge>
                      {setup.rr !== "—" && <span className="text-[9px] text-cyan-500 font-medium">R:R {setup.rr}</span>}
                    </div>
                    <p className="text-xs font-bold">{setup.action}</p>
                    {setup.entry !== "—" && (
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        <div>
                          <p className="text-muted-foreground">Entry</p>
                          <p className="font-medium">{setup.entry}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Stop Loss</p>
                          <p className="font-medium text-red-500">{setup.sl}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Target</p>
                          <p className="font-medium text-emerald-500">{setup.target}</p>
                        </div>
                      </div>
                    )}
                    <p className="text-[9px] text-muted-foreground italic">{setup.note}</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Time to Expiry */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<Clock className="w-3.5 h-3.5 text-blue-500" />} text="Expiry Info" />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">Days to Expiry</p>
                    <p className="font-bold text-lg">{analysis?.expiry?.daysToExpiry ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Mode</p>
                    <p className="font-bold">{rec?.riskLevel ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Theta/Day</p>
                    <p className="font-bold">~₹{(vix * 0.16).toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Expected Move</p>
                    <p className="font-bold">±{Math.round(spotPrice * vix / 100 * Math.sqrt(4 / 365))} pts</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Quick Reference */}
            <Card className="border-border/50">
              <CardContent className="p-3 space-y-2">
                <CardTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-orange-500" />} text="Quick Reference" />
                <div className="space-y-1.5 text-[10px]">
                  <div className="flex items-start gap-2">
                    <span className="text-emerald-500 mt-0.5">●</span>
                    <span><strong>Long Buildup:</strong> Price ↑ + OI ↑ = New buying</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-red-500 mt-0.5">●</span>
                    <span><strong>Short Buildup:</strong> Price ↓ + OI ↑ = New selling</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-amber-500 mt-0.5">●</span>
                    <span><strong>Short Covering:</strong> Price ↑ + OI ↓ = Shorts exiting</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-blue-500 mt-0.5">●</span>
                    <span><strong>Long Unwinding:</strong> Price ↓ + OI ↓ = Longs exiting</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function CardTitle({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-1">
      {icon}
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{text}</span>
    </div>
  );
}

function MetricPill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card p-2 text-center">
      <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${color ?? ""}`}>{value}</p>
    </div>
  );
}

function GapBar({ label, pct, color, icon }: { label: string; pct: number; color: string; icon: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {icon} {label}
        </span>
        <span className="font-bold tabular-nums">{pct}%</span>
      </div>
      <div className="h-2 bg-muted/50 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%`, opacity: 0.7 }} />
      </div>
    </div>
  );
}

function MoodGauge({ pcr, vix }: { pcr: number; vix: number }) {
  let score = 3;
  if (pcr > 1.3) score += 1;
  else if (pcr < 0.7) score -= 1;
  if (vix > 20) score -= 1;
  else if (vix < 12) score += 1;
  score = Math.max(1, Math.min(5, score));

  const moods = [
    { s: 1, label: "Extreme\nFear", color: "bg-red-500", textColor: "text-red-500" },
    { s: 2, label: "Fear", color: "bg-orange-500", textColor: "text-orange-500" },
    { s: 3, label: "Neutral", color: "bg-yellow-500", textColor: "text-yellow-500" },
    { s: 4, label: "Greed", color: "bg-emerald-400", textColor: "text-emerald-400" },
    { s: 5, label: "Extreme\nGreed", color: "bg-emerald-500", textColor: "text-emerald-500" },
  ];

  const active = moods.find((m) => m.s === score)!;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-2">
        {moods.map((m) => (
          <div key={m.s} className="flex flex-col items-center gap-1">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
              m.s === score ? `${m.color} text-white` : "bg-muted/50 text-muted-foreground"
            }`}>
              {m.s}
            </div>
            <span className={`text-[8px] whitespace-pre-line ${m.s === score ? m.textColor : "text-muted-foreground"}`}>
              {m.label}
            </span>
          </div>
        ))}
      </div>
      <div className="text-center">
        <Badge variant="outline" className={`${active.textColor} text-[10px]`}>
          Current: {active.label.replace("\n", " ")} (PCR {pcr.toFixed(2)})
        </Badge>
      </div>
    </div>
  );
}
