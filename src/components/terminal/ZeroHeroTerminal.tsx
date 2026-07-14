"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Home, Link2, Target, Wallet, Grid3X3, Clock, Star, Briefcase,
  TrendingUp, TrendingDown, ChevronDown, Search, X, RefreshCw,
  Wifi, WifiOff, Zap, Activity, ArrowUpRight, ArrowDownRight,
  Building2, AlertTriangle, Brain, Shield, Minus, BarChart3,
  Flame, Trophy,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTerminalStore, INDEX_INSTRUMENTS, EQUITY_INSTRUMENTS, ALL_INSTRUMENTS } from "@/stores/useTerminalStore";
import { getInstrument } from "@/stores/useTerminalStore";
import { isFNO, getExpiryTypeForDate, getStandardizedExpiry } from "@/lib/expiry-calculator";
import { ALL_SYMBOLS } from "@/lib/stockUniverse";
import { analyzeZeroHeroChain, evaluateZeroHeroCandidate } from "@/lib/zero-hero";
import { chainToSDMStrikes, runSMCAnalysis } from "@/lib/smc-engine";

/**
 * Register candidate trades through the unified /api/trade/register endpoint
 * so SMC / Zero Hero AI flow through the SAME lifecycle as server-side
 * strategies (active tracker + Prisma journal + Trade Audit engine). Idempotent
 * per deterministic tradeId, so re-scans are safe.
 */
async function registerTrades(
  strategyId: string,
  symbol: string,
  candidates: any[]
): Promise<void> {
  await Promise.all(
    candidates.map((c) =>
      fetch("/api/trade/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyId,
          symbol,
          strike: c.strike,
          optionType: c.type,
          entry: c.entry,
          sl: c.sl,
          tp1: c.tp1,
          tp2: c.tp2,
          tp3: c.tp3,
          price: c.price ?? c.entry,
          confidence: c.confidence ?? c.conf,
          spotPrice: c.spotPrice ?? c.spot,
          positionSize: c.positionSize?.lots ?? c.positionSize,
          riskPerTrade: c.riskPerTrade ?? c.riskPerTrade,
          qualityScore: c.qualityScore,
          qualityGrade: c.qualityGrade,
        }),
      }).catch(() => {})
    )
  );
}

/**
 * Record EVERY scanner cycle as a permanent AI-training row (M5).
 * Used by both Zero Hero (strategy="ZERO_HERO") and Smart Money (strategy="SMC").
 * Includes BUY/SELL (eligible), REJECT (below confidence floor) and a single
 * NO_TRADE when no candidate is produced. snapshotId is resolved server-side
 * to the latest recorded market snapshot for the symbol.
 */
