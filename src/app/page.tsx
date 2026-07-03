'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  RefreshCw,
  Settings2,
  Sun,
  Moon,
  Activity,
  Zap,
  Brain,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { useTheme } from 'next-themes';
import { useTradingStore } from '@/stores/useTradingStore';
import { OrderPanel } from '@/components/dashboard/OrderPanel';
import { OrderBook } from '@/components/dashboard/OrderBook';
import { PositionTracker } from '@/components/dashboard/PositionTracker';
import { MarketStatus } from '@/components/dashboard/MarketStatus';
import { SDMDashboard } from '@/components/dashboard/SDMDashboard';
import { SDMOptionsPanel } from '@/components/dashboard/SDMOptionsPanel';
import { SDMBot } from '@/components/option-chain/SDMBot';
import { SimpleMode } from '@/components/dashboard/SimpleMode';
import type { FullAnalysis } from '@/lib/sdm-engine';
import type { SDMRecommendation } from '@/types/sdm';
import { getCurrentSession } from '@/lib/market-session';

// ─── Types ────────────────────────────────────────────────────────
type OptionSide = {
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  ltp: number;
  chg: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
};

type OptionData = {
  strike: number;
  ce: OptionSide | null;
  pe: OptionSide | null;
};

type ExpiryInfo = {
  date: string;
  label: string;
  daysToExpiry: number;
};

type MarketSummary = {
  spotPrice: number;
  spotChange: number;
  spotChangePct: number;
  indiaVIX: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  atmStrike: number;
};

