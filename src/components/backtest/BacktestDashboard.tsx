"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  BarChart3,
  RefreshCw,
  Download,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Activity,
} from "lucide-react";
import {
  AggregateStats,
  TradeRecord,
  TradeFilters,
  getStats,
  getTrades,
  exportUrl,
  EMPTY_STATS,
} from "@/lib/trade-audit-client";

const API_BASE =
  process.env.NEXT_PUBLIC_TRADE_AUDIT_URL ?? "http://localhost:4001";

const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined ? "—" : n.toFixed(d);

const rupee = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={`font-mono font-bold text-sm mt-0.5 ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}

function BreakdownTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: string[];
  rows: (string | React.ReactNode)[][];
}) {
  if (rows.length === 0) {
    return (
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold text-muted-foreground mb-2">{title}</div>
        <div className="text-[10px] text-muted-foreground py-4 text-center">No data</div>
      </div>
    );
  }
  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="text-[11px] font-bold text-muted-foreground mb-2">{title}</div>
      <table className="w-full text-[10px] font-mono">
        <thead>
          <tr className="text-muted-foreground text-[9px] uppercase">
            {headers.map((h) => (
              <th key={h} className="text-right py-1 px-1 first:text-left">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-[#2a2e39]">
              {r.map((c, j) => (
                <td key={j} className="py-1 px-1 text-right first:text-left text-white">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeRow({ t }: { t: TradeRecord }) {
  const win = (t.netPnl ?? 0) >= 0;
  const statusColor =
    t.status === "open" ? "text-amber-400" : win ? "text-emerald-400" : "text-red-400";
  return (
    <tr className="border-t border-[#2a2e39] hover:bg-[#131722]">
      <td className="py-1.5 px-1.5 font-bold text-white">{t.symbol}</td>
      <td className="py-1.5 px-1.5 text-muted-foreground">{t.strategyId}</td>
      <td className="py-1.5 px-1.5 text-right">{t.entryPrice}</td>
      <td className="py-1.5 px-1.5 text-right text-red-400/80">{t.stopLoss}</td>
      <td className="py-1.5 px-1.5 text-right text-emerald-400/80">{t.tp1}</td>
      <td className="py-1.5 px-1.5 text-right">{t.signalConfidence}</td>
      <td className={`py-1.5 px-1.5 text-right ${statusColor}`}>
        {t.status === "open" ? "OPEN" : t.exitReason ?? "—"}
      </td>
      <td className={`py-1.5 px-1.5 text-right ${statusColor}`}>
        {t.rMultiple === null || t.rMultiple === undefined ? "—" : `${t.rMultiple.toFixed(2)}R`}
      </td>
      <td className={`py-1.5 px-1.5 text-right ${statusColor}`}>
        {t.netPnl === null ? "—" : `${win ? "+" : ""}${rupee(t.netPnl)}`}
      </td>
      <td className="py-1.5 px-1.5 text-right text-muted-foreground max-w-[180px] truncate" title={t.verification?.notes?.join(" ")}>
        {t.verification?.notes?.length
          ? t.verification.notes[0]
          : (t.tp1Hit || t.tp2Hit || t.tp3Hit ? "TP hit" : t.slHit ? "SL hit" : "—")}
      </td>
    </tr>
  );
}

export default function BacktestDashboard() {
  const [stats, setStats] = useState<AggregateStats>(EMPTY_STATS);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [strategyId, setStrategyId] = useState("");
  const [status, setStatus] = useState<"" | "open" | "closed">("");
  const [outcome, setOutcome] = useState<"" | "win" | "loss">("");
  const [symbol, setSymbol] = useState("");
  const [sort, setSort] = useState<"newest" | "pnl" | "r" | "conf">("newest");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const KNOWN_STRATEGIES = ["BTST", "ZERO_HERO_AI", "SMC"];

  // Strategy dropdown: the three known strategies + any others seen in the ledger
  const strategyOptions = useMemo(() => {
    const dynamic = stats.byStrategy.map((b) => b.strategyId);
    return Array.from(new Set([...KNOWN_STRATEGIES, ...dynamic])).sort();
  }, [stats.byStrategy]);

  // Stock dropdown: every symbol currently present in the ledger
  const stockOptions = useMemo(() => {
    return Array.from(new Set(trades.map((t) => t.symbol))).sort();
  }, [trades]);

  // Client-side sorting (the API returns by recency; we re-order here)
  const sortedTrades = useMemo(() => {
    const arr = [...trades];
    switch (sort) {
      case "pnl":
        arr.sort((a, b) => (b.netPnl ?? 0) - (a.netPnl ?? 0));
        break;
      case "r":
        arr.sort((a, b) => (b.rMultiple ?? 0) - (a.rMultiple ?? 0));
        break;
      case "conf":
        arr.sort((a, b) => (b.signalConfidence ?? 0) - (a.signalConfidence ?? 0));
        break;
      default:
        arr.sort((a, b) => (b.createdAtIst ?? "").localeCompare(a.createdAtIst ?? ""));
    }
    return arr;
  }, [trades, sort]);

  const buildFilters = useCallback(
    (): TradeFilters => ({
      strategyId: strategyId || undefined,
      status: status || undefined,
      outcome: outcome || undefined,
      symbol: symbol || undefined,
      pageSize: 50,
      page,
    }),
    [strategyId, status, outcome, symbol, page]
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const filters = buildFilters();
      const [s, t] = await Promise.all([getStats(filters), getTrades(filters)]);
      setStats(s);
      setTrades(t.items);
      setTotalPages(t.totalPages);
      setConnected(true);
      setError("");
    } catch {
      setConnected(false);
      setError("Cannot connect to Trade Audit engine at localhost:4001");
    } finally {
      setLoading(false);
    }
  }, [buildFilters]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const onFilter = (fn: () => void) => {
    setPage(1);
    fn();
  };

  const selCls =
    "h-6 text-[10px] bg-[#131722] border border-[#2a2e39] rounded px-1.5 font-mono text-white";
  const btnCls =
    "h-7 text-[9px] bg-muted/50 px-2 rounded font-bold flex items-center gap-1 hover:bg-muted";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <span className="text-sm font-bold">Backtest Audit Engine</span>
          <span
            className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full font-bold ${
              connected ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
            {connected ? "Connected :4001" : "Disconnected"}
          </span>
        </div>
        <div className="flex gap-1">
          <a href={exportUrl("csv", buildFilters())} target="_blank" rel="noreferrer" className={btnCls}>
            <Download className="h-3 w-3" /> CSV
          </a>
          <a href={exportUrl("json", buildFilters())} target="_blank" rel="noreferrer" className={btnCls}>
            <Download className="h-3 w-3" /> JSON
          </a>
          <button onClick={fetchData} disabled={loading} className={btnCls}>
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[10px] text-amber-400 bg-amber-500/10 rounded px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {error} — start the engine first:
          <code className="text-[9px] bg-amber-500/20 px-1 py-0.5 rounded">cd trade-audit && ./start.sh</code>
        </div>
      )}

      {!error && (
        <>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
            <StatCard label="Total Trades" value={String(stats.totalTrades)} />
            <StatCard
              label="Win Rate"
              value={`${fmt(stats.winRate, 1)}%`}
              color={stats.winRate > 50 ? "text-emerald-400" : "text-amber-400"}
            />
            <StatCard
              label="Avg R"
              value={`${fmt(stats.avgR, 2)}R`}
              color={(stats.avgR ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}
            />
            <StatCard
              label="Profit Factor"
              value={stats.profitFactor === null ? "—" : fmt(stats.profitFactor, 2)}
              color={(stats.profitFactor ?? 0) >= 1 ? "text-emerald-400" : "text-red-400"}
            />
            <StatCard
              label="Net P&L"
              value={rupee(stats.netPnl)}
              color={(stats.netPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}
            />
            <StatCard
              label="Max DD"
              value={rupee(-(stats.maxDrawdown ?? 0))}
              color="text-red-400"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <BreakdownTable
              title="BY STRATEGY"
              headers={["strategy", "trades", "win%", "avgR", "PF", "net₹"]}
              rows={stats.byStrategy.map((b) => [
                b.strategyId,
                b.trades,
                fmt(b.winRate, 1),
                `${fmt(b.avgR, 2)}R`,
                b.profitFactor === null ? "—" : fmt(b.profitFactor, 2),
                rupee(b.netPnl),
              ])}
            />
            <BreakdownTable
              title="BY SYMBOL"
              headers={["symbol", "trades", "win%", "net₹"]}
              rows={stats.bySymbol.map((b) => [
                b.symbol,
                b.trades,
                fmt(b.winRate, 1),
                rupee(b.netPnl),
              ])}
            />
            <BreakdownTable
              title="BY SESSION"
              headers={["session", "trades", "win%", "net₹"]}
              rows={stats.byMarketSession.map((b) => [
                b.marketSession,
                b.trades,
                fmt(b.winRate, 1),
                rupee(b.netPnl),
              ])}
            />
          </div>

          <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <div className="text-[11px] font-bold text-muted-foreground flex items-center gap-2">
                <Activity className="h-3 w-3 text-emerald-400" />
                TRADE LEDGER ({stats.closedTrades} closed / {stats.openTrades} open)
              </div>
              <div className="flex gap-1.5 items-center flex-wrap">
                <select value={strategyId} onChange={(e) => onFilter(() => setStrategyId(e.target.value))} className={selCls} title="Strategy">
                  <option value="">All Strategies</option>
                  {strategyOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select value={symbol} onChange={(e) => onFilter(() => setSymbol(e.target.value))} className={selCls} title="Stock">
                  <option value="">All Stocks</option>
                  {stockOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select value={status} onChange={(e) => onFilter(() => setStatus(e.target.value as any))} className={selCls} title="Status">
                  <option value="">All Status</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
                <select value={outcome} onChange={(e) => onFilter(() => setOutcome(e.target.value as any))} className={selCls} title="Outcome">
                  <option value="">All Outcome</option>
                  <option value="win">Win</option>
                  <option value="loss">Loss</option>
                </select>
                <select value={sort} onChange={(e) => setSort(e.target.value as any)} className={selCls} title="Sort by">
                  <option value="newest">Newest</option>
                  <option value="pnl">P&L ↓</option>
                  <option value="r">R ↓</option>
                  <option value="conf">Conf ↓</option>
                </select>
                <button onClick={() => onFilter(() => { setSymbol(""); setStrategyId(""); setStatus(""); setOutcome(""); setSort("newest"); })} className={btnCls}>
                  Clear
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="text-muted-foreground text-[9px] uppercase">
                    <th className="text-left py-1 px-1.5">Symbol</th>
                    <th className="text-left py-1 px-1.5">Strategy</th>
                    <th className="text-right py-1 px-1.5">Entry</th>
                    <th className="text-right py-1 px-1.5">SL</th>
                    <th className="text-right py-1 px-1.5">TP1</th>
                    <th className="text-right py-1 px-1.5">Conf</th>
                    <th className="text-right py-1 px-1.5">Exit</th>
                    <th className="text-right py-1 px-1.5">R</th>
                    <th className="text-right py-1 px-1.5">Net</th>
                    <th className="text-right py-1 px-1.5">Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="text-center text-muted-foreground py-8">
                        No trades recorded yet. Strategies will log here once signals fire.
                      </td>
                    </tr>
                  ) : (
                    sortedTrades.map((t) => <TradeRow key={t.id} t={t} />)
                  )}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-2 text-[10px]">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className={btnCls}>
                  Prev
                </button>
                <span className="font-mono text-muted-foreground">Page {page} / {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className={btnCls}>
                  Next
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
