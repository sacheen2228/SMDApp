'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Wifi, WifiOff, Shield, Activity } from 'lucide-react';

interface HealthStatus {
  status: string;
  checks: Record<string, { status: string; message?: string; latencyMs?: number }>;
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
