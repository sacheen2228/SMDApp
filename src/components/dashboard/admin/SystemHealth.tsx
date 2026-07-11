"use client";

import { useState, useEffect } from "react";

interface SystemData {
  breeze: { connected: boolean };
  trades: { total: number; open: number; closed: number; winRate: number; totalPnL: number; winners: number; losers: number };
  timestamp: string;
  env: { hasBreezeKeys: boolean };
}

export default function SystemHealth() {
  const [data, setData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchHealth = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/system");
      const json = await res.json();
      if (json.success) setData(json.data);
      else setError(json.error || "Failed");
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => { fetchHealth(); }, []);

  const StatCard = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3 min-w-[100px]">
      <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
      <div className="font-mono font-bold text-sm" style={{ color: color || "#e2e8f0" }}>{value}</div>
    </div>
  );

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold text-muted-foreground">SYSTEM HEALTH</div>
        <div className="grid grid-cols-4 gap-2">
          {[1,2,3,4].map(i => (
            <div key={i} className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3 animate-pulse">
              <div className="h-3 w-16 bg-muted rounded mb-2" />
              <div className="h-5 w-20 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold text-muted-foreground">SYSTEM HEALTH</div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-[11px] text-red-400">
          Failed to load: {error}
          <button onClick={fetchHealth} className="ml-2 underline">Retry</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold text-muted-foreground">SYSTEM HEALTH</div>
        <button onClick={fetchHealth} className="text-[10px] text-primary hover:underline" disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <StatCard
          label="Breeze API"
          value={data.breeze.connected ? "Connected" : "Disconnected"}
          color={data.breeze.connected ? "#22c55e" : "#ef4444"}
        />
        <StatCard
          label="Data Source"
          value={data.breeze.connected ? "Real API" : "Simulation"}
          color={data.breeze.connected ? "#22c55e" : "#f97316"}
        />
        <StatCard
          label="API Keys"
          value={data.env.hasBreezeKeys ? "Configured" : "Missing"}
          color={data.env.hasBreezeKeys ? "#22c55e" : "#ef4444"}
        />
        <StatCard
          label="Last Check"
          value={new Date(data.timestamp).toLocaleTimeString("en-IN")}
        />
      </div>

      <div className="grid grid-cols-5 gap-2">
        <StatCard label="Total Trades" value={String(data.trades.total)} />
        <StatCard label="Open" value={String(data.trades.open)} color="#3b82f6" />
        <StatCard label="Closed" value={String(data.trades.closed)} />
        <StatCard
          label="Win Rate"
          value={`${data.trades.winRate}%`}
          color={data.trades.winRate > 50 ? "#22c55e" : "#ef4444"}
        />
        <StatCard
          label="Total P&L"
          value={`${data.trades.totalPnL >= 0 ? "+" : ""}${data.trades.totalPnL}`}
          color={data.trades.totalPnL >= 0 ? "#22c55e" : "#ef4444"}
        />
      </div>
    </div>
  );
}
