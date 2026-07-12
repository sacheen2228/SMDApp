'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, RefreshCw, Settings2, Sun, Moon, Activity, Zap, Brain, Timer, CalendarClock, Bot, Scan, Newspaper, Target, TrendingUp, Flame, BookOpen, Crosshair, Monitor } from 'lucide-react';
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
import { SimpleMode } from '@/components/dashboard/SimpleMode';
import { GapAnalysis } from '@/components/dashboard/GapAnalysis';
import { AgentChat } from '@/components/dashboard/AgentChat';
import { AdminPanel } from '@/components/dashboard/AdminPanel';
import { ScannerPanel } from '@/components/dashboard/ScannerPanel';
import { NewsPanel } from '@/components/dashboard/NewsPanel';
import { useWebSocket } from '@/hooks/useWebSocket';

import { MobileNav } from '@/components/dashboard/MobileNav';
import { ZeroHeroTerminal } from '@/components/terminal/ZeroHeroTerminal';
import BotDashboard from '@/components/auto-bot/BotDashboard';

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
function formatIndian(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '0';
  if (num >= 10000000) return (num / 10000000).toFixed(2) + ' Cr';
  if (num >= 100000) return (num / 100000).toFixed(2) + ' L';
  if (num >= 1000) return num.toLocaleString('en-IN');
  return num.toString();
}

function fmt(num: number | undefined | null, d: number = 2): string {
  if (num === undefined || num === null || isNaN(num)) return '0';
  return num.toFixed(d);
}

function oiHeat(oi: number, maxOI: number, isCall: boolean): React.CSSProperties {
  const pct = Math.min(oi / maxOI, 1);
  if (isCall) {
    return { background: `linear-gradient(to left, rgba(239,68,68,${pct * 0.35}), transparent)` };
  }
  return { background: `linear-gradient(to right, rgba(34,197,94,${pct * 0.35}), transparent)` };
}

// ─── Full Chain View (Terminal-style) ──────────────────────────────
interface FullChainViewProps {
  chainData: any[];
  maxOI: number;
  maxCallOI: number;
  maxPutOI: number;
  atmStrike: number;
  spot: number;
  showGreeks: boolean;
  onTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
  rec?: any;
  symbol: string;
}

