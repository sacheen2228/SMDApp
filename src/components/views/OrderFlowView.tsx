"use client";

import { useMemo, useState } from "react";
import { Scissors, Activity as ActivityIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { OrderBookPanel } from "@/components/orderbook/OrderBookPanel";
import { Panel } from "@/components/ui/panel";

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

function n(v: number | null | undefined, d = 0): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return d;
  return v;
}

function fmtLakh(val: number): string {
  if (Math.abs(val) >= 1e7) return (val / 1e7).toFixed(2) + "Cr";
  if (Math.abs(val) >= 1e5) return (val / 1e5).toFixed(2) + "L";
  return val.toFixed(0);
}

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number };

interface OrderFlowData {
  symbol: string;
  spot: number;
  pcr: number;
  totalCallOI: number;
  totalPutOI: number;
  callOiChange: number;
  putOiChange: number;
  candles: Candle[];
  domDepth: Array<{ strike: number; ceBidQty: number; ceAskQty: number; peBidQty: number; peAskQty: number }>;
  lastUpdate: string;
  source: string;
  freshness: string;
}

function fetchOrderFlow(symbol: string) {
  const chainPromise = fetch(`/api/option-chain?symbol=${symbol}`).then(async (r) => {
    if (!r.ok) throw new Error("chain failed");
    return r.json();
  });
  const candlePromise = fetch(`/api/breeze/candles?symbol=${symbol}&interval=5m&limit=200`).then(async (r) => {
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || []).map((c: any) => ({
      time: c.time, open: n(c.open), high: n(c.high), low: n(c.low), close: n(c.close), volume: n(c.volume),
    }));
  });
  return Promise.all([chainPromise, candlePromise]).then(([json, candles]) => {
    const d = json.data || json;
    const fr = d.freshness;
    const s = d.summary || {};
    const rows = (d.data || d.strikes || []);
    return {
      symbol,
      spot: n(s.spotPrice),
      pcr: n(s.pcr),
      totalCallOI: n(s.totalCallOI),
      totalPutOI: n(s.totalPutOI),
      callOiChange: n(s.callOiChange),
      putOiChange: n(s.putOiChange),
      candles: candles as Candle[],
      domDepth: rows.map((r: any) => ({
        strike: r.strike,
        ceBidQty: r.ce?.bid != null ? Number(r.ce.bid) : NaN,
        ceAskQty: r.ce?.ask != null ? Number(r.ce.ask) : NaN,
        peBidQty: r.pe?.bid != null ? Number(r.pe.bid) : NaN,
        peAskQty: r.pe?.ask != null ? Number(r.pe.ask) : NaN,
      })),
      lastUpdate: d.lastUpdate || json.lastUpdate,
      source: d.source || json.source || fr?.source || "UNKNOWN",
      freshness: typeof fr === "string" ? fr : fr?.freshness || "UNKNOWN",
    } as OrderFlowData;
  });
}

/* ═══════════ Money-flow sankey (market → sectors → stocks) ═══════════ */
interface SectorNode { name: string; count: number; chg: number; stocks: Array<{ symbol: string; changePct: number }> }
interface HeatStock { symbol: string; changePct: number }

/* symbol → heatmap market mapping (the sankey follows the selected index) */
const MARKET_OF: Record<string, string> = {
  NIFTY: "NIFTY50",
  BANKNIFTY: "BANKNIFTY",
  FINNIFTY: "NIFTY50",
  MIDCPNIFTY: "NIFTY50",
  SENSEX: "SENSEX",
};

