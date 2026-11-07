// FnoPulseBoard — ranked F&O momentum board (TheTradeCartel "Cartel Pulse"
// equivalent) embedded as a sub-mode of the EXISTING Scanner tab.
//
// Read-only consumer of /api/scanner/fno — no new data plumbing, no new
// formula: the score and metrics are computed by the route (audited
// 2026-10-20, every metric from the symbol's OWN quote + chain). This
// component only ranks, formats and explains them.
//
// Honesty rules: a row without a real price/score is dropped, never
// defaulted; the panel distinguishes "nothing above threshold" from
// "feed unavailable" and always shows the provenance badge.

"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, RefreshCw, AlertTriangle } from "lucide-react";
import { DataFreshnessBadge, type FreshnessMeta } from "./DataFreshnessBadge";

export interface PulseRow {
  rank: number;
  symbol: string;
  name: string;
  sector: string;
  score: number;
  ltp: number;
  changePct: number;
  signals: string[];
  oiSignal: string;
  oiChange: number | null;
  pcr: number | null;
  atmIV: number | null;
  ivPercentile: number | null;
  relVolume: number | null;
  premiumVelocity: number | null;
  sectorStrengthPct: number | null;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rr: number;
}

/**
 * Rank /api/scanner/fno candidates by score (desc) and map them to display
 * rows. Pure — unit-tested in tests/fno-pulse.test.ts.
 * Rows without a real score AND price are dropped (unavailable symbols stay
 * visible via the coverage summary, not as fake rows).
 */
export function rankPulseRows(payload: any): PulseRow[] {
  const candidates = payload?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter(
      (c: any) =>
        c &&
        typeof c.score === "number" &&
        typeof c.ltp === "number" &&
        Number.isFinite(c.score) &&
        Number.isFinite(c.ltp)
    )
    .slice()
    .sort((a: any, b: any) => b.score - a.score)
    .map((c: any, i: number) => {
      const m = c.metrics || {};
      return {
        rank: i + 1,
        symbol: c.symbol ?? "?",
        name: c.name ?? "",
        sector: c.sector ?? "",
        score: c.score,
        ltp: c.ltp,
        changePct: typeof c.changePct === "number" ? c.changePct : 0,
        signals: Array.isArray(c.signals) ? c.signals : [],
        oiSignal: m.oiSignal ?? "—",
        oiChange: typeof m.oiChange === "number" ? m.oiChange : null,
        pcr: typeof m.pcr === "number" ? m.pcr : null,
        atmIV: typeof m.atmIV === "number" ? m.atmIV : null,
        ivPercentile: typeof m.ivPercentile === "number" ? m.ivPercentile : null,
        relVolume: typeof m.relVolume === "number" ? m.relVolume : null,
        premiumVelocity:
          typeof m.premiumVelocity === "number" ? m.premiumVelocity : null,
        sectorStrengthPct:
          typeof m.sectorStrengthPct === "number" ? m.sectorStrengthPct : null,
        stopLoss: typeof c.stopLoss === "number" ? c.stopLoss : 0,
        tp1: typeof c.tp1 === "number" ? c.tp1 : 0,
        tp2: typeof c.tp2 === "number" ? c.tp2 : 0,
        rr: typeof c.rr === "number" ? c.rr : 0,
      };
    });
}

function scoreColor(score: number): string {
  if (score >= 75) return "text-emerald-500";
  if (score >= 60) return "text-teal-500";
  if (score >= 45) return "text-amber-500";
  return "text-red-500";
}

function signalBadge(signal: string): string {
  if (/long buildup|strong momentum|unusual volume/i.test(signal))
    return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (/short buildup|weakness/i.test(signal))
    return "bg-red-500/15 text-red-500 border-red-500/30";
  if (/short covering|long unwinding/i.test(signal))
    return "bg-amber-500/15 text-amber-500 border-amber-500/30";
  return "bg-blue-500/15 text-blue-500 border-blue-500/30";
}

const nf = (n: number | null, d = 2): string =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

const int = (n: number | null): string =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : Math.round(n).toLocaleString("en-IN");

