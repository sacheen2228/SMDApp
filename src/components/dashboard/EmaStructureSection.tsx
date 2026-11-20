// EmaStructureSection — EMA 9/21/50 market-structure display.
//
// Shows LIVE status when BRAIN_FLAGS.emaStructureLive is on (the panel feeds
// the alert-time veto in ema-live-gate); otherwise shadow-research only.
// Never presents a shadow result as an approved executable trade by itself,
// never overrides the existing engine's live decision, and never fabricates
// missing values.

"use client";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowUp,
  ArrowDown,
  Minus,
  Clock,
  Target,
  AlertTriangle,
  CheckCircle,
  Info,
  ChevronRight,
} from "lucide-react";
import type { EmaStructure } from "@/lib/ema-structure";
import type { ConsistencyVerdict } from "@/lib/directional-consistency";
import type { OptionsConfirmationVerdict } from "@/lib/options-confirmation";
import { BRAIN_FLAGS } from "@/lib/brain-flags";

interface EmaStructureSectionProps {
  emaStructure: EmaStructure | null | undefined;
  directionalCheck: ConsistencyVerdict | null | undefined;
  optionsConfirmation: OptionsConfirmationVerdict | null | undefined;
  currentPrice: number;
  showSuggestion?: boolean;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function slopeLabel(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v > 0.05) return "rising";
  if (v < -0.05) return "falling";
  return "flat";
}

