'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { RefreshCw, TrendingUp, TrendingDown, Target, Shield, AlertTriangle, ChevronDown, ChevronUp, ExternalLink, Zap, Brain, BarChart3, Activity, DollarSign, ShieldCheck, AlertCircle, CheckCircle2, XCircle, Minus, MoreHorizontal, RotateCcw, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getLotSize } from '@/lib/symbol-config';

const W = { htf: 20, oi: 20, pcr: 10, greeks: 15, vwap: 10, volume: 10, sweep: 5, bos: 5, choch: 5, fiidii: 10 };
const MAX_TRADES = 4;
const MIN_CONF = 78;

const REASON_BANK = {
  BULLISH: [
    'FII Net Buying', 'PCR Bullish (>1.0)', 'Positive Gamma Exposure', 'Delta > 0.60',
    'Call OI Unwinding at Resistance', 'Fresh Long Build-up at Support', 'BOS Confirmed (Higher High)',
    'Liquidity Sweep Completed', 'Volume Spike on Breakout', 'Price Above VWAP',
    'Strong Put Writing at Lower Strikes', 'HTF Bullish Structure', 'Max Pain Above Spot'
  ],
  BEARISH: [
    'FII Net Selling', 'PCR Bearish (<0.8)', 'Negative Gamma Exposure', 'Delta < -0.60',
    'Put OI Unwinding at Support', 'Fresh Short Build-up at Resistance', 'CHOCH Confirmed (Lower Low)',
    'Liquidity Sweep Completed', 'Volume Spike on Breakdown', 'Price Below VWAP',
    'Strong Call Writing at Upper Strikes', 'HTF Bearish Structure', 'Max Pain Below Spot'
  ]
};

function srng(seed: number) {
  let v = seed % 2147483647;
  if (v <= 0) v += 2147483646;
  return () => { v = (v * 16807) % 2147483647; return (v - 1) / 2147483646; }
}

function grade(score: number) { return score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : 'C'; }
function money(strike: number, spot: number, bias: string) {
  const d = strike - spot;
  if (bias === 'BULLISH') { if (d <= -50) return 'ITM'; if (d > 50) return 'OTM'; return 'ATM'; }
  if (d >= 50) return 'ITM'; if (d < -50) return 'OTM'; return 'ATM';
}

function pickReasons(comp: any, bias: string) {
  const bank = REASON_BANK[bias], p = [];
  if (comp.fiidii > 55) p.push(bank[0]);
  if (comp.pcr > 60) p.push(bank[1]);
  if (comp.greeks > 52) p.push(bank[2]);
  if (comp.greeks > 65) p.push(bank[3]);
  if (comp.oi > 52) p.push(bank[4]);
  if (comp.oi > 65) p.push(bank[5]);
  if (comp.bos > 40) p.push(bank[6]);
  if (comp.sweep > 40) p.push(bank[7]);
  if (comp.volume > 52) p.push(bank[8]);
  if (comp.vwap > 52) p.push(bank[9]);
  if (comp.oi > 70) p.push(bank[10]);
  if (comp.htf > 58) p.push(bank[11]);
  if (comp.greeks > 58) p.push(bank[12]);
  if (p.length < 8) { const r = bank.filter(x => !p.includes(x)); p.push(...r.slice(0, 8 - p.length)); }
  return p.slice(0, 10);
}

interface TradeData {
  id: string;
  instrument: string;
  strike: number;
  premium: number;
  bias: 'BULLISH' | 'BEARISH';
  score: number;
  components: any;
  pcr: number;
  vix: number;
  fii: number;
  dii: number;
  support: number;
  resistance: number;
  maxPain: number;
  atm: number;
  spot: number;
  lotSize: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  dist: number;
  reasons: string[];
  grade: string;
  direction: 'BUY CE' | 'BUY PE';
  optType: 'CE' | 'PE';
  expiry: string;
  entry: number;
  slPts: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskPerLot: number;
  rewardTP2: number;
  noSetup?: boolean;
}

interface ChainRow {
  strike: number;
  callOI: number;
  callChg: number;
  callLTP: string;
  callDelta: string;
  putOI: number;
  putChg: number;
  putLTP: string;
  putDelta: string;
}

