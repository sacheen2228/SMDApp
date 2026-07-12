"use client";

import { useState, useEffect, useMemo } from "react";

interface Trade {
  id: string; tradeId: string; symbol: string; strike: number; type: string;
  entryTime: string; entryPrice: number; exitTime: string | null; exitPrice: number | null;
  pnl: number | null; confidence: number; qualityGrade: string; status: string;
  stopLoss: number; target1: number | null; target2: number | null;
}

export default function TradeJournal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState({ symbol: "", status: "", sort: "entryTime", dir: "desc" as "asc" | "desc" });
  const [stats, setStats] = useState({ total: 0, open: 0, closed: 0, winRate: 0, totalPnL: 0 });

  const fetchTrades = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (filter.symbol) params.set("symbol", filter.symbol);
      const res = await fetch(`/api/trade-journal?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "API error");
      setTrades(json.trades || []);
      setStats(json.stats || { total: 0, open: 0, closed: 0, winRate: 0, totalPnL: 0 });
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    }
    setLoading(false);
  };

  useEffect(() => { fetchTrades(); }, [filter.symbol]);

  const sorted = useMemo(() => {
    const arr = [...trades];
    arr.sort((a, b) => {
      let cmp = 0;
      if (filter.sort === "entryTime") cmp = new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime();
      else if (filter.sort === "pnl") cmp = (a.pnl ?? 0) - (b.pnl ?? 0);
      else if (filter.sort === "confidence") cmp = a.confidence - b.confidence;
      else if (filter.sort === "symbol") cmp = a.symbol.localeCompare(b.symbol);
      return filter.dir === "desc" ? -cmp : cmp;
    });
    if (filter.status) return arr.filter(t => t.status === filter.status);
    return arr;
  }, [trades, filter]);

  const symbols = useMemo(() => [...new Set(trades.map(t => t.symbol))], [trades]);

  const sortDir = (col: string) => filter.sort === col ? (filter.dir === "desc" ? "↓" : "↑") : "";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold text-muted-foreground">TRADE JOURNAL</div>
        <button onClick={fetchTrades} className="text-[10px] text-primary hover:underline" disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-2">
        <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-2">
          <div className="text-[9px] text-muted-foreground">Total</div>
          <div className="font-mono font-bold text-xs">{stats.total}</div>
        </div>
        <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-2">
          <div className="text-[9px] text-muted-foreground">Open</div>
          <div className="font-mono font-bold text-xs text-blue-400">{stats.open}</div>
        </div>
        <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-2">
          <div className="text-[9px] text-muted-foreground">Closed</div>
          <div className="font-mono font-bold text-xs">{stats.closed}</div>
        </div>
        <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-2">
          <div className="text-[9px] text-muted-foreground">Win Rate</div>
          <div className="font-mono font-bold text-xs" style={{ color: stats.winRate > 50 ? "#22c55e" : "#ef4444" }}>{stats.winRate}%</div>
        </div>
        <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-2">
          <div className="text-[9px] text-muted-foreground">Total P&L</div>
          <div className="font-mono font-bold text-xs" style={{ color: stats.totalPnL >= 0 ? "#22c55e" : "#ef4444" }}>
            {stats.totalPnL > 0 ? "+" : ""}{stats.totalPnL}
          </div>
        </div>
      </div>

      {error && <div className="text-[10px] text-red-400 bg-red-500/10 rounded px-2 py-1">{error}</div>}

      {/* Filters */}
      <div className="flex gap-2 items-center">
        <select
          value={filter.symbol}
          onChange={e => setFilter(f => ({ ...f, symbol: e.target.value }))}
          className="h-7 text-[10px] bg-[#1a1d28] border border-[#2a2e39] rounded px-2 text-muted-foreground"
        >
          <option value="">All Symbols</option>
          {symbols.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filter.status}
          onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}
          className="h-7 text-[10px] bg-[#1a1d28] border border-[#2a2e39] rounded px-2 text-muted-foreground"
        >
          <option value="">All Status</option>
          <option value="OPEN">Open</option>
          <option value="TP_HIT">TP Hit</option>
          <option value="SL_HIT">SL Hit</option>
          <option value="EXPIRED">Expired</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-[#2a2e39] bg-[#131722]">
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr className="border-b border-[#2a2e39]">
              {[
                { key: "symbol", label: "Symbol" },
                { key: "type", label: "Type" },
                { key: "strike", label: "Strike" },
                { key: "entryTime", label: "Entry" },
                { key: "entryPrice", label: "Price" },
                { key: "exitPrice", label: "Exit" },
                { key: "pnl", label: "P&L" },
                { key: "confidence", label: "Conf" },
                { key: "qualityGrade", label: "Grade" },
                { key: "status", label: "Status" },
              ].map(col => (
                <th
                  key={col.key}
                  onClick={() => setFilter(f => ({
                    ...f,
                    sort: col.key,
                    dir: f.sort === col.key && f.dir === "desc" ? "asc" : "desc",
                  }))}
                  className="px-2 py-1.5 text-left text-muted-foreground cursor-pointer hover:text-foreground whitespace-nowrap"
                >
                  {col.label} <span className="text-[8px]">{sortDir(col.key)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(t => (
              <tr key={t.id} className="border-b border-[#2a2e39]/50 hover:bg-[#1a1d28]">
                <td className="px-2 py-1 font-bold">{t.symbol}</td>
                <td className={`px-2 py-1 ${t.type === "CALL" ? "text-emerald-400" : "text-red-400"}`}>{t.type}</td>
                <td className="px-2 py-1">{t.strike}</td>
                <td className="px-2 py-1 text-muted-foreground">{new Date(t.entryTime).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</td>
                <td className="px-2 py-1">{t.entryPrice}</td>
                <td className="px-2 py-1">{t.exitPrice ?? "—"}</td>
                <td className={`px-2 py-1 font-bold ${(t.pnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {t.pnl !== null ? `${t.pnl >= 0 ? "+" : ""}${t.pnl}` : "—"}
                </td>
                <td className="px-2 py-1">{t.confidence}</td>
                <td className="px-2 py-1">
                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                    t.qualityGrade === "A" ? "bg-emerald-500/20 text-emerald-400" :
                    t.qualityGrade === "B" ? "bg-blue-500/20 text-blue-400" :
                    t.qualityGrade === "C" ? "bg-orange-500/20 text-orange-400" :
                    "bg-red-500/20 text-red-400"
                  }`}>
                    {t.qualityGrade}
                  </span>
                </td>
                <td className="px-2 py-1">
                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                    t.status === "TP_HIT" ? "bg-emerald-500/20 text-emerald-400" :
                    t.status === "SL_HIT" ? "bg-red-500/20 text-red-400" :
                    t.status === "OPEN" ? "bg-blue-500/20 text-blue-400" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    {t.status.replace("_", " ")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-[11px]">
            No trades found{filter.symbol ? ` for ${filter.symbol}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