function fetchMoneyFlow(market: string) {
  return fetch(`/api/market/heatmap?market=${market}`).then(async (r) => {
    if (!r.ok) throw new Error("heatmap failed");
    const json = await r.json();
    const all: HeatStock[] = json.stocks || [];
    const rawSectors: Array<{ name: string; stocks: HeatStock[] }> = json.sectors || [];
    const sectors: SectorNode[] = rawSectors
      .map((s) => {
        const stocks = (s.stocks || []).map((x) => ({ symbol: x.symbol, changePct: n(x.changePct) }));
        const chg = stocks.length ? stocks.reduce((a, b) => a + b.changePct, 0) / stocks.length : 0;
        return { name: s.name, count: stocks.length, chg, stocks };
      })
      .filter((s) => s.count > 0)
      .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))
      .slice(0, 6);
    // right column: biggest movers, each tagged with its sector
    const movers = all
      .map((x) => ({ ...x, changePct: n(x.changePct) }))
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 6)
      .map((m) => ({ ...m, sector: sectors.find((sec) => sec.stocks.some((x) => x.symbol === m.symbol))?.name ?? "" }));
    const advancing = all.filter((x) => n(x.changePct) > 0).length;
    return { sectors, movers, advancing, declining: all.length - advancing, total: all.length } as {
      sectors: SectorNode[]; movers: Array<HeatStock & { sector: string }>; advancing: number; declining: number; total: number;
    };
  });
}

