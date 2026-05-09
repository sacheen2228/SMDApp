'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  BarChart3,
  Activity,
  Settings2,
  Sun,
  Moon,
  Eye,
  EyeOff,
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

// Types
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
  open: number;
  high: number;
  low: number;
  prevClose: number;
  indiaVIX: number;
  vixChange: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVolume: number;
  totalPutVolume: number;
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
  spotPriceReal?: boolean;
  vixReal?: boolean;
};

type ViewMode = 'option-chain' | 'oi-analysis';

// Format helpers
function formatIndian(num: number): string {
  if (num >= 10000000) return (num / 10000000).toFixed(2) + ' Cr';
  if (num >= 100000) return (num / 100000).toFixed(2) + ' L';
  if (num >= 1000) return num.toLocaleString('en-IN');
  return num.toString();
}

function fmt(num: number, d: number = 2): string {
  return num.toFixed(d);
}

// OI Heat intensity
function oiHeat(oi: number, maxOI: number, isCall: boolean): React.CSSProperties {
  const pct = Math.min(oi / maxOI, 1);
  if (isCall) {
    return { background: `linear-gradient(to left, rgba(239,68,68,${pct * 0.35}), transparent)` };
  }
  return { background: `linear-gradient(to right, rgba(34,197,94,${pct * 0.35}), transparent)` };
}

