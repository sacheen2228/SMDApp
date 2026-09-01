// ─── Expiry Radar Dashboard ───────────────────────────────────────────
// Main dashboard component for CAS + Expiry Liquidity Shift Engine

"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import {
  Zap,
  Activity,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Gauge,
  Target,
  Shield,
  Clock,
  RefreshCw,
  ChevronRight,
  X,
} from "lucide-react";

interface ExpiryRadarData {
  symbol: string;
  timestamp: number;
  isExpiryDay: boolean;
  casActive: boolean;
  casReferencePrice: number;
  currentPrice: number;
  casDislocationPct: number;
  futuresPrice: number;
  futuresConfirmed: boolean;
  atmStrike: number;
  bullishScore: number;
  bearishScore: number;
  expiryScore: number;
  direction: 'BULLISH' | 'BEARISH' | 'NO_DIRECTION';
  optionFlow: string;
  volumeRatio: number;
  ivState: string;
  auctionState: string;
  volumeProfileState: string;
  liquidityState: string;
  signal: string;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  target3: number;
  riskReward: number;
  dataQuality: number;
  status: string;
  casExpiryMode: any;
  marginRisk: any;
  liquidityEvent: any;
  exhaustion: any;
  reversal: any;
}

function ScoreCircle({ score, label, color, size = 60 }: { score: number; label: string; color: string; size?: number }) {
  const circumference = 2 * Math.PI * 24;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg className="transform -rotate-90" width={size} height={size}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={24}
            stroke="currentColor"
            strokeWidth={4}
            fill="none"
            className="text-zinc-800"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={24}
            stroke={color}
            strokeWidth={4}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            fill="none"
            className="transition-all duration-500"
            style={{ filter: `drop-shadow(0 0 8px ${color})` }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-black text-white">{score}</span>
        </div>
      </div>
      <span className="text-[9px] font-medium text-zinc-400">{label}</span>
    </div>
  );
}