/* SVG sankey with animated flow dots */
function MoneyFlowSankey({ sectors, movers }: { sectors: SectorNode[]; movers: Array<HeatStock & { sector: string }> }) {
  const W = 1200, H = 540;
  const cx = 120, cy = H / 2, r = 74;
  const secX = 420, cardW = 300, cardH = 60;
  const stX = 920, stCardW = 260, stCardH = 48;

  const secY = (i: number) => 30 + i * (cardH + 18);
  const stY = (i: number) => 55 + i * (stCardH + 26);

  const link = (x0: number, y0: number, x1: number, y1: number) =>
    `M ${x0} ${y0} C ${x0 + (x1 - x0) * 0.45} ${y0}, ${x0 + (x1 - x0) * 0.55} ${y1}, ${x1} ${y1}`;

  const chgColor = (c: number) => (c > 0 ? "var(--ty-up)" : c < 0 ? "var(--ty-down)" : "var(--ty-muted-fg)");

  return (
    <div className="rounded-lg border border-ty-hairline bg-ty-surface overflow-hidden">
      <div className="border-b border-ty-hairline px-5 py-4">
        <p className="ty-text-xs font-mono tracking-wider text-ty-up">MARKET → SECTORS → ORDER BLOCKS</p>
        <h2 className="ty-text-title font-semibold text-foreground mt-0.5">Follow the money.</h2>
        <p className="ty-text-xs text-ty-subtle-fg">F&O money flow, decoded. Widths follow sector drift; dots pulse with the flow.</p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* market core */}
        <circle cx={cx} cy={cy} r={r + 10} fill="none" stroke="var(--ty-up)" strokeWidth="1" opacity="0.25" />
        <circle cx={cx} cy={cy} r={r} fill="var(--ty-fill)" stroke="var(--ty-up)" strokeWidth="1.5" opacity="0.9" />
        <circle cx={cx} cy={cy} r={r - 8} fill="none" stroke="var(--ty-up)" strokeWidth="0.5" strokeDasharray="2 4" opacity="0.4" />
        <text x={cx} y={cy - 6} textAnchor="middle" className="fill-foreground" style={{ fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>NSE</text>
        <text x={cx} y={cy + 16} textAnchor="middle" fill="var(--ty-subtle-fg)" style={{ fontSize: 11, letterSpacing: 3 }}>MARKET</text>
        <text x={cx} y={cy + 42} textAnchor="middle" fill="var(--ty-subtle-fg)" style={{ fontSize: 10 }}>{sectors.reduce((a, s) => a + s.count, 0)} F&O STOCKS</text>

        {/* market → sector links */}
        {sectors.map((s, i) => {
          const y1 = secY(i) + cardH / 2;
          const d = link(cx + r - 4, cy, secX - 4, y1);
          return (
            <g key={`ml-${s.name}`}>
              <path d={d} fill="none" stroke={chgColor(s.chg)} strokeWidth={Math.max(1.5, Math.min(5, Math.abs(s.chg) * 1.2))} opacity="0.35" />
              {[0, 1].map((k) => (
                <circle key={k} r="2.5" fill={chgColor(s.chg)}>
                  <animateMotion dur={`${2.2 + k * 0.9}s`} repeatCount="indefinite" begin={`${k * 1.1}s`} path={d} />
                </circle>
              ))}
            </g>
          );
        })}

        {/* sector cards */}
        {sectors.map((s, i) => {
          const y = secY(i);
          return (
            <g key={s.name}>
              <rect x={secX} y={y} width={cardW} height={cardH} rx="10" fill="var(--ty-fill)" stroke="var(--ty-hairline-strong)" />
              <text x={secX + 14} y={y + 24} className="fill-foreground" style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>{s.name.toUpperCase()}</text>
              <text x={secX + 14} y={y + 42} fill="var(--ty-subtle-fg)" style={{ fontSize: 10 }}>{s.count} F&O STOCKS · INFLOW EST.</text>
              <text x={secX + cardW - 14} y={y + 26} textAnchor="end" fill={chgColor(s.chg)} style={{ fontSize: 15, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                {s.chg > 0 ? "+" : ""}{s.chg.toFixed(2)}%
              </text>
              <rect x={secX + 14} y={y + cardH - 8} width={(cardW - 28) * Math.min(1, Math.abs(s.chg) / 4)} height="3" rx="1.5" fill={chgColor(s.chg)} />
            </g>
          );
        })}

        {/* sector → stock links */}
        {movers.map((m, i) => {
          const si = sectors.findIndex((s) => s.name === m.sector);
          if (si < 0) return null;
          const y0 = secY(si) + cardH / 2;
          const y1 = stY(i) + stCardH / 2;
          const d = link(secX + cardW, y0, stX - 4, y1);
          return (
            <g key={`sl-${m.symbol}`}>
              <path d={d} fill="none" stroke={chgColor(m.changePct)} strokeWidth={Math.max(1.5, Math.min(5, Math.abs(m.changePct) * 1.2))} opacity="0.35" />
              <circle r="2.5" fill={chgColor(m.changePct)}>
                <animateMotion dur={`${2.6 + (i % 3) * 0.7}s`} repeatCount="indefinite" begin={`${i * 0.4}s`} path={d} />
              </circle>
            </g>
          );
        })}

        {/* stock cards */}
        {movers.map((m, i) => {
          const y = stY(i);
          return (
            <g key={m.symbol}>
              <rect x={stX} y={y} width={stCardW} height={stCardH} rx="10" fill="var(--ty-fill)" stroke="var(--ty-hairline-strong)" />
              <text x={stX + 14} y={y + 20} className="fill-foreground" style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>{m.symbol}</text>
              <text x={stX + stCardW - 14} y={y + 20} textAnchor="end" fill={chgColor(m.changePct)} style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                {m.changePct > 0 ? "+" : ""}{m.changePct.toFixed(2)}%
              </text>
              <rect x={stX + 14} y={y + stCardH - 10} width={(stCardW - 28) * Math.min(1, Math.abs(m.changePct) / 4)} height="2.5" rx="1.25" fill={chgColor(m.changePct)} />
            </g>
          );
        })}
      </svg>
      <div className="border-t border-ty-hairline px-5 py-3 flex items-center gap-6 ty-text-xs">
        <span className="text-ty-up font-semibold">▲ {movers.filter((m) => m.changePct > 0).length} movers buying</span>
        <span className="text-ty-down font-semibold">▼ {movers.filter((m) => m.changePct < 0).length} movers selling</span>
        <span className="text-ty-subtle-fg">breadth: {movers.length ? Math.round((movers.filter((m) => m.changePct > 0).length / movers.length) * 100) : 0}% of top movers green</span>
      </div>
    </div>
  );
}

/* ══════════════════════════ VIEW ══════════════════════════ */
export function OrderFlowView() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [view, setView] = useState("money");

  const { data, isLoading, error } = useQuery<OrderFlowData>({
    queryKey: ["orderflow", symbol],
    queryFn: () => fetchOrderFlow(symbol),
    refetchInterval: 30000,
    staleTime: 10000,
    retry: 1,
  });
  const { data: flow, isLoading: flowLoading, error: flowError } = useQuery({
    queryKey: ["moneyflow", symbol],
    queryFn: () => fetchMoneyFlow(MARKET_OF[symbol] || "NIFTY50"),
    refetchInterval: 60000,
    staleTime: 30000,
    retry: 1,
  });

  const spot = data?.spot ?? 0;
  const pcr = data?.pcr ?? 0;

  // CVD from candles: close>open → buy vol, close<open → sell vol
  const cvd = useMemo(() => {
    const out: { t: string; v: number }[] = [];
    let cum = 0;
    (data?.candles ?? []).slice(-100).forEach((c) => {
      const delta = c.close >= c.open ? c.volume : -c.volume;
      cum += delta;
      out.push({ t: new Date(c.time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }), v: cum });
    });
    return out;
  }, [data?.candles]);

  const topDom = useMemo(() => {
    const withDepth = (data?.domDepth ?? []).filter((d) =>
      Number.isFinite(d.ceBidQty) || Number.isFinite(d.ceAskQty) || Number.isFinite(d.peBidQty) || Number.isFinite(d.peAskQty));
    return withDepth
      .sort((a, b) => {
        const av = (Number.isFinite(a.ceBidQty) ? a.ceBidQty : 0) + (Number.isFinite(a.peAskQty) ? a.peAskQty : 0);
        const bv = (Number.isFinite(b.ceBidQty) ? b.ceBidQty : 0) + (Number.isFinite(b.peAskQty) ? b.peAskQty : 0);
        return bv - av;
      })
      .slice(0, 8);
  }, [data?.domDepth]);

  if (isLoading || flowLoading) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <ActivityIcon className="mx-auto h-8 w-8 animate-spin text-ty-muted-fg mb-2" />
        <p className="ty-text-body-sm text-ty-muted-fg">Loading order flow…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="ty-panel ty-panel-raised p-10 text-center">
        <p className="ty-text-xs text-ty-down">{String(error?.message ?? "No data")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="ty-text-title font-semibold text-foreground">Order Flow</h1>
          <p className="ty-text-xs text-ty-subtle-fg">
            money flow · depth · CVD · strike book · {data.freshness}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={symbol} onValueChange={(v) => setSymbol(v as string)}>
            <SelectTrigger className="w-[110px] px-2">
              <SelectValue placeholder={symbol} />
            </SelectTrigger>
            <SelectContent>
              {SYMBOLS.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant="outline" className="px-2 py-1">{data.source.toUpperCase()}</Badge>
        </div>
      </div>

      <Tabs defaultValue="money" value={view} onValueChange={(v) => setView(v)} className="w-full">
        <TabsList className="grid w-full max-w-[420px] grid-cols-4">
          <TabsTrigger value="money" className="ty-text-xs">Money Flow</TabsTrigger>
          <TabsTrigger value="depth" className="ty-text-xs">Depth</TabsTrigger>
          <TabsTrigger value="cvd" className="ty-text-xs">CVD</TabsTrigger>
          <TabsTrigger value="dom" className="ty-text-xs">Strike Book</TabsTrigger>
        </TabsList>

        <TabsContent value="money" className="mt-4 space-y-3">
          {flowError ? (
            <Panel title="Money flow" subtitle="unavailable">
              <p className="ty-text-xs text-ty-down">{String(flowError?.message ?? "heatmap failed")}</p>
            </Panel>
          ) : flow && flow.sectors.length > 0 ? (
            <MoneyFlowSankey sectors={flow.sectors} movers={flow.movers} />
          ) : (
            <Panel title="Money flow" subtitle="waiting for data"><p className="ty-text-xs text-ty-muted-fg">No sector data yet.</p></Panel>
          )}
        </TabsContent>

        <TabsContent value="depth" className="mt-4 space-y-3">
          <div className="ty-panel ty-panel-raised p-4 h-[600px]">
            <div className="flex items-center gap-2 mb-3">
              <Scissors className="h-4 w-4 text-ty-muted-fg" />
              <span className="ty-text-xs font-semibold text-foreground">Index Depth — NIFTY / SENSEX</span>
            </div>
            <OrderBookPanel />
          </div>
        </TabsContent>

        <TabsContent value="cvd" className="mt-4 space-y-3">
          <Panel title="Cumulative Volume Delta (CVD)" subtitle="Derived from 5m candles (close ≥ open = buy)">
            <div className="h-[340px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={cvd}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--ty-hairline)" />
                  <XAxis dataKey="t" tickFormatter={(v) => String(v)} tickFontSize="9px" />
                  <YAxis tickFormatter={(v) => v > 0 ? "+" + v : v} tickFontSize="9px" />
                  <Tooltip />
                  <Line type="monotone" dataKey="v" stroke="var(--ty-brand)" strokeWidth={2} dot={false} />
                  <ReferenceLine x={0} y={0} stroke="var(--ty-muted-fg)" strokeWidth={1} strokeDasharray="2 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between ty-text-xs mt-2">
              <span className="text-ty-subtle-fg">Latest CVD</span>
              <span className="font-mono font-semibold">{cvd.length ? cvd[cvd.length - 1].v.toFixed(0) : "—"}</span>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="dom" className="mt-4 space-y-3">
          <Panel title="Strike Depth (DOM)" subtitle="bid/ask qty per strike — shown only when the provider exposes it">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse divide-y divide-ty-hairline">
                <thead>
                  <tr className="border-b border-ty-hairline">
                    <th className="ty-stat-label pr-2 py-2">STRIKE</th>
                    <th className="ty-stat-label px-2 py-2 text-right">CE Bid</th>
                    <th className="ty-stat-label px-2 py-2 text-right">CE Ask</th>
                    <th className="ty-stat-label pl-2 py-2 text-right">PE Bid</th>
                    <th className="ty-stat-label pr-2 py-2 text-right">PE Ask</th>
                  </tr>
                </thead>
                <tbody>
                  {topDom.map((d) => (
                    <tr key={d.strike} className="hover:bg-ty-fill/50 transition-colors">
                      <td className="pr-2 py-1.5 font-mono text-foreground">{d.strike}</td>
                      <td className="px-2 py-1.5 text-right font-mono ty-text-xs">{Number.isFinite(d.ceBidQty) ? d.ceBidQty.toLocaleString("en-IN") : "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono ty-text-xs">{Number.isFinite(d.ceAskQty) ? d.ceAskQty.toLocaleString("en-IN") : "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono ty-text-xs">{Number.isFinite(d.peBidQty) ? d.peBidQty.toLocaleString("en-IN") : "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono ty-text-xs">{Number.isFinite(d.peAskQty) ? d.peAskQty.toLocaleString("en-IN") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {topDom.length === 0 && <p className="ty-text-xs text-ty-muted-fg text-center">No DOM data</p>}
            {topDom.length > 0 && !topDom.some((d) => Number.isFinite(d.ceBidQty) || Number.isFinite(d.peBidQty)) && (
              <p className="ty-text-xs text-ty-warn mt-2">
                The active chain source ({data.source}) does not expose live bid/ask depth — the Strike Book stays empty rather than showing fake numbers. Depth appears when Breeze is the source.
              </p>
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
