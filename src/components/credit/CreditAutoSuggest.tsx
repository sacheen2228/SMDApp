"use client";

// ─── Credit Auto-Suggest Panel ────────────────────────────────────
// Fetches the live option chain (same /api/option-chain the app already
// uses — NSE/BSE/Breeze tree, so SENSEX works) and renders ranked
// credit-spread / iron-condor suggestions with full per-lot economics.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  suggestSpreads,
  type ChainRow,
  type SpreadSuggestion,
} from "@/lib/credit-spread-engine";
import { getLotSize } from "@/lib/symbol-config";

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

const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

export default function CreditAutoSuggest() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [capital, setCapital] = useState(100000);

  const lot = SYMBOLS.find((s) => s.value === symbol)?.lot ?? 65;

  const { data, isLoading, dataUpdatedAt, isFetching } = useQuery<any>({
    queryKey: ["option-chain", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/option-chain?symbol=${symbol}`);
      if (!res.ok) throw new Error(`chain ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const spot: number = data?.data?.spotPrice ?? data?.summary?.spotPrice ?? 0;
  const vix: number = data?.summary?.indiaVIX ?? data?.analysis?.greeks?.vix ?? 14;
  const expiry: string = data?.data?.selectedExpiry || data?.data?.expiry || "";
  const chain: ChainRow[] = useMemo(() => data?.data?.data ?? [], [data]);

  const suggestions: SpreadSuggestion[] = useMemo(() => {
    if (!spot || !chain.length) return [];
    return suggestSpreads({ chain, spot, lotSize: lot, vix, expiry, capital });
  }, [chain, spot, lot, vix, expiry, capital]);

  const stale = dataUpdatedAt ? Date.now() - dataUpdatedAt > 60_000 : true;

  return (
    <div className="flex flex-col gap-2 p-2 h-full overflow-auto">
      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={symbol} onValueChange={setSymbol}>
          <SelectTrigger className="h-7 w-[120px] text-[11px]">
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
          <span className="text-[10px] text-muted-foreground">Capital ₹</span>
          <Input
            type="number"
            value={capital}
            min={10000}
            step={10000}
            onChange={(e) => setCapital(Math.max(0, +e.target.value))}
            className="h-7 w-[90px] text-[11px]"
          />
        </div>

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

      {/* ── Suggestions ── */}
      {isLoading && !suggestions.length ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading live chain for {symbol}…
        </div>
      ) : !suggestions.length ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          {spot ? "No qualifying spreads (premiums too thin or chain empty)." : `No chain data for ${symbol}.`}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {suggestions.map((s) => (
            <SpreadCard key={s.id} s={s} />
          ))}
        </div>
      )}

      <p className="text-[9px] text-muted-foreground mt-auto pt-1">
        Auto-suggested from live chain premiums — decision support only, not investment advice.
        Margin = defined-risk spread margin (width − credit) × lot. Min profit = early exit at
        50% credit capture; min loss = stop when spread costs 2× credit.
      </p>
    </div>
  );
}

function SpreadCard({ s }: { s: SpreadSuggestion }) {
  const meta = STRATEGY_META[s.strategy] ?? { label: s.strategy, cls: "" };
  return (
    <div className="rounded-lg border bg-card p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        <Badge variant="outline" className={`text-[9px] font-semibold ${meta.cls}`}>
          {meta.label}
        </Badge>
        <div className="flex items-center gap-1">
          {s.affordableLots > 1 && (
            <Badge variant="secondary" className="text-[9px]">
              {s.affordableLots} lots
            </Badge>
          )}
          <Badge variant="outline" className="text-[9px] tabular-nums">
            score {s.score}
          </Badge>
        </div>
      </div>

      {/* Legs */}
      <div className="text-[10px] font-mono leading-relaxed">
        {s.legs.map((l, i) => (
          <div key={i} className={l.action === "SELL" ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}>
            {l.action} {l.strike} {l.type} @ ₹{l.premium}
          </div>
        ))}
      </div>

      {/* Economics per lot */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] tabular-nums">
        <Metric label="Net credit" value={`₹${s.netCredit}`} tone="credit" />
        <Metric label="Amount needed" value={inr(s.marginPerLot * Math.max(s.affordableLots, 1))} tone="warn" />
        <Metric label="Max profit" value={inr(s.maxProfitPerLot)} tone="profit" />
        <Metric label="Max loss" value={inr(s.maxLossPerLot)} tone="loss" />
        <Metric label="Min profit" value={inr(s.minProfitPerLot)} tone="profit" />
        <Metric label="Min loss" value={inr(s.minLossPerLot)} tone="loss" />
        <Metric label="Win est." value={`${s.winProb}%`} tone="credit" />
        <Metric
          label="Breakeven"
          value={s.breakeven.join(" / ")}
          tone="neutral"
        />
      </div>

      <div className="text-[9px] text-muted-foreground leading-snug">
        {s.reasons.join(" · ")}
      </div>
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
