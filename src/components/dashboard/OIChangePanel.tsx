"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  aggregateStrikes,
  deriveStrikeRange,
  formatLakhCrore,
  sliceStrikesAroundATM,
  toggleExpiry,
  windowOiChange,
  type OiStrikeRow,
} from "@/lib/oi-panel";
import { getChainOiHistory, type ChainOiSnapshot } from "@/lib/market-history-client";
import type { ExpiryInfo } from "@/lib/expiry-calculator";

const TIME_WINDOWS = [
  { key: "5m", label: "Last 5 mins", ms: 5 * 60_000 },
  { key: "10m", label: "Last 10 mins", ms: 10 * 60_000 },
  { key: "15m", label: "Last 15 mins", ms: 15 * 60_000 },
  { key: "30m", label: "Last 30 mins", ms: 30 * 60_000 },
  { key: "1h", label: "Last 1 Hr", ms: 60 * 60_000 },
  { key: "2h", label: "Last 2 Hrs", ms: 2 * 60 * 60_000 },
  { key: "3h", label: "Last 3 Hrs", ms: 3 * 60 * 60_000 },
  { key: "day", label: "Full Day", ms: 0 },
] as const;

type WindowKey = (typeof TIME_WINDOWS)[number]["key"];

const TABS = ["OI Change", "Open Interest", "Multistrike OI", "Option OI vs Time", "Fut OI vs Time"] as const;
type Tab = (typeof TABS)[number];

const ATM_WINDOWS: (number | "all")[] = ["all", 5, 10, 15, 20, 25];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function legOi(leg: any): number {
  return leg && Number.isFinite(leg.oi) ? leg.oi : 0;
}

function legOiChg(leg: any): number {
  return leg && Number.isFinite(leg.oiChg) ? leg.oiChg : 0;
}

function toRow(r: any): OiStrikeRow {
  return {
    strike: r.strike,
    ce: r.ce && Number.isFinite(r.ce.oi) ? { oi: r.ce.oi, oiChg: legOiChg(r.ce) } : null,
    pe: r.pe && Number.isFinite(r.pe.oi) ? { oi: r.pe.oi, oiChg: legOiChg(r.pe) } : null,
  };
}