function slopeIcon(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return <Minus className="h-3 w-3 text-muted-foreground" />;
  if (v > 0.05) return <ArrowUp className="h-3 w-3 text-emerald-500" />;
  if (v < -0.05) return <ArrowDown className="h-3 w-3 text-red-500" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

function priceVsEma(price: number, ema: number | null | undefined): string {
  if (ema == null || !Number.isFinite(ema)) return "—";
  const pct = ((price - ema) / ema) * 100;
  return `${price > ema ? "above" : "below"} by ${Math.abs(pct).toFixed(1)}%`;
}

function alignmentColor(a: EmaStructure["alignment"]) {
  switch (a) {
    case "BULLISH": return "bg-emerald-600 text-white";
    case "BEARISH": return "bg-red-600 text-white";
    case "TRANSITIONAL": return "bg-amber-600 text-white";
    default: return "bg-muted text-muted-foreground";
  }
}

function consistencyColor(v: ConsistencyVerdict) {
  switch (v) {
    case "CONSISTENT": return "bg-emerald-600 text-white";
    case "REVERSAL_CONFIRMED": return "bg-blue-600 text-white";
    case "CONFLICT": return "bg-red-600 text-white";
    default: return "bg-muted text-muted-foreground";
  }
}

function optionsColor(v: OptionsConfirmationVerdict) {
  switch (v) {
    case "SUPPORTIVE": return "bg-emerald-600 text-white";
    case "ADVERSE": return "bg-red-600 text-white";
    default: return "bg-muted text-muted-foreground";
  }
}

function freshnessColor(dq: EmaStructure["dataQuality"]) {
  switch (dq) {
    case "LIVE": return "text-emerald-500";
    case "FRESH": return "text-blue-500";
    case "STALE": return "text-amber-500";
    default: return "text-muted-foreground";
  }
}

export function EmaStructureSection({
  emaStructure,
  directionalCheck,
  optionsConfirmation,
  currentPrice,
  showSuggestion = true,
}: EmaStructureSectionProps) {
  const s = emaStructure;
  if (!s) {
    return (
      <div className="p-2 rounded bg-muted/30 border border-zinc-500/30 text-[10px]">
        <div className="flex items-center gap-1 mb-1">
          <Info className="h-3 w-3 text-muted-foreground" />
          <span className="font-semibold text-muted-foreground">EMA 9/21/50</span>
        </div>
        <p className="text-zinc-400">EMA analysis not available for this candidate.</p>
      </div>
    );
  }

  // Normalize in case the full DirectionalCheckResult object is passed instead
  // of its .verdict string (defensive against stale client bundles).
  const consistencyVerdict =
    directionalCheck != null && typeof directionalCheck === "object" && "verdict" in directionalCheck
      ? (directionalCheck as { verdict: ConsistencyVerdict }).verdict
      : directionalCheck;

  const e9 = s.ema9 ?? null;
  const e21 = s.ema21 ?? null;
  const e50 = s.ema50 ?? null;
  const live = BRAIN_FLAGS.emaStructureLive;

  // Research suggestion: CE when bullish, PE when bearish — only when the
  // directional evidence supports it and options are not adverse.
  let suggestion: "BUY_CE" | "BUY_PE" | null = null;
  if (showSuggestion) {
    const ok =
      (directionalCheck === "CONSISTENT" || directionalCheck === "REVERSAL_CONFIRMED") &&
      s.direction !== "NEUTRAL";
    const optionsNotAdverse = optionsConfirmation !== "ADVERSE";
    if (ok && optionsNotAdverse) {
      suggestion = s.direction === "BULLISH" ? "BUY_CE" : "BUY_PE";
    }
  }

  // Live gate signals visible on this candidate (trade-direction oppose is
  // applied at alert time in ema-live-gate — the panel has no leg).
  const liveBlockReason = !live
    ? null
    : optionsConfirmation === "ADVERSE"
    ? "options ADVERSE"
    : consistencyVerdict === "CONFLICT"
    ? "directional CONFLICT"
    : null;

  return (
    <div className="p-2 rounded bg-muted/30 border border-zinc-500/30 text-[9px]">
      <div className="flex items-center gap-1 mb-1 border-b border-zinc-500/30 pb-1">
        <Info className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-semibold text-muted-foreground shrink-0">
          EMA 9/21/50 — {live ? "live gate" : "shadow analysis"}
        </span>
        {live && (
          <Badge className="text-[9px] bg-emerald-600 text-white border border-emerald-500/40">
            LIVE
          </Badge>
        )}
        {liveBlockReason && (
          <Badge className="text-[9px] bg-red-600 text-white border border-red-500/40">
            BLOCKS
          </Badge>
        )}
        {suggestion && !liveBlockReason && (
          <Badge className="text-[9px] bg-emerald-500/10 text-emerald-500 border border-emerald-500/30">
            Research: {suggestion === "BUY_CE" ? "BUY_CE" : "BUY_PE"}
          </Badge>
        )}
      </div>

      {/* Alignment */}
      <div className="flex items-center gap-2 mb-1">
        <Badge className={alignmentColor(s.alignment)}> {s.alignment} </Badge>
        <Badge
          className={
            s.direction === "BULLISH"
              ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/30"
              : s.direction === "BEARISH"
              ? "bg-red-500/10 text-red-500 border border-red-500/30"
              : "bg-muted text-muted-foreground border border-zinc-500/30"
          }
        >
          {s.direction}
        </Badge>
        <span className={`text-zinc-400 ml-auto ${freshnessColor(s.dataQuality)}`}>
          {s.dataQuality}
        </span>
      </div>

      {/* EMA ladder */}
      <div className="space-y-1 mb-1">
        <div className="flex items-center justify-between text-[8px]">
          <span className="text-muted-foreground">EMA9</span>
          <div className="flex items-center gap-1">
            <span className="font-bold tabular-nums">{fmtPrice(e9)}</span>
            {slopeIcon(s.slope9)} <span className="text-zinc-400">{slopeLabel(s.slope9)}</span>
          </div>
          <span className={`text-xs ${currentPrice > (e9 ?? 0) ? "text-emerald-500" : "text-red-500"}`}>
            {priceVsEma(currentPrice, e9)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[8px]">
          <span className="text-muted-foreground">EMA21</span>
          <div className="flex items-center gap-1">
            <span className="font-bold tabular-nums">{fmtPrice(e21)}</span>
            {slopeIcon(s.slope21)} <span className="text-zinc-400">{slopeLabel(s.slope21)}</span>
          </div>
          <span className={`text-xs ${currentPrice > (e21 ?? 0) ? "text-emerald-500" : "text-red-500"}`}>
            {priceVsEma(currentPrice, e21)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[8px]">
          <span className="text-muted-foreground">EMA50</span>
          <div className="flex items-center gap-1">
            <span className="font-bold tabular-nums">{fmtPrice(e50)}</span>
            {slopeIcon(s.slope50)} <span className="text-zinc-400">{slopeLabel(s.slope50)}</span>
          </div>
          <span className={`text-xs ${currentPrice > (e50 ?? 0) ? "text-emerald-500" : "text-red-500"}`}>
            {priceVsEma(currentPrice, e50)}
          </span>
        </div>
      </div>

      {/* Separation / compression / structure */}
      <div className="grid grid-cols-2 gap-1 mb-1">
        <div className="text-center">
          <div className="text-muted-foreground">Sep 9-21</div>
          <div className="font-bold tabular-nums">
            {s.separation9_21Atr == null ? "—" : s.separation9_21Atr.toFixed(2) + " ATR"}
          </div>
        </div>
        <div className="text-center">
          <div className="text-muted-foreground">Sep 21-50</div>
          <div className="font-bold tabular-nums">
            {s.separation21_50Atr == null ? "—" : s.separation21_50Atr.toFixed(2) + " ATR"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 mb-1">
        <span className={`text-xs ${s.compression ? "text-amber-500" : "text-zinc-400"}`}>
          {s.compression ? "compressed" : "expanded"} · {s.compressionBars} bars
        </span>
        {s.chop && (
          <span className="text-xs text-amber-500">
            <AlertTriangle className="h-2 w-2 mr-0.5" /> chop
          </span>
        )}
        <span className="text-xs text-zinc-400 ml-auto">{s.structure.trend}</span>
      </div>

      {/* VWAP */}
      {s.vwap != null && s.vsVwap !== "NA" && (
        <div className="flex items-center justify-between mb-1">
          <span className="text-muted-foreground">VWAP</span>
          <span className={`font-bold ${s.vsVwap === "ABOVE" ? "text-emerald-500" : "text-red-500"}`}>
            {s.vsVwap} · {fmtPrice(s.vwap)}
          </span>
        </div>
      )}

      <Separator className="my-1" />

      {/* Setups */}
      <div className="mb-1">
        <span className="text-muted-foreground text-[8px] font-semibold block mb-0.5">Setups</span>
        {s.setups.length === 0 ? (
          <p className="text-zinc-400 text-[8px]">No confirmed setup on the last closed candle.</p>
        ) : (
          <ul className="space-y-0.5">
            {s.setups.map((st, i) => (
              <li key={i} className="flex items-start gap-1 text-[8px]">
                <span
                  className={`font-bold ${st.direction === "BULLISH" ? "text-emerald-500" : "text-red-500"}`}
                >
                  {st.type.replace(/_/g, " ")}
                </span>
                <span className="text-zinc-400 ml-1">→ {st.direction}</span>
                <span className="ml-auto text-zinc-400">
                  {st.confirmed ? "confirmed" : "pending"}
                </span>
                <span className="text-zinc-400 ml-1">inv {fmtPrice(st.invalidation)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Directional consistency */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-muted-foreground">Directional consistency</span>
        <Badge className={consistencyColor(consistencyVerdict ?? "INSUFFICIENT DATA")}>
          {consistencyVerdict ?? "INSUFFICIENT DATA"}
        </Badge>
      </div>
      {consistencyVerdict === "CONFLICT" && (
        <p className="text-amber-500 text-[8px] mt-0.5">
          <AlertTriangle className="h-2 w-2 mr-0.5 shrink-0" />
          EMA/MACD/structure disagree with {suggestion ? suggestion === "BUY_CE" ? "CE" : "PE" : "leg"} — wait for confirmation.
        </p>
      )}

      {/* Options confirmation */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-muted-foreground">Options confirmation</span>
        <Badge className={optionsColor(optionsConfirmation ?? "INCONCLUSIVE")}>
          {optionsConfirmation ?? "INCONCLUSIVE"}
        </Badge>
      </div>

      {/* Footer */}
      <div className="mt-1 pt-1 border-t border-zinc-500/30">
        <span className="text-[8px] text-zinc-400">
          {live
            ? liveBlockReason
              ? `Live gate: BLOCK on ${liveBlockReason}. Missing/stale EMA fails open.`
              : "Live gate on — ADVERSE / CONFLICT / opposite stack blocks the alert."
            : "Shadow research only — not an executable trade."}{" "}
          Bars: {s.bars} · last closed{" "}
          {new Date(s.lastCandleTime ?? 0).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}
        </span>
      </div>
    </div>
  );
}
