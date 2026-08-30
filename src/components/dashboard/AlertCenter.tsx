// In-App Alert Center — displays trade alerts, score alerts, volume spikes
// Alerts are generated from market data changes and stored in memory

"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, AlertTriangle, TrendingUp, TrendingDown, Volume2, Target, Shield, X } from "lucide-react";
import { useState, useEffect } from "react";

interface Alert {
  id: string;
  type: "opportunity" | "score" | "volume" | "breakout" | "risk" | "info";
  symbol: string;
  message: string;
  score?: number;
  entry?: number;
  sl?: number;
  tp?: number;
  rr?: number;
  timestamp: string;
  read: boolean;
}

const ALERT_ICONS: Record<string, any> = {
  opportunity: TrendingUp,
  score: Target,
  volume: Volume2,
  breakout: TrendingUp,
  risk: Shield,
  info: Bell,
};

const ALERT_COLORS: Record<string, string> = {
  opportunity: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
  score: "bg-blue-500/10 border-blue-500/30 text-blue-400",
  volume: "bg-purple-500/10 border-purple-500/30 text-purple-400",
  breakout: "bg-orange-500/10 border-orange-500/30 text-orange-400",
  risk: "bg-red-500/10 border-red-500/30 text-red-400",
  info: "bg-zinc-500/10 border-zinc-500/30 text-zinc-400",
};

function AlertCard({ alert, onDismiss }: { alert: Alert; onDismiss: (id: string) => void }) {
  const Icon = ALERT_ICONS[alert.type] || Bell;
  const color = ALERT_COLORS[alert.type] || ALERT_COLORS.info;

  return (
    <div className={`border rounded-lg p-3 ${color} ${alert.read ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="text-xs font-bold">{alert.symbol}</span>
          {alert.score && (
            <Badge className="bg-emerald-600 text-white text-[8px]">{alert.score}/100</Badge>
          )}
        </div>
        <button onClick={() => onDismiss(alert.id)} className="text-zinc-500 hover:text-white">
          <X className="h-3 w-3" />
        </button>
      </div>
      <p className="text-xs text-zinc-300 mb-1">{alert.message}</p>
      {alert.entry && (
        <div className="flex gap-3 text-[10px]">
          <span>Entry: ₹{alert.entry}</span>
          {alert.sl && <span className="text-red-400">SL: ₹{alert.sl}</span>}
          {alert.tp && <span className="text-emerald-400">TP: ₹{alert.tp}</span>}
          {alert.rr && <span>R:R 1:{alert.rr}</span>}
        </div>
      )}
      <div className="text-[9px] text-zinc-600 mt-1">
        {new Date(alert.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
      </div>
    </div>
  );
}

export function AlertCenter() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showAll, setShowAll] = useState(false);

  // Poll opportunities API for new alerts
  const { data: opps } = useQuery({
    queryKey: ["alert-opps"],
    queryFn: () => fetch("/api/market/opportunities?top=3").then(r => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // Poll breadth for risk alerts
  const { data: breadth } = useQuery({
    queryKey: ["alert-breadth"],
    queryFn: () => fetch("/api/market/breadth").then(r => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // Generate alerts from data
  useEffect(() => {
    const newAlerts: Alert[] = [];

    if (opps?.opportunities) {
      for (const opp of opps.opportunities) {
        if (opp.score >= 70) {
          newAlerts.push({
            id: `opp-${opp.symbol}-${Date.now()}`,
            type: "opportunity",
            symbol: opp.symbol,
            message: `${opp.setup} setup — ${opp.reasons?.join(", ") || "Technical alignment"}`,
            score: opp.score,
            entry: opp.entry,
            sl: opp.sl,
            tp: opp.tp1,
            rr: opp.rr,
            timestamp: new Date().toISOString(),
            read: false,
          });
        }
      }
    }

    if (breadth?.breadthScore !== undefined) {
      if (breadth.breadthScore >= 80) {
        newAlerts.push({
          id: `breadth-bull-${Date.now()}`,
          type: "score",
          symbol: "MARKET",
          message: `Strong bullish breadth — ${breadth.advances} advances vs ${breadth.declines} declines. Score: ${breadth.breadthScore}/100`,
          score: breadth.breadthScore,
          timestamp: new Date().toISOString(),
          read: false,
        });
      } else if (breadth.breadthScore <= 30) {
        newAlerts.push({
          id: `breadth-bear-${Date.now()}`,
          type: "risk",
          symbol: "MARKET",
          message: `Weak breadth warning — ${breadth.declines} declines vs ${breadth.advances} advances. Score: ${breadth.breadthScore}/100`,
          score: breadth.breadthScore,
          timestamp: new Date().toISOString(),
          read: false,
        });
      }
    }

    if (newAlerts.length > 0) {
      setAlerts(prev => {
        const existing = new Set(prev.map(a => a.symbol + a.type));
        const fresh = newAlerts.filter(a => !existing.has(a.symbol + a.type));
        return [...fresh, ...prev].slice(0, 20);
      });
    }
  }, [opps, breadth]);

  const unreadCount = alerts.filter(a => !a.read).length;
  const displayed = showAll ? alerts : alerts.slice(0, 5);

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-xs font-bold text-zinc-400 flex items-center gap-2">
          <Bell className="h-3 w-3" />
          ALERTS
          {unreadCount > 0 && (
            <Badge className="bg-red-600 text-white text-[8px] px-1.5">{unreadCount}</Badge>
          )}
        </CardTitle>
        {alerts.length > 5 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-[9px] text-zinc-500 hover:text-white"
          >
            {showAll ? "Show less" : `Show all (${alerts.length})`}
          </button>
        )}
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        {displayed.length === 0 ? (
          <div className="text-center py-4 text-zinc-600 text-xs">
            <Bell className="h-5 w-5 mx-auto mb-1 opacity-50" />
            No alerts yet
          </div>
        ) : (
          displayed.map(alert => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onDismiss={(id) => setAlerts(prev => prev.filter(a => a.id !== id))}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
