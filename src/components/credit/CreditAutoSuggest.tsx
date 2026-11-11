"use client";

// ─── Credit Auto-Suggest Panel ────────────────────────────────────
// Fetches the live option chain (same /api/option-chain the app already
// uses — NSE/BSE/Breeze tree, so SENSEX works) and renders ranked
// credit-spread / iron-condor suggestions with full per-lot economics.

import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  suggestSpreads,
  type ChainRow,
  type SpreadSuggestion,
  type OptionPlanInput,
} from "@/lib/credit-spread-engine";
import { getLotSize } from "@/lib/symbol-config";
import {
  ArrowUp, ArrowDown, Shield, TrendingUp, TrendingDown, RefreshCw,
  Clock, Lock, Eye, Plus, Share2, Download, Filter, Star,
  Calendar, Percent, Wallet, Activity,
} from "lucide-react";

const SYMBOLS = [
  { value: "NIFTY", label: "NIFTY" },
  { value: "BANKNIFTY", label: "BANKNIFTY" },
  { value: "FINNIFTY", label: "FINNIFTY" },
  { value: "MIDCPNIFTY", label: "MIDCPNIFTY" },
  { value: "SENSEX", label: "SENSEX" },
].map((s) => ({ ...s, lot: getLotSize(s.value) }));