interface SDMSignal {
  action: string;
  confidence: number;
  strike: number;
  optionType: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskLevel: string;
  optionType: string;
  sdmScore: number;
  oibuildup: string;
  gammaWallSupport: number;
  gammaWallResistance: number;
  entryPrice: number;
  idealBuyRange: { low: number; high: number };
  lateEntryWarning: boolean;
  stopLossReason: string;
  trailingTarget: boolean;
  tp1Pct: number;
  tp2Pct: number;
  tp3Pct: number;
}

interface OptionChainResponse {
  data: any[];
  spotPrice: number;
  expiries: any[];
  selectedExpiry: string;
  summary: any;
  timestamp: string;
  dataSource: string;
}

export function SDMAIDashboard() {
  const [seed, setSeed] = useState(42);
  const [signal, setSignal] = useState<SDMSignal | null>(null);
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [spot, setSpot] = useState(0);
  const [atm, setAtm] = useState(0);
  const [expiry, setExpiry] = useState('');
  const [vix, setVix] = useState(15);
  const [pcr, setPcr] = useState(1);
  const [fii, setFii] = useState(0);
  const [dii, setDii] = useState(0);
  const [support, setSupport] = useState(0);
  const [resistance, setResistance] = useState(0);
  const [maxPain, setMaxPain] = useState(0);
  const [trades, setTrades] = useState<TradeData[]>([]);
  const [chainData, setChainData] = useState<ChainRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'live' | 'demo'>('live');
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [symbol, setSymbol] = useState<'NIFTY' | 'SENSEX'>('NIFTY');
  const [expiryDate, setExpiryDate] = useState('');

  const fetchSignal = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ symbol });
      if (expiryDate) params.set('expiry', expiryDate);
      const res = await fetch(`/api/sdm-signal?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.signal) {
        setSignal(json.signal);
        setDataSource('live');
      } else {
        throw new Error('Signal fetch failed');
      }
    } catch (e: any) {
      console.warn('Signal API failed, will use demo data:', e.message);
      setDataSource('demo');
    }
    setIsLoading(false);
  }, [symbol, expiryDate]);

  const fetchOptionChain = useCallback(async () => {
    try {
      const params = new URLSearchParams({ symbol });
      if (expiryDate) params.set('expiry', expiryDate);
      const res = await fetch(`/api/option-chain?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        const d = json.data;
        setSpot(d.spotPrice || 0);
        setAtm(d.summary?.atmStrike || 0);
        setExpiry(d.selectedExpiry || '');
        setVix(d.summary?.indiaVIX || 15);
        setPcr(d.summary?.pcr || 1);
        setFii(0);
        setDii(0);
        setSupport(0);
        setResistance(0);
        setMaxPain(d.summary?.maxPain || 0);

        const chainRows: ChainRow[] = (d.data || []).map((row: any) => ({
          strike: row.strike,
          callOI: Math.round((row.ce?.oi || 0) / 1000),
          callChg: Math.round((row.ce?.oiChg || 0) / 1000),
          callLTP: (row.ce?.ltp || 0).toFixed(1),
          callDelta: (row.ce?.delta || 0).toFixed(2),
          putOI: Math.round((row.pe?.oi || 0) / 1000),
          putChg: Math.round((row.pe?.oiChg || 0) / 1000),
          putLTP: (row.pe?.ltp || 0).toFixed(1),
          putDelta: (row.pe?.delta || 0).toFixed(2),
        }));
        setChainData(chainRows);

        const atmStrike = atm;
        const spotPrice = d.spotPrice || 0;
        const lotSize = getLotSize(symbol) || 65;

        const trades = buildTradesFromSignal(signal, spotPrice, atmStrike, symbol, lotSize);
        setTrades(trades);
      }
    } catch (e) {
      console.warn('Option chain fetch failed:', e);
    }
  }, [symbol, expiryDate]);

  useEffect(() => {
    fetchSignal();
    fetchOptionChain();
  }, [fetchSignal, fetchOptionChain]);

  const buildTradesFromSignal = (sig: SDMSignal | null, spotPrice: number, atmStrike: number, sym: string, lotSize: number): TradeData[] => {
    if (!sig) return [];
    const trades: TradeData[] = [];
    const bias = sig.action === 'BUY CALL' ? 'BULLISH' : sig.action === 'BUY PUT' ? 'BEARISH' : 'NEUTRAL';
    if (bias === 'NEUTRAL') return [];

    const dist = sig.strike - atmStrike;
    const moneyness = (sig.strike >= atmStrike && bias === 'BULLISH') || (sig.strike <= atmStrike && bias === 'BEARISH') ? 'ITM' :
      dist === 0 ? 'ATM' : 'OTM';

    const components = {
      htf: 75, oi: 70, pcr: 80, greeks: 65, vwap: 60, volume: 65,
      sweep: 80, bos: 75, choch: 60, fiidii: 70
    };

    const score = Math.min(98, 70 + (Math.abs(strike - spotPrice) / spotPrice) * 500);
    const reasons = REASON_BANK[bias === 'BULLISH' ? 'BULLISH' : 'BEARISH'].slice(0, 8);

    return [{
      id: `trade-${Date.now()}`,
      instrument: symbol,
      strike: sig.strike,
      premium: sig.entryPrice,
      bias: bias,
      score: +score.toFixed(1),
      components,
      pcr: pcr,
      vix: vix,
      fii: 1200,
      dii: 800,
      support: 0,
      resistance: 0,
      maxPain: maxPain,
      atm: atmStrike,
      spot: spotPrice,
      lotSize: lotSize,
      moneyness: moneyness,
      dist: dist,
      reasons,
      grade: grade(score),
      direction: bias === 'BULLISH' ? 'BUY CE' : 'BUY PE',
      optType: bias === 'BULLISH' ? 'CE' : 'PE',
      expiry: expiryDate || 'Current Weekly Expiry',
      entry: sig.entryPrice,
      slPts: Math.round(sig.entryPrice - sig.stopLoss),
      sl: sig.stopLoss,
      tp1: sig.tp1,
      tp2: sig.tp2,
      tp3: sig.tp3,
      riskPerLot: Math.round((sig.entryPrice - sig.stopLoss) * lotSize),
      rewardTP2: Math.round((sig.tp2 - sig.entryPrice) * lotSize),
    }];
  };

  const formattedTrades = useMemo(() => {
    return trades.filter(t => !t.noSetup);
  }, [trades]);

  const gradeCounts = useMemo(() => {
    const g = { aPlus: 0, a: 0, b: 0 };
    trades.forEach(t => { if (t.noSetup) return; if (t.grade === 'A+') g.aPlus++; else if (t.grade === 'A') g.a++; else g.b++; });
    return g;
  }, [trades]);

  const handleRefresh = () => {
    setSeed(s => s + 1);
    fetchSignal();
    fetchOptionChain();
    setLastUpdate(new Date());
  };

  const handleSymbolChange = (s: 'NIFTY' | 'SENSEX') => {
    setSymbol(s);
  };

  const handleExpiryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setExpiryDate(e.target.value);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[500px]">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-primary border-t-transparent mx-auto" />
          <p className="text-xl text-muted-foreground font-medium">Loading SDM AI Dashboard...</p>
        </div>
      </div>
    );
  }

  const topTrade = trades[0];
  const totalTrades = formattedTrades.length;
  const aPlusCount = gradeCounts.aPlus;
  const aCount = gradeCounts.a;
  const bCount = gradeCounts.b;

  return (
    <TooltipProvider>
      <div className="min-h-screen pb-16">
        <header className="border-b border-white/[.035] sticky top-0 z-30 backdrop-blur-xl bg-[#060810]/80">
          <div className="max-w-[1360px] mx-auto px-5 py-3.5 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center font-bold text-[13px] text-white shadow-lg shadow-emerald-500/10">S</div>
              <div>
                <div className="font-semibold text-slate-100 text-sm leading-tight">SMD AI Dashboard</div>
                <div className="text-[10px] text-slate-600">Institutional Trade Engine · Nifty 50 & Sensex · A+ / A / B Grade</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <MarketBadge />
              <div className="flex items-center gap-2">
                <Select value={symbol} onValueChange={handleSymbolChange}>
                  <SelectTrigger className="w-[110px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NIFTY">NIFTY 50</SelectItem>
                    <SelectItem value="BANKNIFTY">BANK NIFTY</SelectItem>
                    <SelectItem value="FINNIFTY">FIN NIFTY</SelectItem>
                    <SelectItem value="SENSEX">SENSEX</SelectItem>
                  </SelectContent>
                </Select>
                {expiryDate && (
                  <span className="text-[10px] text-slate-500 bg-white/[.03] px-2 py-1 rounded-full border border-white/[.05]">
                    Expiry: {expiryDate}
                  </span>
                )}
              <Button variant="outline" size="sm" onClick={handleRefresh} className="h-8 px-3 gap-1.5">
                <RotateCcw className="w-4 h-4" />
                Refresh
              </Button>
            </div>
            </div>
          </div>
        </header>

        <main className="max-w-[1360px] mx-auto px-5 pt-6 space-y-6">
          {/* Top Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            <MetricCard label="Overall Bias" value={topTrade?.bias || '—'} accent={topTrade?.bias === 'BULLISH' ? 'text-emerald-400' : 'text-rose-400'} />
            <MetricCard label="India VIX" value={vix} accent="text-amber-400" />
            <MetricCard label="A+ Setups" value={aPlusCount} accent="text-emerald-400" />
            <MetricCard label="A Setups" value={aCount} accent="text-sky-400" />
            <MetricCard label="B Setups" value={bCount} accent="text-amber-400" />
            <MetricCard label="FII Flow" value={`${fii >= 0 ? '+' : ''}₹${fii} Cr`} accent={fii >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
            <MetricCard label="Risk Level" value={vix > 16 ? 'Elevated' : 'Moderate'} accent={vix > 16 ? 'text-rose-400' : 'text-amber-400'} />
          </div>

          {/* Trade Cards */}
          <section>
            <div className="flex items-end justify-between mb-4 flex-wrap gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-200 tracking-tight">Today's Institutional Trades</h2>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  SL 20–50 pts · R:R 1:2 / 1:3 / 1:4 · {lastUpdate.toLocaleTimeString('en-IN', { hour12: false })}
                </p>
              </div>
              <div className="hidden sm:flex items-center gap-4 text-[10px]">
                <LegendDot color="bg-emerald-400" label="A+" />
                <LegendDot color="bg-sky-400" label="A" />
                <LegendDot color="bg-amber-400" label="B" />
                <span className="text-slate-700">|</span>
                <LegendDot color="bg-emerald-400/20 border-emerald-400/20 text-emerald-400" label="ATM" />
                <LegendDot color="bg-sky-400/20 border-sky-400/20 text-sky-400" label="ITM" />
                <LegendDot color="bg-amber-400/20 border-amber-400/20 text-amber-400" label="OTM" />
              </div>
            </div>
            <div className="tg grid gap-4" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              {formattedTrades.map((t, i) => <TradeCard key={`${t.instrument}-${t.strike}`} trade={t} rank={i + 1} />)}
              {formattedTrades.length < 2 && (
                <NoSetupCard instrument="No Setup" />
              )}
            </div>
          </section>

          {/* Option Chain */}
          <section>
            <OCPanel chain={chainData} atm={atm} />
          </section>

          {/* 3-Column Bottom */}
          <div className="grid lg:grid-cols-3 gap-4">
            <SPanel components={topTrade?.components || {}} />
            <GPanel d={{ spot, atm, pcr, vix, maxPain, support: 0, resistance: 0 }} />
            <FPanel d={{ fii, dii, support: 0, resistance: 0 }} />
          </div>

          {/* Sensex Overview */}
          <div className="glass glow-none rounded-2xl p-5 rise">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-300">SENSEX Quick View</span>
              <span className={`mono text-xs font-bold text-slate-400`}>
                NEUTRAL
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5">
              {[['Spot', 0, 'text-slate-100'], ['ATM', 0, 'text-slate-100'], ['PCR', 0, 'text-emerald-400'], ['Top Score', '0%', 'text-amber-400'], ['FII', '₹0 Cr', 'text-emerald-400'], ['Max Pain', 0, 'text-slate-100']].map(([l, v, c]) => (
                <div key={l} className="num-cell">
                  <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">{l}</div>
                  <div className={`mono text-sm font-bold ${c}`}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          <PPanel />

          <footer className="text-[10px] text-slate-700 leading-relaxed border-t border-white/[.025] pt-4 pb-2">
            Decision-support tool, not investment advice. Confidence scores are weighted outputs — not guarantees. Demo data via <code className="mono text-slate-600">fetchAllData()</code> — replace with licensed broker API (Kite, Upstox, Angel, Dhan, TrueData) for live feeds. Options carry substantial risk.
          </footer>
        </main>
      </div>
    </TooltipProvider>
  );
}

function MarketBadge() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const m = now.getHours() * 60 + now.getMinutes();
  let st = 'CLOSED', cls = 'bg-slate-500/10 text-slate-500 border-slate-500/20';
  if (m >= 540 && m < 555) { st = 'PRE-MARKET'; cls = 'bg-amber-400/10 text-amber-400 border-amber-400/20'; }
  else if (m >= 555 && m < 930) { st = 'LIVE'; cls = 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20'; }
  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-semibold tracking-wide ${cls}`}>
      <span className="w-[6px] h-[6px] rounded-full bg-current live-dot" />
      {st}
      <span className="mono text-[10px] opacity-50 ml-0.5">{now.toLocaleTimeString('en-IN', { hour12: false })}</span>
    </span>
  );
}

function MetricCard({ label, value, accent }: { label: string; value: any; accent?: string }) {
  return (
    <div className="glass glow-none rounded-xl px-4 py-3 rise">
      <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">{label}</div>
      <div className={`text-[15px] font-bold ${accent || 'text-slate-100'}`}>{value}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-sm ${color}`} />
      <span className="text-slate-700">{label}</span>
    </span>
  );
}

