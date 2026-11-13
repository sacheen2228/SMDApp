'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, RefreshCw, Settings2, Sun, Moon, Activity, Zap, Brain, Timer, CalendarClock, Bot, Scan, Newspaper, Target, TrendingUp, TrendingDown, Flame, BookOpen, Crosshair, Monitor, LineChart, Shield, Users, CandlestickChart, Trophy, FileText, FlaskConical } from 'lucide-react';
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
import { dataSourceBadge } from '@/lib/data-source-label';
import { OrderPanel } from '@/components/dashboard/OrderPanel';
import { OrderBookPanel } from '@/components/orderbook/OrderBookPanel';
import { PositionTracker } from '@/components/dashboard/PositionTracker';
import { MarketStatus } from '@/components/dashboard/MarketStatus';
import { SDMDashboard } from '@/components/dashboard/SDMDashboard';
import { SimpleMode } from '@/components/dashboard/SimpleMode';
import { GapAnalysis } from '@/components/dashboard/GapAnalysis';
import { AgentChat } from '@/components/dashboard/AgentChat';
import { AgentIntelligence } from '@/components/agent-intelligence/AgentIntelligence';
import { AdminPanel } from '@/components/dashboard/AdminPanel';
import ScannerView from '@/components/dashboard/ScannerView';
import { NewsPanel } from '@/components/dashboard/NewsPanel';
import { useWebSocket } from '@/hooks/useWebSocket';

import { MotilalStatus } from '@/components/dashboard/MotilalStatus';
import { ConnectionStatusBar } from '@/components/dashboard/ConnectionStatusBar';
import { MobileNav } from '@/components/dashboard/MobileNav';
import { ZeroHeroTerminal } from '@/components/terminal/ZeroHeroTerminal';
import BacktestDashboard from '@/components/backtest/BacktestDashboard';
import { BTSTDashboard } from '@/components/btst/BTSTDashboard';
import ExpiryPlanPanel from '@/components/dashboard/ExpiryPlanPanel';
import SignalStrip from '@/components/dashboard/SignalStrip';
import NewsSentimentPanel from '@/components/dashboard/NewsSentimentPanel';
import { evaluateStrikeSignal } from '@/lib/signal-engine';
import { runMLAnalysis } from '@/lib/ml-engine';
import { analyzeOptionChain } from '@/lib/sdm-oianalysis';
import { evaluateConfirmations } from '@/lib/signal-persistence';
import { selectStrike, buildOptionPlan, type ChainRowLike, type SelectedStrike, type OptionPlan } from '@/lib/option-plan';
import type { GreeksReadInput } from '@/lib/signal-persistence';

import ZeroHeroLiveTerminal from '@/components/zerohero/ZeroHeroLiveTerminal';
import CreditTab from '@/components/credit/CreditTab';
import { IndiaMarketChart } from '@/components/futures/IndiaMarketChart';
import { VolumeProfilePanel } from '@/components/shared/VolumeProfilePanel';
import { MarketRegimePanel } from '@/components/dashboard/MarketRegimePanel';
import { MarketBreadth } from '@/components/dashboard/MarketBreadth';
import { SectorRotation } from '@/components/dashboard/SectorRotation';
import { MarketHeatmap } from '@/components/dashboard/MarketHeatmap';
import { BestTradesNow } from '@/components/dashboard/BestTradesNow';
import { AlertCenter } from '@/components/dashboard/AlertCenter';
import { CASPanel } from '@/components/dashboard/CASPanel';
import { StockAnalysisDrawer } from '@/components/dashboard/StockAnalysisDrawer';
import InstitutionalPositioningPanel from '@/components/terminal/InstitutionalPositioningPanel';
import ChallengeTab from '@/components/challenge/ChallengeTab';
import IntelTab from '@/components/dashboard/IntelTab';
import { OptionPulseView } from '@/components/views/OptionPulseView';
import { OIFlowView } from '@/components/views/OIFlowView';
import { LiquidityMapView } from '@/components/views/LiquidityMapView';
import { OrderFlowView } from '@/components/views/OrderFlowView';

import { getLotSize } from '@/lib/symbol-config';
import type { FullAnalysis } from '@/lib/sdm-engine';
import type { SDMRecommendation } from '@/types/sdm';
import { getCurrentSession } from '@/lib/market-session';
import { updateSignal, type SignalRec } from '@/lib/signal-persistence';

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
  indiaVIX: number | null;
  prevClose: number | null;
  vixLive?: boolean;
  prevCloseLive?: boolean;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  atmStrike: number;
  callOiChange?: number | null;
  putOiChange?: number | null;
  futuresPrice?: number | null;
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
// Expiry strings from the exchange are "17-Nov-2026". Days-to-expiry is
// computed with LOCAL date parts — toISOString() is UTC and reports a local
// midnight date a day EARLY on an IST server.
const EXPIRY_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
function daysToExpiryLocal(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(dateStr).trim());
  if (!m || !(m[2] in EXPIRY_MONTHS)) return null;
  const d = new Date(Number(m[3]), EXPIRY_MONTHS[m[2]], Number(m[1]));
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

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
  pcr?: number;
  maxPain?: number;
  onStrikeSignal?: (strike: number, type: "CE" | "PE") => void;
}