const STRATEGY_META: Record<string, { label: string; cls: string }> = {
  BULL_PUT_SPREAD: { label: "Bull Put Spread", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" },
  BEAR_CALL_SPREAD: { label: "Bear Call Spread", cls: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30" },
  IRON_CONDOR: { label: "Iron Condor", cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30" },
};

const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

export default function CreditAutoSuggest() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [capital, setCapital] = useState(50000);
  const [riskPct, setRiskPct] = useState(2); // 2% default
  const [minCreditPct, setMinCreditPct] = useState(15); // 15% credit capture min (was 65 - too high)
  const [maxWidth, setMaxWidth] = useState(5); // max width in strikes (was 3 - too restrictive)
  const [selectedExpiry, setSelectedExpiry] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showOnlyTradable, setShowOnlyTradable] = useState(true);
  const [sortBy, setSortBy] = useState<"score" | "rr" | "credit" | "lots">("score");

  const clampCapital = (v: number) => Math.max(10000, Math.min(500000, v));
  const clampRisk = (v: number) => Math.max(1, Math.min(10, v));
  const clampMinCredit = (v: number) => Math.max(10, Math.min(80, v));
  const clampMaxWidth = (v: number) => Math.max(1, Math.min(10, v));

  const lot = SYMBOLS.find((s) => s.value === symbol)?.lot ?? 65;

  const {
    data,
    isLoading,
    dataUpdatedAt,
    isFetching,
  } = useQuery<any>({
    queryKey: ["option-chain", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/option-chain?symbol=${symbol}`);
      if (!res.ok) throw new Error(`chain ${res.status}`);
      return res.json();
    },
    refetchInterval: autoRefresh ? 30_000 : 0,
    staleTime: 15_000,
  });

  const spot: number = data?.data?.spotPrice ?? data?.summary?.spotPrice ?? 0;
  const vix: number = data?.summary?.indiaVIX ?? data?.analysis?.greeks?.vix ?? 14;
  const expiry: string = selectedExpiry || data?.data?.selectedExpiry || data?.data?.expiry || "";
  const chain: ChainRow[] = useMemo(() => data?.data?.data ?? [], [data]);

  const suggestions: SpreadSuggestion[] = useMemo(() => {
    if (!spot || !chain.length) return [];
    return suggestSpreads({
      chain,
      spot,
      lotSize: lot,
      vix,
      expiry,
      capital,
      maxPerStrategy: 5,
    });
  }, [chain, spot, lot, vix, expiry, capital]);

  // Apply filters
  const filtered = useMemo(() => {
    let filtered = suggestions;

    if (showOnlyTradable) {
      filtered = filtered.filter((s) => s.tradable && s.lots > 0);
    }

    // Filter by min credit capture %
    filtered = filtered.filter((s) => {
      const creditPct = s.netCredit / s.width;
      return creditPct >= minCreditPct / 100;
    });

    // Sort
    filtered = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "score": return b.score - a.score;
        case "rr": return (b.maxProfitPerLot / Math.max(b.maxLossPerLot, 1)) - (a.maxProfitPerLot / Math.max(a.maxLossPerLot, 1));
        case "credit": return b.netCredit - a.netCredit;
        case "lots": return b.affordableLots - a.affordableLots;
        default: return b.score - a.score;
      }
    });

    return filtered;
  }, [suggestions, showOnlyTradable, minCreditPct, sortBy]);

  const stale = dataUpdatedAt ? Date.now() - dataUpdatedAt > 60_000 : true;

  return (
    <div className="flex flex-col gap-2 p-2 h-full overflow-auto">
      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center gap-2 p-1 rounded bg-zinc-900/40 border border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Symbol</span>
          <Select value={symbol} onValueChange={setSymbol}>
            <SelectTrigger className="h-7 w-[110px] text-[10px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SYMBOLS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label} (lot {s.lot})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Capital</span>
            <Input
              type="number"
              value={capital}
              min={10000}
              max={500000}
              step={5000}
              onChange={(e) => setCapital(clampCapital(Math.max(0, +e.target.value)))}
              className="h-7 w-[80px] text-[10px]"
            />
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Risk %</span>
            <Input
              type="number"
              value={riskPct}
              min={1}
              max={10}
              step={0.5}
              onChange={(e) => setRiskPct(clampRisk(Math.max(0, +e.target.value)))}
              className="h-7 w-[70px] text-[10px]"
            />
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Min credit %</span>
            <Input
              type="number"
              value={minCreditPct}
              min={10}
              max={80}
              step={5}
              onChange={(e) => setMinCreditPct(clampMinCredit(Math.max(0, +e.target.value)))}
              className="h-7 w-[70px] text-[10px]"
            />
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Max width</span>
            <Input
              type="number"
              value={maxWidth}
              min={1}
              max={10}
              step={1}
              onChange={(e) => setMaxWidth(clampMaxWidth(Math.max(0, +e.target.value)))}
              className="h-7 w-[60px] text-[10px]"
            />
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Sort</span>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="h-7 w-[90px] text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem key="score" value="score">Score</SelectItem>
                <SelectItem key="rr" value="rr">R:R</SelectItem>
                <SelectItem key="credit" value="credit">Credit</SelectItem>
                <SelectItem key="lots" value="lots">Lots</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] ${autoRefresh ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-red-500/10 text-red-400 border-red-500/30"}`}
          >
            <Activity className={`h-3 w-3 ${autoRefresh ? "animate-spin" : ""}`} />
            {autoRefresh ? "Live" : "Paused"}
          </button>
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <Badge variant="outline" className="text-[9px]">
            lot {lot}
          </Badge>
          {spot > 0 && (
            <Badge variant="outline" className="text-[9px] tabular-nums">
              spot {spot.toLocaleString("en-IN")}
            </Badge>
          )}
          <Badge variant="outline" className="text-[9px] tabular-nums">
            VIX {typeof vix === "number" ? vix.toFixed(1) : "—"}
          </Badge>

          <Badge
            variant={stale ? "destructive" : "default"}
            className="text-[9px] ml-auto"
          >
            {isLoading || isFetching
              ? "LIVE…"
              : stale
                ? "STALE DATA"
                : "LIVE · 30s refresh"}
          </Badge>
        </div>
      </div>

      {/* ── Suggestions ── */}
      {isLoading && !suggestions.length ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading live chain for {symbol}…
        </div>
      ) : !suggestions.length ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          {spot ? "No qualifying setups — try lowering confidence or widening width." : `No chain data for ${symbol}.`}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {filtered.map((s) => (
            <SpreadCard key={s.id} s={s} capital={capital} riskPct={riskPct} />
          ))}
        </div>
      )}

      <p className="text-[9px] text-muted-foreground mt-auto pt-1">
        Auto-suggested from live chain premiums — decision support only, not investment advice.
        Margin = defined-risk spread margin (width − credit) × lot. Sizings use {riskPct}% capital risk per trade.
        Min profit = early exit at 50% credit capture; min loss = stop at 1.5× credit.
      </p>
    </div>
  );
}