function fmtTime(ts: number | string): string {
  const d = typeof ts === "string" ? new Date(ts) : new Date(ts);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDayTitle(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

function fmtRefresh(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const day = `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${day}, ${h}:${m} ${ap}`;
}

function expiryLabel(e: ExpiryInfo): { text: string; badge: string } {
  const parts = e.date.split("-"); // DD-MMM-YYYY
  const text = parts.length >= 3 ? `${parts[0]} ${parts[1]} (${e.daysToExpiry} day${e.daysToExpiry === 1 ? "" : "s"})` : e.date;
  return { text, badge: e.type === "weekly" ? "W" : "M" };
}

function axisFmt(n: number): string {
  return formatLakhCrore(n);
}

export function OIChangePanel({
  symbol,
  spot,
  vix,
  pcr,
  expiries,
  selectedExpiry,
}: {
  symbol: string;
  spot: number;
  vix: number;
  pcr: number;
  expiries?: ExpiryInfo[];
  selectedExpiry?: string;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("OI Change");
  const [activeWindow, setActiveWindow] = useState<WindowKey>("day");
  const [selectedExpiries, setSelectedExpiries] = useState<string[]>([]);
  const [minStrike, setMinStrike] = useState<number | null>(null); // null = auto
  const [maxStrike, setMaxStrike] = useState<number | null>(null);
  const [atmWindow, setAtmWindow] = useState<number | "all">("all");
  const [multiStrikes, setMultiStrikes] = useState<number[]>([]);
  const [oiTimeStrike, setOiTimeStrike] = useState<number | null>(null);
  const touchedExpiries = useRef(false);

  // Follow the page's selected expiry until the user customises the checkboxes.
  useEffect(() => {
    if (!selectedExpiry) return;
    if (!touchedExpiries.current) setSelectedExpiries([selectedExpiry]);
  }, [selectedExpiry]);

  // Full reset when the symbol changes (new strike grid, new history, new expiries).
  useEffect(() => {
    touchedExpiries.current = false;
    setSelectedExpiries(selectedExpiry ? [selectedExpiry] : []);
    setMinStrike(null);
    setMaxStrike(null);
    setAtmWindow("all");
    setMultiStrikes([]);
    setOiTimeStrike(null);
    setActiveWindow("day");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const onToggleExpiry = (date: string, checked: boolean) => {
    touchedExpiries.current = true;
    setSelectedExpiries((cur) => {
      // Never allow an empty selection — the last expiry stays checked.
      if (!checked && cur.length <= 1) return cur;
      return toggleExpiry(cur, date, checked);
    });
  };

  // One chain query per selected expiry (≤3). Single-expiry selection shares
  // React Query's cache with the page's ['option-chain', symbol, expiry] entry
  // because the key and queryFn shape match page.tsx exactly.
  const chainQueries = useQueries({
    queries: selectedExpiries.map((exp) => ({
      queryKey: ["option-chain", symbol, exp],
      queryFn: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        try {
          const params = new URLSearchParams({ symbol });
          if (exp) params.set("expiry", exp);
          const res = await fetch(`/api/option-chain?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error("Failed to fetch");
          const json = await res.json();
          const base = json.data || json;
          return { ...base, analysis: json.analysis };
        } finally {
          clearTimeout(timeout);
        }
      },
      refetchInterval: 30000,
      staleTime: 5000,
      retry: 1,
    })),
  });

  const { data: history = [] } = useQuery<ChainOiSnapshot[]>({
    queryKey: ["chain-oi-history", symbol],
    queryFn: () => getChainOiHistory(symbol),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: futures } = useQuery<{ success: boolean; series: any[] }>({
    queryKey: ["futures-oi", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/futures-oi?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) throw new Error("futures-oi");
      return res.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const payloads = useMemo(
    () => chainQueries.map((q) => q.data).filter(Boolean) as any[],
    [chainQueries],
  );
  const chainLoading = chainQueries.some((q) => q.isFetching && !q.data);

  // ─── Strike grid: aggregate across selected expiries, derive step/ATM ───
  const rowsAll: OiStrikeRow[] = useMemo(
    () => aggregateStrikes(payloads.map((p) => (p.data || []).map(toRow))),
    [payloads],
  );

  const step = useMemo(() => {
    const sorted = rowsAll.map((r) => r.strike).sort((a, b) => a - b);
    let min = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > 0 && (min === 0 || gap < min)) min = gap;
    }
    return min > 0 ? min : 50;
  }, [rowsAll]);

  const atm = useMemo(() => {
    const fromSummary = payloads[0]?.summary?.atmStrike;
    if (Number.isFinite(fromSummary) && fromSummary > 0) return fromSummary;
    return Math.round(spot / step) * step;
  }, [payloads, spot, step]);

  const autoRange = useMemo(() => deriveStrikeRange(spot, atm, step), [spot, atm, step]);
  const effMin = minStrike ?? autoRange.min;
  const effMax = maxStrike ?? autoRange.max;

  const inRangeRows = useMemo(
    () => rowsAll.filter((r) => r.strike >= effMin && r.strike <= effMax),
    [rowsAll, effMin, effMax],
  );

  const visibleRows = useMemo(() => {
    const strikes = sliceStrikesAroundATM(inRangeRows.map((r) => r.strike), atm, atmWindow);
    const keep = new Set(strikes);
    return inRangeRows.filter((r) => keep.has(r.strike));
  }, [inRangeRows, atm, atmWindow]);

  // ─── OI change sources ───
  const hasHistory = history.length >= 2;

  const dayChangeRows = useMemo(() => {
    const exch = rowsAll.map((r) => ({
      strike: r.strike,
      ceChg: legOiChg(r.ce),
      peChg: legOiChg(r.pe),
    }));
    const exchNonZero = exch.some((r) => r.ceChg !== 0 || r.peChg !== 0);
    if (exchNonZero || !hasHistory) return exch;
    // Exchange reports 0 change off-session → derive the full-day move from
    // the recorder (first recorded snapshot of the day vs latest).
    const sorted = [...history].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    const first = Date.parse(sorted[0].timestamp);
    const last = Date.parse(sorted[sorted.length - 1].timestamp);
    return windowOiChange(history, Math.max(last - first, 60_000), last);
  }, [rowsAll, history, hasHistory]);

  const effectiveWindow: WindowKey =
    activeWindow !== "day" && !hasHistory ? "day" : activeWindow;

  const changeRows = useMemo(() => {
    if (effectiveWindow === "day") return dayChangeRows;
    const w = TIME_WINDOWS.find((x) => x.key === effectiveWindow)!;
    const last = Math.max(...history.map((h) => Date.parse(h.timestamp)));
    const chg = windowOiChange(history, w.ms, last);
    return rowsAll.map((r) => {
      const c = chg.find((x) => x.strike === r.strike);
      return { strike: r.strike, ceChg: c?.ceChg ?? 0, peChg: c?.peChg ?? 0 };
    });
  }, [effectiveWindow, dayChangeRows, history, rowsAll]);

  const chartRows = useMemo(() => {
    const chgMap = new Map(changeRows.map((c) => [c.strike, c]));
    return visibleRows.map((r) => {
      const c = chgMap.get(r.strike);
      return {
        strike: r.strike,
        callOi: legOi(r.ce),
        putOi: legOi(r.pe),
        callOiChg: c?.ceChg ?? 0,
        putOiChg: c?.peChg ?? 0,
      };
    });
  }, [visibleRows, changeRows]);

  const totals = useMemo(
    () =>
      chartRows.reduce(
        (acc, r) => ({
          callOi: acc.callOi + r.callOi,
          putOi: acc.putOi + r.putOi,
          callOiChg: acc.callOiChg + r.callOiChg,
          putOiChg: acc.putOiChg + r.putOiChg,
        }),
        { callOi: 0, putOi: 0, callOiChg: 0, putOiChg: 0 },
      ),
    [chartRows],
  );

  const sortedHistory = useMemo(
    () =>
      [...history].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
    [history],
  );

  const asOf = useMemo(() => {
    const p = payloads[0];
    return p?.asOf ?? p?.summary?.asOf ?? null;
  }, [payloads]);

  const dayTitle = fmtDayTitle(
    sortedHistory.length ? sortedHistory[sortedHistory.length - 1].timestamp : asOf,
  );

  // Multistrike / OI-vs-Time chip lists follow the strike range.
  const chipStrikes = useMemo(() => {
    const all = inRangeRows.map((r) => r.strike);
    if (all.length <= 24) return all;
    const centre = all.reduce((best, s) => (Math.abs(s - atm) < Math.abs(best - atm) ? s : best), all[0]);
    return all.filter((s) => Math.abs(s - centre) <= step * 12);
  }, [inRangeRows, atm, step]);

  useEffect(() => {
    if (activeTab === "Multistrike OI" && multiStrikes.length === 0 && chipStrikes.length > 0) {
      setMultiStrikes([atm]);
    }
    if (activeTab === "Option OI vs Time" && oiTimeStrike === null && chipStrikes.length > 0) {
      setOiTimeStrike(atm);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, chipStrikes.length]);

  const multiRows = useMemo(
    () =>
      visibleRows
        .filter((r) => multiStrikes.includes(r.strike))
        .map((r) => ({ strike: r.strike, callOi: legOi(r.ce), putOi: legOi(r.pe) })),
    [visibleRows, multiStrikes],
  );

  const oiTimeRows = useMemo(() => {
    if (oiTimeStrike === null) return [];
    return sortedHistory.map((snap) => {
      const row = snap.rows.find((r) => r.strike === oiTimeStrike);
      return {
        label: fmtTime(snap.timestamp),
        callOi: row?.ceOi ?? null,
        putOi: row?.peOi ?? null,
      };
    });
  }, [sortedHistory, oiTimeStrike]);

  const futRows = useMemo(
    () =>
      (futures?.series ?? []).map((r) => ({
        label: `${r.date.slice(8, 10)} ${MONTHS[Number(r.date.slice(5, 7)) - 1] ?? ""}`,
        oi: r.oi,
        oiChg: r.oiChg,
        close: r.close,
      })),
    [futures],
  );

  const spotLine = (
    <ReferenceLine
      x={spot}
      stroke="#e8a33d"
      strokeDasharray="4 3"
      strokeWidth={1}
      label={{
        value: `${symbol} ${spot.toFixed(0)}`,
        position: "insideTopRight",
        fontSize: 9,
        fill: "#e8a33d",
      }}
    />
  );

  const strikeAxis = (
    <XAxis
      dataKey="strike"
      type="number"
      domain={[effMin, effMax]}
      ticks={visibleRows.map((r) => r.strike)}
      tick={{ fontSize: 9 }}
      tickFormatter={(v: number) => String(v)}
      angle={-45}
      textAnchor="end"
      height={56}
      interval={0}
    />
  );

  const hasData = rowsAll.length > 0;
  const noExpiry = selectedExpiries.length === 0;

  return (
    <div className="rounded-xl border bg-card p-3">
      {/* ─── tabs + header ─── */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex flex-wrap gap-2 text-[10px]">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`text-[9px] px-2 py-0.5 rounded border ${activeTab === t ? "bg-primary text-white" : ""}`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground">
          INDIA VIX {Number(vix).toFixed(1)} PCR {Number(pcr).toFixed(2)}
        </div>
      </div>

      <div className="text-[11px] font-semibold mb-2">
        {activeTab === "OI Change" ? `OI Change on ${dayTitle}` : activeTab}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 text-xs">
        {/* ─── sidebar ─── */}
        <div className="col-span-1 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{symbol}</span>
            <span className="font-bold tabular-nums">{spot.toFixed(2)}</span>
          </div>

          <div>
            <div className="text-[10px] mb-1">Expiries Included</div>
            <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
              {(expiries ?? [])
                .filter((e) => !(e as any).expired)
                .slice(0, 8)
                .map((e) => {
                  const { text, badge } = expiryLabel(e);
                  const checked =
                    selectedExpiries.includes(e.date) ||
                    (selectedExpiries.length === 0 && e.date === selectedExpiry);
                  return (
                    <label key={e.date} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(ev) => onToggleExpiry(e.date, ev.target.checked)}
                        className="accent-primary"
                      />
                      <span>{text}</span>
                      <span className="text-[8px] px-1 rounded bg-muted text-muted-foreground">
                        {badge}
                      </span>
                    </label>
                  );
                })}
              {(expiries ?? []).length === 0 && (
                <div className="text-muted-foreground">No expiries</div>
              )}
            </div>
          </div>

          <div>
            <div className="text-[10px] mb-1 flex items-center justify-between">
              <span>Strike Range</span>
              <button
                className="text-primary hover:underline"
                onClick={() => {
                  setMinStrike(null);
                  setMaxStrike(null);
                }}
              >
                Reset
              </button>
            </div>
            <div className="flex gap-1 items-center">
              <Input
                type="number"
                value={effMin}
                onChange={(e) => setMinStrike(Number(e.target.value) || 0)}
                className="h-7 text-[10px] w-20"
                step={step}
              />
              <span className="text-muted-foreground">–</span>
              <Input
                type="number"
                value={effMax}
                onChange={(e) => setMaxStrike(Number(e.target.value) || 0)}
                className="h-7 text-[10px] w-20"
                step={step}
              />
            </div>
          </div>

          <div>
            <div className="text-[10px] mb-1">Strikes above and below ATM</div>
            <div className="flex flex-wrap gap-1">
              {ATM_WINDOWS.map((n) => (
                <Button
                  key={String(n)}
                  variant={atmWindow === n ? "default" : "outline"}
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => setAtmWindow(n)}
                >
                  {n === "all" ? "All" : n}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {/* ─── chart + time controls ─── */}
        <div className="col-span-3">
          <div className="h-[300px] border rounded-md p-2">
            <ResponsiveContainer width="100%" height="100%">
              {noExpiry ? (
                <div />
              ) : activeTab === "OI Change" ? (
                <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.4} />
                  {strikeAxis}
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={axisFmt} width={54} />
                  <Tooltip formatter={(v: any) => formatLakhCrore(Number(v))} />
                  <Legend />
                  {spotLine}
                  <Bar dataKey="putOiChg" name="Put OI chg" fill="#22c55e" />
                  <Bar dataKey="callOiChg" name="Call OI chg" fill="#ef4444" />
                </BarChart>
              ) : activeTab === "Open Interest" ? (
                <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.4} />
                  {strikeAxis}
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={axisFmt} width={54} />
                  <Tooltip formatter={(v: any) => formatLakhCrore(Number(v))} />
                  <Legend />
                  {spotLine}
                  <Bar dataKey="putOi" name="Put OI" fill="#22c55e" />
                  <Bar dataKey="callOi" name="Call OI" fill="#ef4444" />
                </BarChart>
              ) : activeTab === "Multistrike OI" ? (
                <BarChart data={multiRows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.4} />
                  <XAxis dataKey="strike" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={axisFmt} width={54} />
                  <Tooltip formatter={(v: any) => formatLakhCrore(Number(v))} />
                  <Legend />
                  <Bar dataKey="putOi" name="Put OI" fill="#22c55e" />
                  <Bar dataKey="callOi" name="Call OI" fill="#ef4444" />
                </BarChart>
              ) : activeTab === "Option OI vs Time" ? (
                <LineChart data={oiTimeRows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.4} />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={axisFmt} width={54} />
                  <Tooltip formatter={(v: any) => (v == null ? "—" : formatLakhCrore(Number(v)))} />
                  <Legend />
                  <Line type="monotone" dataKey="callOi" name="Call OI" stroke="#ef4444" dot={false} strokeWidth={1.5} connectNulls />
                  <Line type="monotone" dataKey="putOi" name="Put OI" stroke="#22c55e" dot={false} strokeWidth={1.5} connectNulls />
                </LineChart>
              ) : (
                <LineChart data={futRows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" strokeOpacity={0.4} />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={16} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={axisFmt} width={54} />
                  <Tooltip
                    formatter={(v: any, name: string) => {
                      if (name === "Close") return [Number(v).toFixed(2), name];
                      return [formatLakhCrore(Number(v)), name];
                    }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="oi" name="Fut OI (front month)" stroke="#3b82f6" dot={false} strokeWidth={1.5} />
                </LineChart>
              )}
            </ResponsiveContainer>

            {/* empty states overlay */}
            {!noExpiry && chainLoading && !hasData && (
              <div className="h-full -mt-[296px] flex items-center justify-center text-muted-foreground text-xs pointer-events-none">
                Loading chain…
              </div>
            )}
            {!noExpiry && !chainLoading && !hasData && (
              <div className="h-full -mt-[296px] flex items-center justify-center text-muted-foreground text-xs pointer-events-none">
                No chain data for this expiry
              </div>
            )}
            {activeTab === "Option OI vs Time" && hasData && !hasHistory && (
              <div className="h-full -mt-[296px] flex items-center justify-center text-muted-foreground text-xs pointer-events-none">
                No recorded intraday history yet today
              </div>
            )}
            {activeTab === "Fut OI vs Time" && futRows.length === 0 && (
              <div className="h-full -mt-[296px] flex items-center justify-center text-muted-foreground text-xs pointer-events-none">
                No EOD futures-OI archive yet (bhavcopy)
              </div>
            )}
            {activeTab === "Multistrike OI" && multiRows.length === 0 && hasData && (
              <div className="h-full -mt-[296px] flex items-center justify-center text-muted-foreground text-xs pointer-events-none">
                Select strikes below to compare OI
              </div>
            )}
          </div>

          {/* ─── strike chips (Multistrike / OI vs Time) ─── */}
          {activeTab === "Multistrike OI" && (
            <div className="flex flex-wrap gap-1 mt-2 max-h-20 overflow-y-auto">
              {chipStrikes.map((s) => {
                const on = multiStrikes.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() =>
                      setMultiStrikes((cur) =>
                        cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
                      )
                    }
                    className={`text-[9px] px-1.5 py-0.5 rounded border ${on ? "bg-primary text-white" : "bg-muted/40"}`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          )}
          {activeTab === "Option OI vs Time" && (
            <div className="flex flex-wrap gap-1 mt-2 max-h-20 overflow-y-auto">
              {chipStrikes.map((s) => (
                <button
                  key={s}
                  onClick={() => setOiTimeStrike(s)}
                  className={`text-[9px] px-1.5 py-0.5 rounded border ${oiTimeStrike === s ? "bg-primary text-white" : "bg-muted/40"}`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* ─── time windows (OI Change tab) ─── */}
          {activeTab === "OI Change" && (
            <div className="flex flex-wrap gap-1 mt-2">
              {TIME_WINDOWS.map((w) => {
                const disabled = w.key !== "day" && !hasHistory;
                return (
                  <Button
                    key={w.key}
                    variant={effectiveWindow === w.key ? "default" : "outline"}
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    disabled={disabled}
                    title={disabled ? "No recorded intraday history for this symbol yet" : undefined}
                    onClick={() => setActiveWindow(w.key)}
                  >
                    {w.label}
                  </Button>
                );
              })}
            </div>
          )}

          {/* ─── footer ─── */}
          <div className="mt-2 grid grid-cols-2 lg:grid-cols-4 gap-x-3 gap-y-1 text-[10px]">
            {activeTab === "OI Change" && (
              <>
                <div>
                  <span className="text-muted-foreground">Call OI change </span>
                  <span className="font-semibold tabular-nums">{formatLakhCrore(totals.callOiChg)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Put OI change </span>
                  <span className="font-semibold tabular-nums">{formatLakhCrore(totals.putOiChg)}</span>
                </div>
                {sortedHistory.length > 0 && (
                  <>
                    <div>
                      <span className="text-muted-foreground">{symbol} at {fmtTime(sortedHistory[0].timestamp)} </span>
                      <span className="font-semibold tabular-nums">
                        {(sortedHistory[0].spot ?? spot).toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        at {fmtTime(sortedHistory[sortedHistory.length - 1].timestamp)}{" "}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {(sortedHistory[sortedHistory.length - 1].spot ?? spot).toFixed(2)}
                      </span>
                    </div>
                  </>
                )}
              </>
            )}
            {activeTab === "Open Interest" && (
              <>
                <div>
                  <span className="text-muted-foreground">Call OI </span>
                  <span className="font-semibold tabular-nums">{formatLakhCrore(totals.callOi)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Put OI </span>
                  <span className="font-semibold tabular-nums">{formatLakhCrore(totals.putOi)}</span>
                </div>
              </>
            )}
            {activeTab === "Multistrike OI" && (
              <div className="col-span-2">
                <span className="text-muted-foreground">{multiStrikes.length} strike{multiStrikes.length === 1 ? "" : "s"} selected</span>
              </div>
            )}
            {activeTab === "Fut OI vs Time" && (
              <div className="col-span-2 text-muted-foreground">
                Daily EOD front-month OI (NSE bhavcopy) — NSE publishes no intraday futures OI in the archive
              </div>
            )}
          </div>

          <div className="text-[10px] text-muted-foreground mt-1 flex flex-wrap gap-x-3">
            <span>
              {activeTab === "OI Change"
                ? effectiveWindow === "day"
                  ? "Full-day change vs previous close"
                  : `Change vs ${fmtTime(
                      sortedHistory.length
                        ? Date.parse(sortedHistory[sortedHistory.length - 1].timestamp) -
                            TIME_WINDOWS.find((w) => w.key === effectiveWindow)!.ms
                        : Date.now() - TIME_WINDOWS.find((w) => w.key === effectiveWindow)!.ms,
                    )} snapshot`
                : "Live data from NSE"}
            </span>
            <span>OI last refreshed – {fmtRefresh(asOf)}</span>
            {selectedExpiries.length > 1 && activeTab === "OI Change" && effectiveWindow !== "day" && (
              <span className="text-amber-500">Window change uses recorded chain (nearest expiry only)</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