type OptionChainResponse = {
  symbol: string;
  spotPrice: number;
  expiries: ExpiryInfo[];
  selectedExpiry: string;
  data: OptionData[];
  summary: MarketSummary;
  timestamp: string;
  isLive?: boolean;
  dataSource?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────
function formatIndian(num: number): string {
  if (num >= 10000000) return (num / 10000000).toFixed(2) + ' Cr';
  if (num >= 100000) return (num / 100000).toFixed(2) + ' L';
  if (num >= 1000) return num.toLocaleString('en-IN');
  return num.toString();
}

function fmt(num: number, d: number = 2): string {
  return num.toFixed(d);
}

function oiHeat(oi: number, maxOI: number, isCall: boolean): React.CSSProperties {
  const pct = Math.min(oi / maxOI, 1);
  if (isCall) {
    return { background: `linear-gradient(to left, rgba(239,68,68,${pct * 0.35}), transparent)` };
  }
  return { background: `linear-gradient(to right, rgba(34,197,94,${pct * 0.35}), transparent)` };
}

// ─── Main Page ────────────────────────────────────────────────────
export default function TradingDashboard() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [showGreeks, setShowGreeks] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [viewMode, setViewMode] = useState<'chain' | 'sdm'>('chain');
  const [displayMode, setDisplayMode] = useState<'simple' | 'pro'>('simple');
  const [recommendation, setRecommendation] = useState<SDMRecommendation | null>(null);
  const { theme, setTheme } = useTheme();
  
  const {
    setOptionChain,
    setSelectedSymbol,
    setSelectedExpiry: setStoreExpiry,
    setSelectedStrike,
    setSelectedOption,
    setShowOrderPanel,
    spotPrice,
  } = useTradingStore();
  
  const atmRef = useRef<HTMLTableRowElement>(null);
  
  const [analysis, setAnalysis] = useState<FullAnalysis | null>(null);
  const [breezeStatus, setBreezeStatus] = useState<{ isConnected: boolean; loginInProgress: boolean; message: string }>({
    isConnected: false,
    loginInProgress: false,
    message: '',
  });
  
  // Fetch option chain
  const { data, isLoading, refetch, isFetching } = useQuery<any>({
    queryKey: ['option-chain', symbol, selectedExpiry],
    queryFn: async () => {
      const params = new URLSearchParams({ symbol });
      if (selectedExpiry) params.set('expiry', selectedExpiry);
      const res = await fetch(`/api/option-chain?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      // Store analysis
      if (json.analysis) {
        setAnalysis(json.analysis);
      }
      // Flatten chain data
      return json.data || json;
    },
    refetchInterval: autoRefresh ? 15000 : false,
    staleTime: 5000,
  });
  
  // Update store
  useEffect(() => {
    if (data) {
      setOptionChain(data as any);
      setSelectedSymbol(symbol);
    }
  }, [data]);
  
  // Set default expiry
  useEffect(() => {
    if (data?.expiries?.length && !selectedExpiry) {
      setSelectedExpiry(data.expiries[0].date);
      setStoreExpiry(data.expiries[0].date);
    }
  }, [data]);
  
  // Scroll to ATM
  useEffect(() => {
    if (data?.summary?.atmStrike && atmRef.current) {
      setTimeout(() => {
        atmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  }, [data?.summary?.atmStrike, selectedExpiry, symbol]);
  
  // Max OI for heat map
  const chainData = useMemo(() => {
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }, [data?.data]);

  // Market session info
  const marketSession = useMemo(() => getCurrentSession(), []);

  // Check Breeze connection status on mount
  useEffect(() => {
    fetch('/api/breeze-connect')
      .then(r => r.json())
      .then(json => {
        if (json.success) {
          setBreezeStatus(prev => ({
            ...prev,
            isConnected: json.data.isConnected,
          }));
        }
      })
      .catch(() => {});
  }, []);

  // Poll login status when in progress
  useEffect(() => {
    if (!breezeStatus.loginInProgress) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/breeze-connect/status');
        const json = await res.json();
        if (json.success) {
          const s = json.data;
          setBreezeStatus({
            isConnected: s.isConnected,
            loginInProgress: s.status !== 'success' && s.status !== 'failed',
            message: s.message || '',
          });
          if (s.status === 'success') {
            refetch();
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [breezeStatus.loginInProgress]);

  const handleBreezeConnect = async () => {
    setBreezeStatus(prev => ({ ...prev, loginInProgress: true, message: 'Generating session...' }));
    try {
      const res = await fetch('/api/breeze-connect', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setBreezeStatus({ isConnected: true, loginInProgress: false, message: 'Connected!' });
        refetch();
      } else {
        setBreezeStatus(prev => ({ ...prev, loginInProgress: false, message: json.error || 'Failed' }));
      }
    } catch (err: any) {
      setBreezeStatus(prev => ({ ...prev, loginInProgress: false, message: err.message }));
    }
  };
  const maxCallOI = useMemo(() => chainData.length ? Math.max(...chainData.map(d => d.ce?.oi || 0)) : 1, [chainData]);
  const maxPutOI = useMemo(() => chainData.length ? Math.max(...chainData.map(d => d.pe?.oi || 0)) : 1, [chainData]);
  const maxOI = Math.max(maxCallOI, maxPutOI);
  
  const summary = data?.summary;
  const isPositive = (summary?.spotChange || 0) >= 0;
  
  // Handle buy/sell click
  const handleTrade = (strike: number, side: 'call' | 'put', action: 'buy' | 'sell') => {
    setSelectedStrike(strike);
    setSelectedOption(side);
    setShowOrderPanel(true);
  };
  
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Loading trading dashboard...</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ─── Header ─── */}
      <header className="sticky top-0 z-50 border-b bg-card/95 backdrop-blur-md">
        <div className="flex items-center justify-between px-3 py-2 gap-2">
          {/* Left: Logo + Symbol */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
                <Zap className="h-4 w-4 text-white" />
              </div>
              <h1 className="font-bold text-base tracking-tight hidden sm:block">SD PRO</h1>
            </div>
            
            <Select value={symbol} onValueChange={(v) => { setSymbol(v); setSelectedExpiry(''); }}>
              <SelectTrigger className="w-[120px] h-8 text-sm font-bold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NIFTY">NIFTY 50</SelectItem>
                <SelectItem value="BANKNIFTY">BANK NIFTY</SelectItem>
                <SelectItem value="FINNIFTY">FIN NIFTY</SelectItem>
                <SelectItem value="MIDCPNIFTY">MIDCAP NIFTY</SelectItem>
                <SelectItem value="SENSEX">SENSEX</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          {/* Center: View Tabs + Expiry Tabs */}
          <div className="flex items-center gap-2 flex-1 justify-center">
            {/* View Mode Tabs */}
            <div className="flex items-center bg-muted/50 rounded-lg p-0.5 shrink-0">
              <Button
                variant={viewMode === 'chain' ? 'default' : 'ghost'}
                size="sm"
                className={`h-7 text-[11px] px-3 font-bold ${
                  viewMode === 'chain' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                }`}
                onClick={() => setViewMode('chain')}
              >
                <Activity className="h-3 w-3 mr-1" /> Chain
              </Button>
              <Button
                variant={viewMode === 'sdm' ? 'default' : 'ghost'}
                size="sm"
                className={`h-7 text-[11px] px-3 font-bold ${
                  viewMode === 'sdm' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                }`}
                onClick={() => setViewMode('sdm')}
              >
                <Brain className="h-3 w-3 mr-1" /> SDM AI
              </Button>
            </div>

            <div className="w-px h-5 bg-border" />

            {/* Simple/Pro Toggle */}
            <div className="flex items-center bg-muted/50 rounded-lg p-0.5 shrink-0">
              <Button
                variant={displayMode === 'simple' ? 'default' : 'ghost'}
                size="sm"
                className={`h-7 text-[11px] px-3 font-bold ${
                  displayMode === 'simple' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground'
                }`}
                onClick={() => setDisplayMode('simple')}
              >
                Simple
              </Button>
              <Button
                variant={displayMode === 'pro' ? 'default' : 'ghost'}
                size="sm"
                className={`h-7 text-[11px] px-3 font-bold ${
                  displayMode === 'pro' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground'
                }`}
                onClick={() => setDisplayMode('pro')}
              >
                Pro
              </Button>
            </div>
            
            <div className="w-px h-5 bg-border" />
            
            {/* Expiry Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto">
              {data?.expiries?.slice(0, 5).map((exp) => (
                <Button
                  key={exp.date}
                  variant={selectedExpiry === exp.date ? 'default' : 'ghost'}
                  size="sm"
                  className={`h-7 text-[11px] px-2 shrink-0 font-medium ${
                    selectedExpiry === exp.date ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground'
                  }`}
                  onClick={() => { setSelectedExpiry(exp.date); setStoreExpiry(exp.date); }}
                >
                  {exp.label.split(' ').slice(0, 2).join(' ')}
                  <span className="ml-0.5 text-[9px] opacity-60">({exp.daysToExpiry}d)</span>
                </Button>
              ))}
            </div>
          </div>
          
          {/* Right: Controls */}
          <div className="flex items-center gap-2 shrink-0">
            <MarketStatus />
            
            <Separator orientation="vertical" className="h-4" />
            
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </Button>
            
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px] px-2">
                  <Settings2 className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48" align="end">
                <div className="space-y-3">
                  <h4 className="font-semibold text-sm">Settings</h4>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <Label className="text-sm cursor-pointer">Greeks</Label>
                    <Switch checked={showGreeks} onCheckedChange={setShowGreeks} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm cursor-pointer">Auto Refresh</Label>
                    <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        
        {/* Market Summary Strip */}
        {summary && (
          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border/50 overflow-x-auto text-[11px]">
            <span className="text-muted-foreground">Spot</span>
            <span className="font-bold tabular-nums">{fmt(summary.spotPrice)}</span>
            <Badge className={`text-[9px] h-4 px-1 ${isPositive ? 'bg-emerald-600' : 'bg-red-600'} text-white`}>
              {isPositive ? '+' : ''}{fmt(summary.spotChange)} ({isPositive ? '+' : ''}{fmt(summary.spotChangePct)}%)
            </Badge>
            <div className="w-px h-3 bg-border" />
            <span className="text-muted-foreground">VIX</span>
            <span className="font-semibold tabular-nums">{fmt(summary.indiaVIX)}</span>
            <div className="w-px h-3 bg-border" />
            <span className="text-muted-foreground">PCR</span>
            <span className={`font-semibold tabular-nums ${summary.pcr > 1.2 ? 'text-emerald-500' : summary.pcr < 0.7 ? 'text-red-500' : ''}`}>
              {fmt(summary.pcr)}
            </span>
            <div className="w-px h-3 bg-border" />
            <span className="text-muted-foreground">ATM</span>
            <span className="font-semibold text-primary tabular-nums">{summary.atmStrike}</span>
            <div className="w-px h-3 bg-border" />
            <Badge
              className={`text-[8px] h-4 ${
                marketSession.confidenceMultiplier >= 0.8
                  ? 'bg-emerald-600 text-white'
                  : marketSession.confidenceMultiplier >= 0.5
                  ? 'bg-yellow-600 text-white'
                  : 'bg-gray-600 text-white'
              }`}
            >
              {marketSession.label}
            </Badge>
            <div className="w-px h-3 bg-border" />
            <span className="text-muted-foreground">CE OI</span>
            <span className="text-red-500 font-semibold tabular-nums">{formatIndian(summary.totalCallOI)}</span>
            <span className="text-muted-foreground">PE OI</span>
            <span className="text-emerald-500 font-semibold tabular-nums">{formatIndian(summary.totalPutOI)}</span>
            {data?.dataSource && (
              <>
                <div className="w-px h-3 bg-border" />
                <Badge className="text-[8px]" variant={data.dataSource === 'simulation' ? 'outline' : 'default'}>
                  {data.dataSource === 'icici-breeze' ? 'LIVE' : data.dataSource === 'simulation' ? 'DEMO' : 'Yahoo'}
                </Badge>
              </>
            )}
            {data?.dataSource === 'simulation' && !breezeStatus.isConnected && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[9px] px-2 gap-1 border-emerald-500/50 text-emerald-500 hover:bg-emerald-500/10"
                onClick={handleBreezeConnect}
                disabled={breezeStatus.loginInProgress}
              >
                <Zap className="h-2.5 w-2.5" />
                {breezeStatus.loginInProgress ? breezeStatus.message || 'Connecting...' : 'Connect to Breeze'}
              </Button>
            )}
          </div>
        )}
      </header>
      
      {/* ─── Main Content ─── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ─── Simple Mode: Clean AI Recommendation ─── */}
        {displayMode === 'simple' ? (
          <div className="flex-1 overflow-auto">
            <SimpleMode
              recommendation={recommendation}
              spotPrice={data?.spotPrice || summary?.spotPrice || 0}
              symbol={symbol}
            />
          </div>
        ) : viewMode === 'chain' ? (
          <>
            {/* Left: Option Chain */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Column Headers */}
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 z-40">
                  <tr>
                    <th colSpan={showGreeks ? 7 : 5} className="py-1.5 text-center bg-red-500/10 dark:bg-red-500/20 border-b-2 border-red-500/30">
                      <span className="text-red-600 dark:text-red-400 font-bold text-xs tracking-widest">CALLS</span>
                    </th>
                    <th className="py-1.5 text-center bg-muted border-b-2 border-border">
                      <span className="font-bold text-xs"><Activity className="h-3 w-3 inline" /> STRIKE</span>
                    </th>
                    <th colSpan={showGreeks ? 7 : 5} className="py-1.5 text-center bg-emerald-500/10 dark:bg-emerald-500/20 border-b-2 border-emerald-500/30">
                      <span className="text-emerald-600 dark:text-emerald-400 font-bold text-xs tracking-widest">PUTS</span>
                    </th>
                  </tr>
              <tr className="text-[9px] font-semibold text-muted-foreground bg-muted/70">
                <th className="px-1 py-1 text-right">OI</th>
                <th className="px-1 py-1 text-right">Chg</th>
                <th className="px-1 py-1 text-right">Vol</th>
                <th className="px-1 py-1 text-right">LTP</th>
                {showGreeks && <><th className="px-1 py-1 text-right">Δ</th><th className="px-1 py-1 text-right">Θ</th><th className="px-1 py-1 text-right">γ</th></>}
                <th className="px-1 py-1 text-center font-bold">₹</th>
                {showGreeks && <><th className="px-1 py-1 text-left">γ</th><th className="px-1 py-1 text-left">Θ</th><th className="px-1 py-1 text-left">Δ</th></>}
                <th className="px-1 py-1 text-left">LTP</th>
                <th className="px-1 py-1 text-left">Vol</th>
                <th className="px-1 py-1 text-left">Chg</th>
                <th className="px-1 py-1 text-left">OI</th>
              </tr>
            </thead>
            <tbody className="overflow-auto">
              {chainData.map((row) => {
                const isATM = row.strike === data?.summary?.atmStrike;
                const spot = data?.spotPrice || 0;
                const isITMCall = row.strike < spot;
                const isITMPut = row.strike > spot;
                
                return (
                  <tr
                    key={row.strike}
                    ref={isATM ? atmRef : undefined}
                    className={`border-b border-border/30 transition-colors duration-75 hover:bg-accent/20 ${
                      isATM ? 'bg-primary/8 ring-1 ring-inset ring-primary/20' : ''
                    }`}
                  >
                    {/* CALL Side */}
                    <td className="px-1 py-1 text-right font-mono tabular-nums cursor-pointer" style={row.ce ? oiHeat(row.ce.oi, maxOI, true) : undefined}
                      onClick={() => row.ce && handleTrade(row.strike, 'call', 'buy')}>
                      <span className={row.ce && row.ce.oi > maxCallOI * 0.7 ? 'font-bold text-red-600 dark:text-red-400' : ''}>
                        {row.ce ? formatIndian(row.ce.oi) : '—'}
                      </span>
                    </td>
                    <td className={`px-1 py-1 text-right font-mono tabular-nums text-xs ${row.ce?.oiChg > 0 ? 'text-red-500' : row.ce?.oiChg < 0 ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                      {row.ce ? (row.ce.oiChg > 0 ? '+' : '') + formatIndian(row.ce.oiChg) : '—'}
                    </td>
                    <td className="px-1 py-1 text-right font-mono tabular-nums text-muted-foreground">
                      {row.ce ? formatIndian(row.ce.volume) : '—'}
                    </td>
                    <td className={`px-1 py-1 text-right font-mono tabular-nums font-semibold ${isITMCall ? 'bg-red-500/8' : ''}`}>
                      {row.ce ? fmt(row.ce.ltp) : '—'}
                    </td>
                    {showGreeks && row.ce && (
                      <><td className="px-1 py-1 text-right font-mono text-muted-foreground/60">{fmt(row.ce.delta)}</td><td className="px-1 py-1 text-right font-mono text-muted-foreground/60">{fmt(row.ce.theta)}</td><td className="px-1 py-1 text-right font-mono text-muted-foreground/60">{fmt(row.ce.gamma, 4)}</td></>
                    )}
                    {showGreeks && !row.ce && <><td /><td /><td /></>}
                    
                    {/* STRIKE */}
                    <td className={`px-2 py-1 text-center font-bold font-mono tabular-nums bg-muted/50 ${isATM ? 'bg-primary/15 text-primary text-[12px]' : ''}`}>
                      {row.strike}
                      {isATM && <span className="ml-1 text-[8px] font-medium text-primary/70">ATM</span>}
                    </td>
                    
                    {/* PUT Side */}
                    {showGreeks && row.pe && (
                      <><td className="px-1 py-1 text-left font-mono text-muted-foreground/60">{fmt(row.pe.gamma, 4)}</td><td className="px-1 py-1 text-left font-mono text-muted-foreground/60">{fmt(row.pe.theta)}</td><td className="px-1 py-1 text-left font-mono text-muted-foreground/60">{fmt(row.pe.delta)}</td></>
                    )}
                    {showGreeks && !row.pe && <><td /><td /><td /></>}
                    <td className={`px-1 py-1 text-left font-mono tabular-nums font-semibold ${isITMPut ? 'bg-emerald-500/8' : ''}`}
                      onClick={() => row.pe && handleTrade(row.strike, 'put', 'buy')}>
                      {row.pe ? fmt(row.pe.ltp) : '—'}
                    </td>
                    <td className="px-1 py-1 text-left font-mono tabular-nums text-muted-foreground">
                      {row.pe ? formatIndian(row.pe.volume) : '—'}
                    </td>
                    <td className={`px-1 py-1 text-left font-mono tabular-nums text-xs ${row.pe?.oiChg > 0 ? 'text-red-500' : row.pe?.oiChg < 0 ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                      {row.pe ? (row.pe.oiChg > 0 ? '+' : '') + formatIndian(row.pe.oiChg) : '—'}
                    </td>
                    <td className="px-1 py-1 text-left font-mono tabular-nums cursor-pointer" style={row.pe ? oiHeat(row.pe.oi, maxOI, false) : undefined}
                      onClick={() => row.pe && handleTrade(row.strike, 'put', 'buy')}>
                      <span className={row.pe && row.pe.oi > maxPutOI * 0.7 ? 'font-bold text-emerald-600 dark:text-emerald-400' : ''}>
                        {row.pe ? formatIndian(row.pe.oi) : '—'}
                      </span>
                    </td>
                    
                    {/* Buy/Sell Buttons */}
                    <td className="px-1 py-1">
                      <div className="flex gap-0.5">
                        {row.ce && (
                          <Button size="sm" className="h-5 w-8 text-[8px] px-0 bg-emerald-600 hover:bg-emerald-700"
                            onClick={() => handleTrade(row.strike, 'call', 'buy')}>
                            B
                          </Button>
                        )}
                        {row.pe && (
                          <Button size="sm" className="h-5 w-8 text-[8px] px-0 bg-red-600 hover:bg-red-700"
                            onClick={() => handleTrade(row.strike, 'put', 'sell')}>
                            S
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        
        {/* Right Sidebar: SDM AI + Orders + Positions */}
        <div className="w-[340px] border-l overflow-auto hidden lg:block">
          <div className="space-y-0">
            {/* SDM AI Dashboard */}
            <SDMDashboard analysis={analysis} loading={isLoading} />
            <OrderBook />
            <PositionTracker />
          </div>
        </div>
        </>
        ) : (
        /* ═══════ SDM OPTIONS AI FULL VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <SDMOptionsPanel analysis={analysis} chainData={chainData} loading={isLoading} />
        </div>
        )}
      </div>
      
      {/* ─── Footer ─── */}
      <footer className="border-t bg-card/95 px-3 py-1.5">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-6 h-1.5 rounded bg-red-500/40 inline-block" /> Call OI</span>
            <span className="flex items-center gap-1"><span className="w-6 h-1.5 rounded bg-emerald-500/40 inline-block" /> Put OI</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" /> ATM</span>
          </div>
          {data?.timestamp && (
            <span>Updated: {new Date(data.timestamp).toLocaleTimeString('en-IN')}</span>
          )}
        </div>
      </footer>
      
      {/* ─── Order Panel (Modal) ─── */}
      <OrderPanel />
      
      {/* ─── SDM Bot (Fixed Overlay) ─── */}
      <div className="fixed top-4 right-4 z-50 w-80">
        <SDMBot
          optionChainData={data}
          spotPrice={data?.spotPrice || summary?.spotPrice || 0}
          symbol={symbol}
          expiryDate={selectedExpiry}
          onRecommendation={setRecommendation}
        />
      </div>
    </div>
  );
}
