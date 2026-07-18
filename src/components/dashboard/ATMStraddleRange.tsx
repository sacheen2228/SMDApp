"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Activity, Target, ArrowDown, ArrowUp, ShieldCheck, Zap } from "lucide-react";

interface ConfBreakdown { oi: number; iv: number; pcr: number; volume: number; }
interface Breakout {
  direction: "up" | "down" | "none";
  confirmed: boolean;
  reasons: string[];
  failedReasons: string[];
}
export interface StraddleRange {
  symbol: string;
  spot: number;
  atmStrike: number;
  cePremium: number;
  pePremium: number;
  combinedPremium: number;
  support: number;
  resistance: number;
  distanceFromSpot: number;
  spotVsSupport: number;
  spotVsResistance: number;
  confidence: number;
  confidenceBreakdown: ConfBreakdown;
  breakout: Breakout;
  expectedMovePct: number;
  rangeWidthPct: number;
}

export function ATMStraddleRange({ symbol, autoRefresh = true }: { symbol: string; autoRefresh?: boolean }) {
  const [range, setRange] = useState<StraddleRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number>(0);

  const fetchRange = useCallback(async () => {
    try {
      const res = await fetch(`/api/atm-straddle?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "no data");
      setRange(json.range as StraddleRange);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "failed to load straddle range");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    setLoading(true);
    fetchRange();
    if (!autoRefresh) return;
    const id = setInterval(fetchRange, 15000);
    return () => clearInterval(id);
  }, [fetchRange, autoRefresh]);

  const fmt = (n: number) => (typeof n === "number" && !isNaN(n) ? (n >= 1000 ? n.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : n.toFixed(1)) : "--");
  const pct = (n: number) => (typeof n === "number" && !isNaN(n) ? n.toFixed(2) : "0.00");
  const confColor = (c: number) => (c >= 75 ? "text-emerald-500" : c >= 55 ? "text-amber-500" : "text-red-500");

  // Visual range bar: position of spot relative to support/resistance
  let barPos = 50;
  if (range) {
    const span = range.resistance - range.support;
    barPos = span > 0 ? ((range.spot - range.support) / span) * 100 : 50;
    barPos = Math.max(2, Math.min(98, barPos));
  }

  return (
    <div className="h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-emerald-500" />
          <span className="text-sm font-bold">ATM Straddle Range Engine</span>
          <span className="text-[10px] text-muted-foreground">Expected Move = ATM CE + ATM PE</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {loading && <Activity className="h-3 w-3 animate-spin" />}
          {updatedAt > 0 && <span>updated {new Date(updatedAt).toLocaleTimeString("en-IN")}</span>}
          <button onClick={fetchRange} className="px-2 py-0.5 rounded bg-muted hover:bg-muted/70 font-bold">Refresh</button>
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">{error}</div>
      )}

      {range && (
        <>
          {/* Key metrics row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Metric label="Spot" value={fmt(range.spot)} sub={`ATM ${range.atmStrike}`} />
            <Metric label="CE Premium" value={fmt(range.cePremium)} sub="ATM Call" tone="text-red-500" />
            <Metric label="PE Premium" value={fmt(range.pePremium)} sub="ATM Put" tone="text-emerald-500" />
            <Metric label="Expected Move" value={fmt(range.combinedPremium)} sub={`${pct(range.expectedMovePct)}%`} tone="text-primary font-bold" />
          </div>

          {/* Range bar */}
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span className="text-emerald-500 font-semibold">S {fmt(range.support)}</span>
              <span>Straddle Range ({pct(range.rangeWidthPct)}%)</span>
              <span className="text-red-500 font-semibold">R {fmt(range.resistance)}</span>
            </div>
            <div className="relative h-3 rounded-full bg-gradient-to-r from-emerald-500/30 via-muted to-red-500/30">
              <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <div
                className="absolute -top-1 h-5 w-1.5 rounded bg-primary shadow"
                style={{ left: `${barPos}%`, transform: "translateX(-50%)" }}
                title={`Spot ${fmt(range.spot)}`}
              />
            </div>
            <div className="flex justify-between text-[10px] mt-1">
              <span className={range.spotVsSupport <= 0 ? "text-emerald-500 font-bold" : "text-muted-foreground"}>
                {range.spotVsSupport >= 0 ? `${fmt(range.spotVsSupport)} to S` : `below S by ${fmt(-range.spotVsSupport)}`}
              </span>
              <span className={range.spotVsResistance <= 0 ? "text-red-500 font-bold" : "text-muted-foreground"}>
                {range.spotVsResistance >= 0 ? `${fmt(range.spotVsResistance)} to R` : `above R by ${fmt(-range.spotVsResistance)}`}
              </span>
            </div>
          </div>

          {/* Breakout + confidence */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-[11px] font-bold">Breakout Confirmation</span>
                {range.breakout.confirmed && (
                  <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded ${range.breakout.direction === "up" ? "bg-red-500/20 text-red-500" : "bg-emerald-500/20 text-emerald-500"}`}>
                    {range.breakout.direction === "up" ? "↗ UP BREAKOUT" : "↘ DOWN BREAKOUT"}
                  </span>
                )}
                {!range.breakout.confirmed && (
                  <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">RANGE BOUND</span>
                )}
              </div>
              {range.breakout.reasons.length > 0 && (
                <ul className="text-[10px] text-emerald-500 space-y-0.5">
                  {range.breakout.reasons.map((r, i) => <li key={i}>✓ {r}</li>)}
                </ul>
              )}
              {range.breakout.failedReasons.length > 0 && (
                <ul className="text-[10px] text-muted-foreground space-y-0.5 mt-1">
                  {range.breakout.failedReasons.map((r, i) => <li key={i}>• {r}</li>)}
                </ul>
              )}
            </div>

            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] font-bold">Range Confidence</span>
                <span className={`ml-auto text-sm font-bold ${confColor(range.confidence)}`}>{range.confidence}%</span>
              </div>
              <ConfBar label="OI Quality" v={range.confidenceBreakdown.oi} />
              <ConfBar label="IV Quality" v={range.confidenceBreakdown.iv} />
              <ConfBar label="PCR Health" v={range.confidenceBreakdown.pcr} />
              <ConfBar label="Volume" v={range.confidenceBreakdown.volume} />
            </div>
          </div>

          <div className="text-[10px] text-muted-foreground">
            Institutional expected-move model: the combined ATM straddle premium is the market's implied 1-sigma intraday range.
            Support = ATM − (CE+PE), Resistance = ATM + (CE+PE). Auto-updates every 15s with the live option chain.
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${tone || ""}`}>{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ConfBar({ label, v }: { label: string; v: number }) {
  const color = v >= 75 ? "bg-emerald-500" : v >= 55 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="text-[9px] text-muted-foreground w-20">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${v}%` }} />
      </div>
      <span className="text-[9px] tabular-nums w-7 text-right">{v}</span>
    </div>
  );
}
