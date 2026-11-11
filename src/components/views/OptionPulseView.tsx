"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Activity, ChevronDown, RefreshCw, Target, Activity as ActivityIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel, StatCell, Chip, TimeframePills } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

function n(n: number | null, d = 0): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return d;
  return n;
}

function fmtLakh(n: number): string {
  if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
  if (Math.abs(n) >= 1e5) return (n / 1e5).toFixed(2) + "L";
  return n.toFixed(0);
}

function pcrVerdict(pcr: number): { label: string; tone: "up" | "down" | "neutral" } {
  if (pcr > 1.15) return { label: "Put-heavy — writers defending downside", tone: "down" };
  if (pcr < 0.85) return { label: "Call-heavy — writers capping upside", tone: "up" };
  return { label: "Balanced positioning", tone: "neutral" };
}

interface OptionLeg {
  oi: number;
  oiChg: number;
  iv: number;
  ltp: number;
  delta: number;
}

interface ChainRow {
  strike: number;
  ce: OptionLeg | null;
  pe: OptionLeg | null;
}

interface OptionPulseData {
  summary: {
    spotPrice: number;
    pcr: number;
    maxPain: number;
    atmStrike: number;
    indiaVIX: number | null;
    callOiChange: number;
    putOiChange: number;
    totalCallOI: number;
    totalPutOI: number;
  };
  strikes: ChainRow[];
  expiries: Array<{ date: string; label: string; daysToExpiry: number }>;
  lastUpdate: string;
  source: string;
  freshness: string;
}

function fetchOptionPulse(symbol: string, expiry?: string) {
  const params = new URLSearchParams({ symbol });
  if (expiry) params.set("expiry", expiry);
  return fetch(`/api/option-chain?${params}`).then(async (r) => {
    if (!r.ok) throw new Error("option-chain failed");
    const json = await r.json();
    const d = json.data || json;
    const fr = d.freshness;
    return {
      ...d,
      source: d.source || fr?.source || "UNKNOWN",
      freshness: typeof fr === "string" ? fr : fr?.freshness || "UNKNOWN",
    } as OptionPulseData;
  });
}

