'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Wifi, WifiOff, Shield, Activity } from 'lucide-react';

interface HealthStatus {
  status: string;
  checks: Record<string, { status: string; message?: string; latencyMs?: number }>;
}

interface ReadinessStatus {
  gate: 'READY' | 'DEGRADED' | 'NOT_READY' | 'NON_TRADING_DAY';
  summary: string;
  minutesToOpen: number;
  blockers: string[];
  warnings: string[];
}

const GATE_STYLES: Record<ReadinessStatus['gate'], { dot: string; text: string }> = {
  READY: { dot: 'bg-green-500', text: 'READY' },
  DEGRADED: { dot: 'bg-yellow-500 animate-pulse', text: 'DEGRADED' },
  NOT_READY: { dot: 'bg-red-500 animate-pulse', text: 'NOT READY' },
  NON_TRADING_DAY: { dot: 'bg-zinc-500', text: 'NON-TRADING DAY' },
};

// Readiness runs live probes (feed service, chain, session) — 5 min is enough.
const READINESS_POLL_MS = 5 * 60 * 1000;

function ReadinessIndicator() {
  const [readiness, setReadiness] = useState<ReadinessStatus | null>(null);

  const fetchReadiness = useCallback(async () => {
    try {
      const res = await fetch('/api/premarket-readiness');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.gate) setReadiness(data as ReadinessStatus);
    } catch {
      // leave the previous value; a transient failure must not blank the bar
    }
  }, []);

  useEffect(() => {
    fetchReadiness();
    const id = setInterval(fetchReadiness, READINESS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchReadiness]);

  if (!readiness) return null;
  const style = GATE_STYLES[readiness.gate];

  return (
    <Tooltip>
      <TooltipTrigger>
        <Badge variant="outline" className="text-[8px] gap-1 h-5">
          <div className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
          {style.text}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <div className="text-xs space-y-1">
          <div className="font-medium">{readiness.summary}</div>
          <div className="text-muted-foreground">{readiness.minutesToOpen} min to open</div>
          {readiness.blockers.map((b, i) => (
            <div key={`b${i}`} className="text-red-400">• {b}</div>
          ))}
          {readiness.warnings.map((w, i) => (
            <div key={`w${i}`} className="text-yellow-400">• {w}</div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function ConnectionStatusBar() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  if (!health) return null;

  const getIndicator = (key: string, label: string) => {
    const check = health.checks[key];
    const isOk = check?.status === 'OK' || check?.status === 'CONNECTED' || check?.status === 'LIVE';
    const isWarn = check?.status === 'WARNING' || check?.status === 'RECONNECTING' || check?.status === 'DELAYED';

    return (
      <Tooltip>
        <TooltipTrigger>
          <div className="flex items-center gap-1">
            <div className={`h-1.5 w-1.5 rounded-full ${
              isOk ? 'bg-green-500' : isWarn ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
            }`} />
            <span className="text-[9px] text-muted-foreground hidden md:inline">{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs space-y-1">
            <div className="font-medium">{label}: {check?.status || 'UNKNOWN'}</div>
            {check?.message && <div className="text-muted-foreground">{check.message}</div>}
            {check?.latencyMs && <div className="text-muted-foreground">Latency: {check.latencyMs}ms</div>}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  };

  // Determine overall data source
  const yahooStatus = health.checks['data_YAHOO']?.status;
  const breezeStatus = health.checks['broker_ICICI_BREEZE']?.status;
  const motilalStatus = health.checks['broker_MOTILAL']?.status;

  let dataSourceLabel = 'DATA UNAVAILABLE';
  let dataSourceColor = 'bg-red-500';
  if (breezeStatus === 'CONNECTED') {
    dataSourceLabel = 'BREEZE LIVE';
    dataSourceColor = 'bg-green-500';
  } else if (motilalStatus === 'CONNECTED') {
    dataSourceLabel = 'MOTILAL LIVE';
    dataSourceColor = 'bg-green-500';
  } else if (yahooStatus === 'LIVE') {
    dataSourceLabel = 'YAHOO DELAYED';
    dataSourceColor = 'bg-yellow-500';
  }

  return (
    <div className="flex items-center gap-3">
      {/* Data source badge */}
      <Badge variant="outline" className="text-[8px] gap-1 h-5">
        <div className={`h-1.5 w-1.5 rounded-full ${dataSourceColor}`} />
        {dataSourceLabel}
      </Badge>

      {/* Premarket readiness verdict */}
      <ReadinessIndicator />

      {/* Individual indicators */}
      <div className="flex items-center gap-2">
        {getIndicator('backend', 'API')}
        {getIndicator('database', 'DB')}
        {getIndicator('websocket', 'WS')}
        {getIndicator('memory', 'MEM')}
      </div>
    </div>
  );
}