export default function FnoPulseBoard() {
  const { data, isLoading, isFetching, refetch, error } = useQuery<any>({
    queryKey: ["fno-pulse"],
    queryFn: async () => {
      const res = await fetch(`/api/scanner/fno`, {
        signal: AbortSignal.timeout(60_000),
      });
      const json = await res.json().catch(() => null);
      if (!json) throw new Error("F&O pulse scan failed");
      return json;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });

  const rows = rankPulseRows(data);
  const meta: FreshnessMeta | null = data?.meta ?? null;
  const coverage = data?.coverage ?? null;
  const scanError: string | null =
    data?.status === "UNAVAILABLE"
      ? data?.error || "The F&O pulse feed is unavailable"
      : error
      ? String((error as any)?.message || "F&O pulse scan failed")
      : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Controls */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-3 py-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-sky-500" />
          <span className="text-[10px] font-bold text-muted-foreground">
            F&O Pulse — ranked momentum
          </span>
        </div>
        {meta && <DataFreshnessBadge meta={meta} showReason />}
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
        {coverage && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {coverage.quoted}/{coverage.requested} quoted · {coverage.chained}/
            {coverage.requested} chained
            {!coverage.complete && " · partial"}
          </span>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Activity className="h-12 w-12 mb-4 animate-pulse text-sky-500" />
            <p className="text-lg font-medium">Scanning F&O universe...</p>
            <p className="text-sm mt-1">Ranking stocks by real OI, IV and volume</p>
          </div>
        ) : scanError ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <AlertTriangle className="h-10 w-10 mb-3 text-red-500" />
            <p className="text-lg font-medium text-red-400">F&O Pulse unavailable</p>
            <p className="text-sm mt-1 max-w-md text-center">{scanError}</p>
            {meta?.reason ? (
              <p className="text-xs mt-1 text-zinc-500">{meta.reason}</p>
            ) : null}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <p className="text-lg font-medium">No ranked symbols</p>
            <p className="text-sm mt-1 max-w-md text-center">
              {coverage && coverage.quoted === 0
                ? "No F&O stock had a live quote in this scan."
                : "No symbol produced a score with real quote + chain data."}
            </p>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-background/95 backdrop-blur border-b">
              <tr className="text-muted-foreground">
                <th className="px-2 py-2 text-left font-semibold">#</th>
                <th className="px-3 py-2 text-left font-semibold">Symbol</th>
                <th className="px-2 py-2 text-right font-semibold">Score</th>
                <th className="px-2 py-2 text-right font-semibold">LTP</th>
                <th className="px-2 py-2 text-right font-semibold">Chg%</th>
                <th className="px-2 py-2 text-left font-semibold">OI Read</th>
                <th className="px-2 py-2 text-right font-semibold">PCR</th>
                <th className="px-2 py-2 text-right font-semibold">IV</th>
                <th className="px-2 py-2 text-right font-semibold">RelVol</th>
                <th className="px-2 py-2 text-left font-semibold">Signals</th>
                <th className="px-2 py-2 text-right font-semibold">SL</th>
                <th className="px-2 py-2 text-right font-semibold">TP1</th>
                <th className="px-2 py-2 text-right font-semibold">R:R</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.symbol}
                  className="border-b border-border/40 hover:bg-muted/40"
                  title={`${r.name}${r.sector ? ` · ${r.sector}` : ""} — score built from OI change, IV percentile, relative volume, price momentum and sector strength (computed by /api/scanner/fno, not here)`}
                >
                  <td className="px-2 py-1.5 text-muted-foreground tabular-nums">
                    {r.rank}
                  </td>
                  <td className="px-3 py-1.5 font-bold">{r.symbol}</td>
                  <td className={`px-2 py-1.5 text-right font-bold tabular-nums ${scoreColor(r.score)}`}>
                    {r.score}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">₹{nf(r.ltp)}</td>
                  <td
                    className={`px-2 py-1.5 text-right tabular-nums ${
                      r.changePct >= 0 ? "text-emerald-500" : "text-red-500"
                    }`}
                  >
                    {r.changePct >= 0 ? "+" : ""}
                    {r.changePct.toFixed(2)}%
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{r.oiSignal}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nf(r.pcr)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.atmIV === null ? "—" : `${r.atmIV.toFixed(1)}%`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nf(r.relVolume, 1)}x</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {r.signals.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        r.signals.slice(0, 3).map((s) => (
                          <Badge
                            key={s}
                            className={`${signalBadge(s)} text-[9px] px-1.5 py-0 border font-semibold`}
                          >
                            {s}
                          </Badge>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-red-500">
                    {r.stopLoss ? `₹${nf(r.stopLoss)}` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-emerald-500">
                    {r.tp1 ? `₹${nf(r.tp1)}` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">
                    {r.rr ? `1:${r.rr}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
