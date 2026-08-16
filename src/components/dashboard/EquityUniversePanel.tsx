// EquityUniversePanel — Dynamic NSE/BSE cash-equity scanner with
// a CMP price filter (default ₹1,000). The filter applies ONLY to
// cash equities, never to indices/futures/options.

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, RefreshCw } from "lucide-react";

const PRICE_FILTERS = [
  { label: "₹100", value: 100 },
  { label: "₹250", value: 250 },
  { label: "₹500", value: 500 },
  { label: "₹750", value: 750 },
  { label: "₹1,000", value: 1000 },
  { label: "₹1,500", value: 1500 },
  { label: "₹2,000", value: 2000 },
  { label: "Custom", value: -1 },
];

type EquityResult = {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  regime: string;
  signalStrength: number;
  signalLabel: string;
  setup: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr: number;
  historicalExpectancy: number;
};

function signalColor(label: string): string {
  switch (label) {
    case "A+":
      return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
    case "A":
      return "bg-green-500/15 text-green-500 border-green-500/30";
    case "B":
      return "bg-blue-500/15 text-blue-500 border-blue-500/30";
    case "WATCH":
      return "bg-amber-500/15 text-amber-500 border-amber-500/30";
    default:
      return "bg-red-500/15 text-red-500 border-red-500/30";
  }
}

export default function EquityUniversePanel() {
  const [priceFilter, setPriceFilter] = useState<number>(1000);
  const [customPrice, setCustomPrice] = useState<number>(1000);
  const [showCustom, setShowCustom] = useState(false);
  const [minSignal, setMinSignal] = useState(60);

  const effectiveFilter = priceFilter === -1 ? customPrice : priceFilter;

  const { data, isLoading, isFetching, refetch } = useQuery<any>({
    queryKey: ["equity-universe", effectiveFilter, minSignal],
    queryFn: async () => {
      const res = await fetch(
        `/api/equity-universe?priceFilter=${effectiveFilter}&interval=5m&limit=200&minSignal=${minSignal}`,
        { signal: AbortSignal.timeout(60_000) }
      );
      if (!res.ok) throw new Error("Equity scan failed");
      const json = await res.json();
      return json.data;
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60_000,
  });

  const results: EquityResult[] = data?.results || [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Controls */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-3 py-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5 text-teal-500" />
          <span className="text-[10px] font-bold text-muted-foreground">Max CMP</span>
        </div>
        <Select
          value={priceFilter === -1 ? "custom" : String(priceFilter)}
          onValueChange={(v) => {
            if (v === "custom") {
              setShowCustom(true);
              setPriceFilter(-1);
            } else {
              setShowCustom(false);
              setPriceFilter(parseInt(v));
            }
          }}
        >
          <SelectTrigger className="h-6 w-[110px] text-[10px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRICE_FILTERS.map((f) => (
              <SelectItem key={f.label} value={f.label === "Custom" ? "custom" : String(f.value)}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showCustom && (
          <input
            type="number"
            value={customPrice}
            onChange={(e) => setCustomPrice(parseInt(e.target.value) || 1000)}
            className="h-6 w-20 rounded border bg-transparent px-2 text-[10px]"
            placeholder="₹"
          />
        )}
        <Select value={String(minSignal)} onValueChange={(v) => setMinSignal(parseInt(v))}>
          <SelectTrigger className="h-6 w-[90px] text-[10px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[50, 60, 70, 80].map((s) => (
              <SelectItem key={s} value={String(s)}>
                ≥ {s} pts
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2 font-bold"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        {data && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {data.scanned} scanned · {data.filtered} passed (CMP ≤ ₹{data.priceFilter.toLocaleString()})
          </span>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Search className="h-12 w-12 mb-4 animate-pulse text-teal-500" />
            <p className="text-lg font-medium">Scanning cash equities...</p>
            <p className="text-sm mt-1">Applying CMP filter ₹{effectiveFilter.toLocaleString()}</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <p className="text-lg font-medium">No setups found</p>
            <p className="text-sm mt-1">Try raising the price filter or lowering the score threshold</p>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-background/95 backdrop-blur border-b">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Symbol</th>
                <th className="px-2 py-2 text-right font-semibold">CMP</th>
                <th className="px-2 py-2 text-right font-semibold">Chg%</th>
                <th className="px-2 py-2 text-left font-semibold">Signal</th>
                <th className="px-2 py-2 text-left font-semibold">Setup</th>
                <th className="px-2 py-2 text-left font-semibold">Dir</th>
                <th className="px-2 py-2 text-right font-semibold">Entry</th>
                <th className="px-2 py-2 text-right font-semibold">SL</th>
                <th className="px-2 py-2 text-right font-semibold">TP1</th>
                <th className="px-2 py-2 text-right font-semibold">TP2</th>
                <th className="px-2 py-2 text-right font-semibold">R:R</th>
                <th className="px-2 py-2 text-right font-semibold">Exp</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.symbol} className="border-b border-border/40 hover:bg-muted/40">
                  <td className="px-3 py-1.5 font-bold">{r.symbol}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">₹{r.price.toFixed(1)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.changePct >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}%
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge className={`${signalColor(r.signalLabel)} text-[9px] px-1.5 py-0 border`}>
                      {r.signalLabel} {r.signalStrength}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[150px]">{r.setup}</td>
                  <td className={`px-2 py-1.5 font-bold ${r.direction === "LONG" ? "text-emerald-500" : "text-red-500"}`}>
                    {r.direction}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">₹{r.entry.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-red-500">₹{r.sl.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-emerald-500">₹{r.tp1?.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-emerald-500">₹{r.tp2?.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">{r.rr?.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{(r.historicalExpectancy ?? 0).toFixed(2)}R</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}