function FullChainView({ chainData, maxOI, maxCallOI, maxPutOI, atmStrike, spot, showGreeks, onTrade, rec, symbol, pcr = 1, maxPain = 0, onStrikeSignal }: FullChainViewProps) {
  const [newsScore, setNewsScore] = useState(0);

  // Transform API chain data to rows
  const rows = useMemo(() => {
    return chainData.map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? { oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, vol: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, ltp: row.ce.ltp || 0, gamma: row.ce.gamma || 0, theta: row.ce.theta || 0, vega: row.ce.vega || 0 } : null,
      pe: row.pe ? { oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, vol: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, ltp: row.pe.ltp || 0, gamma: row.pe.gamma || 0, theta: row.pe.theta || 0, vega: row.pe.vega || 0 } : null,
    }));
  }, [chainData]);

  // Compute signals per row
  const signalMap = useMemo(() => {
    const map = new Map<number, any>();
    for (const r of rows) {
      // Derive price direction from moneyness (no historical LTP available):
      //   ITM CALL → premium naturally higher → simulate prev<curr → price up
      //   OTM CALL → premium naturally lower → simulate prev>curr → price down
      //   ITM PUT  → premium naturally higher → simulate prev<curr → price up
      //   OTM PUT  → premium naturally lower → simulate prev>curr → price down
      const cePrevLtp = r.ce ? (r.strike > spot ? r.ce.ltp * 1.5 : 0) : 0;
      const pePrevLtp = r.pe ? (r.strike < spot ? r.pe.ltp * 1.5 : 0) : 0;
      const signal = evaluateStrikeSignal(
        r.strike, spot, atmStrike, maxPain, pcr,
        r.ce?.ltp ?? 0, r.ce?.oi ?? 0, r.ce?.oiChg ?? 0,
        r.ce?.iv ?? 0, r.ce?.delta ?? 0, cePrevLtp,
        r.pe?.ltp ?? 0, r.pe?.oi ?? 0, r.pe?.oiChg ?? 0,
        r.pe?.iv ?? 0, r.pe?.delta ?? 0, pePrevLtp,
        newsScore,
      );
      map.set(r.strike, signal);
    }
    return map;
  }, [rows, spot, atmStrike, maxPain, pcr, newsScore]);

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

      {/* Signal Strip + News */}
      <div className="shrink-0 px-3 pt-2 space-y-1.5">
        <SignalStrip
          chainData={chainData}
          spot={spot}
          atmStrike={atmStrike}
          maxPain={maxPain}
          pcr={pcr}
          newsScore={newsScore}
          onStrikeClick={(strike, type) => onStrikeSignal?.(strike, type)}
        />
        <NewsSentimentPanel onScoreChange={setNewsScore} />
      </div>

      {/* Chain Table — min-width keeps 8 columns readable; parent scrolls horizontally on phones */}
      <div className="flex-1 overflow-y-auto p-3">
        <table className="w-full min-w-[560px] border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              {["OI", "OI Chg", "Vol", "IV", "Delta", "M", "Sig", "LTP"].map((h) => (
                <th key={h} className="text-right text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase tracking-wide bg-[#10151d]">{h}</th>
              ))}
              <th className="text-center text-[#e8a33d] font-bold py-1.5 px-1 text-[10.5px] bg-[#10151d]">STRIKE</th>
              {["LTP", "M", "Sig", "Delta", "IV", "Vol", "OI Chg", "OI"].map((h) => (
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
                  <td className="text-right py-1.5 px-1">{signalBadge(signalMap.get(r.strike), 'ce')}</td>
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
                  <td className="text-left py-1.5 px-1">{signalBadge(signalMap.get(r.strike), 'pe')}</td>
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

function signalBadge(signal: any, side: 'ce' | 'pe'): React.ReactNode {
  if (!signal) return <span className="text-[#3a4a60] text-[9px]">—</span>;
  const leg = side === 'ce' ? signal.ce : signal.pe;
  if (!leg) return <span className="text-[#3a4a60] text-[9px]">—</span>;
  if (leg.direction === 'BUY') {
    const isCE = side === 'ce';
    return (
      <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
        isCE ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
      }`}>
        BUY
      </span>
    );
  }
  if (leg.direction === 'AVOID') {
    return <span className="text-[9px] text-[#5a6a80]">AVOID</span>;
  }
  return <span className="text-[#3a4a60] text-[9px]">—</span>;
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
  const [viewMode, setViewMode] = useState<'gap' | 'scanner' | 'news' | 'agent' | 'agent-intel' | 'admin' | 'terminal' | 'chain' | 'btst' | 'backtest' | 'daily' | 'expiry' | 'zerohero' | 'institutional' | 'orderbook' | 'india' | 'intelligence' | 'challenge' | 'credit' | 'options' | 'oiflow' | 'liq' | 'orderflow'>('terminal');
  const [displayMode, setDisplayMode] = useState<'simple' | 'pro'>('simple');
  const [showSidebar, setShowSidebar] = useState(true);
  const [selectedAnalysisStock, setSelectedAnalysisStock] = useState<string | null>(null);
  // Candles published by IndiaMarketChart → feed the Volume Profile panel
  const [indiaBars, setIndiaBars] = useState<Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>>([]);
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
  // Live session — cheap pure Date math, recomputed every render (the 1s
  // countdown keeps that honest) so the refresh cadence flips within ~1s of
  // market open/close. 15s while open (matches the countdown), 5min closed.
  const marketSession = getCurrentSession();
  const refreshSecs = marketSession.isMarketOpen ? 15 : 300;
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const params = new URLSearchParams({ symbol });
        if (selectedExpiry) params.set('expiry', selectedExpiry);
        const res = await fetch(`/api/option-chain?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error('Failed to fetch');
        const json = await res.json();
        const base = json.data || json;
        return { ...base, analysis: json.analysis };
      } finally {
        clearTimeout(timeout);
      }
    },
    refetchInterval: autoRefresh ? refreshSecs * 1000 : false,
    staleTime: 5000,
    retry: 1,
    retryDelay: 2000,
  });

  // Sync analysis from query data (not inside queryFn to avoid infinite loops)
  useEffect(() => {
    if ((data as any)?.analysis) {
      setAnalysis((data as any).analysis);
    }
  }, [data]);
  
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
    refetchInterval: autoRefresh ? 30000 : false,
  });

  // Normalize the summary from the LIVE option-chain response. The API wraps
  // stats in `analysis` (pcr / vix / OI / maxPain / atmStrike); the inner
  // data.summary only carries spotPrice. Declared here, before the effects
  // that reference it, to avoid a TDZ error.
  const summary: MarketSummary | null = (() => {
    if (!data) return null;
    const raw = data as any;
    // data = json.data = { summary: {...}, data: [...strikes], expiries: [...] }
    // analysis is at json.analysis (stored separately via setAnalysis)
    const chainSummary = raw.summary || {};
    const chain = raw.data || [];
    const spot = chainSummary.spotPrice ?? 0;
    const atmStrike =
      chainSummary.atmStrike ??
      (Array.isArray(chain) && chain.length
        ? chain.reduce((b: any, r: any) =>
            Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b
          ).strike
        : 0);
    const prevClose = typeof chainSummary.prevClose === 'number' ? chainSummary.prevClose : null;
    const spotChange = prevClose ? spot - prevClose : 0;
    const spotChangePct = prevClose ? ((spot - prevClose) / prevClose) * 100 : 0;
    return {
      spotPrice: spot,
      spotChange,
      spotChangePct,
      indiaVIX: (typeof chainSummary.indiaVIX === 'number' ? chainSummary.indiaVIX : null),
      prevClose,
      vixLive: chainSummary.vixLive ?? false,
      prevCloseLive: chainSummary.prevCloseLive ?? false,
      pcr: chainSummary.pcr ?? 1,
      maxPain: chainSummary.maxPain ?? 0,
      totalCallOI: chainSummary.totalCallOI ?? 0,
      totalPutOI: chainSummary.totalPutOI ?? 0,
      atmStrike,
      callOiChange: chainSummary.callOiChange ?? null,
      putOiChange: chainSummary.putOiChange ?? null,
      futuresPrice: chainSummary.futuresPrice ?? null,
    };
  })();

  // OI Summary for SimpleMode card — absorption/exhaustion, traps, support/resistance
  const oiSummary = useMemo(() => {
    const raw = data as any;
    const chain = raw?.data || [];
    const spot = raw?.summary?.spotPrice || 0;
    if (!chain.length || !spot) return null;
    const analysis = analyzeOptionChain(chain, spot);
    return {
      freshWriting: analysis.freshWriting || [],
      traps: analysis.traps || [],
      supportResistance: analysis.supportResistance || { resistance: [], support: [] },
      classifications: analysis.classifications || [],
      pcrOI: analysis.pcrOI ?? 0,
      maxPain: analysis.maxPain ?? 0,
    };
  }, [data]);

  // Tech reads — REAL 15m trend (SuperTrend/EMA/structure), 5m trigger
  // evidence (closed bars), vsVwap and RVOL from the tech-cache snapshots.
  // The server refreshes a snapshot only when it is stale (TTL = one bar
  // interval), so these reads change when a candle CLOSES — not on every
  // 15s OI tick.
  const { data: techData } = useQuery<any>({
    queryKey: ['tech-reads', symbol],
    queryFn: async () => {
      const res = await fetch(`/api/tech-cache?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: autoRefresh ? 30000 : false,
    staleTime: 15000,
  });

  // ── Strike selection + plan re-pricing (REAL gate rules, no invented contract) ──
  // selectStrike picks the tradable contract for the signal direction from the
  // LIVE chain: ATM..3-OTM only, |delta| ≥ 0.35 when published, 1 lot must fit
  // the per-trade budget, ltp > 0. When it picks a (possibly different)
  // contract, buildOptionPlan re-prices entry/SL/targets for THAT premium.
  // Lot size comes from symbol-config (fail-closed: unknown symbol → 0 → no
  // selection, never NIFTY's lot for a stock).
  const strikeSel = useMemo(() => {
    const raw = data as any;
    const chainRows: ChainRowLike[] = raw?.data || [];
    const spot = raw?.summary?.spotPrice || raw?.analysis?.spotPrice || 0;
    const rec = raw?.analysis?.recommendation;
    const dir = rec?.optionType === "CE" ? "CALL" : rec?.optionType === "PE" ? "PUT" : rec?.direction === "CALL" ? "CALL" : rec?.direction === "PUT" ? "PUT" : null;
    const lotSize = getLotSize(symbol);
    const sel = dir && spot > 0 && lotSize > 0 && chainRows.length
      ? selectStrike({ chain: chainRows, direction: dir, spot, lotSize })
      : null;

    const plan: OptionPlan | null = sel
      ? buildOptionPlan({ symbol, optionType: sel.optionType, entryPremium: sel.entry, lotSize })
      : null;

    // Greeks of the traded leg (selected contract, else the SDM rec's leg).
    const greeks: GreeksReadInput | null = (() => {
      const targetStrike = sel?.strike ?? rec?.strike;
      const optType = sel?.optionType ?? rec?.optionType;
      if (targetStrike == null || !optType) return null;
      const row = chainRows.find((r: any) => r.strike === targetStrike);
      if (!row) return null;
      const leg = optType === "CE" ? row.ce : row.pe;
      if (!leg) return null;
      const premium = Number(leg.ltp) || 0;
      if (!(premium > 0)) return null;
      const num = (v: any) => (v != null && Number.isFinite(Number(v)) && Number(v) !== 0 ? Number(v) : null);
      return {
        delta: num(leg.delta), theta: num(leg.theta), gamma: num(leg.gamma),
        vega: num(leg.vega), iv: num(leg.iv), premium,
      };
    })();

    return { sel, plan, greeks, lotSize };
  }, [data, symbol]);

  // Confirmation checks for SimpleMode card — tells the user WHEN to take a
  // trade. Every check is scored from REAL reads only: the 15m trend read,
  // the 5m closed-bar trigger, real RVOL, real PCR, real vsVwap, real ADX/DI,
  // and the traded leg's real |delta|. Missing data marks a check UNAVAILABLE
  // (not counted, never a fabricated pass).
  const confirmations = useMemo(() => {
    const raw = data as any;
    const rec = raw?.analysis?.recommendation;
    const dir = rec?.optionType === "CE" ? "CALL" : rec?.optionType === "PE" ? "PUT" : rec?.direction === "CALL" ? "CALL" : rec?.direction === "PUT" ? "PUT" : null;
    if (!dir) return [];

    const summaryData = raw?.summary || {};
    const ceOI = summaryData.totalCallOI || 0;
    const peOI = summaryData.totalPutOI || 0;
    const pcr = ceOI > 0 ? peOI / ceOI : summaryData.pcr ?? null;

    const snap15 = techData?.snapshots?.["15m"];
    const snap5 = techData?.snapshots?.["5m"];
    const trendRead = snap15?.fresh && snap15?.trend ? snap15.trend : null;
    const adxRead = trendRead && trendRead.adx != null && trendRead.pdi != null && trendRead.mdi != null
      ? { adx: trendRead.adx, pdi: trendRead.pdi, mdi: trendRead.mdi }
      : null;

    const triggerLayer =
      snap5?.fresh ? snap5.triggers?.[dir === "CALL" ? "call" : "put"] : null;
    const triggerRead = triggerLayer
      ? {
          hits: triggerLayer.state === "agree" ? [triggerLayer.evidence] : [],
          opposing: triggerLayer.state === "against" ? [triggerLayer.evidence] : [],
        }
      : null;

    return evaluateConfirmations({
      direction: dir,
      trendRead,
      triggerRead,
      adxRead,
      greeksRead: strikeSel.greeks,
      rvol: techData?.rvol ?? null,
      pcr: pcr && pcr > 0 ? pcr : null,
      vsVwap: snap5?.fresh && snap5?.vsVwap ? snap5.vsVwap : null,
    });
  }, [data, techData, strikeSel]);

  // Build the SDM recommendation from the LIVE analysis in the option-chain
  // response. The API returns analysis.recommendation + analysis.pcr / vix /
  // maxPain; we map it onto the SDMRecommendation shape SimpleMode reads.
  //
  // Direction is routed through the signal-persistence layer so the card does
  // not flip BUY CE <-> BUY PE on every option-chain refresh. A raw direction
  // must persist (minConfirmations × minPersistenceMs) and clear a hysteresis
  // margin before it becomes the confirmed signal; below the confidence floor
  // the card reads NO TRADE. Levels (entry/SL/targets) always belong to the
  // displayed direction. Genuine reversals are confirmed, not blocked.
  const recommendation: SDMRecommendation | null = useMemo(() => {
    const a = (data as any)?.analysis;
    const rec = a?.recommendation;
    if (!rec) return null;

    // Levels come from the SELECTED contract when strike selection ran: the
    // selector's premium re-priced through the canonical plan builder (rupee
    // risk + 2R/3R/4R). Without a selection (no lot size / no chain) the SDM
    // rec's own real levels are kept as-is.
    const plan = strikeSel.plan;
    const sel = strikeSel.sel;
    const entry = plan ? plan.entry : (rec.entryPrice || 0);
    const sl = plan ? plan.stopLoss : (rec.stopLoss || 0);
    const tp1 = plan ? (plan.targets[0] || 0) : (rec.tp1 || 0);
    const tp2 = plan ? (plan.targets[1] || 0) : (rec.tp2 || 0);
    const tp3 = plan ? (plan.targets[2] || 0) : (rec.tp3 || 0);
    const strike = sel ? sel.strike : rec.strike;
    const rr = entry && sl && entry !== sl ? Math.abs((tp1 - entry) / (entry - sl)) : 0;
    const score = rec.sdmScore ?? 0;
    const raw: SignalRec = {
      direction: rec.optionType === "CE" ? "CALL" : rec.optionType === "PE" ? "PUT" : rec.direction,
      confidence: Math.round(rec.confidence || 0),
      entry,
      sl,
      tp1,
      tp2,
      tp3,
      strike,
      tradeGrade:
        score >= 75 ? "A+" : score >= 65 ? "A" : score >= 55 ? "B+" : score >= 45 ? "B" : "C",
      reason: Array.isArray(rec.reasons) ? rec.reasons.join(" · ") : (rec.reasons || ""),
      riskReward: Math.round(rr * 10) / 10,
      confirmations,
    };
    const { rec: confirmedRec, showDirection } = updateSignal(raw, Date.now(), confirmations);

    // Expiry — REAL days-to-expiry from the contract the response SERVED.
    // (Never toISOString: a UTC shift reports a local midnight date a day early.)
    const servedExpiry = (data as any)?.selectedExpiry || (data as any)?.expiry || null;
    const dte = daysToExpiryLocal(servedExpiry);

    return {
      direction: showDirection ? confirmedRec.direction : "WAIT",
      optionType: sel?.optionType ?? rec.optionType ?? undefined,
      strike: confirmedRec.strike,
      strikeType: (sel?.isAtm ? "ATM" : `${sel?.otmSteps ?? 0} OTM`) as any,
      entry: confirmedRec.entry,
      tp1: confirmedRec.tp1,
      tp2: confirmedRec.tp2,
      tp3: confirmedRec.tp3,
      sl: confirmedRec.sl,
      confidence: confirmedRec.confidence,
      riskReward: confirmedRec.riskReward,
      isExpiryDay: dte === 0,
      daysToExpiry: dte ?? a?.expiry?.daysToExpiry ?? 0,
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
      reason: confirmedRec.reason,
      timeSensitiveNote: "",
      smartEntry: {} as any,
      smartExit: {} as any,
      premiumFairValue: {} as any,
      probabilities: {} as any,
      tradeGrade: confirmedRec.tradeGrade,
      dataHealth: {} as any,
      positionSizing: plan
        ? { lots: plan.lots, deployed: plan.deployed, riskAmount: plan.riskAmount, lotCost: plan.lotCost, tradable: plan.tradable, notes: plan.notes }
        : ({} as any),
      marketRegime: {} as any,
      holdingTimeEstimate: "",
      expectedMove: 0,
    } as SDMRecommendation;
  }, [data, confirmations, strikeSel]);

  // Update store
  useEffect(() => {
    if (data) {
      setOptionChain(data as any);
      setSelectedSymbol(symbol);
    }
  }, [data, setOptionChain, setSelectedSymbol, symbol]);
  
  // Run ML analysis on data change
  useEffect(() => {
    if (data?.data?.length && data?.candles?.length) {
      const result = runMLAnalysis(data.candles, data.data, data.summary?.spotPrice || data.analysis?.spotPrice || 0);
      setMlResult(result);
    }
  }, [data]);
  
  // Set default expiry — prefer the contract the response actually SERVED
  // (nearest still-live). Never expiries[0]: exchanges/providers list dead or
  // holiday-shifted contracts first (observed: holiday Tue 10-Nov-2026 as
  // expiries[0] → gate rejected it with EXPIRY_UNAVAILABLE 400s and this tab
  // looped on the bad query key).
  useEffect(() => {
    if (selectedExpiry || !data) return;
    const served = data.selectedExpiry || data.expiry;
    if (served) {
      setSelectedExpiry(served);
      setStoreExpiry(served);
      return;
    }
    if (data.expiries?.length) {
      const firstLive = data.expiries.find((e: any) => !e.expired)?.date || data.expiries[0].date;
      setSelectedExpiry(firstLive);
      setStoreExpiry(firstLive);
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
  
  // Auto-refresh countdown — mirrors the query's refetchInterval (15s open,
  // 5min closed) so what you see is what actually refetches.
  useEffect(() => {
    if (!autoRefresh) { setRefreshCountdown(0); return; }
    setRefreshCountdown(refreshSecs);
    const interval = setInterval(() => {
      setRefreshCountdown((prev) => {
        if (prev <= 1) return refreshSecs;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshSecs]);

  // Max OI for heat map
  const chainData = useMemo(() => {
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }, [data?.data]);

  // Market session info — declared at the top of the component (marketSession)
  // so the option-chain query can use it for the refresh cadence.

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
      <div className="min-h-screen flex flex-col bg-background">
        {/* Show header + tabs immediately so user can navigate */}
        <header className="sticky top-0 z-50 border-b bg-card/95 backdrop-blur-md">
          <div className="flex items-center justify-between px-3 py-1.5">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
                <Zap className="h-3.5 w-3.5 text-white" />
              </div>
              <h1 className="font-bold text-sm tracking-tight">SMDApp</h1>
            </div>
            <div className="flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
              <span className="text-[9px] text-muted-foreground">Loading data...</span>
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-primary mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">Fetching market data...</p>
            <p className="text-[9px] text-muted-foreground/60 mt-1">This may take a few seconds</p>
          </div>
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
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { refetch(); setRefreshCountdown(refreshSecs); }} disabled={isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
            {autoRefresh && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
                <Timer className="h-3 w-3" />
                <span>{refreshCountdown >= 60 ? `${Math.floor(refreshCountdown / 60)}m ${refreshCountdown % 60}s` : `${refreshCountdown}s`}</span>
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
            <Button variant={viewMode === 'scanner' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'scanner' ? 'bg-teal-600 text-white shadow-sm shadow-teal-500/25' : 'text-muted-foreground hover:text-teal-500'}`}
              onClick={() => { setViewMode('scanner'); setDisplayMode('pro'); }}>
              <Scan className="h-2.5 w-2.5 mr-0.5" /> Scanner
            </Button>
            <Button variant={viewMode === 'btst' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'btst' ? 'bg-cyan-600 text-white shadow-sm shadow-cyan-500/25' : 'text-muted-foreground hover:text-cyan-500'}`}
              onClick={() => { setViewMode('btst'); setDisplayMode('pro'); }}>
              <Flame className="h-2.5 w-2.5 mr-0.5" /> BTST
            </Button>
            <Button variant={viewMode === 'daily' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'daily' ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/25' : 'text-muted-foreground hover:text-violet-500'}`}
              onClick={() => { setViewMode('daily'); setDisplayMode('pro'); }}>
              <CalendarClock className="h-2.5 w-2.5 mr-0.5" /> Daily
            </Button>
            <Button variant={viewMode === 'challenge' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'challenge' ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-sm shadow-amber-500/25' : 'text-muted-foreground hover:text-amber-500'}`}
              onClick={() => { setViewMode('challenge'); setDisplayMode('pro'); }}>
              <Trophy className="h-2.5 w-2.5 mr-0.5" /> ₹15K→₹1L
            </Button>
            <Button variant={viewMode === 'expiry' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'expiry' ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/25' : 'text-muted-foreground hover:text-amber-500'}`}
              onClick={() => { setViewMode('expiry'); setDisplayMode('pro'); }}>
              <Target className="h-2.5 w-2.5 mr-0.5" /> Expiry Plan
            </Button>
            <Button variant={viewMode === 'backtest' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'backtest' ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/25' : 'text-muted-foreground hover:text-amber-500'}`}
              onClick={() => { setViewMode('backtest'); setDisplayMode('pro'); }}>
              <LineChart className="h-2.5 w-2.5 mr-0.5" /> Backtest
            </Button>
            <Button variant={viewMode === 'zerohero' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'zerohero' ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/25' : 'text-muted-foreground hover:text-amber-500'}`}
              onClick={() => { setViewMode('zerohero'); setDisplayMode('pro'); }}>
              <Crosshair className="h-2.5 w-2.5 mr-0.5" /> Zero Hero
            </Button>
            
            <Button variant={viewMode === 'institutional' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'institutional' ? 'bg-rose-600 text-white shadow-sm shadow-rose-500/25' : 'text-muted-foreground hover:text-rose-500'}`}
              onClick={() => { setViewMode('institutional'); setDisplayMode('pro'); }}>
              <Users className="h-2.5 w-2.5 mr-0.5" /> Insti
            </Button>
            <Button variant={viewMode === 'orderbook' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'orderbook' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/25' : 'text-muted-foreground hover:text-indigo-500'}`}
              onClick={() => { setViewMode('orderbook'); setDisplayMode('pro'); }}>
              <BookOpen className="h-2.5 w-2.5 mr-0.5" /> Book
            </Button>
            <Button variant={viewMode === 'credit' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'credit' ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/25' : 'text-muted-foreground hover:text-emerald-500'}`}
              onClick={() => { setViewMode('credit'); setDisplayMode('pro'); }}>
              <TrendingDown className="h-2.5 w-2.5 mr-0.5" /> Credit
            </Button>
            <Button variant={viewMode === 'india' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'india' ? 'bg-orange-600 text-white shadow-sm shadow-orange-500/25' : 'text-muted-foreground hover:text-orange-500'}`}
              onClick={() => { setViewMode('india'); setDisplayMode('pro'); }}>
              <CandlestickChart className="h-2.5 w-2.5 mr-0.5" /> India Chart
            </Button>
            <Button variant={viewMode === 'intelligence' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'intelligence' ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-sm shadow-emerald-500/25' : 'text-muted-foreground hover:text-emerald-500'}`}
              onClick={() => { setViewMode('intelligence'); setDisplayMode('pro'); }}>
              <Brain className="h-2.5 w-2.5 mr-0.5" /> Intel
            </Button>
            <Button variant={viewMode === 'options' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'options' ? 'bg-rose-600 text-white shadow-sm shadow-rose-500/25' : 'text-muted-foreground hover:text-rose-500'}`}
              onClick={() => { setViewMode('options'); setDisplayMode('pro'); }}>
              <Activity className="h-2.5 w-2.5 mr-0.5" /> Option Pulse
            </Button>
            <Button variant={viewMode === 'oiflow' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'oiflow' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/25' : 'text-muted-foreground hover:text-indigo-500'}`}
              onClick={() => { setViewMode('oiflow'); setDisplayMode('pro'); }}>
              <BarChart3 className="h-2.5 w-2.5 mr-0.5" /> OI Flow
            </Button>
            <Button variant={viewMode === 'liq' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'liq' ? 'bg-purple-600 text-white shadow-sm shadow-purple-500/25' : 'text-muted-foreground hover:text-purple-500'}`}
              onClick={() => { setViewMode('liq'); setDisplayMode('pro'); }}>
              <Target className="h-2.5 w-2.5 mr-0.5" /> Liquidity
            </Button>
            <Button variant={viewMode === 'orderflow' ? 'default' : 'ghost'} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${viewMode === 'orderflow' ? 'bg-cyan-600 text-white shadow-sm shadow-cyan-500/25' : 'text-muted-foreground hover:text-cyan-500'}`}
              onClick={() => { setViewMode('orderflow'); setDisplayMode('pro'); }}>
              <Zap className="h-2.5 w-2.5 mr-0.5" /> Order Flow
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
                { mode: 'institutional', label: 'Institutional', icon: Users, color: 'rose' },
                { mode: 'news', label: 'News', icon: Newspaper, color: 'orange' },
                { mode: 'agent', label: 'Agent Chat', icon: Bot, color: 'purple' },
                { mode: 'agent-intel', label: 'Agent Intel', icon: Users, color: 'cyan' },
                { mode: 'backtest', label: 'Backtest Audit', icon: LineChart, color: 'amber' },
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
            <span className="font-semibold tabular-nums">{summary.indiaVIX != null ? fmt(summary.indiaVIX) : '—'}</span>
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
                <Badge className="text-[8px]" variant={dataSourceBadge(data.dataSource).isLive ? 'default' : 'outline'}>
                  {dataSourceBadge(data.dataSource).label}
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
            {/* System Health + Data Source */}
            <ConnectionStatusBar />
            {/* Motilal Connection Status */}
            <MotilalStatus />
          </div>
        )}
      </header>
      
      {/* ─── Main Content ─── */}
      {/* pb: clear the fixed MobileNav bottom bar on phones (lg: desktop has no bottom bar) */}
      <div className="flex flex-1 overflow-hidden pb-[60px] lg:pb-0">
        {/* ─── Simple Mode: Clean AI Recommendation ─── */}
        {displayMode === 'simple' ? (
          <div className="flex-1 overflow-auto">
            <SimpleMode
              recommendation={recommendation}
              spotPrice={data?.spotPrice || summary?.spotPrice || 0}
              symbol={symbol}
              onSwitchToPro={() => setDisplayMode('pro')}
              summary={summary}
              expiries={data?.expiries}
              dataSource={data?.dataSource}
              selectedExpiry={selectedExpiry}
              onExpiryChange={setSelectedExpiry}
              oiSummary={oiSummary}
              confirmations={confirmations}
              atrInfo={{
                tf15: (techData as any)?.snapshots?.["15m"]?.atr ?? null,
                tf5: (techData as any)?.snapshots?.["5m"]?.atr ?? null,
                close: (techData as any)?.snapshots?.["15m"]?.close ?? null,
              }}
              strikeInfo={strikeSel.sel ? {
                strike: strikeSel.sel.strike,
                otmSteps: strikeSel.sel.otmSteps,
                isAtm: strikeSel.sel.isAtm,
                reason: strikeSel.sel.reason,
              } : null}
              greeks={strikeSel.greeks}
              barStamp={{
                asOf5m: (techData as any)?.snapshots?.["5m"]?.asOf ?? null,
                asOf15m: (techData as any)?.snapshots?.["15m"]?.asOf ?? null,
                fresh5m: !!(techData as any)?.snapshots?.["5m"]?.fresh,
              }}
              marketClosed={getCurrentSession('index').session === 'closed'}
            />
          </div>
        ) : viewMode === 'scanner' ? (
        /* ═══════ SCANNER VIEW (Intraday + Weekly) ═══════ */
        <div className="flex-1 overflow-hidden">
          <ScannerView
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
            vix={summary?.indiaVIX ?? undefined}
            sentiment={analysis?.sentiment}
          />
        </div>
        ) : viewMode === 'agent-intel' ? (
        /* ═══════ AGENT INTELLIGENCE ═══════ */
        <div className="flex-1 overflow-auto p-2">
          <AgentIntelligence />
        </div>
        ) : viewMode === 'admin' ? (
        /* ═══════ ADMIN PANEL ═══════ */
        <div className="flex-1 overflow-auto p-2">
          <AdminPanel />
        </div>
        ) : viewMode === 'btst' ? (
        /* ═══════ BTST AI DASHBOARD ═══════ */
        <div className="flex-1 overflow-hidden">
          <BTSTDashboard />
        </div>
        ) : viewMode === 'backtest' ? (
        /* ═══════ BACKTEST AUDIT ENGINE ═══════ */
        <div className="flex-1 overflow-auto p-2">
          <BacktestDashboard />
        </div>
        ) : viewMode === 'challenge' ? (
        /* ═══════ ₹15K → ₹1L CHALLENGE ═══════ */
        <div className="flex-1 overflow-auto">
          <ChallengeTab />
        </div>
        ) : viewMode === 'expiry' ? (
        /* ═══════ EXPIRY PLAN ═══════ */
        <div className="flex-1 overflow-hidden">
          <ExpiryPlanPanel
            symbol={symbol}
            spotPrice={data?.spotPrice || summary?.spotPrice || 0}
            summary={summary}
            chainData={chainData}
            expiries={data?.expiries}
            selectedExpiry={selectedExpiry}
          />
        </div>
 ) : viewMode === 'zerohero' ? (
        /* ═══════ ZERO HERO SCANNER ═══════ */
        <div className="flex-1 overflow-hidden">
          <ZeroHeroLiveTerminal />
        </div>
        ) : viewMode === 'institutional' ? (
        /* ═══════ INSTITUTIONAL POSITIONING ═══════ */
        <div className="flex-1 overflow-hidden">
          <InstitutionalPositioningPanel symbol={symbol} />
        </div>
        ) : viewMode === 'orderbook' ? (
        /* ═══════ ORDER BOOK (NIFTY + SENSEX futures depth) ═══════ */
        <div className="flex-1 overflow-auto">
          <OrderBookPanel />
        </div>
        ) : viewMode === "credit" ? (
        /* ═══════ CREDIT SPREAD ═══════ */
        <CreditTab />
        ) : viewMode === 'india' ? (
        /* ═══════ INDIA MARKET CHART + VOLUME PROFILE ═══════ */
        <div className="flex-1 overflow-hidden p-2 grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 2.2fr) minmax(0, 1fr)' }}>
          <IndiaMarketChart symbol="NIFTY" onBars={setIndiaBars} />
          <VolumeProfilePanel candles={indiaBars} symbol="NIFTY" />
        </div>
        ) : viewMode === 'intelligence' ? (
        /* ═══════ MARKET DECISION INTELLIGENCE CENTER ═══════ */
        <div className="flex-1 overflow-hidden">
          <IntelTab onStockClick={setSelectedAnalysisStock} />
        </div>
        ) : viewMode === 'terminal' ? (
        /* ═══════ TERMINAL ═══════ */
        <div className="flex flex-1 overflow-hidden">
          <ZeroHeroTerminal />
        </div>
        ) : viewMode === 'options' ? (
        /* ═══════ OPTION PULSE ═══════ */
        <div className="flex-1 overflow-hidden p-2">
          <OptionPulseView />
        </div>
        ) : viewMode === 'oiflow' ? (
        /* ═══════ OI FLOW ═══════ */
        <div className="flex-1 overflow-hidden p-2">
          <OIFlowView />
        </div>
        ) : viewMode === 'liq' ? (
        /* ═══════ LIQUIDITY MAP ═══════ */
        <div className="flex-1 overflow-hidden p-2">
          <LiquidityMapView />
        </div>
        ) : viewMode === 'orderflow' ? (
        /* ═══════ ORDER FLOW ═══════ */
        <div className="flex-1 overflow-hidden p-2">
          <OrderFlowView />
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
            pcr={summary?.pcr ?? 1}
            maxPain={summary?.maxPain ?? 0}
          />
</div>
      )}
      
      {/* ─── Order Panel (Modal) ─── */}
       <OrderPanel />

      {/* ─── Stock Analysis Drawer ─── */}
       <StockAnalysisDrawer symbol={selectedAnalysisStock} onClose={() => setSelectedAnalysisStock(null)} />
       
{/* ─── Mobile Navigation ─── */}
        <MobileNav viewMode={viewMode} onViewChange={setViewMode} />
      </div>
      </div>
  );
}