export default function OptionChainPage() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [showGreeks, setShowGreeks] = useState(false);
  const [showOIChg, setShowOIChg] = useState(true);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('option-chain');
  const [strikesAroundATM, setStrikesAroundATM] = useState<number | null>(null);
  const [showOI, setShowOI] = useState(true);
  const atmRef = useRef<HTMLTableRowElement>(null);
  const { theme, setTheme } = useTheme();

  // Fetch option chain data
  const { data, isLoading, refetch, isFetching } = useQuery<OptionChainResponse>({
    queryKey: ['option-chain', symbol, selectedExpiry],
    queryFn: async () => {
      const params = new URLSearchParams({ symbol });
      if (selectedExpiry) params.set('expiry', selectedExpiry);
      const res = await fetch(`/api/option-chain?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    refetchInterval: autoRefresh ? 30000 : false,
    staleTime: 10000,
  });

  // Set default expiry when data loads
  const expiries = data?.expiries;
  if (expiries && expiries.length > 0 && !selectedExpiry) {
    setSelectedExpiry(expiries[0].date);
  }

  // Scroll to ATM on data load
  const atmStrike = data?.summary?.atmStrike;
  useEffect(() => {
    if (atmStrike && atmRef.current) {
      const timer = setTimeout(() => {
        atmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [atmStrike, selectedExpiry, symbol]);

  // Calculate max OI for heat map
  const chainData = data?.data;
  const maxCallOI = useMemo(() => {
    if (!chainData) return 1;
    return Math.max(...chainData.map(d => d.ce?.oi || 0), 1);
  }, [chainData]);

  const maxPutOI = useMemo(() => {
    if (!chainData) return 1;
    return Math.max(...chainData.map(d => d.pe?.oi || 0), 1);
  }, [chainData]);

  const maxOI = Math.max(maxCallOI, maxPutOI);

  const summary = data?.summary;
  const isPositive = (summary?.spotChange || 0) >= 0;

  // Filtered data based on strikes around ATM
  const filteredData = useMemo(() => {
    if (!chainData || !atmStrike || strikesAroundATM === null) return chainData || [];
    return chainData.filter(d => Math.abs(d.strike - atmStrike) <= strikesAroundATM * (symbol === 'NIFTY' || symbol === 'FINNIFTY' ? 50 : symbol === 'BANKNIFTY' || symbol === 'SENSEX' ? 100 : 25));
  }, [chainData, atmStrike, strikesAroundATM, symbol]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ─── Header ─── */}
      <header className="sticky top-0 z-50 border-b bg-card/95 backdrop-blur-md">
        <div className="flex items-center justify-between px-2 md:px-4 py-2 gap-2">
          {/* Left: Logo + Symbol */}
          <div className="flex items-center gap-2 md:gap-4 shrink-0">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
                <BarChart3 className="h-4 w-4 text-white" />
              </div>
              <h1 className="font-bold text-base hidden sm:block tracking-tight">OptionChain</h1>
            </div>

            <Select value={symbol} onValueChange={(v) => { setSymbol(v); setSelectedExpiry(''); setStrikesAroundATM(null); }}>
              <SelectTrigger className="w-[120px] md:w-[150px] h-8 text-sm font-bold">
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

          {/* Center: Expiry Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 justify-center">
            {data?.expiries?.slice(0, 6).map((exp) => (
              <Button
                key={exp.date}
                variant={selectedExpiry === exp.date ? 'default' : 'ghost'}
                size="sm"
                className={`h-7 text-[11px] px-2 md:px-3 shrink-0 font-medium ${
                  selectedExpiry === exp.date
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setSelectedExpiry(exp.date)}
              >
                {exp.label.split(' ').slice(0, 2).join(' ')}
                <span className="ml-0.5 text-[9px] opacity-60">({exp.daysToExpiry}d)</span>
              </Button>
            ))}
          </div>

          {/* Right: Controls */}
          <div className="flex items-center gap-1 md:gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </Button>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px] px-2">
                  <Settings2 className="h-3 w-3" />
                  <span className="hidden md:inline">Settings</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-52" align="end">
                <div className="space-y-3">
                  <h4 className="font-semibold text-sm">Display Options</h4>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <Label htmlFor="show-greeks" className="text-sm cursor-pointer">Greeks</Label>
                    <Switch id="show-greeks" checked={showGreeks} onCheckedChange={setShowGreeks} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="show-oichg" className="text-sm cursor-pointer">OI Change</Label>
                    <Switch id="show-oichg" checked={showOIChg} onCheckedChange={setShowOIChg} />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <Label htmlFor="auto-refresh" className="text-sm cursor-pointer">Auto Refresh</Label>
                    <Switch id="auto-refresh" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* ─── View Mode Tabs ─── */}
        <div className="flex items-center gap-1 px-2 md:px-4 pb-1.5 border-t border-border/50">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 text-[11px] px-3 font-medium rounded-md ${
              viewMode === 'option-chain'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setViewMode('option-chain')}
          >
            Option Chain
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 text-[11px] px-3 font-medium rounded-md ${
              viewMode === 'oi-analysis'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setViewMode('oi-analysis')}
          >
            <Activity className="h-3 w-3 mr-1" />
            OI Analysis
          </Button>
        </div>
      </header>

      {/* ─── Market Summary Bar ─── */}
      {summary && (
        <div className="border-b bg-card">
          <div className="flex items-center gap-2 md:gap-4 px-2 md:px-4 py-2 overflow-x-auto scrollbar-none text-sm">
            {/* Spot */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Spot</span>
              <span className="font-bold text-base tabular-nums">{fmt(summary.spotPrice)}</span>
              <Badge
                className={`text-[10px] h-5 px-1.5 font-semibold ${
                  isPositive ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'
                } text-white border-0`}
              >
                {isPositive ? <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> : <TrendingDown className="h-2.5 w-2.5 mr-0.5" />}
                {isPositive ? '+' : ''}{fmt(summary.spotChange)} ({isPositive ? '+' : ''}{fmt(summary.spotChangePct)}%)
              </Badge>
            </div>

            <div className="w-px h-5 bg-border shrink-0" />

            {/* VIX */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">VIX</span>
              <span className="font-semibold tabular-nums">{fmt(summary.indiaVIX)}</span>
              <span className={`text-[10px] font-semibold ${
                summary.vixChange >= 0 ? 'text-red-500' : 'text-emerald-500'
              }`}>
                {summary.vixChange >= 0 ? '+' : ''}{fmt(summary.vixChange)}
              </span>
            </div>

            <div className="w-px h-5 bg-border shrink-0" />

            {/* PCR */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">PCR</span>
              <span className={`font-semibold tabular-nums ${
                summary.pcr > 1.2 ? 'text-emerald-500' : summary.pcr < 0.7 ? 'text-red-500' : 'text-foreground'
              }`}>
                {fmt(summary.pcr)}
              </span>
            </div>

            <div className="w-px h-5 bg-border shrink-0" />

            {/* Max Pain */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Max Pain</span>
              <span className="font-semibold text-amber-500 tabular-nums">{fmt(summary.maxPain)}</span>
            </div>

            <div className="w-px h-5 bg-border shrink-0" />

            {/* OI Summary */}
            <div className="flex items-center gap-3 shrink-0">
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                <span className="text-[10px] text-muted-foreground">CE OI</span>
                <span className="text-[11px] font-semibold text-red-500 tabular-nums">{formatIndian(summary.totalCallOI)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="text-[10px] text-muted-foreground">PE OI</span>
                <span className="text-[11px] font-semibold text-emerald-500 tabular-nums">{formatIndian(summary.totalPutOI)}</span>
              </div>
            </div>

            {/* OHLC */}
            <div className="hidden lg:flex items-center gap-2 shrink-0 text-[11px]">
              <span className="text-muted-foreground">O <span className="text-foreground font-medium tabular-nums">{fmt(summary.open)}</span></span>
              <span className="text-muted-foreground">H <span className="text-emerald-500 font-medium tabular-nums">{fmt(summary.high)}</span></span>
              <span className="text-muted-foreground">L <span className="text-red-500 font-medium tabular-nums">{fmt(summary.low)}</span></span>
              <span className="text-muted-foreground">PC <span className="text-foreground font-medium tabular-nums">{fmt(summary.prevClose)}</span></span>
            </div>
          </div>
        </div>
      )}

      {/* ─── Conditional View ─── */}
      {viewMode === 'oi-analysis' && chainData ? (
        <OIAnalysisView
          data={filteredData}
          spotPrice={data!.spotPrice}
          maxOI={maxOI}
          atmStrike={data!.summary.atmStrike}
          showOI={showOI}
          setShowOI={setShowOI}
          strikesAroundATM={strikesAroundATM}
          setStrikesAroundATM={setStrikesAroundATM}
        />
      ) : viewMode === 'option-chain' && chainData ? (
        <>
          {/* ─── OI Summary Strip ─── */}
          <OIStrip data={chainData} spotPrice={data!.spotPrice} maxOI={maxOI} atmStrike={data!.summary.atmStrike} />

          {/* ─── Option Chain Table ─── */}
          <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-[11px] md:text-xs">
              <thead className="sticky top-0 z-40">
                {/* Section Headers */}
                <tr>
                  <th colSpan={showGreeks ? 10 : showOIChg ? 7 : 6} className="py-1.5 text-center bg-red-500/10 dark:bg-red-500/20 border-b-2 border-red-500/30">
                    <span className="text-red-600 dark:text-red-400 font-bold text-xs tracking-widest">CALLS</span>
                  </th>
                  <th className="py-1.5 text-center bg-muted border-b-2 border-border">
                    <span className="font-bold text-xs"><ArrowUpDown className="h-3 w-3 inline" /> STRIKE</span>
                  </th>
                  <th colSpan={showGreeks ? 10 : showOIChg ? 7 : 6} className="py-1.5 text-center bg-emerald-500/10 dark:bg-emerald-500/20 border-b-2 border-emerald-500/30">
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold text-xs tracking-widest">PUTS</span>
                  </th>
                </tr>
                {/* Column Headers */}
                <tr className="text-[9px] md:text-[10px] font-semibold text-muted-foreground bg-muted/70">
                  {/* Call columns */}
                  <th className="px-1.5 py-1 text-right bg-red-500/5">OI</th>
                  {showOIChg && <th className="px-1.5 py-1 text-right bg-red-500/5">Chg OI</th>}
                  <th className="px-1.5 py-1 text-right bg-red-500/5">Vol</th>
                  <th className="px-1.5 py-1 text-right bg-red-500/5">IV</th>
                  <th className="px-1.5 py-1 text-right bg-red-500/5">LTP</th>
                  <th className="px-1.5 py-1 text-right bg-red-500/5">Chg</th>
                  {showGreeks && (
                    <>
                      <th className="px-1 py-1 text-right bg-red-500/5">&Delta;</th>
                      <th className="px-1 py-1 text-right bg-red-500/5">&Gamma;</th>
                      <th className="px-1 py-1 text-right bg-red-500/5">&Theta;</th>
                      <th className="px-1 py-1 text-right bg-red-500/5">&nu;</th>
                    </>
                  )}
                  {/* Strike */}
                  <th className="px-2 py-1 text-center bg-muted font-bold">&#8377;</th>
                  {/* Put columns */}
                  <th className="px-1.5 py-1 text-left bg-emerald-500/5">Chg</th>
                  <th className="px-1.5 py-1 text-left bg-emerald-500/5">LTP</th>
                  <th className="px-1.5 py-1 text-left bg-emerald-500/5">IV</th>
                  <th className="px-1.5 py-1 text-left bg-emerald-500/5">Vol</th>
                  {showOIChg && <th className="px-1.5 py-1 text-left bg-emerald-500/5">Chg OI</th>}
                  <th className="px-1.5 py-1 text-left bg-emerald-500/5">OI</th>
                  {showGreeks && (
                    <>
                      <th className="px-1 py-1 text-left bg-emerald-500/5">&Delta;</th>
                      <th className="px-1 py-1 text-left bg-emerald-500/5">&Gamma;</th>
                      <th className="px-1 py-1 text-left bg-emerald-500/5">&Theta;</th>
                      <th className="px-1 py-1 text-left bg-emerald-500/5">&nu;</th>
                    </>
                  )}
                </tr>
              </thead>

              <tbody>
                {filteredData.map((row) => {
                  const isATM = row.strike === data?.summary?.atmStrike;
                  const spot = data?.spotPrice || 0;
                  const isITMCall = row.strike < spot;
                  const isITMPut = row.strike > spot;
                  const isSelected = selectedStrike === row.strike;

                  return (
                    <tr
                      key={row.strike}
                      ref={isATM ? atmRef : undefined}
                      className={`
                        border-b border-border/30 cursor-pointer transition-colors duration-75
                        ${isATM ? 'bg-primary/8 ring-1 ring-inset ring-primary/20' : ''}
                        ${isSelected && !isATM ? 'bg-accent/40' : ''}
                        hover:bg-accent/20
                      `}
                      onClick={() => setSelectedStrike(isSelected ? null : row.strike)}
                    >
                      {/* ── CALL Side ── */}
                      <td className="px-1.5 py-1 text-right font-mono tabular-nums" style={row.ce ? oiHeat(row.ce.oi, maxOI, true) : undefined}>
                        <span className={row.ce && row.ce.oi > maxCallOI * 0.7 ? 'font-bold text-red-600 dark:text-red-400' : ''}>
                          {row.ce ? formatIndian(row.ce.oi) : '\u2014'}
                        </span>
                      </td>
                      {showOIChg && (
                        <td className={`px-1.5 py-1 text-right font-mono tabular-nums ${
                          row.ce?.oiChg && row.ce.oiChg > 0 ? 'text-red-500' : row.ce?.oiChg && row.ce.oiChg < 0 ? 'text-emerald-500' : 'text-muted-foreground'
                        }`}>
                          {row.ce ? (row.ce.oiChg > 0 ? '+' : '') + formatIndian(row.ce.oiChg) : '\u2014'}
                        </td>
                      )}
                      <td className="px-1.5 py-1 text-right font-mono tabular-nums text-muted-foreground">
                        {row.ce ? formatIndian(row.ce.volume) : '\u2014'}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono tabular-nums text-muted-foreground">
                        {row.ce ? fmt(row.ce.iv) : '\u2014'}
                      </td>
                      <td className={`px-1.5 py-1 text-right font-mono tabular-nums font-semibold ${
                        isITMCall ? 'bg-red-500/8 dark:bg-red-500/10' : ''
                      }`}>
                        {row.ce ? fmt(row.ce.ltp) : '\u2014'}
                      </td>
                      <td className={`px-1.5 py-1 text-right font-mono tabular-nums ${
                        row.ce?.chg && row.ce.chg > 0 ? 'text-red-500' : row.ce?.chg && row.ce.chg < 0 ? 'text-emerald-500' : ''
                      }`}>
                        {row.ce ? (row.ce.chg > 0 ? '+' : '') + fmt(row.ce.chg) : '\u2014'}
                      </td>
                      {showGreeks && row.ce && (
                        <>
                          <td className="px-1 py-1 text-right font-mono tabular-nums text-muted-foreground/60">{fmt(row.ce.delta)}</td>
                          <td className="px-1 py-1 text-right font-mono tabular-nums text-muted-foreground/60">{fmt(row.ce.gamma, 4)}</td>
                          <td className="px-1 py-1 text-right font-mono tabular-nums text-muted-foreground/60">{fmt(row.ce.theta)}</td>
                          <td className="px-1 py-1 text-right font-mono tabular-nums text-muted-foreground/60">{fmt(row.ce.vega)}</td>
                        </>
                      )}
                      {showGreeks && !row.ce && <><td /><td /><td /><td /></>}

                      {/* ── STRIKE ── */}
                      <td className={`px-2 py-1 text-center font-bold font-mono tabular-nums bg-muted/50 ${
                        isATM ? 'bg-primary/15 text-primary text-[12px]' : ''
                      }`}>
                        {row.strike}
                        {isATM && <span className="ml-1 text-[8px] font-medium text-primary/70">ATM</span>}
                      </td>

                      {/* ── PUT Side ── */}
                      <td className={`px-1.5 py-1 text-left font-mono tabular-nums ${
                        row.pe?.chg && row.pe.chg > 0 ? 'text-red-500' : row.pe?.chg && row.pe.chg < 0 ? 'text-emerald-500' : ''
                      }`}>
                        {row.pe ? (row.pe.chg > 0 ? '+' : '') + fmt(row.pe.chg) : '\u2014'}
                      </td>
                      <td className={`px-1.5 py-1 text-left font-mono tabular-nums font-semibold ${
                        isITMPut ? 'bg-emerald-500/8 dark:bg-emerald-500/10' : ''
                      }`}>
                        {row.pe ? fmt(row.pe.ltp) : '\u2014'}
                      </td>
                      <td className="px-1.5 py-1 text-left font-mono tabular-nums text-muted-foreground">
                        {row.pe ? fmt(row.pe.iv) : '\u2014'}
                      </td>
                      <td className="px-1.5 py-1 text-left font-mono tabular-nums text-muted-foreground">
                        {row.pe ? formatIndian(row.pe.volume) : '\u2014'}
                      </td>
                      {showOIChg && (
                        <td className={`px-1.5 py-1 text-left font-mono tabular-nums ${
                          row.pe?.oiChg && row.pe.oiChg > 0 ? 'text-red-500' : row.pe?.oiChg && row.pe.oiChg < 0 ? 'text-emerald-500' : 'text-muted-foreground'
                        }`}>
                          {row.pe ? (row.pe.oiChg > 0 ? '+' : '') + formatIndian(row.pe.oiChg) : '\u2014'}
                        </td>
                      )}
                      <td className="px-1.5 py-1 text-left font-mono tabular-nums" style={row.pe ? oiHeat(row.pe.oi, maxOI, false) : undefined}>
                        <span className={row.pe && row.pe.oi > maxPutOI * 0.7 ? 'font-bold text-emerald-600 dark:text-emerald-400' : ''}>
                          {row.pe ? formatIndian(row.pe.oi) : '\u2014'}
                        </span>
                      </td>
                      {showGreeks && row.pe && (
                        <>
                          <td className="px-1 py-1 text-left font-mono tabular-nums text-muted-foreground/60">{fmt(row.pe.delta)}</td>
                          <td className="px-1 py-1 text-left font-mono tabular-nums text-muted-foreground/60">{fmt(row.pe.gamma, 4)}</td>
                          <td className="px-1 py-1 text-left font-mono tabular-nums text-muted-foreground/60">{fmt(row.pe.theta)}</td>
                          <td className="px-1 py-1 text-left font-mono tabular-nums text-muted-foreground/60">{fmt(row.pe.vega)}</td>
                        </>
                      )}
                      {showGreeks && !row.pe && <><td /><td /><td /><td /></>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {/* ─── Footer ─── */}
      <footer className="border-t bg-card/95 backdrop-blur-sm px-2 md:px-4 py-1.5 mt-auto">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              {data?.isLive ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-emerald-500 font-semibold">LIVE</span> · Motilal Oswal
                </>
              ) : data?.spotPriceReal ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  <span className="text-blue-500 font-semibold">REAL PRICES</span> · Yahoo Finance
                  <span className="text-muted-foreground">· OI simulated</span>
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  <span className="text-amber-500 font-semibold">SIMULATED</span> · Demo Data
                </>
              )}
              <span className="text-muted-foreground">· 30s refresh</span>
            </span>
            {data?.timestamp && (
              <span>{new Date(data.timestamp).toLocaleTimeString('en-IN')}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-6 h-1.5 rounded bg-red-500/40 inline-block" /> Call OI</span>
            <span className="flex items-center gap-1"><span className="w-6 h-1.5 rounded bg-emerald-500/40 inline-block" /> Put OI</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" /> ATM</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── OI Strip Component ───
function OIStrip({ data, spotPrice, maxOI, atmStrike }: {
  data: OptionData[];
  spotPrice: number;
  maxOI: number;
  atmStrike: number;
}) {
  const topCallOI = useMemo(() =>
    [...data].sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0)).slice(0, 5),
    [data]
  );
  const topPutOI = useMemo(() =>
    [...data].sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0)).slice(0, 5),
    [data]
  );

  const topCallMax = Math.max(...topCallOI.map(d => d.ce?.oi || 0), 1);
  const topPutMax = Math.max(...topPutOI.map(d => d.pe?.oi || 0), 1);

  return (
    <div className="border-b bg-card">
      <div className="flex items-stretch gap-4 md:gap-6 px-2 md:px-4 py-3 overflow-x-auto scrollbar-none">
        {/* Top Call OI */}
        <div className="shrink-0 min-w-[240px] md:min-w-[280px]">
          <div className="flex items-center gap-1.5 mb-2">
            <Activity className="h-3 w-3 text-red-500" />
            <span className="text-[10px] font-bold text-red-600 dark:text-red-400 uppercase tracking-wider">Call OI · Resistance</span>
          </div>
          <div className="space-y-1">
            {topCallOI.map((d) => (
              <div key={d.strike} className="flex items-center gap-2 text-[11px]">
                <span className="w-12 text-right font-mono tabular-nums text-muted-foreground shrink-0">{d.strike}</span>
                <div className="flex-1 h-3 bg-muted/50 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-red-400 to-red-500 rounded-sm oi-bar"
                    style={{ width: `${((d.ce?.oi || 0) / topCallMax) * 100}%` }}
                  />
                </div>
                <span className="w-14 text-right font-mono tabular-nums text-muted-foreground shrink-0">{formatIndian(d.ce?.oi || 0)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="w-px bg-border shrink-0" />

        {/* Top Put OI */}
        <div className="shrink-0 min-w-[240px] md:min-w-[280px]">
          <div className="flex items-center gap-1.5 mb-2">
            <Activity className="h-3 w-3 text-emerald-500" />
            <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Put OI · Support</span>
          </div>
          <div className="space-y-1">
            {topPutOI.map((d) => (
              <div key={d.strike} className="flex items-center gap-2 text-[11px]">
                <span className="w-12 text-right font-mono tabular-nums text-muted-foreground shrink-0">{d.strike}</span>
                <div className="flex-1 h-3 bg-muted/50 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500 rounded-sm oi-bar"
                    style={{ width: `${((d.pe?.oi || 0) / topPutMax) * 100}%` }}
                  />
                </div>
                <span className="w-14 text-right font-mono tabular-nums text-muted-foreground shrink-0">{formatIndian(d.pe?.oi || 0)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="w-px bg-border shrink-0 hidden md:block" />

        {/* OI Distribution Chart */}
        <div className="hidden md:block shrink-0 flex-1 min-w-[300px]">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="h-3 w-3 text-primary" />
            <span className="text-[10px] font-bold uppercase tracking-wider">OI Distribution</span>
          </div>
          <div className="flex items-end gap-[1px] h-14 relative">
            {data.length > 0 && (
              <div
                className="absolute bottom-0 w-px bg-primary/30 z-10"
                style={{
                  left: `${((atmStrike - data[0]?.strike) / (data[data.length - 1]?.strike - data[0]?.strike)) * 100}%`,
                  height: '100%'
                }}
              />
            )}
            {data.filter(d => d.ce || d.pe).map((d) => {
              const callPct = maxOI > 0 ? ((d.ce?.oi || 0) / maxOI) * 100 : 0;
              const putPct = maxOI > 0 ? ((d.pe?.oi || 0) / maxOI) * 100 : 0;
              const isATM = d.strike === atmStrike;

              return (
                <div
                  key={d.strike}
                  className={`flex-1 flex flex-col-reverse gap-[1px] min-w-[2px] ${isATM ? 'opacity-100' : 'opacity-60 hover:opacity-100'} transition-opacity`}
                >
                  <div
                    className="w-full bg-emerald-500/70 rounded-t-[1px] transition-all duration-500"
                    style={{ height: `${Math.max(putPct, 0.5)}%`, minHeight: d.pe?.oi ? '1px' : '0' }}
                  />
                  <div
                    className="w-full bg-red-500/70 rounded-t-[1px] transition-all duration-500"
                    style={{ height: `${Math.max(callPct, 0.5)}%`, minHeight: d.ce?.oi ? '1px' : '0' }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[8px] text-muted-foreground mt-1 tabular-nums">
            <span>{data[0]?.strike}</span>
            <span className="text-primary font-medium">{atmStrike} ATM</span>
            <span>{data[data.length - 1]?.strike}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── OI Analysis View (Sensibull-style) ───
function OIAnalysisView({ data, spotPrice, maxOI, atmStrike, showOI, setShowOI, strikesAroundATM, setStrikesAroundATM }: {
  data: OptionData[];
  spotPrice: number;
  maxOI: number;
  atmStrike: number;
  showOI: boolean;
  setShowOI: (v: boolean) => void;
  strikesAroundATM: number | null;
  setStrikesAroundATM: (v: number | null) => void;
}) {
  const [analysisMode, setAnalysisMode] = useState<'oi-change' | 'open-interest'>('oi-change');
  const chartRef = useRef<HTMLDivElement>(null);

  // Get data for the chart
  const chartData = useMemo(() => {
    return data.filter(d => d.ce || d.pe);
  }, [data]);

  // Calculate max values for scaling
  const maxOIChg = useMemo(() => {
    if (chartData.length === 0) return 1;
    const maxCeChg = Math.max(...chartData.map(d => Math.abs(d.ce?.oiChg || 0)));
    const maxPeChg = Math.max(...chartData.map(d => Math.abs(d.pe?.oiChg || 0)));
    return Math.max(maxCeChg, maxPeChg, 1);
  }, [chartData]);

  const maxOIVal = useMemo(() => {
    if (chartData.length === 0) return 1;
    const maxCe = Math.max(...chartData.map(d => d.ce?.oi || 0));
    const maxPe = Math.max(...chartData.map(d => d.pe?.oi || 0));
    return Math.max(maxCe, maxPe, 1);
  }, [chartData]);

  const scaleMax = analysisMode === 'oi-change' ? maxOIChg : maxOIVal;

  // Strike range options
  const strikeRangeOptions = [
    { label: 'All', value: null },
    { label: '5', value: 5 },
    { label: '10', value: 10 },
    { label: '15', value: 15 },
    { label: '20', value: 20 },
  ];

  // Top Call/Put OI
  const topCallOI = useMemo(() =>
    [...data].sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0)).slice(0, 5),
    [data]
  );
  const topPutOI = useMemo(() =>
    [...data].sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0)).slice(0, 5),
    [data]
  );

  const topCallChg = useMemo(() =>
    [...data].filter(d => d.ce && d.ce.oiChg !== 0).sort((a, b) => Math.abs(b.ce?.oiChg || 0) - Math.abs(a.ce?.oiChg || 0)).slice(0, 5),
    [data]
  );
  const topPutChg = useMemo(() =>
    [...data].filter(d => d.pe && d.pe.oiChg !== 0).sort((a, b) => Math.abs(b.pe?.oiChg || 0) - Math.abs(a.ce?.oiChg || 0)).slice(0, 5),
    [data]
  );

  return (
    <div className="flex-1 overflow-auto">
      {/* Controls Bar */}
      <div className="border-b bg-card px-2 md:px-4 py-2">
        <div className="flex flex-wrap items-center gap-2 md:gap-4">
          {/* Analysis Mode Tabs */}
          <div className="flex items-center bg-muted rounded-md p-0.5">
            <Button
              variant="ghost"
              size="sm"
              className={`h-6 text-[11px] px-2.5 rounded-sm ${
                analysisMode === 'oi-change'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              }`}
              onClick={() => setAnalysisMode('oi-change')}
            >
              OI Change
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`h-6 text-[11px] px-2.5 rounded-sm ${
                analysisMode === 'open-interest'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              }`}
              onClick={() => setAnalysisMode('open-interest')}
            >
              Open Interest
            </Button>
          </div>

          {/* Strikes Around ATM */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground font-medium mr-1">Strikes:</span>
            {strikeRangeOptions.map(opt => (
              <Button
                key={opt.label}
                variant="ghost"
                size="sm"
                className={`h-6 text-[10px] px-2 rounded-sm ${
                  strikesAroundATM === opt.value
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setStrikesAroundATM(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>

          {/* Show OI Toggle */}
          <div className="flex items-center gap-1.5 ml-auto">
            <Label htmlFor="show-oi-toggle" className="text-[10px] text-muted-foreground cursor-pointer">Show OI</Label>
            <Switch id="show-oi-toggle" checked={showOI} onCheckedChange={setShowOI} className="scale-75" />
          </div>
        </div>
      </div>

      {/* Main Chart Area */}
      <div className="px-2 md:px-4 py-4">
        {/* Chart Title */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold">
              {analysisMode === 'oi-change' ? 'Call / Put OI Change' : 'Call / Put Open Interest'}
            </h3>
            <span className="text-[10px] text-muted-foreground">
              {data.length > 0 && `${data[0]?.strike} - ${data[data.length - 1]?.strike}`}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm bg-red-500/80 inline-block" /> Call
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm bg-emerald-500/80 inline-block" /> Put
            </span>
          </div>
        </div>

        {/* Bar Chart */}
        <div className="relative border rounded-lg bg-card/50 p-4" ref={chartRef}>
          {/* Y-axis labels */}
          <div className="absolute left-1 top-4 bottom-6 flex flex-col justify-between text-[8px] text-muted-foreground tabular-nums">
            <span>+{formatIndian(scaleMax)}</span>
            <span>0</span>
            <span>-{formatIndian(scaleMax)}</span>
          </div>

          {/* Chart Body */}
          <div className="ml-10">
            {/* Zero line */}
            <div className="relative h-48 md:h-64">
              {/* Center line (zero) */}
              <div className="absolute left-0 right-0 top-1/2 h-px bg-border z-10" />

              {/* Spot price vertical line */}
              {chartData.length > 0 && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-primary/40 z-10"
                  style={{
                    left: `${((atmStrike - chartData[0]?.strike) / (chartData[chartData.length - 1]?.strike - chartData[0]?.strike)) * 100}%`
                  }}
                >
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 text-[8px] text-primary font-bold whitespace-nowrap">
                    {spotPrice}
                  </div>
                </div>
              )}

              {/* Bars */}
              <div className="flex items-stretch h-full gap-[1px]">
                {chartData.map((d) => {
                  const isATM = d.strike === atmStrike;

                  if (analysisMode === 'oi-change') {
                    const ceChg = d.ce?.oiChg || 0;
                    const peChg = d.pe?.oiChg || 0;
                    const ceHeight = scaleMax > 0 ? (Math.abs(ceChg) / scaleMax) * 50 : 0;
                    const peHeight = scaleMax > 0 ? (Math.abs(peChg) / scaleMax) * 50 : 0;

                    return (
                      <div
                        key={d.strike}
                        className={`flex-1 flex flex-col items-center justify-center min-w-[3px] md:min-w-[5px] group relative ${isATM ? 'opacity-100' : 'opacity-70 hover:opacity-100'} transition-opacity`}
                      >
                        {/* Call bar (top = positive, bottom = negative) */}
                        {ceChg >= 0 ? (
                          <div
                            className="w-full bg-red-500/80 rounded-t-sm transition-all duration-300"
                            style={{ height: `${Math.max(ceHeight, ceChg ? 1 : 0)}%`, marginTop: 'auto', marginBottom: '50%' }}
                          />
                        ) : (
                          <div style={{ marginTop: '50%' }}>
                            <div
                              className="w-full bg-red-500/80 rounded-b-sm transition-all duration-300"
                              style={{ height: `${Math.max(ceHeight, 1)}%` }}
                            />
                          </div>
                        )}

                        {/* Put bar (opposite direction) */}
                        {peChg >= 0 ? (
                          <div
                            className="w-full bg-emerald-500/80 rounded-t-sm transition-all duration-300 absolute"
                            style={{ height: `${Math.max(peHeight, peChg ? 1 : 0)}%`, top: `${50 - peHeight}%` }}
                          />
                        ) : (
                          <div
                            className="w-full bg-emerald-500/80 rounded-b-sm transition-all duration-300 absolute"
                            style={{ height: `${Math.max(peHeight, 1)}%`, top: '50%' }}
                          />
                        )}

                        {/* Hover tooltip */}
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-popover border rounded px-1.5 py-0.5 text-[8px] font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-sm pointer-events-none">
                          <span className="text-red-500">C:{formatIndian(ceChg)}</span>
                          {' | '}
                          <span className="text-emerald-500">P:{formatIndian(peChg)}</span>
                          <br />
                          <span className="text-foreground">{d.strike}</span>
                        </div>
                      </div>
                    );
                  } else {
                    // Open Interest mode
                    const ceOI = d.ce?.oi || 0;
                    const peOI = d.pe?.oi || 0;
                    const ceHeight = maxOIVal > 0 ? (ceOI / maxOIVal) * 50 : 0;
                    const peHeight = maxOIVal > 0 ? (peOI / maxOIVal) * 50 : 0;

                    return (
                      <div
                        key={d.strike}
                        className={`flex-1 flex flex-col items-center min-w-[3px] md:min-w-[5px] group relative ${isATM ? 'opacity-100' : 'opacity-70 hover:opacity-100'} transition-opacity`}
                      >
                        {/* Call OI bar (grows downward from center) */}
                        {showOI && (
                          <div
                            className="w-full bg-red-500/70 rounded-b-sm transition-all duration-300"
                            style={{ height: `${Math.max(ceHeight, ceOI ? 1 : 0)}%`, marginTop: '50%' }}
                          />
                        )}

                        {/* Put OI bar (grows upward from center) */}
                        {showOI && (
                          <div
                            className="w-full bg-emerald-500/70 rounded-t-sm transition-all duration-300 absolute"
                            style={{ height: `${Math.max(peHeight, peOI ? 1 : 0)}%`, top: `${50 - peHeight}%` }}
                          />
                        )}

                        {/* Hover tooltip */}
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-popover border rounded px-1.5 py-0.5 text-[8px] font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-sm pointer-events-none">
                          <span className="text-red-500">C:{formatIndian(ceOI)}</span>
                          {' | '}
                          <span className="text-emerald-500">P:{formatIndian(peOI)}</span>
                          <br />
                          <span className="text-foreground">{d.strike}</span>
                        </div>
                      </div>
                    );
                  }
                })}
              </div>
            </div>

            {/* X-axis labels */}
            <div className="flex justify-between text-[8px] text-muted-foreground mt-1 tabular-nums overflow-hidden">
              {chartData.filter((_, i) => i % Math.max(1, Math.floor(chartData.length / 8)) === 0).map(d => (
                <span key={d.strike} className="shrink-0">{d.strike}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          {/* Top Call OI Resistance */}
          <div className="border rounded-lg p-3 bg-card">
            <div className="flex items-center gap-1.5 mb-2">
              <Activity className="h-3 w-3 text-red-500" />
              <span className="text-[10px] font-bold text-red-600 dark:text-red-400 uppercase">Call Resistance</span>
            </div>
            <div className="space-y-1">
              {topCallOI.slice(0, 3).map(d => (
                <div key={d.strike} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono tabular-nums text-muted-foreground">{d.strike}</span>
                  <span className="font-mono tabular-nums font-semibold text-red-500">{formatIndian(d.ce?.oi || 0)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Top Put OI Support */}
          <div className="border rounded-lg p-3 bg-card">
            <div className="flex items-center gap-1.5 mb-2">
              <Activity className="h-3 w-3 text-emerald-500" />
              <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase">Put Support</span>
            </div>
            <div className="space-y-1">
              {topPutOI.slice(0, 3).map(d => (
                <div key={d.strike} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono tabular-nums text-muted-foreground">{d.strike}</span>
                  <span className="font-mono tabular-nums font-semibold text-emerald-500">{formatIndian(d.pe?.oi || 0)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Top Call OI Change */}
          <div className="border rounded-lg p-3 bg-card">
            <div className="flex items-center gap-1.5 mb-2">
              <TrendingUp className="h-3 w-3 text-red-500" />
              <span className="text-[10px] font-bold text-red-600 dark:text-red-400 uppercase">CE OI Change</span>
            </div>
            <div className="space-y-1">
              {topCallChg.slice(0, 3).map(d => (
                <div key={d.strike} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono tabular-nums text-muted-foreground">{d.strike}</span>
                  <span className={`font-mono tabular-nums font-semibold ${(d.ce?.oiChg || 0) >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                    {(d.ce?.oiChg || 0) >= 0 ? '+' : ''}{formatIndian(d.ce?.oiChg || 0)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Top Put OI Change */}
          <div className="border rounded-lg p-3 bg-card">
            <div className="flex items-center gap-1.5 mb-2">
              <TrendingDown className="h-3 w-3 text-emerald-500" />
              <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase">PE OI Change</span>
            </div>
            <div className="space-y-1">
              {topPutChg.slice(0, 3).map(d => (
                <div key={d.strike} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono tabular-nums text-muted-foreground">{d.strike}</span>
                  <span className={`font-mono tabular-nums font-semibold ${(d.pe?.oiChg || 0) >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                    {(d.pe?.oiChg || 0) >= 0 ? '+' : ''}{formatIndian(d.pe?.oiChg || 0)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* OI Data Table */}
        {showOI && (
          <div className="mt-4 border rounded-lg overflow-hidden">
            <div className="bg-card px-3 py-2 border-b">
              <h4 className="text-xs font-bold">
                {analysisMode === 'oi-change' ? 'OI Change by Strike' : 'Open Interest by Strike'}
              </h4>
            </div>
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-muted/90">
                  <tr className="text-[9px] font-semibold text-muted-foreground">
                    <th className="px-2 py-1 text-left">Strike</th>
                    <th className="px-2 py-1 text-right text-red-500">CE {analysisMode === 'oi-change' ? 'Chg' : 'OI'}</th>
                    <th className="px-2 py-1 text-right text-emerald-500">PE {analysisMode === 'oi-change' ? 'Chg' : 'OI'}</th>
                    <th className="px-2 py-1 text-right">CE Vol</th>
                    <th className="px-2 py-1 text-right">PE Vol</th>
                    <th className="px-2 py-1 text-right">CE IV</th>
                    <th className="px-2 py-1 text-right">PE IV</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.map((d) => {
                    const isATM = d.strike === atmStrike;
                    return (
                      <tr
                        key={d.strike}
                        className={`border-b border-border/20 ${isATM ? 'bg-primary/5 font-semibold' : ''}`}
                      >
                        <td className="px-2 py-1 font-mono tabular-nums">
                          {d.strike}
                          {isATM && <span className="ml-1 text-[7px] text-primary font-bold">ATM</span>}
                        </td>
                        <td className={`px-2 py-1 text-right font-mono tabular-nums ${
                          analysisMode === 'oi-change'
                            ? (d.ce?.oiChg || 0) > 0 ? 'text-red-500' : (d.ce?.oiChg || 0) < 0 ? 'text-emerald-500' : ''
                            : ''
                        }`}>
                          {analysisMode === 'oi-change'
                            ? ((d.ce?.oiChg || 0) >= 0 ? '+' : '') + formatIndian(d.ce?.oiChg || 0)
                            : formatIndian(d.ce?.oi || 0)
                          }
                        </td>
                        <td className={`px-2 py-1 text-right font-mono tabular-nums ${
                          analysisMode === 'oi-change'
                            ? (d.pe?.oiChg || 0) > 0 ? 'text-red-500' : (d.pe?.oiChg || 0) < 0 ? 'text-emerald-500' : ''
                            : ''
                        }`}>
                          {analysisMode === 'oi-change'
                            ? ((d.pe?.oiChg || 0) >= 0 ? '+' : '') + formatIndian(d.pe?.oiChg || 0)
                            : formatIndian(d.pe?.oi || 0)
                          }
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                          {formatIndian(d.ce?.volume || 0)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                          {formatIndian(d.pe?.volume || 0)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                          {d.ce ? fmt(d.ce.iv) : '\u2014'}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                          {d.pe ? fmt(d.pe.iv) : '\u2014'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Loading Screen ───
function LoadingScreen() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card p-4">
        <div className="flex items-center gap-4">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-8 w-[150px] rounded-md bg-muted animate-pulse" />
          <div className="h-8 w-[120px] rounded-md bg-muted animate-pulse" />
        </div>
      </header>
      <div className="h-16 bg-muted/30 animate-pulse" />
      <div className="h-24 bg-muted/20 animate-pulse" />
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <div className="text-center">
            <p className="text-lg font-medium">Loading Option Chain</p>
            <p className="text-sm text-muted-foreground mt-1">Fetching real-time data...</p>
          </div>
        </div>
      </div>
    </div>
  );
}
