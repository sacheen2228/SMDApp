// Greeks Heatmap — 5-year-old simple: Where is FAST? Where is SLOW? Where is DANGER?
// Green = GO (safe to buy) | Yellow = WAIT | Red = STOP (danger)

"use client";

import { memo, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gauge, Zap, Shield, AlertTriangle, ArrowUp, ArrowDown } from "lucide-react";

interface GreekRow {
  strike: number;
  ceDelta: number;
  peDelta: number;
  ceGamma: number;
  peGamma: number;
  ceTheta: number;
  peTheta: number;
  ceVega: number;
  peVega: number;
  ceOI: number;
  peOI: number;
  ceLTP: number;
  peLTP: number;
}

interface GreeksHeatmapProps {
  chainData: any[];
  spotPrice: number;
}

export const GreeksHeatmap = memo(function GreeksHeatmap({ chainData, spotPrice }: GreeksHeatmapProps) {
  const rows = useMemo((): GreekRow[] => {
    if (!chainData?.length) return [];
    return chainData
      .filter((s: any) => s.ce || s.pe)
      .map((s: any) => ({
        strike: s.strike,
        ceDelta: s.ce?.delta || 0,
        peDelta: s.pe?.delta || 0,
        ceGamma: s.ce?.gamma || 0,
        peGamma: s.pe?.gamma || 0,
        ceTheta: s.ce?.theta || 0,
        peTheta: s.pe?.theta || 0,
        ceVega: s.ce?.vega || 0,
        peVega: s.pe?.vega || 0,
        ceOI: s.ce?.oi || 0,
        peOI: s.pe?.oi || 0,
        ceLTP: s.ce?.ltp || 0,
        peLTP: s.pe?.ltp || 0,
      }))
      .sort((a: GreekRow, b: GreekRow) => a.strike - b.strike);
  }, [chainData]);

  if (!rows.length) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="p-4 text-center text-muted-foreground text-xs">
          Enable Greeks in Settings to view heatmap
        </CardContent>
      </Card>
    );
  }

  // Find ATM (closest to spot)
  const atmStrike = rows.reduce((best, r) =>
    Math.abs(r.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? r : best
  ).strike;

  // Pick key strikes: ATM ± 2 steps (5 total)
  const atmIdx = rows.findIndex(r => r.strike === atmStrike);
  const step = Math.max(1, Math.floor(rows.length / 10));
  const keyIndices = [atmIdx - step * 2, atmIdx - step, atmIdx, atmIdx + step, atmIdx + step * 2]
    .filter(i => i >= 0 && i < rows.length);
  const keyRows = keyIndices.map(i => rows[i]);

  // Compute simple signals for each key strike
  const signals = keyRows.map(r => {
    const isCall = r.ceDelta > 0.3 && r.ceGamma > 0.005;
    const isPut = Math.abs(r.peDelta) > 0.3 && r.peGamma > 0.005;
    const gammaHigh = Math.max(r.ceGamma, r.peGamma) > 0.01;
    const thetaBurn = Math.min(Math.abs(r.ceTheta), Math.abs(r.peTheta)) > 5;
    const vegaHigh = Math.max(r.ceVega, r.peVega) > 10;

    let signal = "WAIT";
    let label = "⏳ Wait";
    let color = "bg-yellow-500/20 border-yellow-500/30 text-yellow-500";
    let icon = <AlertTriangle className="h-4 w-4" />;
    let tradeType = ""; // "CALL" | "PUT" | ""
    let entry = 0;
    let sl = 0;
    let tp1 = 0;
    let tp2 = 0;

    if (isCall && !thetaBurn && !gammaHigh) {
      signal = "GO";
      label = "🟢 GO — Buy Call";
      color = "bg-emerald-500/20 border-emerald-500/30 text-emerald-500";
      icon = <ArrowUp className="h-4 w-4" />;
      tradeType = "CALL";
      entry = r.ceLTP || 0;
      sl = entry * 0.65; // 35% SL
      tp1 = entry * 1.5; // 50% TP
      tp2 = entry * 2.0; // 100% TP
    } else if (isPut && !thetaBurn && !gammaHigh) {
      signal = "GO";
      label = "🔴 GO — Buy Put";
      color = "bg-emerald-500/20 border-emerald-500/30 text-emerald-500";
      icon = <ArrowDown className="h-4 w-4" />;
      tradeType = "PUT";
      entry = r.peLTP || 0;
      sl = entry * 0.65;
      tp1 = entry * 1.5;
      tp2 = entry * 2.0;
    } else if (gammaHigh) {
      signal = "FAST";
      label = "⚡ FAST — Big moves coming";
      color = "bg-orange-500/20 border-orange-500/30 text-orange-500";
      icon = <Zap className="h-4 w-4" />;
    } else if (thetaBurn) {
      signal = "DANGER";
      label = "🛑 DANGER — Time eating money";
      color = "bg-red-500/20 border-red-500/30 text-red-500";
      icon = <Shield className="h-4 w-4" />;
    }

    const oiTotal = r.ceOI + r.peOI;
    const oiCallPct = oiTotal > 0 ? Math.round((r.ceOI / oiTotal) * 100) : 50;

    return { 
      strike: r.strike, 
      signal, 
      label, 
      color, 
      icon, 
      isATM: r.strike === atmStrike, 
      oiCallPct,
      tradeType,
      entry,
      sl,
      tp1,
      tp2,
    };
  });

  return (
    <Card className="border-border bg-card">
      <CardContent className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Gauge className="h-5 w-5 text-cyan-500" />
            <span>Greeks Made Simple</span>
          </h3>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-500">GO</span>
            <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500">WAIT</span>
            <span className="px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-500">FAST</span>
            <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-500">STOP</span>
          </div>
        </div>

        {/* Strike Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {signals.map((s, idx) => (
            <div
              key={s.strike}
              className={`relative p-3 rounded-xl border-2 transition-all ${s.color} ${
                s.isATM ? "ring-2 ring-primary shadow-lg" : ""
              }`}
            >
              {s.isATM && (
                <div className="absolute -top-2 left-1/2 -translate-x-1/2">
                  <Badge className="bg-primary text-primary-foreground text-[10px]">ATM</Badge>
                </div>
              )}

              <div className="text-center space-y-2">
                <div className="text-xs font-bold tabular-nums">
                  ₹{s.strike.toLocaleString("en-IN")}
                </div>

                <div className="flex items-center justify-center gap-2">
                  {s.icon}
                  <span className="text-xs font-semibold">{s.label}</span>
                </div>

                {/* Trade Setup for GO signals */}
                {s.tradeType && s.entry > 0 && (
                  <div className="bg-muted/50 rounded-lg p-2 space-y-1 text-[9px]">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Entry</span>
                      <span className="font-bold text-emerald-500">₹{s.entry.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">SL</span>
                      <span className="font-bold text-red-500">₹{s.sl.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">T1</span>
                      <span className="font-bold text-emerald-500">₹{s.tp1.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">T2</span>
                      <span className="font-bold text-emerald-500">₹{s.tp2.toFixed(1)}</span>
                    </div>
                  </div>
                )}

                {/* OI Split */}
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500/60 rounded-full transition-all"
                    style={{ width: `${s.oiCallPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-[8px] text-muted-foreground">
                  <span>📞 {s.oiCallPct}%</span>
                  <span>📦 {100 - s.oiCallPct}%</span>
                </div>
              </div>
            </div>
          ))}

          {/* Legend */}
          <div className="lg:col-span-5 p-3 bg-muted/30 rounded-xl space-y-2">
            <p className="text-xs font-bold text-center">What the colors mean:</p>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="flex items-center gap-1.5 p-2 bg-emerald-500/20 rounded text-emerald-500">
                <ArrowUp className="h-3 w-3" /> GO — Safe to enter
              </div>
              <div className="flex items-center gap-1.5 p-2 bg-yellow-500/20 rounded text-yellow-500">
                <AlertTriangle className="h-3 w-3" /> WAIT — Not ready yet
              </div>
              <div className="flex items-center gap-1.5 p-2 bg-orange-500/20 rounded text-orange-500">
                <Zap className="h-3 w-3" /> FAST — Big move coming
              </div>
              <div className="flex items-center gap-1.5 p-2 bg-red-500/20 rounded text-red-500">
                <Shield className="h-3 w-3" /> STOP — Time decay eating you
              </div>
            </div>
            <p className="text-[9px] text-center text-muted-foreground">
              Green bar = Calls | Gray bar = Puts | ATM = best strike to watch
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
