'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  BarChart3,
  Activity,
  Settings2,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
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
};

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

            <Select value={symbol} onValueChange={(v) => { setSymbol(v); setSelectedExpiry(''); }}>
              <SelectTrigger className="w-[120px] md:w-[150px] h-8 text-sm font-bold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NIFTY">NIFTY 50</SelectItem>
                <SelectItem value="BANKNIFTY">BANK NIFTY</SelectItem>
                <SelectItem value="FINNIFTY">FIN NIFTY</SelectItem>
                <SelectItem value="MIDCPNIFTY">MIDCAP NIFTY</SelectItem>
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
                {summary.vixChange >= 0 ? '▲' : '▼'} {fmt(Math.abs(summary.vixChange))}
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

      {/* ─── OI Analysis ─── */}
      {chainData && (
        <OIAnalysis data={chainData} spotPrice={data!.spotPrice} maxOI={maxOI} atmStrike={data!.summary.atmStrike} />
      )}

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
                  <th className="px-1 py-1 text-right bg-red-500/5">Δ</th>
                  <th className="px-1 py-1 text-right bg-red-500/5">Γ</th>
                  <th className="px-1 py-1 text-right bg-red-500/5">Θ</th>
                  <th className="px-1 py-1 text-right bg-red-500/5">ν</th>
                </>
              )}
              {/* Strike */}
              <th className="px-2 py-1 text-center bg-muted font-bold">₹</th>
              {/* Put columns */}
              <th className="px-1.5 py-1 text-left bg-emerald-500/5">Chg</th>
              <th className="px-1.5 py-1 text-left bg-emerald-500/5">LTP</th>
              <th className="px-1.5 py-1 text-left bg-emerald-500/5">IV</th>
              <th className="px-1.5 py-1 text-left bg-emerald-500/5">Vol</th>
              {showOIChg && <th className="px-1.5 py-1 text-left bg-emerald-500/5">Chg OI</th>}
              <th className="px-1.5 py-1 text-left bg-emerald-500/5">OI</th>
              {showGreeks && (
                <>
                  <th className="px-1 py-1 text-left bg-emerald-500/5">Δ</th>
                  <th className="px-1 py-1 text-left bg-emerald-500/5">Γ</th>
                  <th className="px-1 py-1 text-left bg-emerald-500/5">Θ</th>
                  <th className="px-1 py-1 text-left bg-emerald-500/5">ν</th>
                </>
              )}
            </tr>
          </thead>

          <tbody>
            {chainData?.map((row) => {
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
                      {row.ce ? formatIndian(row.ce.oi) : '—'}
                    </span>
                  </td>
                  {showOIChg && (
                    <td className={`px-1.5 py-1 text-right font-mono tabular-nums ${
                      row.ce?.oiChg && row.ce.oiChg > 0 ? 'text-red-500' : row.ce?.oiChg && row.ce.oiChg < 0 ? 'text-emerald-500' : 'text-muted-foreground'
                    }`}>
                      {row.ce ? (row.ce.oiChg > 0 ? '+' : '') + formatIndian(row.ce.oiChg) : '—'}
                    </td>
                  )}
                  <td className="px-1.5 py-1 text-right font-mono tabular-nums text-muted-foreground">
                    {row.ce ? formatIndian(row.ce.volume) : '—'}
                  </td>
                  <td className="px-1.5 py-1 text-right font-mono tabular-nums text-muted-foreground">
                    {row.ce ? fmt(row.ce.iv) : '—'}
                  </td>
                  <td className={`px-1.5 py-1 text-right font-mono tabular-nums font-semibold ${
                    isITMCall ? 'bg-red-500/8 dark:bg-red-500/10' : ''
                  }`}>
                    {row.ce ? fmt(row.ce.ltp) : '—'}
                  </td>
                  <td className={`px-1.5 py-1 text-right font-mono tabular-nums ${
                    row.ce?.chg && row.ce.chg > 0 ? 'text-red-500' : row.ce?.chg && row.ce.chg < 0 ? 'text-emerald-500' : ''
                  }`}>
                    {row.ce ? (row.ce.chg > 0 ? '+' : '') + fmt(row.ce.chg) : '—'}
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
                    {row.pe ? (row.pe.chg > 0 ? '+' : '') + fmt(row.pe.chg) : '—'}
                  </td>
                  <td className={`px-1.5 py-1 text-left font-mono tabular-nums font-semibold ${
                    isITMPut ? 'bg-emerald-500/8 dark:bg-emerald-500/10' : ''
                  }`}>
                    {row.pe ? fmt(row.pe.ltp) : '—'}
                  </td>
                  <td className="px-1.5 py-1 text-left font-mono tabular-nums text-muted-foreground">
                    {row.pe ? fmt(row.pe.iv) : '—'}
                  </td>
                  <td className="px-1.5 py-1 text-left font-mono tabular-nums text-muted-foreground">
                    {row.pe ? formatIndian(row.pe.volume) : '—'}
                  </td>
                  {showOIChg && (
                    <td className={`px-1.5 py-1 text-left font-mono tabular-nums ${
                      row.pe?.oiChg && row.pe.oiChg > 0 ? 'text-red-500' : row.pe?.oiChg && row.pe.oiChg < 0 ? 'text-emerald-500' : 'text-muted-foreground'
                    }`}>
                      {row.pe ? (row.pe.oiChg > 0 ? '+' : '') + formatIndian(row.pe.oiChg) : '—'}
                    </td>
                  )}
                  <td className="px-1.5 py-1 text-left font-mono tabular-nums" style={row.pe ? oiHeat(row.pe.oi, maxOI, false) : undefined}>
                    <span className={row.pe && row.pe.oi > maxPutOI * 0.7 ? 'font-bold text-emerald-600 dark:text-emerald-400' : ''}>
                      {row.pe ? formatIndian(row.pe.oi) : '—'}
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

      {/* ─── Footer ─── */}
      <footer className="border-t bg-card/95 backdrop-blur-sm px-2 md:px-4 py-1.5">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              Live · 30s refresh
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

// ─── OI Analysis Component ───
function OIAnalysis({ data, spotPrice, maxOI, atmStrike }: {
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
            {/* Center line for ATM */}
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
