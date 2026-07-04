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
  Timer,
  CalendarClock,
  Bot,
  Scan,
  Newspaper,
  Target,
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
import { GapAnalysis } from '@/components/dashboard/GapAnalysis';
import { BacktestReport } from '@/components/dashboard/BacktestReport';
import { BacktestTab } from '@/components/dashboard/BacktestTab';
import { AgentChat } from '@/components/dashboard/AgentChat';
import { ScannerPanel } from '@/components/dashboard/ScannerPanel';
import { NewsPanel } from '@/components/dashboard/NewsPanel';
import { BreakoutDetector } from '@/components/dashboard/BreakoutDetector';
import { StrategyBuilder } from '@/components/dashboard/StrategyBuilder';
import { GreeksHeatmap } from '@/components/dashboard/GreeksHeatmap';
import { TVChart } from '@/components/dashboard/TVChart';
import { ResizablePanel } from '@/components/ui/resizable-panel';
import { MobileNav } from '@/components/dashboard/MobileNav';
import { VirtualOptionChain } from '@/components/option-chain/VirtualOptionChain';
import { getLotSize } from '@/lib/symbol-config';
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
  const [showGreeks, setShowGreeks] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [viewMode, setViewMode] = useState<'chain' | 'sdm' | 'gap' | 'backtest' | 'agent' | 'scanner' | 'news' | 'breakout' | 'strategy' | 'greeks' | 'chart'>('chain');
  const [displayMode, setDisplayMode] = useState<'simple' | 'pro'>('simple');
  const [showSidebar, setShowSidebar] = useState(true);
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
  const [refreshCountdown, setRefreshCountdown] = useState(15);
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
  
  // Fetch trade journal
  const { data: journalData } = useQuery<any[]>({
    queryKey: ['trade-journal'],
    queryFn: async () => {
      const res = await fetch('/api/trade-journal');
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.trades) ? json.trades : Array.isArray(json) ? json : [];
    },
    staleTime: 30000,
  });
  
  // Update store
  useEffect(() => {
    if (data) {
      setOptionChain(data as any);
      setSelectedSymbol(symbol);
    }
  }, [data, setOptionChain, setSelectedSymbol, symbol]);
  
  // Set default expiry
  useEffect(() => {
    if (data?.expiries?.length && !selectedExpiry) {
      setSelectedExpiry(data.expiries[0].date);
      setStoreExpiry(data.expiries[0].date);
    }
  }, [data, selectedExpiry, setSelectedExpiry, setStoreExpiry]);
  
  // Scroll to ATM
  useEffect(() => {
    if (data?.summary?.atmStrike && atmRef.current) {
      const timer = setTimeout(() => {
        atmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [data?.summary?.atmStrike, selectedExpiry, symbol]);
  
  // Auto-refresh countdown
  useEffect(() => {
    if (!autoRefresh) { setRefreshCountdown(0); return; }
    setRefreshCountdown(15);
    const interval = setInterval(() => {
      setRefreshCountdown((prev) => {
        if (prev <= 1) return 15;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [autoRefresh, data]);

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
    <div className="min-h-screen flex flex-col bg-background text-foreground pb-14 lg:pb-0">
      {/* ─── Header ─── */}
      <header className="sticky top-0 z-50 border-b bg-card/95 backdrop-blur-md">
        {/* Row 1: Logo + Symbol + Controls */}
        <div className="flex items-center justify-between px-3 py-1.5 gap-2">
          <div className="flex items-center gap-2 shrink-0">
            <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
              <Zap className="h-3.5 w-3.5 text-white" />
            </div>
            <h1 className="font-bold text-sm tracking-tight hidden sm:block">Angel</h1>
            <Select value={symbol} onValueChange={(v) => { setSymbol(v); setSelectedExpiry(''); }}>
              <SelectTrigger className="w-[100px] h-7 text-xs font-bold">
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
          <div className="flex items-center gap-1.5 shrink-0">
            <MarketStatus />
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 w-7 p-0">
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
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { refetch(); setRefreshCountdown(15); }} disabled={isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
            {autoRefresh && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
                <Timer className="h-3 w-3" />
                <span>{refreshCountdown}s</span>
              </div>
            )}
          </div>
        </div>
        {/* Row 2: View Tabs + Simple/Pro + Expiry */}
        <div className="flex items-center gap-1.5 px-3 pb-1.5 overflow-x-auto">
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5 shrink-0">
            <Button variant={viewMode === 'chain' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'chain' ? 'bg-cyan-600 text-white shadow-sm shadow-cyan-500/25' : 'text-muted-foreground hover:text-cyan-500'}`}
              onClick={() => { setViewMode('chain'); setDisplayMode('pro'); }}>
              <Activity className="h-2.5 w-2.5 mr-0.5" /> Chain
            </Button>
            <Button variant={viewMode === 'sdm' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'sdm' ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/25' : 'text-muted-foreground hover:text-violet-500'}`}
              onClick={() => { setViewMode('sdm'); setDisplayMode('pro'); }}>
              <Brain className="h-2.5 w-2.5 mr-0.5" /> SDM AI
            </Button>
            <Button variant={viewMode === 'gap' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'gap' ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/25' : 'text-muted-foreground hover:text-amber-500'}`}
              onClick={() => { setViewMode('gap'); setDisplayMode('pro'); }}>
              <BarChart3 className="h-2.5 w-2.5 mr-0.5" /> Gap
            </Button>
            <Button variant={viewMode === 'backtest' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'backtest' ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/25' : 'text-muted-foreground hover:text-blue-500'}`}
              onClick={() => { setViewMode('backtest'); setDisplayMode('pro'); }}>
              <CalendarClock className="h-2.5 w-2.5 mr-0.5" /> Backtest
            </Button>
            <Button variant={viewMode === 'agent' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'agent' ? 'bg-purple-600 text-white shadow-sm shadow-purple-500/25' : 'text-muted-foreground hover:text-purple-500'}`}
              onClick={() => { setViewMode('agent'); setDisplayMode('pro'); }}>
              <Bot className="h-2.5 w-2.5 mr-0.5" /> Agent
            </Button>
            <Button variant={viewMode === 'scanner' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'scanner' ? 'bg-teal-600 text-white shadow-sm shadow-teal-500/25' : 'text-muted-foreground hover:text-teal-500'}`}
              onClick={() => { setViewMode('scanner'); setDisplayMode('pro'); }}>
              <Scan className="h-2.5 w-2.5 mr-0.5" /> Scanner
            </Button>
            <Button variant={viewMode === 'news' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'news' ? 'bg-orange-600 text-white shadow-sm shadow-orange-500/25' : 'text-muted-foreground hover:text-orange-500'}`}
              onClick={() => { setViewMode('news'); setDisplayMode('pro'); }}>
              <Newspaper className="h-2.5 w-2.5 mr-0.5" /> News
            </Button>
            <Button variant={viewMode === 'breakout' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'breakout' ? 'bg-rose-600 text-white shadow-sm shadow-rose-500/25' : 'text-muted-foreground hover:text-rose-500'}`}
              onClick={() => { setViewMode('breakout'); setDisplayMode('pro'); }}>
              <Target className="h-2.5 w-2.5 mr-0.5" /> Breakout
            </Button>
            <Button variant={viewMode === 'strategy' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'strategy' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/25' : 'text-muted-foreground hover:text-indigo-500'}`}
              onClick={() => { setViewMode('strategy'); setDisplayMode('pro'); }}>
              <BarChart3 className="h-2.5 w-2.5 mr-0.5" /> Strategy
            </Button>
            <Button variant={viewMode === 'greeks' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'greeks' ? 'bg-cyan-600 text-white shadow-sm shadow-cyan-500/25' : 'text-muted-foreground hover:text-cyan-500'}`}
              onClick={() => { setViewMode('greeks'); setDisplayMode('pro'); }}>
              <Activity className="h-2.5 w-2.5 mr-0.5" /> Greeks
            </Button>
            <Button variant={viewMode === 'chart' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'chart' ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/25' : 'text-muted-foreground hover:text-amber-500'}`}
              onClick={() => { setViewMode('chart'); setDisplayMode('pro'); }}>
              <BarChart3 className="h-2.5 w-2.5 mr-0.5" /> Chart
            </Button>
          </div>

          <div className="w-px h-4 bg-border shrink-0" />

          <div className="flex items-center bg-muted/50 rounded-lg p-0.5 shrink-0">
            <Button variant={displayMode === 'simple' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${displayMode === 'simple' ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/25' : 'text-muted-foreground hover:text-emerald-500'}`}
              onClick={() => setDisplayMode('simple')}>
              Simple
            </Button>
            <Button variant={displayMode === 'pro' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${displayMode === 'pro' ? 'bg-rose-600 text-white shadow-sm shadow-rose-500/25' : 'text-muted-foreground hover:text-rose-500'}`}
              onClick={() => setDisplayMode('pro')}>
              Pro
            </Button>
          </div>
          
          <div className="w-px h-4 bg-border shrink-0 hidden sm:block" />
          
          <div className="flex items-center gap-0.5 overflow-x-auto shrink-0 hidden sm:flex">
            {data?.expiries?.slice(0, 5).map((exp) => (
              <Button key={exp.date} variant={selectedExpiry === exp.date ? 'default' : 'ghost'} size="sm"
                className={`h-6 text-[9px] px-1.5 shrink-0 font-medium ${selectedExpiry === exp.date ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground'}`}
                onClick={() => { setSelectedExpiry(exp.date); setStoreExpiry(exp.date); }}>
                {exp.label.split(' ').slice(0, 2).join(' ')}
                <span className="ml-0.5 text-[7px] opacity-60">({exp.daysToExpiry}d)</span>
              </Button>
            ))}
          </div>
        </div>
        
        {/* Market Summary Strip */}
        {summary && (
          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border/50 overflow-x-auto text-[11px] scrollbar-hide">
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
              onSwitchToPro={() => setDisplayMode('pro')}
            />
          </div>
        ) : viewMode === 'chain' ? (
          <>
            {/* Left: Option Chain (Virtualized) */}
            <VirtualOptionChain
              data={chainData}
              maxOI={maxOI}
              maxCallOI={maxCallOI}
              maxPutOI={maxPutOI}
              atmStrike={data?.summary?.atmStrike ?? 0}
              spot={data?.spotPrice || 0}
              showGreeks={showGreeks}
              onTrade={handleTrade}
              scrollToATM
            />

        {/* Right Sidebar: SDM AI + Orders + Positions */}
        {showSidebar ? (
        <ResizablePanel defaultSize={28} minSize={18} maxSize={45} className="border-l overflow-auto hidden lg:block">
          <Button variant="ghost" size="sm" className="absolute top-1 right-3 z-10 h-6 w-6 p-0 text-muted-foreground"
            onClick={() => setShowSidebar(false)} aria-label="Close sidebar">
            ✕
          </Button>
          <div className="space-y-0">
            <SDMDashboard analysis={analysis} loading={isLoading} />
            <OrderBook />
            <PositionTracker />
          </div>
        </ResizablePanel>
        ) : (
        <div className="hidden lg:flex flex-col items-center border-l py-2 gap-2 shrink-0">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
            onClick={() => setShowSidebar(true)}>
            ☰
          </Button>
        </div>
        )}
        </>
        ) : viewMode === 'sdm' ? (
        /* ═══════ SDM OPTIONS AI FULL VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <SDMOptionsPanel analysis={analysis} chainData={chainData} loading={isLoading} />
        </div>
        ) : viewMode === 'backtest' ? (
        /* ═══════ BACKTEST VIEW ═══════ */
        <div className="flex-1 overflow-auto p-3">
          <BacktestTab trades={journalData || []} symbol={symbol} />
        </div>
        ) : viewMode === 'agent' ? (
        /* ═══════ AGENT VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <AgentChat
            symbol={symbol}
            spotPrice={data?.spotPrice || summary?.spotPrice || 0}
            analysis={analysis}
            summary={summary}
            gammaBlast={null}
            expiryDate={selectedExpiry}
          />
        </div>
        ) : viewMode === 'scanner' ? (
        /* ═══════ INTRADAY SCANNER VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <ScannerPanel
            symbol={symbol}
            spotPrice={data?.spotPrice || summary?.spotPrice || 0}
          />
        </div>
        ) : viewMode === 'news' ? (
        /* ═══════ NEWS SENTIMENT VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <NewsPanel symbol={symbol} />
        </div>
        ) : viewMode === 'breakout' ? (
        /* ═══════ BREAKOUT DETECTOR VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <BreakoutDetector />
        </div>
        ) : viewMode === 'strategy' ? (
        /* ═══════ STRATEGY BUILDER VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <StrategyBuilder
            spotPrice={data?.spotPrice || summary?.spotPrice || 0}
            chainData={chainData}
            symbol={symbol}
          />
        </div>
        ) : viewMode === 'greeks' ? (
        /* ═══════ GREEKS HEATMAP VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <GreeksHeatmap
            chainData={chainData}
            spotPrice={data?.spotPrice || summary?.spotPrice || 0}
          />
        </div>
        ) : viewMode === 'chart' ? (
        /* ═══════ TRADINGVIEW CHART VIEW ═══════ */
        <div className="flex-1 overflow-hidden p-2">
          <TVChart
            data={(data?.candles || []).map((c: any) => {
              const ts = c.timestamp || c.time;
              const date = new Date(ts.includes(':') && !ts.includes('T') ? `2026-07-04T${ts}:00` : ts);
              return {
                time: Math.floor(date.getTime() / 1000) as any,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
              };
            }).filter((c: any) => c.time > 0)}
            volume={(data?.candles || []).map((c: any) => {
              const ts = c.timestamp || c.time;
              const date = new Date(ts.includes(':') && !ts.includes('T') ? `2026-07-04T${ts}:00` : ts);
              return {
                time: Math.floor(date.getTime() / 1000) as any,
                value: c.volume || 0,
                color: c.close >= c.open ? "#26a69a80" : "#ef535080",
              };
            }).filter((c: any) => c.time > 0)}
            height={500}
          />
        </div>
        ) : (
        /* ═══════ GAP ANALYSIS VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <GapAnalysis
            analysis={analysis}
            summary={summary}
            spotPrice={data?.spotPrice || summary?.spotPrice || 0}
            symbol={symbol}
            expiryDate={selectedExpiry}
            chainData={chainData}
          />
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
            <span className="border-l border-border pl-2">Lot: {getLotSize(symbol)}</span>
            <span>Lot × 25 = {getLotSize(symbol) * 25} qty</span>
          </div>
          <div className="flex items-center gap-3">
            {marketSession && (
              <span className={`px-1.5 py-0.5 rounded text-[8px] font-medium ${
                marketSession.session === 'primary' ? 'bg-emerald-500/20 text-emerald-500' :
                marketSession.session === 'closed' ? 'bg-red-500/20 text-red-500' :
                'bg-yellow-500/20 text-yellow-500'
              }`}>
                {marketSession.label}
              </span>
            )}
            {data?.timestamp && (
              <span>Updated: {new Date(data.timestamp).toLocaleTimeString('en-IN')}</span>
            )}
          </div>
        </div>
      </footer>
      
      {/* ─── Order Panel (Modal) ─── */}
      <OrderPanel />
      
      {/* ─── SDM Bot (Fixed Overlay) ─── */}
      <div className="fixed top-4 right-4 z-50 w-80 hidden lg:block">
        <SDMBot
          optionChainData={data}
          spotPrice={data?.spotPrice || summary?.spotPrice || 0}
          symbol={symbol}
          expiryDate={selectedExpiry}
          onRecommendation={setRecommendation}
        />
      </div>

      {/* ─── Mobile Navigation ─── */}
      <MobileNav viewMode={viewMode} onViewChange={setViewMode} />
    </div>
  );
}