async function recordScannerCycle(
  symbol: string,
  strategy: string,
  candidates: { strike: number; type: "CE" | "PE"; entry: number; sl?: number; tp1?: number; tp2?: number; conf: number; rr?: number }[]
): Promise<void> {
  const results: any[] = candidates.map((c) => ({
    symbol,
    strategy,
    decision: c.conf >= 60 ? (c.type === "CE" ? "BUY" : "SELL") : "REJECT",
    confidence: c.conf,
    riskScore: Math.max(0, Math.min(100, 100 - c.conf)),
    perEngineConfidence: { [strategy]: c.conf },
    triggeredEngines: c.conf >= 60 ? [strategy] : [],
    rejectedConditions: c.conf >= 60 ? [] : ["confidence_below_60"],
    reasons: [`strike ${c.strike} ${c.type} conf=${c.conf}`],
    selectedStrike: c.strike,
    entry: c.entry,
    sl: c.sl,
    tp1: c.tp1,
    tp2: c.tp2,
    expectedRR: c.rr,
  }));
  if (results.length === 0) {
    results.push({
      symbol,
      strategy,
      decision: "NO_TRADE",
      confidence: 0,
      riskScore: 100,
      perEngineConfidence: {},
      triggeredEngines: [],
      rejectedConditions: ["no_candidates"],
      reasons: ["no eligible strikes near spot"],
    });
  }
  await fetch("/api/market-recorder/scanner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  }).catch(() => {});
}

type Tab = "overview" | "options" | "zerohero" | "smartmoney" | "greeks" | "dom" | "history" | "watchlist" | "positions";

const TABS: { id: Tab; icon: React.ReactNode; label: string }[] = [
  { id: "overview", icon: <Home size={19} />, label: "Overview" },
  { id: "options", icon: <Link2 size={19} />, label: "Option Chain" },
  { id: "zerohero", icon: <Target size={19} />, label: "Zero Hero" },
  { id: "smartmoney", icon: <Wallet size={19} />, label: "Smart Money" },
  { id: "greeks", icon: <Grid3X3 size={19} />, label: "Greeks" },
  { id: "dom", icon: <BarChart3 size={19} />, label: "DOM Analysis" },
  { id: "history", icon: <Clock size={19} />, label: "Trade History" },
  { id: "watchlist", icon: <Star size={19} />, label: "Watchlist" },
  { id: "positions", icon: <Briefcase size={19} />, label: "Positions & P&L" },
];

function getISTTime(): Date {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
}

function isMarketOpen(): boolean {
  const ist = getISTTime();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins <= 930;
}

function fmt(n: number, d = 2): string {
  if (n == null || isNaN(n)) return "0";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtInt(n: number): string {
  if (n == null || isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-IN");
}

interface ChainRow {
  strike: number;
  atm: boolean;
  ce: { oi: number; oiChg: number; vol: number; iv: number; delta: number; ltp: number; gamma: number; theta: number; vega: number } | null;
  pe: { oi: number; oiChg: number; vol: number; iv: number; delta: number; ltp: number; gamma: number; theta: number; vega: number } | null;
}

interface ZHCandidate {
  rank: number;
  strike: number;
  type: "CE" | "PE";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  rr: number;
  prob: number;
  conf: number;
  stars: number;
}

interface TradeRec {
  action: string;
  strike: number;
  type: "CE" | "PE";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  bias: string;
  rr: number;
  reason: string;
  confidence: number;
}

interface Trade {
  tradeId: string;
  symbol: string;
  strike: number;
  optionType: string;
  direction: string;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  status: string;
  entryTime: string;
}

// ─── Money Tag ─────────────────────────────────────────────────────
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

function StarRating({ count }: { count: number }) {
  return (
    <span className="text-amber-400 text-[11px] tracking-tight">
      {"★".repeat(count)}{"☆".repeat(Math.max(0, 5 - count))}
    </span>
  );
}

// ─── Main Component ────────────────────────────────────────────────
export function ZeroHeroTerminal() {
  const { symbol, expiry, setSymbol, setExpiry } = useTerminalStore();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [instDropdown, setInstDropdown] = useState(false);
  const [instSearch, setInstSearch] = useState("");
  const [expiryType, setExpiryType] = useState<"weekly" | "monthly">("weekly");
  const [now, setNow] = useState("");
  const [open, setOpen] = useState(false);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const ddRef = useRef<HTMLDivElement>(null);

  // Data states
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [spot, setSpot] = useState(0);
  const [vix, setVix] = useState(0);
  const [pcr, setPcr] = useState(0);
  const [maxPain, setMaxPain] = useState(0);
  const [candles, setCandles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [notAvailable, setNotAvailable] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("--:--:--");
  const [trades, setTrades] = useState<Trade[]>([]);
  const [rec, setRec] = useState<TradeRec | null>(null);
  const fetchGenRef = useRef(0);

  // Positions (local state)
  const [positions, setPositions] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [pendingTrade, setPendingTrade] = useState<any>(null);
  const [modalQty, setModalQty] = useState(1);

  // Watchlist
  const [watchlist, setWatchlist] = useState<Set<string>>(() => new Set(["NIFTY", "BANKNIFTY", "RELIANCE", "HDFCBANK"]));

  const inst = getInstrument(symbol);
  const lotSize = inst?.lotSize || 65;
  const isEligible = isFNO(symbol); // All F&O indices + F&O equity stocks eligible for Zero Hero

  // ─── Fetch option chain ──────────────────────────────────────────
  const fetchChain = useCallback(async (gen: number) => {
    try {
      const params = new URLSearchParams({ symbol });
      if (expiry) params.set("expiry", expiry);
      const res = await fetch(`/api/option-chain?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed");
      }
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "No data");

      const strikes = json.data?.data || [];
      const spotPrice = json.data?.summary?.spotPrice || json.data?.spotPrice || 0;
      const mp = json.data?.summary?.maxPain || 0;
      const notAvail = json.data?.notAvailable === true;
      let totalCallOI = 0;
      let totalPutOI = 0;

      const rows: ChainRow[] = strikes.map((s: any) => {
        totalCallOI += s.ce?.oi || 0;
        totalPutOI += s.pe?.oi || 0;
        return {
          strike: s.strike,
          atm: false,
          ce: s.ce ? { oi: s.ce.oi || 0, oiChg: s.ce.oiChg || 0, vol: s.ce.volume || 0, iv: s.ce.iv || 0, delta: s.ce.delta || 0, ltp: s.ce.ltp || 0, gamma: s.ce.gamma || 0, theta: s.ce.theta || 0, vega: s.ce.vega || 0 } : null,
          pe: s.pe ? { oi: s.pe.oi || 0, oiChg: s.pe.oiChg || 0, vol: s.pe.volume || 0, iv: s.pe.iv || 0, delta: s.pe.delta || 0, ltp: s.pe.ltp || 0, gamma: s.pe.gamma || 0, theta: s.pe.theta || 0, vega: s.pe.vega || 0 } : null,
        };
      });

      // Mark ATM
      let closest = rows[0];
      let minDiff = Infinity;
      for (const r of rows) {
        const diff = Math.abs(r.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; closest = r; }
      }
      if (closest) closest.atm = true;

      // Sort and take 19 centered on ATM
      const sorted = [...rows].sort((a, b) => a.strike - b.strike);
      const atmIdx = sorted.findIndex((s) => s.atm);
      const start = Math.max(0, atmIdx - 9);
      const end = Math.min(sorted.length, start + 19);
      const nearby = sorted.slice(start, end);

      if (gen !== fetchGenRef.current) return;
      setChain(nearby);
      setSpot(spotPrice);
      setMaxPain(mp);
      setNotAvailable(notAvail);
      setPcr(totalCallOI > 0 ? totalPutOI / totalCallOI : 1);
      setVix(json.data?.summary?.indiaVIX || 0);
      setCandles(json.data?.candles || []);
      setLastUpdate(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
      setOpen(isMarketOpen());
      setError(false);
      setErrorMsg("");
    } catch (e: any) {
      if (gen !== fetchGenRef.current) return;
      setError(true);
      setErrorMsg(e?.message || "Failed to load data");
    } finally {
      if (gen !== fetchGenRef.current) return;
      setLoading(false);
    }
  }, [symbol, expiry]);

  // ─── Fetch VIX from summary ──────────────────────────────────────
  const fetchVix = useCallback(async (gen: number) => {
    try {
      const params = new URLSearchParams({ symbol });
      if (expiry) params.set("expiry", expiry);
      const res = await fetch(`/api/option-chain?${params}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && gen === fetchGenRef.current) setVix(json.data?.summary?.indiaVIX || 0);
      }
    } catch {}
  }, [symbol, expiry]);

  // ─── Fetch AI recommendation ─────────────────────────────────────
  const fetchRec = useCallback(async (gen: number) => {
    try {
      const params = new URLSearchParams({ symbol });
      if (expiry) params.set("expiry", expiry);
      const res = await fetch(`/api/sdm-signal?${params}`);
      if (!res.ok) return;
      const json = await res.json();
      if (!json.success || !json.signal) return;
      if (gen !== fetchGenRef.current) return;
      const s = json.signal;
      const type = s.direction === "CALL" ? "CE" : s.direction === "PUT" ? "PE" : null;
      if (!type || !s.strike) return;
      setRec({
        action: s.direction === "CALL" ? "BUY_CALL" : "BUY_PUT",
        strike: s.strike,
        type,
        entry: s.entry || 0,
        sl: s.sl || 0,
        tp1: s.tp1 || 0,
        tp2: s.tp2 || 0,
        bias: s.marketContext?.trend || "NEUTRAL",
        rr: s.riskReward || 2,
        reason: s.reason || "",
        confidence: typeof s.confidence === "number" ? s.confidence : 0,
      });
    } catch {}
  }, [symbol, expiry]);

  // ─── Fetch trades ────────────────────────────────────────────────
  const fetchTrades = useCallback(async (gen: number) => {
    try {
      const res = await fetch(`/api/trade-journal?symbol=${symbol}`);
      if (!res.ok) return;
      const json = await res.json();
      if (gen !== fetchGenRef.current) return;
      setTrades((json.trades || []).slice(0, 20));
    } catch {}
  }, [symbol]);

  // ─── Initial + periodic fetch ────────────────────────────────────
  useEffect(() => {
    const gen = ++fetchGenRef.current;
    setLoading(true);
    setError(false);
    setErrorMsg("");
    setNotAvailable(false);
    setChain([]);
    setSpot(0);
    fetchChain(gen);
    fetchVix(gen);
    fetchRec(gen);
    fetchTrades(gen);
    const interval = setInterval(() => fetchChain(gen), 30000);
    const vixInterval = setInterval(() => fetchVix(gen), 60000);
    const recInterval = setInterval(() => fetchRec(gen), 120000);
    const tradesInterval = setInterval(() => fetchTrades(gen), 60000);
    return () => {
      clearInterval(interval);
      clearInterval(vixInterval);
      clearInterval(recInterval);
      clearInterval(tradesInterval);
    };
  }, [fetchChain, fetchVix, fetchRec, fetchTrades]);

  // ─── Clock ───────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const ist = getISTTime();
      setNow(ist.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
      setOpen(isMarketOpen());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // ─── Click outside dropdown ──────────────────────────────────────
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setInstDropdown(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  // ─── Derived data ────────────────────────────────────────────────
  const atmStrike = chain.find((r) => r.atm)?.strike || 0;
  const spotChange = 0; // Would need previous close

  const filteredInstruments = useMemo(() => {
    const q = instSearch.toUpperCase().trim();
    const filter = (list: typeof ALL_INSTRUMENTS) => q ? list.filter((i) => i.symbol.includes(q) || i.label.includes(q)) : list;
    return { indices: filter(INDEX_INSTRUMENTS), equity: filter(EQUITY_INSTRUMENTS) };
  }, [instSearch]);

  // ─── Zero Hero candidates ────────────────────────────────────────
  const zhCandidates = useMemo(() => {
    if (!isEligible) return [];
    const threshold = spot * 0.02;
    const nearStrikes = chain.filter((s) => Math.abs(s.strike - spot) <= threshold);
    // Chain-wide context computed ONCE (reuses sdm-oianalysis, gamma-blast, expiry-calculator)
    const ctx = analyzeZeroHeroChain(chain, spot, vix || 14, symbol);
    const lotSize = getInstrument(symbol)?.lotSize || 75;
    const list: ZHCandidate[] = [];
    for (const s of nearStrikes) {
      for (const type of ["CE", "PE"] as const) {
        const d = type === "CE" ? s.ce : s.pe;
        if (!d || d.ltp <= 0) continue;
        // Per-candidate evaluation via the consolidated engine
        const r = evaluateZeroHeroCandidate({
          strike: s.strike,
          type,
          ltp: d.ltp,
          delta: d.delta || 0,
          iv: d.iv || 15,
          oiChg: d.oiChg || 0,
          volume: d.vol || 0,
          spot,
          lotSize,
          capital: 100000,
          riskPerTradePercent: 2,
          maxPositionSize: 10,
          context: ctx,
        });
        list.push({ rank: 0, strike: s.strike, type, entry: d.ltp, sl: r.sl, tp1: r.tp1, tp2: r.tp2, rr: r.rr, prob: r.prob, conf: r.conf, stars: r.stars });
      }
    }
    list.sort((a, b) => b.conf - a.conf);
    return list.slice(0, 10).map((c, i) => ({ ...c, rank: i + 1 }));
  }, [chain, spot, isEligible, vix, symbol]);

  // ─── Record Zero Hero candidates into the Trade Audit (backtest) engine ─
  useEffect(() => {
    if (activeTab !== "zerohero" || !isEligible) return;
    const toRecord = zhCandidates
      .filter((z) => z.conf >= 60)
      .map((z) => ({
        strike: z.strike,
        type: z.type as "CE" | "PE",
        entry: z.entry,
        sl: z.sl,
        tp1: z.tp1,
        tp2: z.tp2,
        price: z.entry,
      }));
    if (toRecord.length) registerTrades("ZERO_HERO_AI", symbol, toRecord).catch(() => {});
    // M5: record the full scanner cycle as an AI-training row (every cycle).
    recordScannerCycle(symbol, "ZERO_HERO", zhCandidates).catch(() => {});
  }, [activeTab, isEligible, zhCandidates, symbol]);

  // ─── FII/DII flow from OI ───────────────────────────────────────
  const flowData = useMemo(() => {
    let totalCallOIChg = 0, totalPutOIChg = 0, totalCallVol = 0, totalPutVol = 0;
    for (const s of chain) {
      if (s.ce) { totalCallOIChg += s.ce.oiChg; totalCallVol += s.ce.vol; }
      if (s.pe) { totalPutOIChg += s.pe.oiChg; totalPutVol += s.pe.vol; }
    }
    const totalOIChg = Math.abs(totalCallOIChg) + Math.abs(totalPutOIChg);
    const ratio = totalOIChg > 0 ? (totalCallOIChg - totalPutOIChg) / totalOIChg : 0;
    const bias = ratio > 0.1 ? "BULLISH" : ratio < -0.1 ? "BEARISH" : "NEUTRAL";
    const strength = Math.round(50 + Math.abs(ratio) * 50);
    return { totalCallOIChg, totalPutOIChg, totalCallVol, totalPutVol, bias, strength, pcr };
  }, [chain, pcr]);

  // ─── Open trade modal ────────────────────────────────────────────
  function openTrade(strike: number, type: "CE" | "PE", ltp: number, rrOverride?: number) {
    const rr = rrOverride || 2;
    const slPct = 0.22;
    const sl = ltp * (1 - slPct);
    const tp1 = ltp * (1 + slPct);
    const tp2 = ltp * (1 + slPct * rr);
    setPendingTrade({ strike, type, ltp, sl, tp1, tp2, rr });
    setModalQty(1);
    setShowModal(true);
  }

  function executeBuy() {
    if (!pendingTrade) return;
    const p = pendingTrade;
    setPositions((prev) => [...prev, {
      id: Date.now(), sym: symbol, strike: p.strike, type: p.type,
      entry: p.ltp, ltp: p.ltp, lot: lotSize, qty: modalQty,
      sl: p.sl, tp1: p.tp1, tp2: p.tp2, rr: p.rr, time: new Date(),
    }]);
    setShowModal(false);
    setPendingTrade(null);
  }

  function closePosition(id: number) {
    setPositions((prev) => prev.filter((p) => p.id !== id));
  }

  const totalPnl = positions.reduce((s, p) => s + (p.ltp - p.entry) * p.qty * p.lot, 0);

  // ═══════ RENDER ═══════════════════════════════════════════════════
  return (
    <div className="flex h-full w-full bg-[#0a0e14] text-[#dfe6ee] overflow-hidden" style={{ fontFamily: "var(--sans, Inter, -apple-system, sans-serif)" }}>
      {/* ─── Sidebar ─── */}
      <div className="w-[64px] bg-[#10151d] border-r border-[#1f2733] flex flex-col items-center py-3.5 gap-1.5 shrink-0">
        <div className="text-lg font-extrabold text-[#2dd4a7] mb-3">Z</div>
        {TABS.map((tab) => (
          <div
            key={tab.id}
            className={`relative w-11 h-11 rounded-[10px] flex items-center justify-center cursor-pointer transition-all duration-150 ${
              activeTab === tab.id
                ? "bg-[rgba(45,212,167,.12)] text-[#2dd4a7]"
                : "text-[#7d8ba0] hover:bg-[#151b25] hover:text-[#dfe6ee]"
            }`}
            onClick={() => setActiveTab(tab.id)}
            onMouseEnter={() => setHoveredTab(tab.id)}
            onMouseLeave={() => setHoveredTab(null)}
          >
            {tab.icon}
            {hoveredTab === tab.id && (
              <div className="absolute left-[56px] bg-black/80 px-2 py-1 rounded-md text-[11px] whitespace-nowrap z-50 border border-[#1f2733]">
                {tab.label}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ─── Main Area ─── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* ─── Topbar ─── */}
        <div className="h-12 bg-[#10151d] border-b border-[#1f2733] flex items-center px-3.5 gap-2.5 shrink-0">
          {/* Instrument Dropdown */}
          <div className="relative" ref={ddRef}>
            <button
              className="bg-[#151b25] border border-[#1f2733] text-[#dfe6ee] px-2.5 py-1.5 rounded-lg font-mono text-[13px] font-semibold cursor-pointer flex items-center gap-2 hover:border-[#2dd4a7] transition-colors"
              onClick={() => setInstDropdown(!instDropdown)}
            >
              📊 <span>{inst?.label || symbol}</span> <ChevronDown size={12} />
            </button>
            {instDropdown && (
              <div className="absolute top-[36px] left-0 w-[260px] max-h-[340px] overflow-y-auto bg-[#141a24] border border-[#1f2733] rounded-lg z-[100] shadow-xl">
                <input
                  className="w-full px-2.5 py-2 bg-[#0d121a] border-b border-[#1f2733] text-[#dfe6ee] font-mono text-xs outline-none"
                  placeholder="Search instrument..."
                  value={instSearch}
                  onChange={(e) => setInstSearch(e.target.value)}
                  autoFocus
                />
                <div>
                  <div className="px-2.5 py-1 text-[9px] text-[#7d8ba0] uppercase tracking-wider font-bold">Indices</div>
                  {filteredInstruments.indices.map((i) => (
                    <div
                      key={i.symbol}
                      className="px-2.5 py-1.5 flex justify-between cursor-pointer font-mono text-[12.5px] hover:bg-[#151b25]"
                      onClick={() => { setSymbol(i.symbol); setExpiry(""); setInstDropdown(false); setInstSearch(""); }}
                    >
                      <span className="text-[#dfe6ee]">{i.label}</span>
                      <span className="text-[#7d8ba0]">Lot {i.lotSize}</span>
                    </div>
                  ))}
                  <div className="px-2.5 py-1 text-[9px] text-[#7d8ba0] uppercase tracking-wider font-bold border-t border-[#1f2733]">Equity</div>
                  {filteredInstruments.equity.map((i) => (
                    <div
                      key={i.symbol}
                      className="px-2.5 py-1.5 flex justify-between cursor-pointer font-mono text-[12.5px] hover:bg-[#151b25]"
                      onClick={() => { setSymbol(i.symbol); setExpiry(""); setInstDropdown(false); setInstSearch(""); }}
                    >
                      <span className="text-[#dfe6ee]">{i.label}</span>
                      <span className="text-[#7d8ba0]">Lot {i.lotSize}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Expiry Toggle */}
          <div className="flex bg-[#151b25] rounded-lg border border-[#1f2733] overflow-hidden">
            <button
              className={`px-3 py-1.5 text-xs font-semibold border-none cursor-pointer transition-colors ${
                expiryType === "weekly" ? "bg-[#2dd4a7] text-[#00251c]" : "bg-transparent text-[#7d8ba0]"
              }`}
              onClick={() => setExpiryType("weekly")}
            >
              Weekly
            </button>
            <button
              className={`px-3 py-1.5 text-xs font-semibold border-none cursor-pointer transition-colors ${
                expiryType === "monthly" ? "bg-[#2dd4a7] text-[#00251c]" : "bg-transparent text-[#7d8ba0]"
              }`}
              onClick={() => setExpiryType("monthly")}
            >
              Monthly
            </button>
          </div>

          {/* Market Tag */}
          <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${open ? "bg-[rgba(31,191,117,.15)] text-[#1fbf75]" : "bg-[rgba(242,73,92,.15)] text-[#f2495c]"}`}>
            ● {open ? "OPEN" : "CLOSED"}
          </span>

          <div className="font-mono text-xs text-[#7d8ba0] flex gap-1.5 items-center">
            VIX <b className="text-[#dfe6ee]">{vix > 0 ? vix.toFixed(1) : "—"}</b>
          </div>
          <div className="font-mono text-xs text-[#7d8ba0] flex gap-1.5 items-center">
            PCR <b className="text-[#dfe6ee]">{pcr.toFixed(2)}</b>
          </div>
          <div className="font-mono text-xs text-[#7d8ba0] flex gap-1.5 items-center">
            SPOT <b className="text-[#dfe6ee] px-2 py-0.5 bg-[#151b25] rounded-lg border border-[#1f2733] font-bold text-sm">{fmt(spot)}</b>
          </div>

          {positions.length > 0 && (
            <div className="font-mono text-xs text-[#7d8ba0] flex gap-1.5 items-center">
              DAY P&L <b className={`font-bold ${totalPnl >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>₹{fmtInt(totalPnl)}</b>
            </div>
          )}

          <div className="flex-1" />

          <div className="font-mono text-xs text-[#7d8ba0] flex items-center gap-1.5">
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            <span>{lastUpdate}</span>
          </div>
          <div className="font-mono text-xs text-[#7d8ba0]">{now}</div>
        </div>

        {/* ─── Workspace ─── */}
        <div className="flex-1 overflow-y-auto p-3.5">
          {activeTab === "overview" && (
            <OverviewTab
              chain={chain} spot={spot} atmStrike={atmStrike} maxPain={maxPain}
              flowData={flowData} zhCandidates={zhCandidates} isEligible={isEligible}
              lotSize={lotSize} symbol={symbol} expiryType={expiryType}
              openTrade={openTrade} loading={loading} error={error} errorMsg={errorMsg}
              notAvailable={notAvailable}
            />
          )}
          {activeTab === "options" && (
            <FullOptionChain chain={chain} spot={spot} atmStrike={atmStrike} openTrade={openTrade} />
          )}
          {activeTab === "zerohero" && (
            <FullZeroHero candidates={zhCandidates} isEligible={isEligible} symbol={symbol} expiryType={expiryType} openTrade={openTrade} />
          )}
          {activeTab === "smartmoney" && (
            <SmartMoneyTab flowData={flowData} chain={chain} spot={spot} vix={vix} pcr={pcr} maxPain={maxPain} candles={candles} openTrade={openTrade} symbol={symbol} setSymbol={setSymbol} />
          )}
          {activeTab === "greeks" && (
            <GreeksTab chain={chain} />
          )}
          {activeTab === "dom" && (
            <DOMTab symbol={symbol} />
          )}
          {activeTab === "history" && (
            <TradeHistoryTab trades={trades} />
          )}
          {activeTab === "watchlist" && (
            <WatchlistTab watchlist={watchlist} setWatchlist={setWatchlist} setSymbol={setSymbol} symbol={symbol} />
          )}
          {activeTab === "positions" && (
            <PositionsTab positions={positions} closePosition={closePosition} totalPnl={totalPnl} />
          )}
        </div>
      </div>

      {/* ─── Trade Modal ─── */}
      {showModal && pendingTrade && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]" onClick={() => setShowModal(false)}>
          <div className="bg-[#10151d] border border-[#1f2733] rounded-xl w-[380px] p-[18px] relative" onClick={(e) => e.stopPropagation()}>
            <div className="absolute top-3.5 right-4 cursor-pointer text-[#7d8ba0] text-lg" onClick={() => setShowModal(false)}>✕</div>
            <h3 className="mb-3.5 text-[15px] font-bold">Trade {pendingTrade.strike} {pendingTrade.type}</h3>
            {[
              ["LTP", `₹${fmt(pendingTrade.ltp)}`],
              ["Lot Size", lotSize],
              ["Quantity (lots)", null],
              ["Est. Margin", `₹${fmtInt(pendingTrade.ltp * modalQty * lotSize * 0.18 * 5)}`, "text-amber-400"],
              ["Stop Loss", `₹${fmt(pendingTrade.sl)}`, "text-red-400"],
              ["Target (TP1)", `₹${fmt(pendingTrade.tp1)}`, "text-emerald-400"],
              ["Target (TP2)", `₹${fmt(pendingTrade.tp2)}`, "text-emerald-400"],
              ["Risk : Reward", `1:${pendingTrade.rr}`, "text-[#4f8ff7]"],
            ].map(([label, value, color], i) => (
              <div key={i} className="flex justify-between mb-2.5 text-[12.5px] font-mono">
                <label className="text-[#7d8ba0]" style={{ fontFamily: "var(--sans)" }}>{label as string}</label>
                {value === null ? (
                  <input type="number" value={modalQty} min={1} onChange={(e) => setModalQty(parseInt(e.target.value) || 1)}
                    className="w-[100px] bg-[#151b25] border border-[#1f2733] text-[#dfe6ee] px-2 py-1.5 rounded-md font-mono text-right" />
                ) : (
                  <b style={{ color: color || "#dfe6ee" }}>{value as string}</b>
                )}
              </div>
            ))}
            <div className="flex gap-2 mt-4">
              <button className="flex-1 py-2.5 rounded-lg border-none font-bold cursor-pointer text-[13px] bg-[#151b25] text-[#7d8ba0] border border-[#1f2733]" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="flex-1 py-2.5 rounded-lg border-none font-bold cursor-pointer text-[13px] bg-[#1fbf75] text-[#04220f]" onClick={executeBuy}>BUY</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TAB COMPONENTS
// ═══════════════════════════════════════════════════════════════════

// ─── Overview Tab ──────────────────────────────────────────────────
function OverviewTab({ chain, spot, atmStrike, maxPain, flowData, zhCandidates, isEligible, lotSize, symbol, expiryType, openTrade, loading, error, errorMsg, notAvailable }: any) {
  if (loading) return <div className="text-[#7d8ba0] text-center py-10">Loading option chain data...</div>;
  if (error) return <div className="text-[#f2495c] text-center py-10"><div className="mb-2">Failed to load data</div>{errorMsg && <div className="text-[11px] text-[#7d8ba0] font-mono">{errorMsg}</div>}<div className="text-[11px] text-[#7d8ba0] mt-2">Retrying...</div></div>;

  return (
    <>
      {/* Row 1: Chain + Zero Hero mini */}
      <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-3.5 items-start">
        <div className="col-span-2 bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#1f2733] flex items-center justify-between font-bold text-[13px]">
            <span>Live Option Chain <span className="text-[#7d8ba0] font-mono text-[11px] ml-1">{symbol} {fmt(spot)}</span></span>
            <span className="text-[#7d8ba0] font-mono text-[11px]" style={{ color: "#2dd4a7" }}>👉 = AI-recommended strike</span>
          </div>
          <div className="p-2.5 overflow-y-auto" style={{ maxHeight: 420 }}>
{chain.length === 0 ? (
              <div className="text-[#e8a33d] text-center py-8 text-[12.5px]">
                <div className="mb-1 font-bold">No option chain data for {symbol}</div>
                <div className="text-[#7d8ba0] text-[11px]">Spot: ₹{fmt(spot)}</div>
                <div className="text-[#7d8ba0] text-[11px] mt-1">
                  {notAvailable
                    ? 'This symbol has no live option chain data source available.'
                    : symbol === 'SENSEX'
                    ? 'SENSEX derivatives not available via ICICI Breeze API (BFO segment). Spot from Yahoo Finance.'
                    : symbol === 'BANKEX'
                    ? 'BANKEX not available via any current data source.'
                    : 'Option chain not available via current data sources for this symbol.'}
                </div>
              </div>
            ) : (
              <OptionChainTable chain={chain} atmStrike={atmStrike} openTrade={openTrade} />
            )}
          </div>
        </div>
        <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#1f2733] flex items-center justify-between font-bold text-[13px]">
            <span>🔥 Zero Hero Scanner</span>
            <span className="text-[#7d8ba0] font-mono text-[11px]">{isEligible ? "Top 5" : "All stocks (BTST)"}</span>
          </div>
          <div className="p-2.5 overflow-y-auto" style={{ maxHeight: 420 }}>
            {!isEligible ? (
              <div className="text-[#7d8ba0] text-center py-8 text-[12.5px]">Zero Hero BTST scans all stocks. Switch to an F&O instrument for weekly/monthly expiry trades.</div>
            ) : zhCandidates.slice(0, 5).map((z: ZHCandidate, idx: number) => (
              <div key={idx} className="flex justify-between items-center py-1.5 border-b border-[#1f2733] font-mono text-[11.5px] cursor-pointer hover:bg-[#151b25] px-1"
                onClick={() => openTrade(z.strike, z.type, z.entry, z.rr)}>
                <span>{idx + 1}. {fmtInt(z.strike)} <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${z.type === "CE" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" : "bg-[rgba(242,73,92,.18)] text-[#f2495c]"}`}>{z.type}</span></span>
                <span className="text-[#1fbf75]">₹{fmt(z.entry)}</span>
                <span className={`px-1.5 py-0.5 rounded font-bold text-[10.5px] ${z.rr >= 3 ? "bg-[rgba(45,212,167,.18)] text-[#2dd4a7]" : z.rr >= 2 ? "bg-[rgba(79,143,247,.18)] text-[#4f8ff7]" : "bg-[rgba(125,139,160,.2)] text-[#7d8ba0]"}`}>1:{z.rr}</span>
                <StarRating count={z.stars} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Row 2: FII/DII + OI */}
      <div className="grid grid-cols-2 gap-3.5 mt-3.5">
        <FIIFlowPanel flowData={flowData} />
        <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#1f2733] flex items-center justify-between font-bold text-[13px]">
            <span>OI Distribution</span>
            <span className="text-[#7d8ba0] font-mono text-[11px]">Max Pain <b className="text-[#e8a33d]">{maxPain ? fmtInt(maxPain) : "—"}</b></span>
          </div>
          <div className="p-2.5">
            <OIDistribution chain={chain} maxPain={maxPain} />
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Option Chain Table ────────────────────────────────────────────
function OptionChainTable({ chain, atmStrike, openTrade, rec }: { chain: ChainRow[]; atmStrike: number; openTrade: (strike: number, type: "CE" | "PE", ltp: number) => void; rec?: TradeRec | null }) {
  return (
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
        {chain.map((r) => {
          const isRecCE = rec?.strike === r.strike && rec?.type === "CE";
          const isRecPE = rec?.strike === r.strike && rec?.type === "PE";
          return (
            <tr key={r.strike} className={`${r.atm ? "bg-[rgba(232,163,61,.08)]" : ""} border-b border-[#1f2733]`}>
              <td className="text-right py-1.5 px-1">{r.ce ? (r.ce.oi >= 1000 ? (r.ce.oi / 1000).toFixed(0) + "K" : r.ce.oi) : "—"}</td>
              <td className={`text-right py-1.5 px-1 ${r.ce && r.ce.oiChg > 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>{r.ce ? (r.ce.oiChg > 0 ? "+" : "") + (Math.abs(r.ce.oiChg) >= 1000 ? (r.ce.oiChg / 1000).toFixed(1) + "K" : r.ce.oiChg) : "—"}</td>
              <td className="text-right py-1.5 px-1">{r.ce ? (r.ce.vol >= 1000 ? (r.ce.vol / 1000).toFixed(0) + "K" : r.ce.vol) : "—"}</td>
              <td className="text-right py-1.5 px-1">{r.ce?.iv?.toFixed(1) || "—"}</td>
              <td className="text-right py-1.5 px-1">{r.ce?.delta?.toFixed(2) || "—"}</td>
              <td className="text-right py-1.5 px-1"><MoneyTag strike={r.strike} atmStrike={atmStrike} side="CE" /></td>
              <td className={`text-right py-1.5 px-1 cursor-pointer font-semibold ${isRecCE ? "bg-[rgba(45,212,167,.1)] outline outline-[1.5px] outline-[#2dd4a7] rounded font-bold" : "text-[#1fbf75]"}`}
                onClick={() => r.ce && openTrade(r.strike, "CE", r.ce.ltp)}>
                {isRecCE ? "👉 " : ""}₹{r.ce ? fmt(r.ce.ltp) : "—"}
              </td>
              <td className={`text-center py-1.5 px-1 font-bold ${r.atm ? "text-[#e8a33d]" : "text-[#dfe6ee]"}`}>{fmtInt(r.strike)}</td>
              <td className={`text-left py-1.5 px-1 cursor-pointer font-semibold ${isRecPE ? "bg-[rgba(45,212,167,.1)] outline outline-[1.5px] outline-[#2dd4a7] rounded font-bold" : "text-[#f2495c]"}`}
                onClick={() => r.pe && openTrade(r.strike, "PE", r.pe.ltp)}>
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
  );
}

// ─── Full Option Chain ─────────────────────────────────────────────
function FullOptionChain({ chain, spot, atmStrike, openTrade }: any) {
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] flex items-center justify-between font-bold text-[13px]">
        <span>Live Option Chain — Full <span className="text-[#7d8ba0] font-mono text-[11px] ml-1">{fmt(spot)}</span></span>
        <span className="text-[#7d8ba0] font-mono text-[11px]" style={{ color: "#2dd4a7" }}>👉 = AI-recommended strike</span>
      </div>
      <div className="p-2.5 overflow-y-auto" style={{ maxHeight: "76vh" }}>
        <OptionChainTable chain={chain} atmStrike={atmStrike} openTrade={openTrade} />
      </div>
    </div>
  );
}

// ─── Full Zero Hero ────────────────────────────────────────────────
function FullZeroHero({ candidates, isEligible, symbol, expiryType, openTrade }: any) {
  if (!isEligible) return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">🎯 Zero Hero Scanner — Full</div>
      <div className="p-4 text-[#7d8ba0] text-center py-10">Zero Hero covers all F&O instruments (weekly/monthly expiry) + BTST for all stocks. Switch instrument to view.</div>
    </div>
  );

  const exp = getStandardizedExpiry(symbol);
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] flex items-center justify-between font-bold text-[13px]">
        <span>🎯 Zero Hero Scanner — Full</span>
        <span className="text-[#7d8ba0] font-mono text-[11px]">
          {symbol} · {expiryType} · sorted by confidence
          {exp && (
            <span className="ml-2 text-[#e8a33d]">
              {exp.expiry_mode} · {exp.expiry_date} ({exp.expiry_type}) · L{exp.lot_size}
            </span>
          )}
        </span>
      </div>
      <div className="p-2.5">
        <div className="grid grid-cols-[.5fr_1.2fr_.6fr_1fr_1fr_1fr_.8fr_.6fr] gap-1.5 items-center py-2 border-b border-[#1f2733] text-[10px] text-[#7d8ba0] uppercase font-bold">
          <div>#</div><div>Strike / Type</div><div>Entry</div><div>TP1 / TP2</div><div>SL</div><div>Target</div><div>R:R</div><div>Conf</div>
        </div>
        {candidates.map((z: ZHCandidate, idx: number) => (
          <div key={idx}
            className="grid grid-cols-[.5fr_1.2fr_.6fr_1fr_1fr_1fr_.8fr_.6fr] gap-1.5 items-center py-2 border-b border-[#1f2733] font-mono text-[11.5px] cursor-pointer hover:bg-[#151b25]"
            onClick={() => openTrade(z.strike, z.type, z.entry, z.rr)}>
            <div>{idx + 1}</div>
            <div>{fmtInt(z.strike)} <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${z.type === "CE" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" : "bg-[rgba(242,73,92,.18)] text-[#f2495c]"}`}>{z.type}</span></div>
            <div className="text-[#1fbf75]">₹{fmt(z.entry)}</div>
            <div>₹{fmt(z.tp1)} / ₹{fmt(z.tp2)}</div>
            <div className="text-[#f2495c]">₹{fmt(z.sl)}</div>
            <div>{z.prob}%</div>
            <div><span className={`px-1.5 py-0.5 rounded font-bold text-[10.5px] ${z.rr >= 3 ? "bg-[rgba(45,212,167,.18)] text-[#2dd4a7]" : z.rr >= 2 ? "bg-[rgba(79,143,247,.18)] text-[#4f8ff7]" : "bg-[rgba(125,139,160,.2)] text-[#7d8ba0]"}`}>1:{z.rr}</span></div>
            <div><StarRating count={z.stars} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── FII Flow Panel ────────────────────────────────────────────────
function FIIFlowPanel({ flowData }: { flowData: any }) {
  const { totalCallOIChg, totalPutOIChg, bias, strength } = flowData;
  const bearish = bias === "BEARISH";
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] flex items-center justify-between font-bold text-[13px]">
        <span>FII / DII Flow</span>
        <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${bearish ? "bg-[rgba(242,73,92,.18)] text-[#f2495c]" : "bg-[rgba(31,191,117,.18)] text-[#1fbf75]"}`}>{bias}</span>
      </div>
      <div className="p-3">
        <div className="text-[11px] text-[#7d8ba0] mb-1">Call OI Change</div>
        <div className="h-2.5 rounded-md bg-[#151b25] overflow-hidden mb-1">
          <div className="h-full rounded-md" style={{
            width: `${Math.min(100, Math.abs(totalCallOIChg) / 200000 * 100)}%`,
            background: totalCallOIChg >= 0 ? "#1fbf75" : "#f2495c",
          }} />
        </div>
        <div className={`font-mono font-bold text-[12px] mb-3 ${totalCallOIChg >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
          {totalCallOIChg >= 0 ? "+" : ""}{fmt(totalCallOIChg)}
        </div>
        <div className="text-[11px] text-[#7d8ba0] mb-1">Put OI Change</div>
        <div className="h-2.5 rounded-md bg-[#151b25] overflow-hidden mb-1">
          <div className="h-full rounded-md" style={{
            width: `${Math.min(100, Math.abs(totalPutOIChg) / 200000 * 100)}%`,
            background: totalPutOIChg >= 0 ? "#1fbf75" : "#f2495c",
          }} />
        </div>
        <div className={`font-mono font-bold text-[12px] ${totalPutOIChg >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
          {totalPutOIChg >= 0 ? "+" : ""}{fmt(totalPutOIChg)}
        </div>
        <div className="flex gap-3 mt-3 text-[11px] text-[#7d8ba0]">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#f2495c] inline-block" /> Selling</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#1fbf75] inline-block" /> Buying</span>
        </div>
      </div>
    </div>
  );
}

// ─── OI Distribution ───────────────────────────────────────────────
function OIDistribution({ chain, maxPain }: { chain: ChainRow[]; maxPain: number }) {
  const maxOi = Math.max(...chain.map((r) => Math.max(r.ce?.oi || 0, r.pe?.oi || 0)), 1);
  return (
    <div className="flex items-end gap-px" style={{ height: 180 }}>
      {chain.map((r) => {
        const ceH = ((r.ce?.oi || 0) / maxOi) * 80;
        const peH = ((r.pe?.oi || 0) / maxOi) * 80;
        const isMP = r.strike === maxPain;
        return (
          <div key={r.strike} className="flex-1 flex flex-col items-center relative" style={{ height: "100%" }}>
            <div className="absolute" style={{ bottom: "50%", left: 0, right: 0, display: "flex", justifyContent: "center" }}>
              <div className="w-full max-w-[16px] rounded-t-sm" style={{ height: ceH, background: "#1fbf75cc" }} />
            </div>
            <div className="absolute" style={{ top: "50%", left: 0, right: 0, display: "flex", justifyContent: "center" }}>
              <div className="w-full max-w-[16px] rounded-b-sm" style={{ height: peH, background: "#f2495ccc" }} />
            </div>
            {isMP && <div className="absolute inset-0 border-l border-r border-[#e8a33d] pointer-events-none" />}
            <div className="absolute bottom-0 text-[9px] text-[#7d8ba0] font-mono">{String(r.strike).slice(-3)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Greeks Tab ────────────────────────────────────────────────────
function GreeksTab({ chain }: { chain: ChainRow[] }) {
  const metrics = ["IV", "Delta", "Theta", "Gamma", "Vega"] as const;
  function greekColor(val: number, max: number) {
    const t = Math.max(-1, Math.min(1, val / max));
    if (t >= 0) {
      const g = Math.round(191 * t + 40 * (1 - t));
      return `rgba(31,${g},117,${0.25 + 0.55 * Math.abs(t)})`;
    } else {
      const r = Math.round(242 * Math.abs(t) + 40 * (1 - Math.abs(t)));
      return `rgba(${r},73,92,${0.25 + 0.55 * Math.abs(t)})`;
    }
  }
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Greek Heatmap <span className="text-[#7d8ba0] font-mono text-[11px]">ATM ± 8 strikes</span></div>
      <div className="p-3 overflow-x-auto">
        <div style={{ display: "flex" }}>
          <div style={{ width: 50 }} />
          {chain.map((r) => (
            <div key={r.strike} style={{ width: 56, textAlign: "center", fontSize: 10, color: r.atm ? "#e8a33d" : "#7d8ba0", fontFamily: "var(--mono)", fontWeight: r.atm ? 700 : 400 }}>
              {r.atm ? "ATM" : String(r.strike).slice(-3)}
            </div>
          ))}
        </div>
        {metrics.map((metric) => (
          <div key={metric} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
            <div style={{ width: 50, fontSize: 10.5, color: "#7d8ba0", textAlign: "right", paddingRight: 6 }}>{metric}</div>
            {chain.map((r) => {
              const d = metric === "CE" ? r.ce : r.pe;
              let v = 0, disp = "—";
              if (metric === "IV") { v = (d?.iv || 0) - 18; disp = (d?.iv || 0).toFixed(1); }
              if (metric === "Delta") { v = (d?.delta || 0) - 0.5; disp = (d?.delta || 0).toFixed(2); }
              if (metric === "Theta") { v = -(d?.theta || 0); disp = v.toFixed(2); }
              if (metric === "Gamma") { v = d?.gamma || 0; disp = Math.abs(v).toFixed(3); }
              if (metric === "Vega") { v = d?.vega || 0; disp = Math.abs(v).toFixed(2); }
              return (
                <div key={r.strike} style={{ width: 56, height: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontFamily: "var(--mono)", borderRadius: 3, background: greekColor(v, metric === "IV" ? 10 : metric === "Delta" ? 0.5 : 1) }}>
                  {disp}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

interface DOMData {
  spot: number;
  atmStrike: number;
  pcr: number;
  maxPain: number;
  resistance: number[];
  support: number[];
  unusualBuildup: any[];
  strikes: any[];
  timestamp: string;
}

function DOMTab({ symbol }: { symbol: string }) {
  const [data, setData] = useState<DOMData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function fetchDOM() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/dom-analysis?symbol=${symbol}`);
        const json = await res.json();
        if (mounted && json.success && json.data) {
          setData(json.data);
        } else if (mounted) {
          setError(json.error || 'Failed to fetch DOM data');
        }
      } catch (e: any) {
        if (mounted) setError(e.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    fetchDOM();
    return () => { mounted = false; };
  }, [symbol]);

  const fmtInt = (n: number) => Math.round(n || 0).toLocaleString('en-IN');
  const fmt = (n: number, d = 2) => (n == null || isNaN(n)) ? '0' : n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

  if (loading) return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">DOM Analysis</div>
      <div className="p-6 text-center text-[#7d8ba0]">Loading DOM analysis...</div>
    </div>
  );

  if (error) return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">DOM Analysis</div>
      <div className="p-6 text-center text-[#f2495c]">{error}</div>
    </div>
  );

  if (!data) return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">DOM Analysis</div>
      <div className="p-6 text-center text-[#7d8ba0]">No DOM data available</div>
    </div>
  );

  const spot = data.spot;

  return (
    <div className="space-y-3">
      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px] flex items-center justify-between">
          <span>DOM Analysis — {symbol}</span>
          <span className="text-[#7d8ba0] font-mono text-[11px]">NSE Equity Derivatives</span>
        </div>
        <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <div className="bg-[#0a1018] rounded p-2"><div className="text-[#7d8ba0]">Spot</div><div className="font-bold text-[#e8a33d]">₹{fmt(spot)}</div></div>
          <div className="bg-[#0a1018] rounded p-2"><div className="text-[#7d8ba0]">PCR</div><div className="font-bold text-[#1fbf75]">{fmt(data.pcr, 2)}</div></div>
          <div className="bg-[#0a1018] rounded p-2"><div className="text-[#7d8ba0]">Max Pain</div><div className="font-bold text-[#4f8ff7]">{fmtInt(data.maxPain)}</div></div>
          <div className="bg-[#0a1018] rounded p-2"><div className="text-[#7d8ba0]">ATM Strike</div><div className="font-bold text-[#e8a33d]">{fmtInt(data.atmStrike)}</div></div>
        </div>
      </div>

      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Unusual OI Buildup <span className="text-[#7d8ba0] font-mono text-[11px]">Threshold: 50K OI change</span></div>
        <div className="p-2.5 overflow-x-auto">
          {data.unusualBuildup?.length ? (
            <table className="w-full border-collapse font-mono text-[12px]">
              <thead>
                <tr>
                  {["Strike", "Type", "OI Chg", "Volume", "LTP", "Interpretation"].map((h) => (
                    <th key={h} className={`text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase ${h === "Interpretation" ? "text-left" : "text-right"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.unusualBuildup.slice(0, 10).map((u: any, i: number) => (
                  <tr key={i} className="border-b border-[#1f2733] hover:bg-[#151b25]">
                    <td className="text-left py-1.5 px-1 font-bold text-[#e8a33d]">{fmtInt(u.strike)}</td>
                    <td className="text-right py-1.5 px-1"><span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${u.type === "CE" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" : "bg-[rgba(242,73,92,.18)] text-[#f2495c]"}`}>{u.type}</span></td>
                    <td className={`text-right py-1.5 px-1 ${u.oiChg < 0 ? "text-[#f2495c]" : "text-[#1fbf75]"}`}>{u.oiChg > 0 ? "+" : ""}{Math.abs(u.oiChg) >= 1000 ? (u.oiChg / 1000).toFixed(1) + "K" : u.oiChg}</td>
                    <td className="text-right py-1.5 px-1">{u.volume >= 1000 ? (u.volume / 1000).toFixed(0) + "K" : u.volume}</td>
                    <td className="text-right py-1.5 px-1 text-[#1fbf75]">₹{fmt(u.ltp)}</td>
                    <td className="text-left py-1.5 px-1 text-[#7d8ba0]">{u.interpretation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-6 text-[#7d8ba0] text-[12px]">No unusual OI buildup detected (threshold: 50K)</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px] flex items-center gap-2">
            <Shield className="size-4 text-[#f2495c]" /><span>Resistance (Call OI Walls)</span>
          </div>
          <div className="p-3">
            {data.resistance?.length ? (
              data.resistance.map((r: number, i: number) => (
                <div key={i} className="flex justify-between py-1 border-b border-[#1f2733] last:border-0 font-mono text-[12px]">
                  <span className="text-[#e8a33d]">{fmtInt(r)}</span><span className="text-[#f2495c]">CE OI</span>
                </div>
              ))
            ) : (
              <div className="text-center py-4 text-[#7d8ba0] text-[12px]">No resistance levels</div>
            )}
          </div>
        </div>
        <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px] flex items-center gap-2">
            <Target className="size-4 text-[#1fbf75]" /><span>Support (Put OI Walls)</span>
          </div>
          <div className="p-3">
            {data.support?.length ? (
              data.support.map((s: number, i: number) => (
                <div key={i} className="flex justify-between py-1 border-b border-[#1f2733] last:border-0 font-mono text-[12px]">
                  <span className="text-[#e8a33d]">{fmtInt(s)}</span><span className="text-[#1fbf75]">PE OI</span>
                </div>
              ))
            ) : (
              <div className="text-center py-4 text-[#7d8ba0] text-[12px]">No support levels</div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Full Option Chain (ATM ± 10)</div>
        <div className="p-2.5 overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead>
              <tr>
                {["Strike", "CE OI", "CE Chg", "CE Vol", "CE LTP", "PE OI", "PE Chg", "PE Vol", "PE LTP"].map((h) => (
                  <th key={h} className="text-[#7d8ba0] font-semibold py-1 px-1 text-[10px] uppercase text-right">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.strikes
                .filter((s: any) => Math.abs(s.strike - spot) <= 1000)
                .slice(-21)
                .map((s: any) => {
                  const ce = s.ce || {};
                  const pe = s.pe || {};
                  return (
                    <tr key={s.strike} className={`border-b border-[#1f2733] ${s.strike === data.atmStrike ? "bg-[rgba(232,163,61,.08)]" : ""}`}>
                      <td className={`text-right py-1 px-1 font-bold ${s.strike === data.atmStrike ? "text-[#e8a33d]" : "text-[#dfe6ee]"}`}>
                        {fmtInt(s.strike)}{s.strike === data.atmStrike && <span className="text-[9px] ml-1 bg-amber-500/20 text-amber-400 px-1 rounded">ATM</span>}
                      </td>
                      <td className="text-right py-1 px-1 text-[#1fbf75]">{fmtInt(ce.oi)}</td>
                      <td className={`text-right py-1 px-1 ${(ce.oiChg || 0) < 0 ? "text-[#f2495c]" : "text-[#1fbf75]"}`}>{ce.oiChg > 0 ? "+" : ""}{fmtInt(ce.oiChg || 0)}</td>
                      <td className="text-right py-1 px-1 text-[#7d8ba0]">{ce.volume >= 1000 ? (ce.volume / 1000).toFixed(0) + "K" : fmtInt(ce.volume)}</td>
                      <td className="text-right py-1 px-1 text-[#1fbf75]">₹{fmt(ce.ltp)}</td>
                      <td className="text-right py-1 px-1 text-[#f2495c]">{fmtInt(pe.oi)}</td>
                      <td className={`text-right py-1 px-1 ${(pe.oiChg || 0) < 0 ? "text-[#f2495c]" : "text-[#1fbf75]"}`}>{pe.oiChg > 0 ? "+" : ""}{fmtInt(pe.oiChg || 0)}</td>
                      <td className="text-right py-1 px-1 text-[#7d8ba0]">{pe.volume >= 1000 ? (pe.volume / 1000).toFixed(0) + "K" : fmtInt(pe.volume)}</td>
                      <td className="text-right py-1 px-1 text-[#f2495c]">₹{fmt(pe.ltp)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Smart Money Tab ───────────────────────────────────────────────
function SmartMoneyTab({ flowData, chain, spot, vix, pcr, maxPain, candles, openTrade, symbol: activeSymbol, setSymbol }: any) {
  // ─── SMC Engine results ─────────────────────────────────────────
  const smcResult = useMemo(() => {
    if (!chain.length || !spot) return null;
    try {
      const sdmChain = chainToSDMStrikes(chain);
      return runSMCAnalysis({
        symbol: activeSymbol,
        spot,
        optionChain: sdmChain,
        candles: candles as any[] | undefined,
        vix: vix || undefined,
      });
    } catch {
      return null;
    }
  }, [chain, spot, candles, vix, activeSymbol]);

  const smcCandidates = smcResult?.candidates || [];
  const marketStructure = smcResult?.marketStructure;
  const analysis = smcResult?.analysis;

  // ─── Render helpers ─────────────────────────────────────────────
  function renderCandTable() {
    if (!smcCandidates.length) return null;
    const h = ["Strike", "Type", "Confidence", "Entry", "SL", "TP1", "TP2", "TP3", "R:R", "Grade", "Sizing"];
    return (
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead>
          <tr>
            {h.map(hh => (
              <th key={hh} className={`text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase ${hh === "Strike" || hh === "Grade" || hh === "Sizing" ? "text-left" : "text-right"}`}>{hh}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {smcCandidates.map((c: any, i: number) => (
            <tr key={i} className="border-b border-[#1f2733] cursor-pointer hover:bg-[#151b25]" onClick={() => openTrade(c.strike, c.type, c.entry, c.rr)}>
              <td className="text-left py-1.5 px-1 font-bold text-[#e8a33d]">{fmtInt(c.strike)}</td>
              <td className="text-right py-1.5 px-1"><span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${c.type === "CE" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" : "bg-[rgba(242,73,92,.18)] text-[#f2495c]"}`}>{c.type}</span></td>
              <td className="text-right py-1.5 px-1">
                <span className={`px-1.5 py-0.5 rounded font-bold text-[10.5px] ${
                  c.confidence >= 90 ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" :
                  c.confidence >= 80 ? "bg-[rgba(79,143,247,.18)] text-[#4f8ff7]" :
                  c.confidence >= 70 ? "bg-[rgba(232,163,61,.18)] text-[#e8a33d]" :
                  "bg-[rgba(242,73,92,.18)] text-[#f2495c]"
                }`}>{c.confidence}%</span>
              </td>
              <td className="text-right py-1.5 px-1 text-[#1fbf75]">₹{fmt(c.entry)}</td>
              <td className="text-right py-1.5 px-1 text-[#f2495c]">₹{fmt(c.sl)}</td>
              <td className="text-right py-1.5 px-1">₹{fmt(c.tp1)}</td>
              <td className="text-right py-1.5 px-1">{c.tp2 ? "₹"+fmt(c.tp2) : "—"}</td>
              <td className="text-right py-1.5 px-1">{c.tp3 ? "₹"+fmt(c.tp3) : "—"}</td>
              <td className="text-right py-1.5 px-1"><span className="px-1.5 py-0.5 rounded font-bold text-[10.5px] bg-[rgba(79,143,247,.18)] text-[#4f8ff7]">1:{c.rr?.toFixed(1)}</span></td>
              <td className="text-left py-1.5 px-1">
                <span className={`px-1.5 py-0.5 rounded font-bold text-[10.5px] ${
                  c.qualityGrade === "A+" ? "bg-[rgba(212,175,55,.25)] text-[#d4af37]" :
                  c.qualityGrade === "A" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" :
                  c.qualityGrade === "B" ? "bg-[rgba(79,143,247,.18)] text-[#4f8ff7]" :
                  c.qualityGrade === "C" ? "bg-[rgba(232,163,61,.18)] text-[#e8a33d]" :
                  "bg-[rgba(242,73,92,.18)] text-[#f2495c]"
                }`}>{c.qualityGrade}</span>
              </td>
              <td className="text-left py-1.5 px-1 text-[#7d8ba0] text-[10px]">
                {c.positionSize?.lots ? `${c.positionSize.lots}L (₹${fmtInt(c.positionSize.maxLoss)} risk)` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function renderDetails() {
    if (!marketStructure || !analysis) return null;
    return (
      <div className="grid grid-cols-3 gap-2 mt-2 text-[11px]">
        <div className="bg-[#0c111a] rounded p-2">
          <div className="font-bold mb-1 text-[#2dd4a7]">Market Structure</div>
          <div><span className="text-[#7d8ba0]">Trend:</span> <span className={marketStructure.trend === "BULLISH" ? "text-[#1fbf75]" : "text-[#f2495c]"}>{marketStructure.trend}</span></div>
          <div><span className="text-[#7d8ba0]">BOS:</span> {marketStructure.bos ? "✓" : "✗"}</div>
          <div><span className="text-[#7d8ba0]">CHoCH:</span> {marketStructure.choch ? "✓" : "✗"}</div>
          <div><span className="text-[#7d8ba0]">Liq Sweep:</span> {marketStructure.liquiditySweep ? "✓" : "✗"}</div>
          <div><span className="text-[#7d8ba0]">OB count:</span> {marketStructure.orderBlocks?.length || 0}</div>
          <div><span className="text-[#7d8ba0]">FVG count:</span> {marketStructure.fvgs?.length || 0}</div>
        </div>
        <div className="bg-[#0c111a] rounded p-2">
          <div className="font-bold mb-1 text-[#e8a33d]">Scores</div>
          <div><span className="text-[#7d8ba0]">ATR:</span> ₹{fmt(analysis.atr)}</div>
          <div><span className="text-[#7d8ba0]">VWAP:</span> ₹{fmt(analysis.vwap)}</div>
          <div><span className="text-[#7d8ba0]">PCR:</span> {analysis.pcr?.toFixed(2)}</div>
          <div><span className="text-[#7d8ba0]">Confidence:</span> <span className={analysis.confidence >= (analysis.minConfidence || 75) ? "text-[#1fbf75]" : "text-[#e8a33d]"}>{analysis.confidence}%</span></div>
          <div><span className="text-[#7d8ba0]">Min Conf:</span> <span className="text-[#4f8ff7]">{analysis.minConfidence}%</span></div>
          <div><span className="text-[#7d8ba0]">Trend Score:</span> {analysis.trendScore}/100</div>
        </div>
        <div className="bg-[#0c111a] rounded p-2">
          <div className="font-bold mb-1 text-[#a78bfa]">India Context</div>
          <div><span className="text-[#7d8ba0]">Regime:</span> <span className="text-[#4f8ff7]">{analysis.regime}</span></div>
          <div><span className="text-[#7d8ba0]">VIX:</span> <span className={analysis.vixRegime === "EXTREME" ? "text-[#f2495c]" : "text-[#e8a33d]"}>{analysis.vixRegime}</span></div>
          <div><span className="text-[#7d8ba0]">OI Signal:</span> <span className={analysis.oiSignal === "BUILDUP" ? "text-[#1fbf75]" : "text-[#7d8ba0]"}>{analysis.oiSignal}</span></div>
          <div><span className="text-[#7d8ba0]">PCR Trend:</span> {analysis.pcrTrend}</div>
          <div><span className="text-[#7d8ba0]">DTE:</span> {analysis.daysToExpiry}d</div>
          <div><span className="text-[#7d8ba0]">Max Pain:</span> ₹{fmtInt(analysis.maxPain)}</div>
        </div>
      </div>
    );
  }

  // ─── Auto-register candidates ──────────────────────────────────
  const registeredRef = useRef(false);
  useEffect(() => {
    if (registeredRef.current) return;
    if (!smcCandidates.length) return;
    registeredRef.current = true;
    registerTrades("SMART_MONEY", activeSymbol, smcCandidates).catch(() => {});
    recordScannerCycle(activeSymbol, "SMART_MONEY", smcCandidates.map((c: any) => ({
      strike: c.strike, type: c.type, entry: c.entry, sl: c.sl,
      tp1: c.tp1, tp2: c.tp2, conf: c.confidence, price: c.entry,
    }))).catch(() => {});
  }, [smcCandidates, activeSymbol]);

  return (
    <div className="space-y-3.5">
      <FIIFlowPanel flowData={flowData} />
      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px] flex items-center justify-between">
          <div>Smart Money Scanner <span className="text-[#7d8ba0] font-mono text-[11px]">SMC India Edition</span></div>
          <div className="flex items-center gap-2">
            {smcResult?.rejected && (
              <span className="text-[#e8a33d] text-[10px] font-mono">{smcResult.rejectionReasons?.join(", ")}</span>
            )}
          </div>
        </div>
        <div className="p-2.5 overflow-x-auto">
          {!smcCandidates.length ? (
            <div className="text-center py-6 text-[#7d8ba0] text-[12px]">
              <div className="font-bold text-[#e8a33d] mb-1">No SMC Candidates</div>
              <div>Insufficient data to generate SMC signals. Ensure option chain, candles, and spot price are available.</div>
            </div>
          ) : (
            <>
              {renderCandTable()}
              {renderDetails()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Trade History Tab ─────────────────────────────────────────────
function TradeHistoryTab({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Trade History</div>
      <div className="p-4 text-[#7d8ba0] text-center py-10">No trades recorded yet.</div>
    </div>
  );
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Trade History</div>
      <div className="p-2.5 overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              {["Date", "Sym", "Stk", "Type", "Entry", "Exit", "P&L", "St"].map((h) => (
                <th key={h} className={`text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase ${h === "Date" || h === "Sym" ? "text-left" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.tradeId} className="border-b border-[#1f2733] text-[11px]">
                <td className="text-left py-1.5 px-1 text-[#7d8ba0]">{new Date(t.entryTime).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</td>
                <td className="text-left py-1.5 px-1 font-bold">{t.symbol?.slice(0, 4)}</td>
                <td className="text-right py-1.5 px-1">{t.strike ? fmtInt(t.strike) : "—"}</td>
                <td className="text-right py-1.5 px-1"><span className={`text-[10.5px] font-bold px-1 py-0.5 rounded ${(t.optionType || t.direction)?.includes("CE") || t.direction?.includes("CALL") ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" : "bg-[rgba(242,73,92,.18)] text-[#f2495c]"}`}>{t.optionType || t.direction?.slice(-2) || "?"}</span></td>
                <td className="text-right py-1.5 px-1">₹{t.entryPrice?.toFixed(1) || "—"}</td>
                <td className="text-right py-1.5 px-1">{t.exitPrice ? "₹" + t.exitPrice.toFixed(1) : "—"}</td>
                <td className={`text-right py-1.5 px-1 font-bold ${(t.pnl ?? 0) > 0 ? "text-[#1fbf75]" : (t.pnl ?? 0) < 0 ? "text-[#f2495c]" : "text-[#7d8ba0]"}`}>{t.pnl != null ? (t.pnl > 0 ? "+" : "") + "₹" + t.pnl.toFixed(0) : "—"}</td>
                <td className="text-right py-1.5 px-1">{t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Watchlist Tab ─────────────────────────────────────────────────
function WatchlistTab({ watchlist, setWatchlist, setSymbol, symbol }: { watchlist: Set<string>; setWatchlist: (s: Set<string>) => void; setSymbol: (s: string) => void; symbol: string }) {
  const toggle = (sym: string) => {
    const next = new Set(watchlist);
    if (next.has(sym)) next.delete(sym); else next.add(sym);
    setWatchlist(next);
  };
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">⭐ Watchlist <span className="text-[#7d8ba0] font-mono text-[11px]">Click a row to switch instrument</span></div>
      <div className="p-2.5 overflow-y-auto" style={{ maxHeight: "78vh" }}>
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              {["Pin", "Instrument", "Lot", "Exchange"].map((h) => (
                <th key={h} className={`text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase ${h !== "Lot" ? "text-left" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...ALL_INSTRUMENTS].sort((a, b) => (watchlist.has(b.symbol) ? 1 : 0) - (watchlist.has(a.symbol) ? 1 : 0)).map((i) => {
              const active = i.symbol === symbol;
              return (
                <tr key={i.symbol} className={`border-b border-[#1f2733] cursor-pointer ${active ? "bg-[rgba(45,212,167,.08)]" : "hover:bg-[#151b25]"}`}
                  onClick={() => setSymbol(i.symbol)}>
                  <td className="text-left py-1.5 px-1" onClick={(e) => { e.stopPropagation(); toggle(i.symbol); }}>
                    <span style={{ color: watchlist.has(i.symbol) ? "#e8a33d" : "#7d8ba0", fontSize: 15 }}>{watchlist.has(i.symbol) ? "★" : "☆"}</span>
                  </td>
                  <td className="text-left py-1.5 px-1 font-medium" style={{ color: active ? "#2dd4a7" : "#dfe6ee" }}>{i.label}</td>
                  <td className="text-right py-1.5 px-1">{i.lotSize}</td>
                  <td className="text-left py-1.5 px-1 text-[#7d8ba0]">{i.exchange}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Positions Tab ─────────────────────────────────────────────────
function PositionsTab({ positions, closePosition, totalPnl }: { positions: any[]; closePosition: (id: number) => void; totalPnl: number }) {
  const winners = positions.filter((p) => p.ltp > p.entry).length;
  const losers = positions.filter((p) => p.ltp < p.entry).length;
  return (
    <div className="grid grid-cols-2 gap-3.5">
      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">💼 Open Positions <span className="text-[#7d8ba0] font-mono text-[11px]">{positions.length} open</span></div>
        <div className="p-2.5 overflow-x-auto">
          {positions.length === 0 ? (
            <div className="p-6 text-[#7d8ba0] text-center text-[12.5px]">No open positions. Buy from the option chain or Zero Hero scanner.</div>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px]">
              <thead>
                <tr>
                  {["Instrument", "Qty", "Entry", "LTP", "SL", "Target", "R:R", "P&L", ""].map((h) => (
                    <th key={h} className={`text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase ${h === "Instrument" ? "text-left" : "text-right"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pnl = (p.ltp - p.entry) * p.qty * p.lot;
                  return (
                    <tr key={p.id} className="border-b border-[#1f2733] text-[11px]">
                      <td className="text-left py-1.5 px-1">{p.sym} <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${p.type === "CE" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" : "bg-[rgba(242,73,92,.18)] text-[#f2495c]"}`}>{p.type}</span> {fmtInt(p.strike)}</td>
                      <td className="text-right py-1.5 px-1">{p.qty * p.lot}</td>
                      <td className="text-right py-1.5 px-1">₹{fmt(p.entry)}</td>
                      <td className={`text-right py-1.5 px-1 ${p.ltp >= p.entry ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>₹{fmt(p.ltp)}</td>
                      <td className="text-right py-1.5 px-1 text-[#f2495c]">₹{fmt(p.sl)}</td>
                      <td className="text-right py-1.5 px-1 text-[#1fbf75]">₹{fmt(p.tp1)}</td>
                      <td className="text-right py-1.5 px-1"><span className="px-1.5 py-0.5 rounded font-bold text-[10.5px] bg-[rgba(79,143,247,.18)] text-[#4f8ff7]">1:{p.rr}</span></td>
                      <td className={`text-right py-1.5 px-1 font-bold ${pnl < 0 ? "text-[#f2495c]" : "text-[#1fbf75]"}`}>₹{fmtInt(pnl)}</td>
                      <td className="text-right py-1.5 px-1">
                        <button className="px-2 py-0.5 rounded text-[11px] font-bold bg-[#151b25] text-[#7d8ba0] border border-[#1f2733] cursor-pointer" onClick={() => closePosition(p.id)}>Close</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
        <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">Day P&L Summary</div>
        <div className="p-3">
          <div className="text-center py-3">
            <div className="text-[#7d8ba0] text-[11px]">Unrealized P&L</div>
            <div className={`font-mono text-[26px] font-extrabold ${totalPnl < 0 ? "text-[#f2495c]" : "text-[#1fbf75]"}`}>₹{fmtInt(totalPnl)}</div>
          </div>
          <div className="flex justify-around text-center mt-2">
            <div><div className="text-[#7d8ba0] text-[11px]">Open</div><div className="font-mono font-bold">{positions.length}</div></div>
            <div><div className="text-[#7d8ba0] text-[11px]">In profit</div><div className="text-[#1fbf75] font-mono font-bold">{winners}</div></div>
            <div><div className="text-[#7d8ba0] text-[11px]">In loss</div><div className="text-[#f2495c] font-mono font-bold">{losers}</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}
