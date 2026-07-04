// Greeks Heatmap — visual delta/gamma/theta/vega across strikes

"use client";

import { memo, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";

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
}

interface GreeksHeatmapProps {
  chainData: any[];
  spotPrice: number;
}

function getHeatColor(value: number, min: number, max: number, invert = false): string {
  if (max === min) return "bg-muted/20";
  const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const intensity = invert ? 1 - normalized : normalized;

  if (intensity < 0.2) return "bg-blue-500/10 text-blue-400";
  if (intensity < 0.4) return "bg-blue-500/20 text-blue-300";
  if (intensity < 0.6) return "bg-yellow-500/20 text-yellow-400";
  if (intensity < 0.8) return "bg-orange-500/20 text-orange-400";
  return "bg-red-500/20 text-red-400";
}

function formatGreek(val: number, decimals = 2): string {
  if (val === 0 || isNaN(val)) return "—";
  return val.toFixed(decimals);
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

  // Compute ranges for color scaling
  const allDeltas = rows.flatMap((r) => [Math.abs(r.ceDelta), Math.abs(r.peDelta)]);
  const allGammas = rows.flatMap((r) => [r.ceGamma, r.peGamma]);
  const allThetas = rows.flatMap((r) => [r.ceTheta, r.peTheta]);
  const allVegas = rows.flatMap((r) => [r.ceVega, r.peVega]);

  const deltaMax = Math.max(...allDeltas, 0.01);
  const gammaMax = Math.max(...allGammas, 0.001);
  const thetaMax = Math.max(...allThetas, 0.01);
  const vegaMax = Math.max(...allVegas, 0.01);

  return (
    <Card className="border-border bg-card overflow-x-auto">
      <CardContent className="p-2">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[9px] text-muted-foreground font-bold uppercase">Greeks Heatmap</span>
          <div className="flex items-center gap-1 text-[7px] text-muted-foreground">
            <span className="w-2 h-2 rounded bg-blue-500/20" /> Low
            <span className="w-2 h-2 rounded bg-yellow-500/20" /> Mid
            <span className="w-2 h-2 rounded bg-red-500/20" /> High
          </div>
        </div>
        <table className="w-full text-[9px]">
          <thead>
            <tr className="text-muted-foreground border-b border-border/50">
              <th className="text-left p-1 font-bold">Strike</th>
              <th className="text-center p-1 font-bold text-green-500" colSpan={4}>CALL</th>
              <th className="text-center p-1 font-bold text-red-500" colSpan={4}>PUT</th>
              <th className="text-center p-1 font-bold">OI</th>
            </tr>
            <tr className="text-muted-foreground/60 border-b border-border/30">
              <th />
              <th className="p-0.5 font-normal">Δ</th>
              <th className="p-0.5 font-normal">Γ</th>
              <th className="p-0.5 font-normal">Θ</th>
              <th className="p-0.5 font-normal">ν</th>
              <th className="p-0.5 font-normal">Δ</th>
              <th className="p-0.5 font-normal">Γ</th>
              <th className="p-0.5 font-normal">Θ</th>
              <th className="p-0.5 font-normal">ν</th>
              <th className="p-0.5 font-normal">C/P</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isATM = r.strike === atmStrike;
              const oiRatio = r.ceOI + r.peOI > 0 ? r.ceOI / (r.ceOI + r.peOI) : 0.5;
              return (
                <tr
                  key={r.strike}
                  className={`border-b border-border/20 ${isATM ? "bg-primary/5 font-bold" : ""}`}
                >
                  <td className={`p-1 ${isATM ? "text-primary" : "text-foreground"}`}>
                    {r.strike.toLocaleString("en-IN")}
                    {isATM && <span className="text-[7px] ml-0.5 text-primary/60">ATM</span>}
                  </td>
                  {/* CE Greeks */}
                  <td className={`p-0.5 text-center ${getHeatColor(Math.abs(r.ceDelta), 0, deltaMax)}`}>
                    {formatGreek(r.ceDelta)}
                  </td>
                  <td className={`p-0.5 text-center ${getHeatColor(r.ceGamma, 0, gammaMax)}`}>
                    {formatGreek(r.ceGamma, 4)}
                  </td>
                  <td className={`p-0.5 text-center ${getHeatColor(Math.abs(r.ceTheta), 0, thetaMax, true)}`}>
                    {formatGreek(r.ceTheta)}
                  </td>
                  <td className={`p-0.5 text-center ${getHeatColor(r.ceVega, 0, vegaMax)}`}>
                    {formatGreek(r.ceVega)}
                  </td>
                  {/* PE Greeks */}
                  <td className={`p-0.5 text-center ${getHeatColor(Math.abs(r.peDelta), 0, deltaMax)}`}>
                    {formatGreek(r.peDelta)}
                  </td>
                  <td className={`p-0.5 text-center ${getHeatColor(r.peGamma, 0, gammaMax)}`}>
                    {formatGreek(r.peGamma, 4)}
                  </td>
                  <td className={`p-0.5 text-center ${getHeatColor(Math.abs(r.peTheta), 0, thetaMax, true)}`}>
                    {formatGreek(r.peTheta)}
                  </td>
                  <td className={`p-0.5 text-center ${getHeatColor(r.peVega, 0, vegaMax)}`}>
                    {formatGreek(r.peVega)}
                  </td>
                  {/* OI Ratio */}
                  <td className="p-0.5 text-center">
                    <div className="flex items-center gap-0.5">
                      <div className="flex-1 h-1.5 rounded-full bg-muted/30 overflow-hidden">
                        <div
                          className="h-full bg-green-500/60 rounded-full"
                          style={{ width: `${oiRatio * 100}%` }}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
});