function MetricCard({ icon, label, value, change, color }: { icon: any; label: string; value: string; change?: string; color: string }) {
  return (
    <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-lg ${color}`}>{icon}</span>
        <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-bold text-white">{value}</span>
        {change && <span className="text-[10px] font-medium">{change}</span>}
      </div>
    </div>
  );
}

function StatusBadge({ label, color, pulse = false }: { label: string; color: string; pulse?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={`text-[9px] font-bold px-2 py-0.5 ${color} ${pulse ? 'animate-pulse' : ''}`}
    >
      {label}
    </Badge>
  );
}

export function ExpiryRadar() {
  const [selectedSymbol, setSelectedSymbol] = useState("NIFTY");
  const [expanded, setExpanded] = useState(false);

  const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

  const { data, isLoading, error } = useQuery({
    queryKey: ["expiry-radar", selectedSymbol],
    queryFn: async () => {
      const res = await fetch(`/api/expiry-liquidity?symbol=${selectedSymbol}&details=true`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    refetchInterval: 15000,
    staleTime: 5000,
    enabled: true,
  });

  const radar = data as ExpiryRadarData | undefined;

  const directionColor = radar?.direction === 'BULLISH' ? 'text-emerald-400' :
    radar?.direction === 'BEARISH' ? 'text-red-400' : 'text-yellow-400';
  const directionIcon = radar?.direction === 'BULLISH' ? <TrendingUp className="h-4 w-4" /> :
    radar?.direction === 'BEARISH' ? <TrendingDown className="h-4 w-4" /> : <Gauge className="h-4 w-4" />;

  const scoreColor = radar && radar.expiryScore >= 80 ? 'text-emerald-400' :
    radar && radar.expiryScore >= 60 ? 'text-emerald-300' :
    radar && radar.expiryScore >= 40 ? 'text-yellow-400' :
    radar && radar.expiryScore >= 20 ? 'text-orange-400' : 'text-red-400';

  if (isLoading) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800 h-full">
        <CardContent className="p-4">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-zinc-800 rounded w-1/4" />
            <div className="grid grid-cols-3 gap-2">
              {[1,2,3].map(i => <div key={i} className="h-24 bg-zinc-800 rounded" />)}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800 h-full">
        <CardContent className="p-4 text-center text-red-400">
          Failed to load: {(error as Error).message}
        </CardContent>
      </Card>
    );
  }

  if (!radar) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800 h-full">
        <CardContent className="p-4 text-center text-zinc-500">
          No data available
        </CardContent>
      </Card>
    );
  }

  const isExpiryMode = radar.casExpiryMode?.isActive;

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden h-full flex flex-col">
      {/* Header */}
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Zap className="h-3 w-3 text-yellow-500 animate-pulse" />
            <CardTitle className="text-xs font-bold text-zinc-400">EXPIRY RADAR</CardTitle>
          </div>
          <StatusBadge label={radar.signal} color={
            radar.signal === 'LONG_CALL' ? 'bg-emerald-600' :
            radar.signal === 'LONG_PUT' ? 'bg-red-600' :
            radar.signal === 'WATCH' ? 'bg-yellow-600' :
            'bg-zinc-600'
          } pulse={radar.status === 'CONFIRMING'} />
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedSymbol} onValueChange={setSelectedSymbol} className="w-32">
            <SelectTrigger className="text-[10px] h-7 bg-zinc-800 border-zinc-700">
              <SelectValue placeholder="Symbol" />
            </SelectTrigger>
            <SelectContent>
              {SYMBOLS.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isExpiryMode && (
            <StatusBadge
              label={`CAS ${radar.casExpiryMode?.phase} ${radar.casExpiryMode?.countdownLabel}`}
              color="bg-orange-600"
              pulse
            />
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-0 flex-1 overflow-auto">
        {/* Top Row: Core Metrics */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <MetricCard
            icon={<Zap className="h-4 w-4" />}
            label="EXPIRY SCORE"
            value={radar.expiryScore}
            color={scoreColor}
          />
          <MetricCard
            icon={<Activity className="h-4 w-4" />}
            label="CAS DISLOCATION"
            value={`${radar.casDislocationPct >= 0 ? '+' : ''}${radar.casDislocationPct.toFixed(2)}%`}
            color={radar.casDislocationPct > 0 ? 'text-emerald-400' : radar.casDislocationPct < 0 ? 'text-red-400' : 'text-zinc-400'}
          />
          <MetricCard
            icon={<Gauge className="h-4 w-4" />}
            label="VIX"
            value={radar.vixState || 'NORMAL'}
            color="text-yellow-400"
          />
        </div>

        {/* Second Row: Direction & Flow */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-400">DIRECTION</span>
              <div className={`flex items-center gap-1 ${directionColor}`}>
                {directionIcon}
                <span className="text-sm font-black">{radar.direction}</span>
              </div>
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-emerald-400 font-bold">Bullish: {radar.bullishScore}</span>
              <span className="text-red-400 font-bold">Bearish: {radar.bearishScore}</span>
            </div>
          </div>

          <MetricCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="OPTION FLOW"
            value={radar.optionFlow}
            color={radar.optionFlow === 'LONG_BUILDUP' || radar.optionFlow === 'SHORT_COVERING' ? 'text-emerald-400' :
              radar.optionFlow === 'SHORT_BUILDUP' || radar.optionFlow === 'LONG_UNWINDING' ? 'text-red-400' :
              'text-zinc-400'}
          />
          <MetricCard
            icon={<Target className="h-4 w-4" />}
            label="R:R"
            value={`1:${radar.riskReward?.toFixed(1) || '0'}`}
            color={radar.riskReward >= 2 ? 'text-emerald-400' : radar.riskReward >= 1.5 ? 'text-yellow-400' : 'text-red-400'}
          />
        </div>

        {/* CAS & Futures Section */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-400 flex items-center gap-1">
                <Activity className="h-3 w-3" />
                CAS REFERENCE
              </span>
              <StatusBadge label={radar.casActive ? 'ACTIVE' : 'INACTIVE'} color={radar.casActive ? 'bg-emerald-600' : 'bg-zinc-600'} />
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div>
                <span className="text-zinc-500">Reference</span>
                <div className="font-bold">₹{radar.casReferencePrice?.toFixed(2) || '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">Current</span>
                <div className="font-bold">₹{radar.currentPrice?.toFixed(2) || '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">Dislocation</span>
                <div className={`font-bold ${radar.casDislocationPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {radar.casDislocationPct >= 0 ? '+' : ''}{radar.casDislocationPct.toFixed(2)}%
                </div>
              </div>
              <div>
                <span className="text-zinc-500">Status</span>
                <div className={`font-bold ${radar.casActive ? 'text-emerald-400' : 'text-zinc-400'}`}>
                  {radar.casActive ? 'LIVE' : 'PENDING'}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-400 flex items-center gap-1">
                <Zap className="h-3 w-3" />
                FUTURES
              </span>
              <StatusBadge label={radar.futuresConfirmed ? 'CONFIRMED' : 'NO CONFIRM'} color={radar.futuresConfirmed ? 'bg-emerald-600' : 'bg-red-600'} />
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div>
                <span className="text-zinc-500">Futures</span>
                <div className="font-bold">₹{radar.futuresPrice?.toFixed(2) || '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">Basis</span>
                <div className="font-bold">₹{radar.futuresPrice ? (radar.futuresPrice - radar.currentPrice).toFixed(2) : '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">OI State</span>
                <div className="font-bold text-zinc-400">{radar.futuresPrice ? 'CONFIRMED' : 'PENDING'}</div>
              </div>
              <div>
                <span className="text-zinc-500">Confirmed</span>
                <div className={`font-bold ${radar.futuresConfirmed ? 'text-emerald-400' : 'text-red-400'}`}>
                  {radar.futuresConfirmed ? 'YES' : 'NO'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Trade Setup Card */}
        {radar.signal !== 'NO_TRADE' && radar.signal !== 'WATCH' && (
          <div className="bg-zinc-800/50 border border-emerald-500/30 rounded-lg p-3 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-emerald-400 flex items-center gap-1">
                <Target className="h-3 w-3" />
                TRADE SETUP
              </span>
              <StatusBadge label={radar.status} color={
                radar.status === 'CONFIRMED' ? 'bg-emerald-600' :
                radar.status === 'CONFIRMING' ? 'bg-blue-600' :
                radar.status === 'TRIGGERED' ? 'bg-emerald-600' :
                radar.status === 'ACTIVE' ? 'bg-emerald-600' :
                'bg-zinc-600'
              } />
            </div>
            <div className="grid grid-cols-5 gap-2 text-[10px] mb-2">
              <div>
                <span className="text-zinc-500">Entry</span>
                <div className="font-bold text-white">₹{radar.entry?.toFixed(2) || '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">Stop</span>
                <div className="font-bold text-red-400">₹{radar.stop?.toFixed(2) || '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">Target 1</span>
                <div className="font-bold text-emerald-400">₹{radar.target1?.toFixed(2) || '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">Target 2</span>
                <div className="font-bold text-emerald-400">₹{radar.target2?.toFixed(2) || '—'}</div>
              </div>
              <div>
                <span className="text-zinc-500">R:R</span>
                <div className={`font-bold ${radar.riskReward >= 2 ? 'text-emerald-400' : radar.riskReward >= 1.5 ? 'text-yellow-400' : 'text-red-400'}`}>
                  1:{radar.riskReward?.toFixed(1) || '0'}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {radar.explainability?.why?.slice(0, 3).map((r: string, i: number) => (
                <Badge key={i} className="bg-emerald-500/10 text-emerald-400 text-[8px] border-emerald-500/20">
                  ✓ {r}
                </Badge>
              ))}
              {radar.explainability?.risks?.slice(0, 2).map((r: string, i: number) => (
                <Badge key={i} className="bg-red-500/10 text-red-400 text-[8px] border-red-500/20">
                  ⚠ {r}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Bottom Row: Risk & Quality */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
            <div className="text-[10px] font-bold text-zinc-400 mb-2">RISK METRICS</div>
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between"><span className="text-zinc-500">Margin Risk</span><span className="font-bold text-emerald-400">LOW</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Data Quality</span><span className="font-bold text-emerald-400">{radar.dataQuality}%</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Exhaustion</span><span className="font-bold text-zinc-400">NONE</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Reversal Risk</span><span className="font-bold text-emerald-400">NONE</span></div>
            </div>
          </div>

          <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
            <div className="text-[10px] font-bold text-zinc-400 mb-2">AUCTION / VP</div>
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between"><span className="text-zinc-500">Auction State</span><span className="font-bold text-zinc-400">{radar.auctionState}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">VP State</span><span className="font-bold text-zinc-400">{radar.volumeProfileState}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Liquidity</span><span className="font-bold text-zinc-400">{radar.liquidityState}</span></div>
            </div>
          </div>

          <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
            <div className="text-[10px] font-bold text-zinc-400 mb-2">EXPIRY MODE</div>
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between">
                <span className="text-zinc-500">Phase</span>
                <span className={`font-bold ${radar.casExpiryMode?.isActive ? 'text-orange-400' : 'text-zinc-400'}`}>
                  {radar.casExpiryMode?.phase || 'INACTIVE'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">CAS Ends</span>
                <span className="font-bold text-orange-400">{radar.casExpiryMode?.timeRemainingCas}m</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">F&O Ends</span>
                <span className="font-bold text-orange-400">{radar.casExpiryMode?.timeRemainingFo}m</span>
              </div>
            </div>
          </div>
        </div>

        {/* Disclaimer */}
        <div className="mt-4 text-center text-[9px] text-zinc-600">
          AI-generated analysis based on real market data. Not financial advice.
        </div>
      </CardContent>
    </Card>
  );
}