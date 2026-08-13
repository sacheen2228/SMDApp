'use client';

import React, { useState, useMemo } from 'react';
import { Shield, ShieldAlert, TrendingUp, TrendingDown, Info, BarChart3, AlertTriangle } from 'lucide-react';
import { pickHedgeStrike, type HedgeSelection, type HedgeCandidate } from '@/lib/hedge-engine';

interface HedgePanelProps {
  chainData: any[];
  spot: number;
  pcr?: number;
  atmStrike?: number;
}

export default function HedgePanel({ chainData, spot, pcr, atmStrike = 0 }: HedgePanelProps) {
  const [primaryStrike, setPrimaryStrike] = useState<number>(atmStrike || Math.round(spot / 50) * 50);
  const [primaryType, setPrimaryType] = useState<"CE" | "PE">("CE");

  // Primary leg data from chain
  const primaryLeg = useMemo(() => {
    const row = chainData.find((r: any) => r.strike === primaryStrike);
    if (!row) return null;
    const leg = primaryType === "CE" ? row.ce : row.pe;
    return leg ? { strike: primaryStrike, type: primaryType, ltp: leg.ltp, delta: leg.delta, iv: leg.iv, oi: leg.oi } : null;
  }, [chainData, primaryStrike, primaryType]);

  // Hedge selection
  const hedge: HedgeSelection | null = useMemo(() => {
    if (!primaryLeg || !primaryLeg.ltp) return null;
    return pickHedgeStrike(
      chainData, spot,
      primaryStrike, primaryType,
      primaryLeg.iv ?? 0, primaryLeg.delta ?? 0, primaryLeg.ltp,
    );
  }, [chainData, spot, primaryStrike, primaryType, primaryLeg]);

  // Quick pick chain rows
  const sortedStrikes = useMemo(() => {
    if (!chainData.length) return [];
    return [...chainData].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 10);
  }, [chainData, spot]);

  return (
    <div className="flex flex-col h-full bg-[#0a0e14] overflow-hidden" style={{ fontFamily: "var(--sans, Inter, -apple-system, sans-serif)" }}>
      {/* Header */}
      <div className="h-12 bg-[#10151d] border-b border-[#1f2733] flex items-center px-4 gap-3 shrink-0">
        <Shield className="h-4 w-4 text-amber-400" />
        <span className="font-bold text-[13px]">Buy-Only Hedge Builder</span>
        <span className="text-[9px] text-[#7d8ba0]">Model Signal — not investment advice</span>
        <span className="ml-auto text-[#7d8ba0] font-mono text-[11px]">
          SPOT <b className="text-[#dfe6ee] px-2 py-0.5 bg-[#151b25] rounded-lg border border-[#1f2733] font-bold text-sm">{spot.toLocaleString("en-IN")}</b>
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ─── Primary Leg Selection ─── */}
        <div className="bg-[#10151d] border border-[#1f2733] rounded p-3 space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-[#dfe6ee]">
            <BarChart3 className="h-3.5 w-3.5 text-[#7d8ba0]" />
            Primary Leg
          </div>
          <div className="flex items-center gap-3">
            {/* Strike input */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[#7d8ba0]">Strike</span>
              <input
                type="number"
                value={primaryStrike}
                onChange={(e) => setPrimaryStrike(Number(e.target.value))}
                className="w-24 bg-[#0a0e14] border border-[#1f2733] rounded px-2 py-1 text-[12px] text-[#dfe6ee] font-bold font-mono outline-none"
                step={50}
              />
            </div>
            {/* Type toggle */}
            <div className="flex bg-[#0a0e14] rounded-lg p-0.5 border border-[#1f2733]">
              <button
                onClick={() => setPrimaryType("CE")}
                className={`px-3 py-1 text-[11px] font-bold rounded ${primaryType === "CE" ? "bg-emerald-600 text-white" : "text-[#7d8ba0]"}`}
              >
                <TrendingUp className="h-3 w-3 inline mr-1" />CE
              </button>
              <button
                onClick={() => setPrimaryType("PE")}
                className={`px-3 py-1 text-[11px] font-bold rounded ${primaryType === "PE" ? "bg-red-600 text-white" : "text-[#7d8ba0]"}`}
              >
                <TrendingDown className="h-3 w-3 inline mr-1" />PE
              </button>
            </div>
            {/* Quick pick from nearby strikes */}
            <select
              value={primaryStrike}
              onChange={(e) => setPrimaryStrike(Number(e.target.value))}
              className="bg-[#0a0e14] border border-[#1f2733] rounded px-2 py-1 text-[11px] text-[#dfe6ee] outline-none"
            >
              <option value="">Nearby strikes</option>
              {sortedStrikes.map((r: any) => {
                const ceLtp = r.ce?.ltp ?? 0;
                const peLtp = r.pe?.ltp ?? 0;
                return (
                  <option key={r.strike} value={r.strike}>
                    {r.strike} (CE ₹{ceLtp} / PE ₹{peLtp})
                  </option>
                );
              })}
            </select>
          </div>
          {/* Primary leg details */}
          {primaryLeg && (
            <div className="grid grid-cols-4 gap-3 pt-2 border-t border-[#1f2733] text-center">
              <div>
                <div className="text-[9px] text-[#5a6a80]">Premium</div>
                <div className="font-bold text-[13px] text-[#dfe6ee]">₹{primaryLeg.ltp?.toFixed(2) ?? "—"}</div>
              </div>
              <div>
                <div className="text-[9px] text-[#5a6a80]">Delta</div>
                <div className="font-bold text-[13px]"
                  style={{ color: primaryType === "CE" ? "#1fbf75" : "#f2495c" }}>
                  {primaryLeg.delta?.toFixed(2) ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-[9px] text-[#5a6a80]">IV</div>
                <div className="font-bold text-[13px] text-[#dfe6ee]">{primaryLeg.iv?.toFixed(1) ?? "—"}%</div>
              </div>
              <div>
                <div className="text-[9px] text-[#5a6a80]">OI</div>
                <div className="font-bold text-[13px] text-[#dfe6ee]">{primaryLeg.oi ? (primaryLeg.oi / 1000).toFixed(0) + "K" : "—"}</div>
              </div>
            </div>
          )}
        </div>

        {/* ─── Hedge Selection ─── */}
        {hedge && (
          <div className="bg-[#10151d] border border-[#1f2733] rounded p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#dfe6ee]">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
                Recommended Hedge
              </div>
              {hedge.hedgeLeg && (
                <span className="text-[10px] font-bold text-amber-400">
                  Score: {hedge.totalScore}/100
                </span>
              )}
            </div>

            {/* Fallback warning */}
            {hedge.fallbackWarning && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded p-2 text-[10px]">
                <AlertTriangle className="h-3 w-3 text-amber-400 mt-0.5 shrink-0" />
                <span className="text-amber-300">{hedge.fallbackWarning}</span>
              </div>
            )}

            {hedge.hedgeLeg && (
              <>
                {/* Hedge candidate card */}
                <div className="bg-[#0a0e14] border border-[#1f2733] rounded p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[15px] font-bold">
                      <span className={hedge.hedgeLeg.type === "CE" ? "text-emerald-400" : "text-red-400"}>
                        {hedge.hedgeLeg.strike} {hedge.hedgeLeg.type}
                      </span>
                    </span>
                    <span className={`text-[11px] font-bold ${hedge.hedgeLeg.totalScore >= 70 ? 'text-emerald-400' : hedge.hedgeLeg.totalScore >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                      {hedge.hedgeLeg.totalScore >= 70 ? 'STRONG' : hedge.hedgeLeg.totalScore >= 50 ? 'ADEQUATE' : 'WEAK'}
                    </span>
                  </div>

                  {/* Premium + Greeks row */}
                  <div className="grid grid-cols-5 gap-2 text-center mb-3">
                    <div>
                      <div className="text-[9px] text-[#5a6a80]">Premium</div>
                      <div className="font-bold text-[12px] text-[#dfe6ee]">₹{hedge.hedgeLeg.premium.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-[#5a6a80]">Δ</div>
                      <div className="font-bold text-[12px] text-[#dfe6ee]">{hedge.hedgeLeg.delta.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-[#5a6a80]">θ</div>
                      <div className="font-bold text-[12px] text-[#dfe6ee]">{hedge.hedgeLeg.theta.toFixed(1)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-[#5a6a80]">γ</div>
                      <div className="font-bold text-[12px] text-[#dfe6ee]">{hedge.hedgeLeg.gamma.toFixed(4)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-[#5a6a80]">IV</div>
                      <div className="font-bold text-[12px] text-[#dfe6ee]">{hedge.hedgeLeg.iv.toFixed(1)}%</div>
                    </div>
                  </div>

                  {/* Score breakdown */}
                  <div className="space-y-1.5">
                    <ScoreBar label="Liquidity (OI)" score={hedge.hedgeLeg.liquidityScore} max={30} color="bg-blue-500" />
                    <ScoreBar label="Cost efficiency (θ/₹)" score={hedge.hedgeLeg.costEfficiencyScore} max={25} color="bg-emerald-500" />
                    <ScoreBar label="Relative IV" score={hedge.hedgeLeg.relativeIVScore} max={20} color="bg-violet-500" />
                    <ScoreBar label="Responsiveness (γ)" score={hedge.hedgeLeg.responsivenessScore} max={15} color="bg-amber-500" />
                    <ScoreBar label="Momentum (OI Chg)" score={hedge.hedgeLeg.momentumScore} max={10} color={hedge.hedgeLeg.momentumScore >= 8 ? "bg-emerald-500" : "bg-red-500"} />
                  </div>
                </div>

                {/* Reasoning */}
                <div className="bg-[#0a0e14] border border-[#1f2733] rounded p-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Info className="h-3 w-3 text-[#7d8ba0]" />
                    <span className="text-[10px] font-semibold text-[#7d8ba0]">Selected for:</span>
                  </div>
                  <ul className="space-y-0.5">
                    {hedge.hedgeLeg.reasons.map((r, i) => (
                      <li key={i} className="text-[10px] text-[#b0c0d0] flex items-start gap-1">
                        <span className="text-[#5a6a80] mt-0.5">·</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {!hedge.hedgeLeg && !hedge.fallbackWarning && (
              <div className="text-[11px] text-[#7d8ba0] text-center py-4">
                Select a primary leg with a valid premium to see hedge recommendations.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreBar({ label, score, max, color }: { label: string; score: number; max: number; color: string }) {
  const pct = max > 0 ? (score / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] text-[#7d8ba0] w-32 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-[#1f2733] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] text-[#b0c0d0] font-bold w-6 text-right">{score}</span>
    </div>
  );
}
