"use client";

import { Badge } from "@/components/ui/badge";
import { Activity, Wifi, WifiOff, CheckCircle, AlertTriangle } from "lucide-react";
import type { DataHealthReport } from "@/lib/data-health";

interface DataHealthStripProps {
  health: DataHealthReport | null;
  source: string;
  lastUpdate: string;
}

export function DataHealthStrip({ health, source, lastUpdate }: DataHealthStripProps) {
  if (!health) return null;

  const latencyColor = health.latencyMs < 500 ? "text-emerald-400" : health.latencyMs < 2000 ? "text-amber-400" : "text-red-400";
  const freshnessSec = health.freshnessMs / 1000;
  const freshnessColor = freshnessSec < 10 ? "text-emerald-400" : freshnessSec < 60 ? "text-amber-400" : "text-red-400";
  const completenessPct = Math.round(health.completeness * 100);
  const completenessColor = completenessPct > 95 ? "text-emerald-400" : completenessPct > 80 ? "text-amber-400" : "text-red-400";

  const statusDot = health.status === "HEALTHY" ? "bg-emerald-400" : health.status === "DEGRADED" ? "bg-amber-400" : "bg-red-400";
  const statusLabel = health.status === "HEALTHY" ? "LIVE" : health.status === "OFFLINE" ? "OFFLINE" : "DEGRADED";
  const StatusIcon = health.status === "HEALTHY" ? Wifi : WifiOff;

  const isLive = source.toLowerCase().includes("live") || source.toLowerCase().includes("breeze");

  return (
    <div className="bg-slate-900/80 border border-white/10 rounded-lg px-3 py-1.5 flex items-center gap-3 max-h-8 text-xs overflow-x-auto">
      {/* Connection status */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
        <StatusIcon className="w-3 h-3 text-gray-400" />
        <span className="text-gray-300">{statusLabel}</span>
      </div>

      <span className="text-gray-600">|</span>

      {/* Latency */}
      <div className="flex items-center gap-1 shrink-0">
        <Activity className="w-3 h-3 text-gray-500" />
        <span className={latencyColor}>{health.latencyMs}ms</span>
      </div>

      {/* Freshness */}
      <div className="flex items-center gap-1 shrink-0">
        <span className={freshnessColor}>
          {freshnessSec < 1 ? "just now" : `${freshnessSec.toFixed(1)}s ago`}
        </span>
      </div>

      {/* Completeness */}
      <div className="flex items-center gap-1 shrink-0">
        <span className={completenessColor}>{completenessPct}% complete</span>
      </div>

      {/* Greeks */}
      <Badge
        className={`text-[9px] px-1.5 py-0 shrink-0 ${
          health.greeksAvailable
            ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
            : "bg-red-500/20 text-red-400 border-red-500/30"
        }`}
      >
        {health.greeksAvailable ? "Greeks OK" : "Greeks Missing"}
      </Badge>

      {/* Source */}
      <Badge
        className={`text-[9px] px-1.5 py-0 shrink-0 ${
          isLive
            ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
            : "bg-amber-500/20 text-amber-400 border-amber-500/30"
        }`}
      >
        {isLive ? "LIVE" : "SIMULATION"}
      </Badge>
    </div>
  );
}
