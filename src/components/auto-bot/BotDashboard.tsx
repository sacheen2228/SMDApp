"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Activity, TrendingUp, TrendingDown, AlertTriangle, BarChart3, RefreshCw } from "lucide-react";

interface BotStats {
  today_pnl: number;
  win_rate: number;
  trades_today: number;
  open_count: number;
  alltime_pnl: number;
}

interface Alert {
  id: string;
  ticker: string;
  market: string;
  broke: number;
  stop: number;
  target: number;
  volume: string;
  touches: number;
  qty: number;
  time: string;
}

interface Position {
  id: number;
  ticker: string;
  market: string;
  qty: number;
  entry: number;
  stop: number;
  target: number;
  last: number;
  live_pnl: number;
  status: string;
}

interface WinLoss {
  wins: number;
  losses: number;
}

interface BotData {
  stats: BotStats;
  alerts: Alert[];
  positions: Position[];
  closed: Position[];
  winners_vs_losers: WinLoss;
}

const API_BASE = "http://localhost:8000";

function BotStatsBand({ stats }: { stats: BotStats }) {
  const items = [
    { label: "Today P&L", value: `₹${stats.today_pnl.toFixed(0)}`, color: stats.today_pnl >= 0 ? "text-emerald-400" : "text-red-400" },
    { label: "Win Rate", value: `${stats.win_rate.toFixed(0)}%`, color: stats.win_rate > 50 ? "text-emerald-400" : "text-amber-400" },
    { label: "Today Trades", value: stats.trades_today, color: "text-blue-400" },
    { label: "Open", value: stats.open_count, color: stats.open_count > 0 ? "text-emerald-400" : "text-muted-foreground" },
    { label: "All-time P&L", value: `₹${stats.alltime_pnl.toFixed(0)}`, color: stats.alltime_pnl >= 0 ? "text-emerald-400" : "text-red-400" },
  ];
  return (
    <div className="grid grid-cols-5 gap-2">
      {items.map((item) => (
        <div key={item.label} className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{item.label}</div>
          <div className={`font-mono font-bold text-sm mt-0.5 ${item.color}`}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

function BotAlerts({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="text-[11px] font-bold text-muted-foreground mb-2 flex items-center gap-2">
        <AlertTriangle className="h-3 w-3 text-amber-400" />
        PENDING BREAKOUT ALERTS
      </div>
      {alerts.length === 0 ? (
        <div className="text-[10px] text-muted-foreground py-6 text-center">No pending alerts</div>
      ) : (
        <div className="space-y-1">
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between text-[10px] font-mono bg-[#131722] rounded px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-bold text-white">{a.ticker}</span>
                <span className="text-muted-foreground text-[9px]">{a.market}</span>
              </div>
              <div className="flex items-center gap-3 text-muted-foreground">
                <span>{a.broke}</span>
                <span className="text-red-400">SL {a.stop}</span>
                <span className="text-emerald-400">TP {a.target}</span>
                <span className="text-amber-400">x{a.volume}</span>
                <span>{a.touches}t</span>
                <span className="text-blue-400">{a.qty}qty</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BotPositions({ positions }: { positions: Position[] }) {
  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="text-[11px] font-bold text-muted-foreground mb-2 flex items-center gap-2">
        <Activity className="h-3 w-3 text-emerald-400" />
        OPEN POSITIONS
      </div>
      {positions.length === 0 ? (
        <div className="text-[10px] text-muted-foreground py-6 text-center">No open positions</div>
      ) : (
        <div className="space-y-2">
          {positions.map((p) => {
            const pnlPercent = p.entry > 0 ? ((p.last - p.entry) / p.entry) * 100 : 0;
            const barColor = p.live_pnl >= 0 ? "bg-emerald-500/30" : "bg-red-500/30";
            const fillColor = p.live_pnl >= 0 ? "bg-emerald-400" : "bg-red-400";
            const progress = Math.min(Math.abs(pnlPercent) * 10, 100);
            return (
              <div key={p.id} className="bg-[#131722] rounded-lg p-2.5">
                <div className="flex items-center justify-between text-[10px] font-mono">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white">{p.ticker}</span>
                    <span className="text-muted-foreground text-[9px]">{p.market}</span>
                    <span className="text-muted-foreground">{p.qty} @ {p.entry}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-red-400">SL {p.stop}</span>
                    <span className="text-emerald-400">TP {p.target}</span>
                    <span className={p.live_pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {p.live_pnl >= 0 ? "+" : ""}{p.live_pnl.toFixed(0)}
                    </span>
                  </div>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-[#2a2e39] overflow-hidden">
                  <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(progress, 100)}%` }}>
                    <div className={`h-full rounded-full ${fillColor}`} style={{ width: `${Math.min(pnlPercent > 0 ? 100 : 0, 100)}%` }} />
                  </div>
                </div>
                <div className="flex justify-between text-[8px] text-muted-foreground mt-0.5">
                  <span>Entry: {p.entry}</span>
                  <span>Last: {p.last}</span>
                  <span>P&L: {p.live_pnl >= 0 ? "+" : ""}{p.live_pnl.toFixed(0)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BotWinLossChart({ data }: { data: WinLoss }) {
  const total = data.wins + data.losses || 1;
  const winPct = (data.wins / total) * 100;
  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="text-[11px] font-bold text-muted-foreground mb-2 flex items-center gap-2">
        <BarChart3 className="h-3 w-3" />
        WIN / LOSS
      </div>
      <div className="flex items-end gap-2 h-20">
        <div className="flex-1 flex flex-col items-center">
          <div className="text-[9px] font-mono font-bold text-emerald-400 mb-1">{data.wins}</div>
          <div className="w-full bg-[#2a2e39] rounded-t flex flex-col-reverse overflow-hidden" style={{ height: "60px" }}>
            <div className="bg-emerald-500/70 rounded-t" style={{ height: `${(data.wins / total) * 100}%` }} />
          </div>
          <div className="text-[8px] text-muted-foreground mt-1">Wins</div>
        </div>
        <div className="flex-1 flex flex-col items-center">
          <div className="text-[9px] font-mono font-bold text-red-400 mb-1">{data.losses}</div>
          <div className="w-full bg-[#2a2e39] rounded-t flex flex-col-reverse overflow-hidden" style={{ height: "60px" }}>
            <div className="bg-red-500/70 rounded-t" style={{ height: `${(data.losses / total) * 100}%` }} />
          </div>
          <div className="text-[8px] text-muted-foreground mt-1">Losses</div>
        </div>
      </div>
      <div className="text-center text-[9px] text-muted-foreground mt-2">
        Win Rate: <span className="font-bold font-mono text-emerald-400">{winPct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

function BotClosedTrades({ trades }: { trades: Position[] }) {
  return (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
      <div className="text-[11px] font-bold text-muted-foreground mb-2">RECENT CLOSED TRADES</div>
      {trades.length === 0 ? (
        <div className="text-[10px] text-muted-foreground py-6 text-center">No closed trades</div>
      ) : (
        <div className="space-y-1">
          {trades.map((t) => (
            <div key={t.id} className="flex items-center justify-between text-[10px] font-mono bg-[#131722] rounded px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-bold text-white">{t.ticker}</span>
                <span className="text-muted-foreground">{t.qty} @ {t.entry}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Exit {t.last}</span>
                <span className={t.live_pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                  {t.live_pnl >= 0 ? <TrendingUp className="h-3 w-3 inline" /> : <TrendingDown className="h-3 w-3 inline" />}
                  {t.live_pnl >= 0 ? "+" : ""}{t.live_pnl.toFixed(0)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BotDashboard() {
  const [data, setData] = useState<BotData>({
    stats: { today_pnl: 0, win_rate: 0, trades_today: 0, open_count: 0, alltime_pnl: 0 },
    alerts: [],
    positions: [],
    closed: [],
    winners_vs_losers: { wins: 0, losses: 0 },
  });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await Promise.all([
        fetch(`${API_BASE}/api/stats`),
        fetch(`${API_BASE}/api/alerts`),
        fetch(`${API_BASE}/api/positions`),
        fetch(`${API_BASE}/api/closed`),
      ]);
      if (!res[0].ok) throw new Error("Bot not reachable");
      const [stats, alerts, positions, closed] = await Promise.all(res.map((r) => r.json()));
      setData({
        stats: {
          today_pnl: stats.today_pnl ?? 0,
          win_rate: stats.win_rate ?? 0,
          trades_today: stats.today_trades ?? 0,
          open_count: stats.open_positions ?? 0,
          alltime_pnl: stats.alltime_pnl ?? 0,
        },
        alerts: alerts ?? [],
        positions: positions ?? [],
        closed: closed ?? [],
        winners_vs_losers: { wins: stats.wins ?? 0, losses: stats.losses ?? 0 },
      });
      setError("");
    } catch {
      setError("Cannot connect to bot engine at localhost:8000");
    }
  }, []);

  useEffect(() => {
    fetchData();
    let pollInterval: ReturnType<typeof setInterval>;
    try {
      const ws = new WebSocket(`ws://localhost:8000/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        try { setData(JSON.parse(event.data)); } catch { /* skip malformed */ }
      };
      ws.onerror = () => setConnected(false);
      ws.onclose = () => {
        setConnected(false);
        pollInterval = setInterval(fetchData, 5000);
      };
    } catch {
      pollInterval = setInterval(fetchData, 5000);
    }
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [fetchData]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <span className="text-sm font-bold">Breakout/Desk Engine</span>
          <span className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full font-bold ${
            connected ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <div className="flex gap-1">
          <button onClick={fetchData} className="h-6 text-[9px] bg-muted/50 px-2 rounded font-bold flex items-center gap-1 hover:bg-muted">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[10px] text-amber-400 bg-amber-500/10 rounded px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {error} — start the bot engine first:
          <code className="text-[9px] bg-amber-500/20 px-1 py-0.5 rounded">cd auto-bot && ./start.sh</code>
        </div>
      )}

      {!error && (
        <>
          <BotStatsBand stats={data.stats} />
          <BotAlerts alerts={data.alerts} />
          <BotPositions positions={data.positions} />
          <div className="grid grid-cols-2 gap-3">
            <BotWinLossChart data={data.winners_vs_losers} />
            <BotClosedTrades trades={data.closed} />
          </div>
        </>
      )}
    </div>
  );
}