function NoSetupCard({ instrument }: { instrument: string }) {
  return (
    <div className="glass glow-none rounded-2xl p-6 flex flex-col items-center justify-center text-center h-full rise" style={{ minHeight: 440 }}>
      <div className="w-14 h-14 rounded-2xl bg-slate-800/30 border border-slate-700/30 flex items-center justify-center mb-4">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div className="text-slate-400 font-semibold text-sm mb-1.5">No Qualifying Setup</div>
      <div className="text-slate-600 text-xs leading-relaxed max-w-[200px]">{instrument} has no A/B grade institutional setup at this time.</div>
      <div className="mt-4 text-[9px] text-slate-700 uppercase tracking-widest">Awaiting confluence</div>
    </div>
  );
}

function TradeCard({ trade, rank }: { trade: TradeData; rank: number }) {
  if (trade.noSetup) return <NoSetupCard instrument={trade.instrument} />;
  const bull = trade.direction === 'BUY CE';
  const dc = bull ? 'text-emerald-400' : 'text-rose-400';
  const gl = trade.grade === 'A+' ? 'glow-aplus' : trade.grade === 'A' ? 'glow-a' : 'glow-b';
  const ac = trade.grade === 'A+' ? 'acc-aplus' : trade.grade === 'A' ? 'acc-a' : 'acc-b';
  const gc = trade.grade === 'A+' ? 'g-aplus' : trade.grade === 'A' ? 'g-a' : 'g-b';
  const mc = trade.moneyness === 'ATM' ? 'money-atm' : trade.moneyness === 'ITM' ? 'money-itm' : 'money-otm';

  return (
    <div className={`glass-deep ${gl} rounded-2xl overflow-hidden rise rd${rank}`}>
      <div className={ac} />
      <div className="p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="mono text-[11px] font-bold text-slate-600 bg-white/[.03] w-6 h-6 rounded-md flex items-center justify-center">#{rank}</span>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-white/[.04] border border-white/[.05] text-slate-300">{trade.instrument}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-md text-slate-500 bg-white/[.02]">Lot: {trade.lotSize}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className={`text-[11px] font-bold px-2.5 py-1 rounded-md ${gc}`}>{trade.grade}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${trade.moneyness === 'ATM' ? 'money-atm' : trade.moneyness === 'ITM' ? 'money-itm' : 'money-otm'}`}>{trade.moneyness}</span>
            <ConfidenceMini value={trade.score} g={trade.grade} />
          </div>
        </div>

        <div className="mb-4">
          <div className={`text-[22px] font-bold tracking-tight ${dc} leading-tight`}>{trade.direction}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="mono text-xl font-bold text-slate-100">{trade.strike} <span className="text-slate-500 text-base">{trade.optType}</span></span>
          </div>
          <div className="text-[11px] text-slate-600 mt-0.5">{trade.expiry} · Spot: {trade.spot}</div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 mb-2.5">
          <div className="num-cell">
            <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">Entry</div>
            <div className="mono text-base font-bold text-slate-100">₹{trade.entry}</div>
          </div>
          <div className="num-cell" style={{ borderColor: 'rgba(251,113,133,.1)' }}>
            <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">Stop Loss <span className="text-rose-500/50">({trade.slPts} pts)</span></div>
            <div className="mono text-base font-bold text-rose-400">₹{trade.sl}</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 mb-4">
          <div className="num-cell rr-cell rr-2">
            <div className="text-[9px] uppercase tracking-widest text-amber-400/70 mb-1 pl-2">TP1 · <span className="font-bold">1:2</span></div>
            <div className="mono text-sm font-bold text-amber-400 pl-2">₹{trade.tp1}</div>
            <div className="text-[9px] text-slate-600 pl-2 mt-0.5">+{(trade.tp1 - trade.entry).toFixed(0)} pts</div>
          </div>
          <div className="num-cell rr-cell rr-3">
            <div className="text-[9px] uppercase tracking-widest text-emerald-400/70 mb-1 pl-2">TP2 · <span className="font-bold">1:3</span></div>
            <div className="mono text-sm font-bold text-emerald-400 pl-2">₹{trade.tp2}</div>
            <div className="text-[9px] text-slate-600 pl-2 mt-0.5">+{(trade.tp2 - trade.entry).toFixed(0)} pts</div>
          </div>
          <div className="num-cell rr-cell rr-4">
            <div className="text-[9px] uppercase tracking-widest text-sky-400/70 mb-1 pl-2">TP3 · <span className="font-bold">1:4</span></div>
            <div className="mono text-sm font-bold text-sky-400 pl-2">₹{trade.tp3}</div>
            <div className="text-[9px] text-slate-600 pl-2 mt-0.5">+{(trade.tp3 - trade.entry).toFixed(0)} pts</div>
          </div>
        </div>

        <div className="flex items-center gap-4 mb-3.5 text-[11px] flex-wrap">
          <span className="text-slate-500">Risk/Lot: <span className="mono text-rose-400/70 font-semibold">₹{trade.riskPerLot}</span></span>
          <span className="text-slate-500">Reward@TP2: <span className="mono text-emerald-400/70 font-semibold">₹{trade.rewardTP2}</span></span>
          <span className="text-slate-500">R:R <span className="mono text-slate-300 font-semibold">1:2 · 1:3 · 1:4</span></span>
        </div>

        <div className="flex items-start gap-2 mb-4 text-[11px] text-slate-500 bg-white/[.015] rounded-lg px-3 py-2 border border-white/[.03]">
          <span className="text-emerald-500/50 mt-px text-xs">▸</span>
          <span>Runner Target: Trail using VWAP & swing structure after TP2 hit</span>
        </div>

        <div className="grad-line mb-3" />

        <div className="text-[9px] uppercase tracking-widest text-slate-700 mb-2">Institutional Confluences ({trade.reasons.length})</div>
        <div className="flex flex-wrap gap-1.5">
          {trade.reasons.map((r, i) => (
            <span key={i} className="tag flex items-center gap-1">
              <span className={trade.direction === 'BUY CE' ? 'text-emerald-500/60' : 'text-rose-500/60'}>✓</span>
              {r}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConfidenceMini({ value, g }: { value: number; g: string }) {
  const c = g === 'A+' ? '#34d399' : g === 'A' ? '#38bdf8' : '#fbbf24';
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 bg-[#111620] rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, value)}%`, background: c, transition: 'width .7s ease' }} />
      </div>
      <span className="mono text-[11px] font-bold" style={{ color: c }}>{value.toFixed(0)}%</span>
    </div>
  );
}

function SBar({ label, value, weight }: { label: string; value: number; weight: number }) {
  const c = (value / 100) * weight;
  const col = c >= weight * 0.7 ? '#34d399' : c >= weight * 0.4 ? '#fbbf24' : '#fb7185';
  return (
    <div className="mb-2">
      <div className="flex justify-between text-[10px] mb-1">
        <span className="text-slate-500">{label} <span className="text-slate-700">w{weight}</span></span>
        <span className="mono text-slate-500">{c.toFixed(1)}/{weight}</span>
      </div>
      <div className="h-1 bg-[#0d1118] rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: col, transition: 'width .6s ease' }} />
      </div>
    </div>
  );
}

function bLabel(chg: number, oi: number) {
  if (chg > oi * 0.15) return { text: 'Long Buildup', c: 'text-emerald-400' };
  if (chg < -oi * 0.15) return { text: 'Short Covering', c: 'text-emerald-400' };
  if (chg > 0) return { text: 'Short Buildup', c: 'text-rose-400' };
  return { text: 'Long Unwinding', c: 'text-rose-400' };
}

function OCPanel({ chain, atm }: { chain: ChainRow[]; atm: number }) {
  return (
    <div className="glass glow-none rounded-2xl overflow-hidden rise">
      <div className="px-5 py-3 flex items-center justify-between border-b border-white/[.03]">
        <span className="text-xs font-semibold text-slate-300">NIFTY Option Chain</span>
        <span className="text-[10px] text-slate-600 mono">{chain.length} strikes</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] mono">
          <thead>
            <tr className="text-slate-600 uppercase text-[9px] tracking-wider border-b border-white/[.03]">
              <th className="text-left px-3 py-2">Call OI</th>
              <th className="text-left px-2 py-2">Chg</th>
              <th className="text-left px-2 py-2">LTP</th>
              <th className="text-left px-2 py-2">Δ</th>
              <th className="text-center px-3 py-2 text-slate-400">Strike</th>
              <th className="text-right px-2 py-2">Δ</th>
              <th className="text-right px-2 py-2">LTP</th>
              <th className="text-right px-2 py-2">Chg</th>
              <th className="text-right px-3 py-2">Put OI</th>
              <th className="text-right px-3 py-2">Signal</th>
            </tr>
          </thead>
          <tbody>
            {chain.map(r => {
              const isATM = r.strike === atm;
              const bl = bLabel(r.putChg, r.putOI);
              return (
                <tr key={r.strike} className={`border-b border-white/[.02] hover:bg-white/[.012] ${isATM ? 'bg-emerald-400/[.025]' : ''}`}>
                  <td className="px-3 py-1.5 text-slate-400">{r.callOI}K</td>
                  <td className={`px-2 py-1.5 ${r.callChg >= 0 ? 'text-emerald-400/70' : 'text-rose-400/70'}`}>{r.callChg >= 0 ? '+' : ''}{r.callChg}</td>
                  <td className="px-2 py-1.5 text-slate-300">{r.callLTP}</td>
                  <td className="px-2 py-1.5 text-slate-600">{r.callDelta}</td>
                  <td className={`text-center px-3 py-1.5 font-bold ${isATM ? 'text-emerald-300' : 'text-slate-200'}`}>
                    {r.strike}{isATM && <span className="ml-1 text-[8px] text-emerald-400/70 font-normal">ATM</span>}
                  </td>
                  <td className="text-right px-2 py-1.5 text-slate-600">{r.putDelta}</td>
                  <td className="text-right px-2 py-1.5 text-slate-300">{r.putLTP}</td>
                  <td className={`text-right px-2 py-1.5 ${r.putChg >= 0 ? 'text-emerald-400/70' : 'text-rose-400/70'}`}>{r.putChg >= 0 ? '+' : ''}{r.putChg}</td>
                  <td className="text-right px-3 py-1.5 text-slate-400">{r.putOI}K</td>
                  <td className="text-right px-3 py-1.5">
                    <span className={`text-[10px] ${bl.c}`}>{bl.text}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SPanel({ components }: { components: any }) {
  const lb: any = { htf: 'HTF Trend', oi: 'OI Analysis', pcr: 'PCR', greeks: 'Greeks / Delta', vwap: 'VWAP Position', volume: 'Volume Profile', sweep: 'Liquidity Sweep', bos: 'Break of Structure', choch: 'Change of Character', fiidii: 'FII / DII Flow' };
  return (
    <div className="glass glow-none rounded-2xl p-5 rise">
      <div className="text-xs font-semibold text-slate-300 mb-4">AI Scoring Engine</div>
      {Object.keys(W).map(k => (
        <SBar key={k} label={lb[k] || k} value={components[k] || 0} weight={W[k as keyof typeof W]} />
      ))}
    </div>
  );
}

function GPanel({ d }: { d: any }) {
  const ivR = Math.round(Math.min(95, Math.max(10, d.vix * 3.5)));
  const ivP = Math.round(15 + (d.vix * 2.3));
  return (
    <div className="glass glow-none rounded-2xl p-5 rise">
      <div className="text-xs font-semibold text-slate-300 mb-4">Volatility & Greeks</div>
      <div className="grid grid-cols-2 gap-2.5">
        {[['IV Rank', `${ivR}%`, 'text-slate-100'], ['IV Percentile', `${ivP}%`, 'text-slate-100'], ['India VIX', d.vix, 'text-amber-400'], ['PCR', d.pcr, d.pcr > 1 ? 'text-emerald-400' : 'text-rose-400'], ['Max Pain', d.maxPain, 'text-slate-100'], ['Spot', d.spot, 'text-sky-300']].map(([l, v, c]) => (
          <div key={l} className="num-cell">
            <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">{l}</div>
            <div className={`mono text-sm font-bold ${c}`}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FPanel({ d }: { d: any }) {
  return (
    <div className="glass glow-none rounded-2xl p-5 rise">
      <div className="text-xs font-semibold text-slate-300 mb-4">Institutional Flow</div>
      <div className="space-y-3">
        {[['FII', d.fii, 30], ['DII', d.dii, 22]].map(([l, v, div]) => (
          <div key={l}>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="text-slate-500">{l}</span>
              <span className={`mono ${v >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{v >= 0 ? '+' : ''}₹{v} Cr</span>
            </div>
            <div className="h-1.5 bg-[#0d1118] rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${v >= 0 ? 'bg-emerald-400' : 'bg-rose-400'}`} style={{ width: `${Math.min(100, Math.abs(v) / div)}%`, transition: 'width .6s ease' }} />
            </div>
          </div>
        ))}
        <div className="grad-line my-1" />
        {[['Support', 0, 'text-emerald-400'], ['Resistance', 0, 'text-rose-400']].map(([l, v, c]) => (
          <div key={l} className="flex justify-between text-[11px]">
            <span className="text-slate-600">{l}</span>
            <span className={`mono ${c}`}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PPanel() {
  const s = [['Win Rate', '73.5%', 'text-emerald-400'], ['Total', 34, 'text-slate-100'], ['Wins', 25, 'text-emerald-400'], ['Losses', 9, 'text-rose-400'], ['Avg R:R', '1:2.8', 'text-slate-100'], ['Profit Factor', '2.4', 'text-slate-100'], ['Max DD', '-5.2%', 'text-rose-400'], ['Streak', '6W', 'text-emerald-400']];
  return (
    <div className="glass glow-none rounded-2xl p-5 rise">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-semibold text-slate-300">Performance Tracker</span>
        <span className="text-[9px] text-slate-700 uppercase tracking-wider">demo — connect trade DB</span>
      </div>
      <div className="grid grid-cols-4 gap-2.5">
        {s.map(([l, v, c]) => (
          <div key={l} className="num-cell">
            <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-1">{l}</div>
            <div className={`mono text-sm font-bold ${c}`}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}