export function OptionPulseView() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [expiry, setExpiry] = useState<string | undefined>(undefined);
  const { data, isLoading, error } = useQuery<OptionPulseData>({
    queryKey: ["option-pulse", symbol, expiry],
    queryFn: () => fetchOptionPulse(symbol, expiry),
    refetchInterval: 30000,
    staleTime: 10000,
    retry: 1,
  });

  const summary = data?.summary;
  const strikes = data?.strikes ?? [];
  const expiries = data?.expiries ?? [];

  const atm = n(summary?.atmStrike);
  const spot = n(summary?.spotPrice);
  const pcr = n(summary?.pcr);
  const maxPain = n(summary?.maxPain);
  const iv = n(summary?.indiaVIX);

  const verdict = pcrVerdict(pcr);
  const callOiChange = n(summary?.callOiChange);
  const putOiChange = n(summary?.putOiChange);

  // ATM window strikes for center table (±5 strikes)
  const center = useMemo(() => {
    if (!strikes.length) return [];
    const mid = strikes.findIndex((s) => s.strike >= atm);
    const start = Math.max(0, mid - 5);
    const end = Math.min(strikes.length, mid + 6);
    return strikes.slice(start, end);
  }, [strikes, atm]);

  const maxCallOi = Math.max(...center.map((s) => n(s.ce?.oi)), 1);
  const maxPutOi = Math.max(...center.map((s) => n(s.pe?.oi)), 1);

  const ivPoints = center.map((s) => ({
    strike: String(s.strike),
    ceIV: n(s.ce?.iv),
    peIV: n(s.pe?.iv),
  }));

  if (isLoading) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <ActivityIcon className="mx-auto h-8 w-8 animate-spin text-ty-muted-fg mb-2" />
        <p className="ty-text-body-sm text-ty-muted-fg">Loading option chain…</p>
      </div>
    );
  }
  if (error || !summary) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <p className="ty-text-xs text-ty-down">{String(error?.message ?? "No data")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="ty-text-title font-semibold text-foreground">Option Pulse</h1>
          <p className="ty-text-xs text-ty-subtle-fg">
            {symbol} · {expiry ?? expiries[0]?.label ?? "nearest expiry"} ·
            updated {data?.lastUpdate ? new Date(data.lastUpdate).toLocaleTimeString("en-IN") : "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={symbol} onValueChange={(v) => setSymbol(v as string)}>
            <SelectTrigger className="w-[90px] px-2">
              <SelectValue placeholder={symbol} />
            </SelectTrigger>
            <SelectContent>
              {SYMBOLS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
          <Badge variant="outline" className="px-2 py-1">
            {data.freshness}
          </Badge>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCell label="Spot" value={spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })} change={{ value: "", up: true }} />
        <StatCell label="PCR" value={pcr.toFixed(2)} change={{ value: verdict.label, up: verdict.tone === "up" }} />
        <StatCell label="Max Pain" value={maxPain.toLocaleString("en-IN")} />
        <StatCell label="ATM IV" value={iv ? iv.toFixed(1) : "—"} change={{ value: "", up: true }} />
        <StatCell label="VIX" value={n(data?.summary?.indiaVIX).toFixed(1)} change={{ value: "", up: true }} />
        <StatCell label="Source" value={data.source.toUpperCase()} />
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        {/* Left: Writers' walls + Expected range */}
        <div className="lg:col-span-4 space-y-3">
          <Panel title="Writers' Walls" subtitle="Top open-interest walls by strike">
            <div className="space-y-2">
              {center.slice(0, 5).map((s) => {
                const callShare = Math.min(100, (n(s.ce?.oi) / maxCallOi) * 100);
                const putShare = Math.min(100, (n(s.pe?.oi) / maxPutOi) * 100);
                return (
                  <div key={s.strike} className="flex items-center gap-2">
                    <span className="w-14 ty-text-xs text-right text-ty-subtle-fg">{s.strike}</span>
                    <div className="flex-1 h-2 bg-ty-fill rounded overflow-hidden">
                      <div className="h-full bg-ty-down/60 rounded" style={{ width: `${putShare}%` }} />
                    </div>
                    <div className="flex-1 h-2 bg-ty-fill rounded overflow-hidden">
                      <div className="h-full bg-ty-up/60 rounded" style={{ width: `${callShare}%` }} />
                    </div>
                    <span className="w-10 ty-text-xs text-right font-medium">
                      {fmtLakh(n(s.ce?.oi) + n(s.pe?.oi))}
                    </span>
                  </div>
                );
              })}
              <div className="pt-2 border-t border-ty-hairline">
                <div className="flex justify-between ty-text-xs mb-1">
                  <span className="text-ty-subtle-fg">Max Pain</span>
                  <span className="font-semibold">{maxPain.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between ty-text-xs">
                  <span className="text-ty-subtle-fg">Call Writing</span>
                  <span className="font-semibold text-ty-up">{callOiChange > 0 ? "+" : ""}{fmtLakh(callOiChange)}</span>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Expected Range" subtitle="ATM straddle 1σ move">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 p-3 bg-ty-fill rounded">
                <div className="flex flex-col gap-0.5">
                  <span className="ty-text-xs text-ty-subtle-fg">Support</span>
                  <span className="ty-text-title font-semibold">{Math.round(spot * 0.98).toLocaleString("en-IN")}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="ty-text-xs text-ty-subtle-fg">Resistance</span>
                  <span className="ty-text-title font-semibold">{Math.round(spot * 1.02).toLocaleString("en-IN")}</span>
                </div>
              </div>
              <div className="p-3 border border-ty-hairline rounded text-center">
                <span className="ty-text-xs block text-ty-subtle-fg">Expected move</span>
                <span className="ty-text-title font-bold">{Math.round(spot * 0.02).toLocaleString("en-IN")} pts</span>
              </div>
            </div>
          </Panel>
        </div>

        {/* Center: Strike table */}
        <div className="lg:col-span-6 space-y-3">
          <Panel title={`Strike Table · PUT OI │ STRIKE │ CALL OI`} subtitle={`${center.length} strikes around ATM ${atm}`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-ty-hairline">
                    <th className="ty-stat-label pr-2 py-2 text-right">PUT OI</th>
                    <th className="ty-stat-label px-3 py-2">STRIKE</th>
                    <th className="ty-stat-label pl-2 py-2">CALL OI</th>
                    <th className="ty-stat-label pr-2 py-2 text-right">PUT Chg</th>
                    <th className="ty-stat-label pl-2 py-2">CALL Chg</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ty-hairline">
                  {center.map((s) => {
                    const isMaxPain = s.strike === maxPain;
                    const isAtm = s.strike === atm;
                    return (
                      <tr key={s.strike} className={cn("group hover:bg-ty-fill/50 transition-colors", isMaxPain ? "ty-glow-brand" : "")}>
                        <td className="pr-2 py-2 text-right font-mono">
                          <div className="flex items-end gap-1">
                            <div className="w-1 bg-ty-down/40 rounded-t" style={{ height: `${Math.min(40, Math.max(4, (n(s.pe?.oi) / maxPutOi) * 40))}px` }} />
                            <span>{fmtLakh(n(s.pe?.oi))}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold text-foreground">
                          <Chip active={isMaxPain} tone="brand">
                            {s.strike}{isMaxPain ? " · MAX PAIN" : ""}{isAtm ? " · ATM" : ""}
                          </Chip>
                        </td>
                        <td className="pl-2 py-2 font-mono">
                          <div className="flex items-end gap-1">
                            <div className="w-1 bg-ty-up/40 rounded-t" style={{ height: `${Math.min(40, Math.max(4, (n(s.ce?.oi) / maxCallOi) * 40))}px` }} />
                            <span>{fmtLakh(n(s.ce?.oi))}</span>
                          </div>
                        </td>
                        <td className="pr-2 py-2 text-right ty-text-xs font-mono">
                          {n(s.pe?.oiChg) >= 0 ? "+" : ""}{n(s.pe?.oiChg).toLocaleString("en-IN")}
                        </td>
                        <td className="pl-2 py-2 ty-text-xs font-mono">
                          {n(s.ce?.oiChg) >= 0 ? "+" : ""}{n(s.ce?.oiChg).toLocaleString("en-IN")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="ty-text-xs text-ty-subtle-fg mt-2">
              Bars sized to max OI in window · {verdict.label}
            </p>
          </Panel>
        </div>

        {/* Right: IV smile + chain says */}
        <div className="lg:col-span-2 space-y-3">
          <Panel title="IV Smile" subtitle="Call vs Put IV by strike">
            <div className="h-[220px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={ivPoints}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--ty-hairline)" />
                  <XAxis dataKey="stroke" tickFormatter={(v) => String(v)} tickFontSize="9px" />
                  <YAxis tickFormatter={(v) => v + "%"} tickFontSize="9px" />
                  <Tooltip />
                  <Line type="monotone" dataKey="ceIV" stroke="var(--ty-up)" strokeWidth={2} dot={false} name="CE IV" />
                  <Line type="monotone" dataKey="peIV" stroke="var(--ty-down)" strokeWidth={2} dot={false} name="PE IV" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="What the Chain Says" subtitle="Plain-English read">
            <div className="space-y-2">
              <div className="flex items-start gap-2 p-3 bg-ty-fill rounded">
                <ActivityIcon className="h-4 w-4 mt-0.5 text-ty-brand flex-shrink-0" />
                <p className="ty-text-body-sm text-foreground leading-relaxed">
                  PCR {pcr.toFixed(2)} → {verdict.label}.{" "}
                  {callOiChange > 0 && putOiChange < 0 ? "Call writers adding, put writers unwinding — bullish tilt." : ""}
                  {putOiChange > 0 && callOiChange < 0 ? "Put writers adding, call writers unwinding — bearish tilt." : ""}
                </p>
              </div>
              <div className="flex justify-between ty-text-xs mb-2">
                <span className="text-ty-subtle-fg">Net OI Change</span>
                <span className="font-semibold">
                  {(putOiChange + callOiChange >= 0 ? "+" : "")}{(putOiChange + callOiChange).toLocaleString("en-IN")}
                </span>
              </div>
              <div className="flex justify-between ty-text-xs">
                <span className="text-ty-subtle-fg">Freshness</span>
                <span className="font-semibold">{data.freshness}</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
