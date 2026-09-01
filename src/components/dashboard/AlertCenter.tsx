// In-App Alert Center — displays trade alerts, score alerts, volume spikes
// Alerts are generated from market data changes and stored in memory
// Also polls server-side alert engine for expiry liquidity / SDM alerts

"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, AlertTriangle, TrendingUp, TrendingDown, Volume2, Target, Shield, X, CheckCheck } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

interface ClientAlert {
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
  source: "client";
}

interface ServerAlert {
  id: string;
  type: string;
  symbol: string;
  message: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  timestamp: number;
  data: Record<string, any>;
  acknowledged: boolean;
  source: "server";
}

type Alert = ClientAlert | ServerAlert;

const ALERT_ICONS: Record<string, any> = {
  opportunity: TrendingUp,
  score: Target,
  volume: Volume2,
  breakout: TrendingUp,
  risk: Shield,
  info: Bell,
  EXPIRY_EVENT_DETECTED: AlertTriangle,
  CAS_DISLOCATION: AlertTriangle,
  OI_UNWINDING: TrendingDown,
  SHORT_COVERING: TrendingUp,
  PREMIUM_ACCELERATION: Volume2,
  IV_SHOCK: AlertTriangle,
  FUTURES_CONFIRMATION: Target,
  BREAKOUT_CONFIRMED: TrendingUp,
  BREAKDOWN_CONFIRMED: TrendingDown,
  MOMENTUM_EXHAUSTION: Shield,
  REVERSAL_RISK: AlertTriangle,
  DATA_QUALITY_DEGRADED: AlertTriangle,
  MARGIN_RISK_HIGH: Shield,
};

const ALERT_COLORS: Record<string, string> = {
  opportunity: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
  score: "bg-blue-500/10 border-blue-500/30 text-blue-400",
  volume: "bg-purple-500/10 border-purple-500/30 text-purple-400",
  breakout: "bg-orange-500/10 border-orange-500/30 text-orange-400",
  risk: "bg-red-500/10 border-red-500/30 text-red-400",
  info: "bg-zinc-500/10 border-zinc-500/30 text-zinc-400",
  WARNING: "bg-amber-500/10 border-amber-500/30 text-amber-400",
  CRITICAL: "bg-red-500/10 border-red-500/30 text-red-400",
  INFO: "bg-zinc-500/10 border-zinc-500/30 text-zinc-400",
};

function AlertCard({
  alert,
  onDismiss,
  onAcknowledge,
}: {
  alert: Alert;
  onDismiss: (id: string) => void;
  onAcknowledge: (id: string) => void;
}) {
  const isServer = alert.source === "server";
  const type = isServer ? (alert as ServerAlert).type : (alert as ClientAlert).type;
  const acknowledged = isServer ? (alert as ServerAlert).acknowledged : (alert as ClientAlert).read;
  const severity = isServer ? (alert as ServerAlert).severity : undefined;

  const iconKey = type;
  const Icon = ALERT_ICONS[iconKey] || Bell;
  const color = isServer
    ? ALERT_COLORS[severity || "INFO"]
    : ALERT_COLORS[type as string] || ALERT_COLORS.info;

  const timestamp = isServer
    ? new Date((alert as ServerAlert).timestamp).toISOString()
    : (alert as ClientAlert).timestamp;

  const displayType = isServer ? type.replace(/_/g, " ").toLowerCase() : type;

  return (
    <div className={`border rounded-lg p-3 ${color} ${acknowledged ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="text-xs font-bold">{alert.symbol}</span>
          <span className="text-[9px] uppercase opacity-60">{displayType}</span>
          {isServer && severity && (
            <Badge className={`text-[8px] ${
              severity === "CRITICAL" ? "bg-red-600" :
              severity === "WARNING" ? "bg-amber-600" : "bg-zinc-600"
            } text-white`}>
              {severity}
            </Badge>
          )}
          {(alert as ClientAlert).score && (
            <Badge className="bg-emerald-600 text-white text-[8px]">{(alert as ClientAlert).score}/100</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isServer && !acknowledged && (
            <button
              onClick={() => onAcknowledge(alert.id)}
              className="text-zinc-500 hover:text-emerald-400"
              title="Acknowledge"
            >
              <CheckCheck className="h-3 w-3" />
            </button>
          )}
          <button onClick={() => onDismiss(alert.id)} className="text-zinc-500 hover:text-white">
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <p className="text-xs text-zinc-300 mb-1">{alert.message}</p>
      {(alert as ClientAlert).entry && (
        <div className="flex gap-3 text-[10px]">
          <span>Entry: ₹{(alert as ClientAlert).entry}</span>
          {(alert as ClientAlert).sl && <span className="text-red-400">SL: ₹{(alert as ClientAlert).sl}</span>}
          {(alert as ClientAlert).tp && <span className="text-emerald-400">TP: ₹{(alert as ClientAlert).tp}</span>}
          {(alert as ClientAlert).rr && <span>R:R 1:{(alert as ClientAlert).rr}</span>}
        </div>
      )}
      <div className="text-[9px] text-zinc-600 mt-1">
        {new Date(timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
      </div>
    </div>
  );
}

export function AlertCenter() {
  const queryClient = useQueryClient();
  const [clientAlerts, setClientAlerts] = useState<ClientAlert[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  // ── Server-side alerts (poll every 2 minutes) ──
  const { data: serverData } = useQuery({
    queryKey: ["server-alerts"],
    queryFn: () => fetch("/api/alerts?limit=20").then((r) => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // ── Acknowledge mutation ──
  const ackMutation = useMutation({
    mutationFn: (id: string) =>
      fetch("/api/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["server-alerts"] }),
  });

  const handleAcknowledge = useCallback(
    (id: string) => ackMutation.mutate(id),
    [ackMutation],
  );

  // ── Poll client-side data sources (existing behavior) ──
  const { data: opps } = useQuery({
    queryKey: ["alert-opps"],
    queryFn: () => fetch("/api/market/opportunities?top=3").then((r) => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const { data: breadth } = useQuery({
    queryKey: ["alert-breadth"],
    queryFn: () => fetch("/api/market/breadth").then((r) => r.json()),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // ── Generate client alerts from market data (fallback) ──
  useEffect(() => {
    const newAlerts: ClientAlert[] = [];

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
            source: "client",
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
          source: "client",
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
          source: "client",
        });
      }
    }

    if (newAlerts.length > 0) {
      setClientAlerts((prev) => {
        const existing = new Set(prev.map((a) => a.symbol + a.type));
        const fresh = newAlerts.filter((a) => !existing.has(a.symbol + a.type));
        return [...fresh, ...prev].slice(0, 20);
      });
    }
  }, [opps, breadth]);

  // ── Merge server + client alerts ──
  const serverAlerts: ServerAlert[] = (serverData?.alerts || []).map((a: any) => ({
    ...a,
    source: "server" as const,
  }));

  const allAlerts: Alert[] = [...serverAlerts, ...clientAlerts].filter(
    (a) => !dismissedIds.has(a.id),
  );

  const unreadCount = allAlerts.filter((a) => {
    if (a.source === "server") return !(a as ServerAlert).acknowledged;
    return !(a as ClientAlert).read;
  }).length;

  const displayed = showAll ? allAlerts : allAlerts.slice(0, 8);

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
        {allAlerts.length > 8 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-[9px] text-zinc-500 hover:text-white"
          >
            {showAll ? "Show less" : `Show all (${allAlerts.length})`}
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
          displayed.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onDismiss={(id) => setDismissedIds((prev) => new Set([...prev, id]))}
              onAcknowledge={handleAcknowledge}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