function SpreadCard({ s, capital, riskPct }: { s: SpreadSuggestion; capital: number; riskPct: number }) {
  const meta = STRATEGY_META[s.strategy] ?? { label: s.strategy, cls: "" };
  const riskAmount = s.maxLossPerLot * s.lots;
  const riskPctOfCapital = (riskAmount / Math.max(capital, 1)) * 100;
  const rewardRisk = s.maxProfitPerLot / Math.max(s.maxLossPerLot, 1);
  const ev = (s.winProb / 100) * s.maxProfitPerLot - ((1 - s.winProb / 100) * s.maxLossPerLot);

  return (
    <div className="rounded-lg border bg-card p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-muted">
            <span className="text-[10px]">{s.symbol}</span>
            <span className="text-[8px] text-muted-foreground">{s.strike}</span>
          </div>
          <Badge variant="outline" className={`text-[9px] font-semibold ${meta.cls}`}>
            {meta.label}
          </Badge>
          <div className="flex items-center gap-1">
            {s.lots > 1 && (
              <Badge variant="secondary" className="text-[9px]">
                {s.lots} lots
              </Badge>
            )}
            <Badge variant="outline" className="text-[9px]">
              score {s.score}
            </Badge>
          </div>
        </div>
        <Badge variant={s.lots > 0 ? "default" : "destructive"} className="text-[9px]">
          {s.lots > 0 ? `${s.lots} lot${s.lots > 1 ? "s" : ""}` : "NO TRADE"}
        </Badge>
      </div>

      {/* Legs */}
      <div className="text-[10px] font-mono leading-relaxed">
        {s.legs.map((l, i) => (
          <div key={i} className="flex justify-between">
            <span className={l.action === "SELL" ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}>
              {l.action} {l.strike} {l.type}
            </span>
            <span className="text-right">₹{l.premium}</span>
          </div>
        ))}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] tabular-nums">
        <Metric label="Net credit" value={`₹${s.netCredit}`} tone="credit" />
        <Metric label="Amount needed" value={inr(s.marginPerLot * Math.max(s.lots, 1))} tone="warn" />
        <Metric label="Max profit / lot" value={inr(s.maxProfitPerLot)} tone="profit" />
        <Metric label="Max loss / lot" value={inr(s.maxLossPerLot)} tone="loss" />
        <Metric label="Min profit / lot" value={inr(s.minProfitPerLot)} tone="profit" />
        <Metric label="Min loss / lot" value={inr(s.minLossPerLot)} tone="loss" />
        <Metric label="Win est." value={`${s.winProb}%`} tone="credit" />
        <Metric label="Breakeven" value={s.breakeven.join(" / ")} tone="neutral" />
      </div>

      {s.lots > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] tabular-nums border-t pt-1">
          <Metric label="Total lots" value={`${s.lots}`} tone="neutral" />
          <Metric label="Risk % capital" value={`${riskPctOfCapital.toFixed(2)}%`} tone="warn" />
          <Metric label="Total max profit" value={inr(s.maxProfitPerLot * s.lots)} tone="profit" />
          <Metric label="Total max loss" value={inr(s.maxLossPerLot * s.lots)} tone="loss" />
          <Metric label="Reward:Risk" value={`${rewardRisk.toFixed(2)}:1`} tone="credit" />
          <Metric label="EV per lot" value={ev.toFixed(0)} tone="neutral" />
        </div>
      )}

      <div className="text-[9px] text-muted-foreground leading-snug">
        {s.reasons.join(" · ")}
      </div>

      {s.lots > 0 && (
        <div className="mt-1.5 flex gap-1">
          <Button size="sm" variant="outline" className="text-[9px] h-6 w-full" onClick={() => {}}>
            <Plus className="w-3 h-3 mr-1" /> Add to watchlist
          </Button>
          <Button size="sm" variant="outline" className="text-[9px] h-6 w-full" onClick={() => {}}>
            <Share2 className="w-3 h-3 mr-1" /> Share setup
          </Button>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "profit" | "loss" | "credit" | "warn" | "neutral";
}) {
  const color =
    tone === "profit"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "loss"
        ? "text-red-500"
        : tone === "credit"
          ? "text-blue-600 dark:text-blue-400"
          : tone === "warn"
            ? "text-amber-600 dark:text-amber-400"
            : "";
  return (
    <div className="flex justify-between gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </div>
  );
}