function FullChainView({ chainData, maxOI, maxCallOI, maxPutOI, atmStrike, spot, showGreeks, onTrade, rec, symbol }: FullChainViewProps) {
  // Transform API chain data to rows
  const rows = useMemo(() => {
    return chainData.map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? { oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, vol: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, ltp: row.ce.ltp || 0, gamma: row.ce.gamma || 0, theta: row.ce.theta || 0, vega: row.ce.vega || 0 } : null,
      pe: row.pe ? { oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, vol: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, ltp: row.pe.ltp || 0, gamma: row.pe.gamma || 0, theta: row.pe.theta || 0, vega: row.pe.vega || 0 } : null,
    }));
  }, [chainData]);

  // Center on ATM ± 12 strikes
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const atmIdx = sorted.findIndex((r) => r.strike === atmStrike) ?? sorted.length / 2;
  const start = Math.max(0, atmIdx - 12);
  const end = Math.min(sorted.length, start + 25);
  const nearby = sorted.slice(start, end);

  return (
    <div className="flex flex-col h-full bg-[#0a0e14] overflow-hidden" style={{ fontFamily: "var(--sans, Inter, -apple-system, sans-serif)" }}>
      {/* Header */}
      <div className="h-12 bg-[#10151d] border-b border-[#1f2733] flex items-center px-4 gap-3 shrink-0">
        <span className="font-bold text-[13px]">Live Option Chain <span className="text-[#7d8ba0] font-mono text-[11px] ml-1">{symbol} {spot.toLocaleString("en-IN")}</span></span>
        <span className="text-[#7d8ba0] font-mono text-[11px]" style={{ color: "#2dd4a7" }}>👉 = AI-recommended strike</span>
        <span className="ml-auto text-[#7d8ba0] font-mono text-[11px]">
          SPOT <b className="text-[#dfe6ee] px-2 py-0.5 bg-[#151b25] rounded-lg border border-[#1f2733] font-bold text-sm">{spot.toLocaleString("en-IN")}</b>
        </span>
      </div>

      {/* Chain Table */}
      <div className="flex-1 overflow-y-auto p-3">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              {["OI", "OI Chg", "Vol", "IV", "Delta", "M", "LTP"].map((h) => (
                <th key={h} className="text-right text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase tracking-wide bg-[#10151d]">{h}</th>
              ))}
              <th className="text-center text-[#e8a33d] font-bold py-1.5 px-1 text-[10.5px] bg-[#10151d]">STRIKE</th>
              {["LTP", "M", "Delta", "IV", "Vol", "OI Chg", "OI"].map((h) => (
                <th key={h} className="text-left text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase tracking-wide bg-[#10151d]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nearby.map((r) => {
              const isRecCE = rec?.strike === r.strike && rec?.type === "CE";
              const isRecPE = rec?.strike === r.strike && rec?.type === "PE";
              return (
                <tr key={r.strike} className={`${r.strike === atmStrike ? "bg-[rgba(232,163,61,.08)]" : ""} border-b border-[#1f2733]`}>
                  <td className="text-right py-1.5 px-1">{r.ce ? (r.ce.oi >= 1000 ? (r.ce.oi / 1000).toFixed(0) + "K" : r.ce.oi) : "—"}</td>
                  <td className={`text-right py-1.5 px-1 ${r.ce && r.ce.oiChg > 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>{r.ce ? (r.ce.oiChg > 0 ? "+" : "") + (Math.abs(r.ce.oiChg) >= 1000 ? (r.ce.oiChg / 1000).toFixed(1) + "K" : r.ce.oiChg) : "—"}</td>
                  <td className="text-right py-1.5 px-1">{r.ce ? (r.ce.vol >= 1000 ? (r.ce.vol / 1000).toFixed(0) + "K" : r.ce.vol) : "—"}</td>
                  <td className="text-right py-1.5 px-1">{r.ce?.iv?.toFixed(1) || "—"}</td>
                  <td className="text-right py-1.5 px-1">{r.ce?.delta?.toFixed(2) || "—"}</td>
                  <td className="text-right py-1.5 px-1"><MoneyTag strike={r.strike} atmStrike={atmStrike} side="CE" /></td>
                  <td className={`text-right py-1.5 px-1 cursor-pointer font-semibold ${isRecCE ? "bg-[rgba(45,212,167,.1)] outline outline-[1.5px] outline-[#2dd4a7] rounded font-bold" : "text-[#1fbf75]"}`}
                    onClick={() => r.ce && onTrade(r.strike, "CE", r.ce.ltp)}>
                    {isRecCE ? "👉 " : ""}₹{r.ce ? fmt(r.ce.ltp) : "—"}
                  </td>
                  <td className={`text-center py-1.5 px-1 font-bold ${r.strike === atmStrike ? "text-[#e8a33d]" : "text-[#dfe6ee]"}`}>{fmtInt(r.strike)}</td>
                  <td className={`text-left py-1.5 px-1 cursor-pointer font-semibold ${isRecPE ? "bg-[rgba(45,212,167,.1)] outline outline-[1.5px] outline-[#2dd4a7] rounded font-bold" : "text-[#f2495c]"}`}
                    onClick={() => r.pe && onTrade(r.strike, "PE", r.pe.ltp)}>
                    {isRecPE ? "👉 " : ""}₹{r.pe ? fmt(r.pe.ltp) : "—"}
                  </td>
                  <td className="text-left py-1.5 px-1"><MoneyTag strike={r.strike} atmStrike={atmStrike} side="PE" /></td>
                  <td className="text-left py-1.5 px-1">{r.pe?.delta?.toFixed(2) || "—"}</td>
                  <td className="text-left py-1.5 px-1">{r.pe?.iv?.toFixed(1) || "—"}</td>
                  <td className="text-left py-1.5 px-1">{r.pe ? (r.pe.vol >= 1000 ? (r.pe.vol / 1000).toFixed(0) + "K" : r.pe.vol) : "—"}</td>
                  <td className={`text-left py-1.5 px-1 ${r.pe && r.pe.oiChg > 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>{r.pe ? (r.pe.oiChg > 0 ? "+" : "") + (Math.abs(r.pe.oiChg) >= 1000 ? (r.pe.oiChg / 1000).toFixed(1) + "K" : r.pe.oiChg) : "—"}</td>
                  <td className="text-left py-1.5 px-1">{r.pe ? (r.pe.oi >= 1000 ? (r.pe.oi / 1000).toFixed(0) + "K" : r.pe.oi) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────
function MoneyTag({ strike, atmStrike, side }: { strike: number; atmStrike: number; side: "CE" | "PE" }) {
  if (strike === atmStrike) return <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">ATM</span>;
  if (side === "CE") {
    return strike < atmStrike
      ? <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-bold">ITM</span>
      : <span className="text-[9px] px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-500 font-bold">OTM</span>;
  }
  return strike > atmStrike
    ? <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-bold">ITM</span>
    : <span className="text-[9px] px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-500 font-bold">OTM</span>;
}

function fmtInt(n: number): string {
  if (n == null || isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-IN");
}

// ─── Main Page ────────────────────────────────────────────────────
export default function TradingDashboard() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [showGreeks, setShowGreeks] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [viewMode, setViewMode] = useState<'gap' | 'scanner' | 'news' | 'agent' | 'admin' | 'terminal' | 'auto-bot'>('terminal');
  const [displayMode, setDisplayMode] = useState<'simple' | 'pro'>('simple');
  const [showSidebar, setShowSidebar] = useState(true);
  // Build the SDM recommendation from the LIVE analysis in the option-chain
  // response. (The raw API returns analysis.recommendation + analysis.pcr /
  // vix / maxPain; we map it onto the SDMRecommendation shape SimpleMode reads.)
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
  
  const { optionChain: wsData, price: wsPrice, signal: wsSignal, isConnected: wsConnected } = useWebSocket(symbol);
  const [mlResult, setMlResult] = useState<any>(null);
  
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

  // Normalize the summary from the LIVE option-chain response. The API wraps
  // stats in `analysis` (pcr / vix / OI / maxPain / atmStrike); the inner
  // data.summary only carries spotPrice. Declared here, before the effects
  // that reference it, to avoid a TDZ error.
  const summary: MarketSummary | null = (() => {
    if (!data) return null;
    const raw = data as any;
    const analysis = raw.analysis || {};
    const inner = raw.data || {};
    const chain = inner.data || [];
    const spot = analysis.spotPrice ?? inner.spotPrice ?? 0;
    const atmStrike =
      analysis.atmStrike ??
      (Array.isArray(chain) && chain.length
        ? chain.reduce((b: any, r: any) =>
            Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b
          ).strike
        : 0);
    return {
      spotPrice: spot,
      spotChange: 0,
      spotChangePct: 0,
      indiaVIX: analysis.greeks?.vix ?? 0,
      pcr: analysis.pcr ?? 1,
      maxPain: analysis.maxPain ?? 0,
      totalCallOI: analysis.totalCallOI ?? 0,
      totalPutOI: analysis.totalPutOI ?? 0,
      atmStrike,
    };
  })();

  // V2 recommendation, produced by SDMBot.tsx (generateTradeRecommendation /
  // sdm-recommendation.ts) — kept separate from the legacy `recommendation`
  // memo below (built from sdm-engine.ts's older shape) so we don't mix the
  // two engines' output into one variable.

  // Build the SDM recommendation from the LIVE analysis in the option-chain
  // response. The API returns analysis.recommendation + analysis.pcr / vix /
  // maxPain; we map it onto the SDMRecommendation shape SimpleMode reads.
  const recommendation: SDMRecommendation | null = useMemo(() => {
    const a = (data as any)?.analysis;
    const rec = a?.recommendation;
    if (!rec) return null;
    const entry = rec.entryPrice || 0;
    const sl = rec.stopLoss || 0;
    const tp1 = rec.tp1 || 0;
    const rr = entry && sl && entry !== sl ? Math.abs((tp1 - entry) / (entry - sl)) : 0;
    const score = rec.sdmScore ?? 0;
    const grade: any =
      score >= 75 ? "A+" : score >= 65 ? "A" : score >= 55 ? "B+" : score >= 45 ? "B" : "C";
    return {
      direction: rec.direction,
      strike: rec.strike,
      strikeType: "ATM" as any,
      entry,
      tp1,
      tp2: rec.tp2 || 0,
      tp3: rec.tp3 || 0,
      sl,
      confidence: Math.round(rec.confidence || 0),
      riskReward: Math.round(rr * 10) / 10,
      isExpiryDay: false,
      daysToExpiry: a?.expiry?.daysToExpiry ?? 0,
      currentWindow: "DAY" as any,
      windowTimeRemaining: "",
      tradesTakenToday: 0,
      tradesRemaining: 0,
      mode: "DAY" as any,
      sellerSLZone: {} as any,
      gammaThetaData: {} as any,
      marketContext: {
        pcr: a?.pcr ?? 1,
        vix: a?.greeks?.vix ?? 0,
        maxPain: a?.maxPain ?? 0,
        spot: a?.spotPrice ?? 0,
      } as any,
      watchList: [] as any,
      whyThisTrade: [] as any,
      sdmScores: {} as any,
      reason: Array.isArray(rec.reasons) ? rec.reasons.join(" · ") : (rec.reasons || ""),
      timeSensitiveNote: "",
      smartEntry: {} as any,
      smartExit: {} as any,
      premiumFairValue: {} as any,
      probabilities: {} as any,
      tradeGrade: grade,
      dataHealth: {} as any,
      positionSizing: {} as any,
      marketRegime: {} as any,
      holdingTimeEstimate: "",
      expectedMove: 0,
    } as SDMRecommendation;
  }, [data]);

  // Update store
  useEffect(() => {
    if (data) {
      setOptionChain(data as any);
      setSelectedSymbol(symbol);
    }
  }, [data, setOptionChain, setSelectedSymbol, symbol]);
  
  // Run ML analysis on data change
  useEffect(() => {
    if (data?.data?.data?.length && data?.data?.candles?.length) {
      const result = runMLAnalysis(data.data.candles, data.data.data, data.data.summary?.spotPrice || data.analysis?.spotPrice || 0);
      setMlResult(result);
    }
  }, [data]);
  
  // Set default expiry
  useEffect(() => {
    if (data?.data?.expiries?.length && !selectedExpiry) {
      setSelectedExpiry(data.data.expiries[0].date);
      setStoreExpiry(data.data.expiries[0].date);
    }
  }, [data, selectedExpiry, setSelectedExpiry, setStoreExpiry]);
  
  // Scroll to ATM
  useEffect(() => {
    if (summary?.atmStrike && atmRef.current) {
      const timer = setTimeout(() => {
        atmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [summary?.atmStrike, selectedExpiry, symbol]);
  
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
    if (Array.isArray(data?.data?.data)) return data.data.data;
    return [];
  }, [data?.data?.data]);

  // Market session info
  const marketSession = useMemo(() => getCurrentSession(), []);

  // Activate Breeze session from ?apisession= URL param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const apiSession = params.get('apisession');
    if (apiSession) {
      fetch(`/api/breeze-connect?apisession=${apiSession}`)
        .then(r => r.json())
        .then(json => {
          if (json.success) {
            setBreezeStatus(prev => ({ ...prev, isConnected: true }));
          } else {
            console.error('[Breeze] Session activation failed:', json.error);
          }
        })
        .catch(() => {});
    }
  }, []);

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
  
  // (summary computed below, before the effects that depend on it)

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
            <Button variant={viewMode === 'gap' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'gap' ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/25' : 'text-muted-foreground hover:text-amber-500'}`}
              onClick={() => { setViewMode('gap'); setDisplayMode('pro'); }}>
              <BarChart3 className="h-2.5 w-2.5 mr-0.5" /> Gap
            </Button>
            <Button variant={viewMode === 'terminal' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'terminal' ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/25' : 'text-muted-foreground hover:text-emerald-500'}`}
              onClick={() => { setViewMode('terminal'); setDisplayMode('pro'); }}>
              <Monitor className="h-2.5 w-2.5 mr-0.5" /> Terminal
            </Button>
            <Button variant={viewMode === 'auto-bot' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'auto-bot' ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/25' : 'text-muted-foreground hover:text-violet-500'}`}
              onClick={() => { setViewMode('auto-bot'); setDisplayMode('pro'); }}>
              <BarChart3 className="h-2.5 w-2.5 mr-0.5" /> Bot
            </Button>
          </div>

          {/* More dropdown */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 text-[9px] px-2 font-bold text-muted-foreground hover:text-foreground">
                More ▾
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {[
                { mode: 'gap', label: 'Gap Analysis', icon: BarChart3, color: 'amber' },
                { mode: 'scanner', label: 'Scanner', icon: Scan, color: 'teal' },
                { mode: 'news', label: 'News', icon: Newspaper, color: 'orange' },
                { mode: 'agent', label: 'Agent Chat', icon: Bot, color: 'purple' },
                { mode: 'auto-bot', label: 'Auto Bot', icon: Activity, color: 'violet' },
                { mode: 'admin', label: 'Admin Panel', icon: Settings2, color: 'gray' },
              ].map((item) => (
                <button
                  key={item.mode}
                  onClick={() => { setViewMode(item.mode as any); setDisplayMode('pro'); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[10px] text-left ${
                    viewMode === item.mode ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                  }`}
                >
                  <item.icon className="h-3 w-3" />
                  {item.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

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
            {data?.data?.expiries?.slice(0, 5).map((exp) => (
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
              summary={summary}
              expiries={data?.data?.expiries}
              dataSource={data?.source || data?.data?.dataSource}
              selectedExpiry={selectedExpiry}
              onExpiryChange={setSelectedExpiry}
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
        ) : viewMode === 'gap' ? (
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
        ) : viewMode === 'agent' ? (
        /* ═══════ AGENT VIEW ═══════ */
        <div className="flex-1 overflow-hidden">
          <AgentChat
            symbol={symbol}
            spotPrice={spotPrice}
            pcr={summary?.pcr}
            vix={summary?.indiaVIX}
            sentiment={analysis?.sentiment}
          />
        </div>
        ) : viewMode === 'admin' ? (
        /* ═══════ ADMIN PANEL ═══════ */
        <div className="flex-1 overflow-auto p-2">
          <AdminPanel />
        </div>
        ) : viewMode === 'auto-bot' ? (
        /* ═══════ AUTO BOT ═══════ */
        <div className="flex-1 overflow-auto p-2">
          <BotDashboard />
        </div>
        ) : viewMode === 'terminal' ? (
        /* ═══════ TERMINAL ═══════ */
        <div className="flex flex-1 overflow-hidden">
          <ZeroHeroTerminal />
        </div>
        ) : (
        /* ═══════ CHAIN VIEW (default) ═══════ */
        <div className="flex-1 overflow-hidden">
          <FullChainView
            chainData={chainData}
            maxOI={maxOI}
            maxCallOI={maxCallOI}
            maxPutOI={maxPutOI}
            atmStrike={summary?.atmStrike ?? 0}
            spot={data?.spotPrice || 0}
            showGreeks={showGreeks}
            onTrade={handleTrade}
            rec={recommendation}
            symbol={symbol}
          />
</div>
      )}
      
      {/* ─── Order Panel (Modal) ─── */}
       <OrderPanel />
       
{/* ─── Mobile Navigation ─── */}
        <MobileNav viewMode={viewMode} onViewChange={setViewMode} />
      </div>
      </div>
  );
}
