"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Home, Link2, Target, Wallet, Clock, Star,
  TrendingUp, TrendingDown, ChevronDown, Search, X, RefreshCw,
  Wifi, WifiOff, Zap, Activity, ArrowUpRight, ArrowDownRight,
  Building2, AlertTriangle, Brain, Shield, Minus, BarChart3,
  Flame, Trophy, Layers, CalendarClock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTerminalStore, INDEX_INSTRUMENTS, EQUITY_INSTRUMENTS, ALL_INSTRUMENTS } from "@/stores/useTerminalStore";
import { InstitutionalGreeksPanel } from "@/components/terminal/InstitutionalGreeksPanel";
import GreekFlowHeatmap from "@/components/terminal/GreekFlowHeatmap";
import EnhancedOptionChain from "@/components/terminal/EnhancedOptionChain";
import { getInstrument } from "@/stores/useTerminalStore";
import { isFNO, getExpiryTypeForDate, getStandardizedExpiry } from "@/lib/expiry-calculator";
import { ALL_SYMBOLS } from "@/lib/stockUniverse";
import { analyzeZeroHeroChain, evaluateZeroHeroCandidate } from "@/lib/zero-hero";
import { scoreTrade, withCandleContext, type MarketDataInput, type StrategyProfile } from "@/lib/unified-scoring-engine";
import { isFallingMarket } from "@/lib/technical-analysis";
import { getLotSize } from "@/lib/symbol-config";
import OptionsEdgePanel from "@/components/terminal/OptionsEdgePanel";
import MostActiveContracts from "@/components/terminal/MostActiveContracts";

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

type Tab = "overview" | "options" | "optionsedge" | "smartmoney" | "instgreeks" | "greekflow" | "dom" | "watchlist" | "ide" | "top5" | "mostactive" | "calculator";

const TABS: { id: Tab; icon: React.ReactNode; label: string }[] = [
  { id: "overview", icon: <Home size={19} />, label: "Overview" },
  { id: "options", icon: <Link2 size={19} />, label: "Option Chain" },
  { id: "optionsedge", icon: <Target size={19} />, label: "Options Edge" },
  { id: "smartmoney", icon: <Wallet size={19} />, label: "Smart Money" },
  { id: "instgreeks", icon: <Zap size={19} />, label: "Institutional Greeks" },
  { id: "greekflow", icon: <Flame size={19} />, label: "Greek Flow Heatmap" },
  { id: "dom", icon: <BarChart3 size={19} />, label: "DOM Analysis" },
  { id: "watchlist", icon: <Star size={19} />, label: "Watchlist" },
  { id: "ide", icon: <Layers size={19} />, label: "Institutional Derivatives" },
  { id: "top5", icon: <Flame size={19} />, label: "Today's Trade" },
  { id: "mostactive", icon: <Activity size={19} />, label: "Most Active F&O" },
  { id: "calculator", icon: <Target size={19} />, label: "Expiry Calculator" },
];

function getISTTime(): Date {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
}

const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-26', '2026-03-10', '2026-03-30', '2026-04-02', '2026-04-14',
  '2026-05-01', '2026-08-15', '2026-09-14', '2026-10-02', '2026-11-11', '2026-12-25',
]);

function isMarketOpen(): boolean {
  const ist = getISTTime();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const iso = ist.toISOString().split('T')[0];
  if (NSE_HOLIDAYS_2026.has(iso)) return false;
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
  daysToExpiry: number;
  unifiedScore?: number;
  unifiedGrade?: string;
  hardGatesPassed?: boolean;
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

// ─── Institutional Derivatives Engine Tab (NIFTY / SENSEX only) ──────────
function InstitutionalDerivativesView() {
  const [sym, setSym] = useState<"NIFTY" | "SENSEX">("NIFTY");
  const [sig, setSig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [source, setSource] = useState<string>("");

  const fetchSig = useCallback(async () => {
    try {
      const res = await fetch(`/api/ide?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "no data");
      setSig(json.signal);
      setSource(json.source || "live-chain");
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "failed");
    } finally {
      setLoading(false);
    }
  }, [sym]);

  useEffect(() => {
    setLoading(true);
    fetchSig();
    const id = setInterval(fetchSig, 900000);
    return () => clearInterval(id);
  }, [fetchSig]);

  const fmt = (n: number) => (typeof n === "number" && !isNaN(n) ? (Math.abs(n) >= 1000 ? n.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : n.toFixed(1)) : "--");
  const decColor = (d: string) =>
    d === "BUY_CALL" || d === "CALL" || d === "LONG" ? "text-[#1fbf75]" :
    d === "BUY_PUT" || d === "PUT" || d === "SHORT" ? "text-[#f2495c]" : "text-[#7d8ba0]";

  // Handle fallback (trade intelligence) data format
  const isFallback = source === "trade-intelligence" || source === "context-fallback";
  const rec = sig?.recommendation || {};
  const isNoTrade = sig?.action === "NO_TRADE" || rec?.action === "NO_TRADE";
  const conf = sig?.confidence?.total || 0;
  const reasons = sig?.reasoning || rec?.reasons || [];

  let barPos = 50;
  if (sig?.raw) {
    const span = sig.resistance - sig.support;
    barPos = span > 0 ? ((sig.raw.spot - sig.support) / span) * 100 : 50;
    barPos = Math.max(2, Math.min(98, barPos));
  }

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-bold">Institutional Derivatives Engine</span>
          <span className="text-[10px] text-[#7d8ba0]">
            {isFallback ? "Trade Intelligence Fallback" : "Option Chain + Greeks + OI + FII/DII → Decision"}
          </span>
          {isFallback && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40">FALLBACK</span>}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#7d8ba0]">
          <span>Index:</span>
          {(["NIFTY", "SENSEX"] as const).map((s) => (
            <button key={s} onClick={() => setSym(s)}
              className={`px-2 py-0.5 rounded font-bold ${sym === s ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" : "bg-[#10151d] border border-[#1f2733] text-[#7d8ba0]"}`}>{s}</button>
          ))}
          {loading && <Activity className="h-3 w-3 animate-spin" />}
          {updatedAt > 0 && <span>{new Date(updatedAt).toLocaleTimeString("en-IN")}</span>}
          <button onClick={fetchSig} className="px-2 py-0.5 rounded bg-[#1f2733] hover:bg-[#2a3441] font-bold">↻</button>
        </div>
      </div>

      {error && <div className="text-[11px] text-[#f2495c] bg-[#f2495c]/10 border border-[#f2495c]/30 rounded p-2">{error}</div>}

      {sig && (
        <>
          {/* Pipeline row — only show if live chain data */}
          {!isFallback && sig.raw && (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5">
              <IdeStat label="Spot" value={fmt(sig.raw.spot)} />
              <IdeStat label="ATM" value={fmt(sig.raw.atm)} />
              <IdeStat label="ATM CE" value={fmt(sig.raw.ce)} />
              <IdeStat label="ATM PE" value={fmt(sig.raw.pe)} />
              <IdeStat label="PCR" value={fmt(sig.raw.pcr)} />
              <IdeStat label="IV" value={fmt(sig.raw.iv)} />
            </div>
          )}

          {/* Fallback context */}
          {isFallback && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
              <IdeStat label="Market Bias" value={sig.marketBias || "N/A"} tone={decColor(sig.marketBias)} />
              <IdeStat label="Confidence" value={`${conf}%`} tone={conf >= 70 ? "text-[#1fbf75]" : conf >= 50 ? "text-[#e8a33d]" : "text-[#7d8ba0]"} />
              <IdeStat label="PCR" value={fmt(sig.oi?.pcr || 1)} />
              <IdeStat label="Max Pain" value={fmt(sig.oi?.maxPain || 0)} />
            </div>
          )}

          {/* Decision + probabilities */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-1.5">
            <IdeCard title="Decision">
              <div className={`text-xl font-extrabold ${decColor(rec.action || sig.decision)}`}>
                {isNoTrade ? "NO TRADE" : (rec.action || sig.decision || "N/A").replace("_", " ")}
              </div>
              <div className="text-[10px] text-[#7d8ba0] mt-1">
                {conf > 0 ? `Confidence ${conf}%` : "No high-conviction setup"}
              </div>
            </IdeCard>
            {!isFallback && sig.callProbability != null && (
              <>
                <IdeCard title="CE (Call) Probability">
                  <ProbBar v={sig.callProbability} color="#1fbf75" />
                </IdeCard>
                <IdeCard title="PE (Put) Probability">
                  <ProbBar v={sig.putProbability} color="#f2495c" />
                </IdeCard>
              </>
            )}
            {isFallback && (
              <>
                <IdeCard title="Regime">
                  <div className="text-lg font-bold text-[#dfe6ee]">{sig.marketBias || "N/A"}</div>
                  <div className="text-[10px] text-[#7d8ba0]">{sig.greeks?.dealerRegime || "Neutral"}</div>
                </IdeCard>
                <IdeCard title="Data Source">
                  <div className="text-lg font-bold text-[#e8a33d]">{source}</div>
                  <div className="text-[10px] text-[#7d8ba0]">Live chain unavailable</div>
                </IdeCard>
              </>
            )}
          </div>

          {/* Trade Plan — live chain */}
          {!isFallback && sig.decision !== "NO_TRADE" && sig.recommendedStrike != null && (
            <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
              <div className="text-[12px] font-bold mb-2">
                Trade Plan — {sig.recommendedType} @ {fmt(sig.recommendedStrike)}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <IdeStat label="Entry" value={fmt(sig.entry)} />
                <IdeStat label="SL" value={fmt(sig.stopLoss)} tone="text-[#f2495c]" />
                <IdeStat label="TP1" value={fmt(sig.target1)} tone="text-[#1fbf75]" />
                <IdeStat label="TP2" value={fmt(sig.target2)} tone="text-[#1fbf75]" />
              </div>
            </div>
          )}

          {/* Trade Plan — fallback */}
          {isFallback && !isNoTrade && (
            <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
              <div className="text-[12px] font-bold mb-2">
                Trade Plan — {rec.action} {rec.strikeType !== "N/A" ? `${rec.strike} ${rec.strikeType}` : ""}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <IdeStat label="Entry" value={fmt(rec.entry)} />
                <IdeStat label="SL" value={fmt(rec.stopLoss)} tone="text-[#f2495c]" />
                <IdeStat label="TP1" value={fmt(rec.target1)} tone="text-[#1fbf75]" />
                <IdeStat label="TP2" value={fmt(rec.target2)} tone="text-[#1fbf75]" />
              </div>
              {rec.riskReward > 0 && (
                <div className="text-center text-[11px] text-[#e8a33d] mt-2">R:R 1:{rec.riskReward.toFixed(1)}</div>
              )}
            </div>
          )}

          {/* Reasons */}
          <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
            <div className="text-[11px] font-bold mb-1.5">
              {isFallback ? "Market Intelligence" : "Engine Reasoning"}
            </div>
            <ul className="text-[10px] text-[#9fb0c3] space-y-0.5">
              {reasons.map((r: string, i: number) => <li key={i}>• {r}</li>)}
            </ul>
          </div>

          <div className="text-[10px] text-[#7d8ba0]">
            {isFallback
              ? "Live option chain unavailable — showing analysis from trade intelligence engine (Index F&O + Market Context)."
              : "Pure derivatives engine — no SMC / BOS / CHOCH / Order Blocks / FVG / EMA / VWAP / RSI / MACD / candlesticks."}
          </div>
        </>
      )}
    </div>
  );
}

function IdeStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-[#1f2733] bg-[#10151d] p-1.5">
      <div className="text-[9px] text-[#7d8ba0] uppercase">{label}</div>
      <div className={`text-[13px] font-bold ${tone || "text-[#dfe6ee]"}`}>{value}</div>
    </div>
  );
}
function IdeCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-2.5">
      <div className="text-[10px] text-[#7d8ba0] uppercase mb-1">{title}</div>
      {children}
    </div>
  );
}
function StrengthBar({ label, v }: { label: string; v: number }) {
  const color = v >= 60 ? "bg-[#1fbf75]" : v >= 40 ? "bg-[#e8a33d]" : "bg-[#f2495c]";
  return (
    <div className="mt-1">
      <div className="flex justify-between text-[9px] text-[#7d8ba0]"><span>{label}</span><span>{v}</span></div>
      <div className="h-1.5 rounded-full bg-[#1f2733] overflow-hidden mt-0.5"><div className={`h-full ${color}`} style={{ width: `${v}%` }} /></div>
    </div>
  );
}
function ProbBar({ v, color }: { v: number; color: string }) {
  return (
    <div className="mt-1">
      <div className={`text-2xl font-extrabold`} style={{ color }}>{v}%</div>
      <div className="h-2 rounded-full bg-[#1f2733] overflow-hidden mt-1"><div className="h-full" style={{ width: `${v}%`, background: color }} /></div>
    </div>
  );
}

function DStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-[#1f2733] bg-[#10151d] p-1.5">
      <div className="text-[9px] text-[#7d8ba0] uppercase">{label}</div>
      <div className={`text-[13px] font-bold ${tone || "text-[#dfe6ee]"}`}>{value}</div>
    </div>
  );
}

// ─── Today's Trade — Top 5 (All Modes: Index F&O / Stock F&O / Equity Swing) ──
function TodaysTradeView() {
  const [top5, setTop5] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [frozen, setFrozen] = useState(false);

  const fetchTop = useCallback(async () => {
    try {
      const res = await fetch(`/api/today-trades?record=true`, { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "no data");
      setTop5(json.top || []);
      setSummary(json.summary || null);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    if (!frozen) fetchTop();
    const id = setInterval(() => { if (!frozen) fetchTop(); }, 300000); // 5 min
    return () => clearInterval(id);
  }, [fetchTop, frozen]);

  const fmt = (n: number) => (typeof n === "number" && !isNaN(n) ? (Math.abs(n) >= 1000 ? n.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : n.toFixed(2)) : "--");
  const stars = (n: number) => "★".repeat(Math.max(0, Math.min(5, n))) + "☆".repeat(Math.max(0, 5 - Math.min(5, n)));

  const modeColors: Record<string, string> = {
    INDEX_FO: "bg-blue-500/20 text-blue-400 border-blue-500/40",
    STOCK_FO: "bg-purple-500/20 text-purple-400 border-purple-500/40",
    EQUITY_SWING: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
  };
  const modeLabels: Record<string, string> = {
    INDEX_FO: "INDEX",
    STOCK_FO: "F&O",
    EQUITY_SWING: "SWING",
  };
  const dirColors: Record<string, string> = {
    LONG: "text-[#1fbf75]",
    BUY: "text-[#1fbf75]",
    BUY_CE: "text-[#1fbf75]",
    SHORT: "text-[#f2495c]",
    SELL: "text-[#f2495c]",
    BUY_PE: "text-[#f2495c]",
    CALL: "text-[#1fbf75]",
    PUT: "text-[#f2495c]",
  };

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-orange-400" />
          <span className="text-sm font-bold">🔥 Today&apos;s Trade — Top 5</span>
          <span className="text-[10px] text-[#7d8ba0]">All Sectors · Index + F&O + Swing</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#7d8ba0]">
          {summary && (
            <span className="text-[9px]">
              <span className="text-blue-400">IDX:{summary.indexFO}</span>{" "}
              <span className="text-purple-400">F&O:{summary.stockFO}</span>{" "}
              <span className="text-emerald-400">SW:{summary.equitySwing}</span>
            </span>
          )}
          {loading && <Activity className="h-3 w-3 animate-spin" />}
          {updatedAt > 0 && <span>{new Date(updatedAt).toLocaleTimeString("en-IN")}</span>}
          <button onClick={() => setFrozen(!frozen)}
            className={`px-2 py-0.5 rounded font-bold text-[9px] ${frozen ? "bg-red-500/20 text-red-400 border border-red-500/40" : "bg-[#1f2733] hover:bg-[#2a3441] text-[#dfe6ee]"}`}>
            {frozen ? "🔒 FROZEN" : "❄️ Freeze"}
          </button>
          <button onClick={fetchTop} className="px-2 py-0.5 rounded bg-[#1f2733] hover:bg-[#2a3441] font-bold">↻</button>
        </div>
      </div>

      {error && <div className="text-[11px] text-[#f2495c] bg-[#f2495c]/10 border border-[#f2495c]/30 rounded p-2">{error}</div>}

      {frozen && <div className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 mb-1">🔒 Prices frozen — click "❄️ Freeze" to unfreeze for live updates</div>}

      <div className="flex-1 overflow-auto">
        {top5.length === 0 && !loading && !error && (
          <div className="p-6 text-center text-[#7d8ba0] text-[12.5px]">
            No high-conviction setups right now.<br/>
            <span className="text-[10px]">Market conditions may be unclear. Scanning Index F&O, Stock F&O, and Equity Swing across all sectors.</span>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {top5.map((c) => {
            const mode = c.mode || "EQUITY_SWING";
            const modeColor = modeColors[mode] || modeColors.EQUITY_SWING;
            const modeLabel = modeLabels[mode] || "SWING";
            const dirColor = dirColors[c.direction] || "text-[#dfe6ee]";
            const isFut = c.type === "FUT";
            const isEq = c.type === "EQ";
            const isOpt = !isEq && !isFut;
            const premTrade = isOpt && typeof c.spotEntry === "number" && c.spotEntry > 0;
            return (
              <div key={`${c.rank}-${c.symbol}-${c.mode}`}
                className="flex items-center gap-3 rounded-lg border border-[#1f2733] bg-[#10151d] px-3 py-2.5">
                <div className="w-5 text-center text-[15px] font-extrabold text-[#7d8ba0]">{c.rank}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-[14px] font-bold ${dirColor}`}>{c.symbol}</span>
                    <span className={`text-[9px] px-1 py-0.5 rounded border ${modeColor}`}>{modeLabel}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-black/30 text-[#9fb0c3]">
                      {isEq ? c.setupType : isFut ? "FUT" : `${c.strike || ""} ${c.type}`}
                    </span>
                    {c.sector && <span className="text-[9px] text-[#7d8ba0]">{c.sector}</span>}
                  </div>
                  <div className="text-[10px] text-[#7d8ba0] mt-0.5">
                    {premTrade ? (
                      <>
                        Entry ₹{fmt(c.entry)} (premium) · SL ₹{fmt(c.stopLoss)} · TP1 ₹{fmt(c.tp1)} · TP2 ₹{fmt(c.tp2)}
                        <span className="text-[#7d8ba0]/60"> · spot {fmt(c.spotEntry)}→{fmt(c.spotStopLoss)}/{fmt(c.spotTarget1)}/{fmt(c.spotTarget2)}</span>
                      </>
                    ) : (
                      <>Entry ₹{fmt(c.entry)} · SL ₹{fmt(c.stopLoss)} · TP1 ₹{fmt(c.tp1)} · TP2 ₹{fmt(c.tp2)}{isOpt ? " (spot)" : ""}</>
                    )}
                  </div>
                  {c.instrument && c.instrument !== "NO_TRADE" && (
                    <div className="text-[9px] text-[#9fb0c3] mt-0.5">
                      {c.instrument} {c.holdingPeriod && `· ${c.holdingPeriod}`}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-[13px] font-bold text-[#dfe6ee]">1:{c.rr?.toFixed(1) || "—"}</div>
                  <div className="text-[12px] text-[#e8a33d] tracking-tight">{stars(c.stars)}</div>
                </div>
                <div className="w-12 text-right">
                  <div className="text-[13px] font-bold" style={{ color: c.probability >= 80 ? "#1fbf75" : c.probability >= 70 ? "#e8a33d" : "#dfe6ee" }}>
                    {c.probability}%
                  </div>
                  <div className="text-[9px] text-[#7d8ba0]">score</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="text-[10px] text-[#7d8ba0]">
        Unified ranking across Index F&O (NIFTY/BANKNIFTY/SENSEX), Stock F&O (futures/options/OI), and Equity Swing (breakout/pullback/accumulation) — all sectors.
      </div>
    </div>
  );
}

// ─── CAS Straddle / Strangle Tab (Live + Backtest) ───────────────

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

  // Live LTP for open paper positions — every 15s fetch each position's
  // option chain and update matching strike premiums. deps exclude `ltp`
  // itself so updates don't retrigger the effect.
  useEffect(() => {
    if (positions.length === 0) return;
    const syms = [...new Set(positions.map((p) => p.sym))];
    let alive = true;
    const tick = async () => {
      try {
        const results = await Promise.all(
          syms.map(async (sym) => {
            try {
              const res = await fetch(`/api/option-chain?symbol=${encodeURIComponent(sym)}`);
              if (!res.ok) return null;
              const json = await res.json();
              if (!json.success) return null;
              return { sym, strikes: json.data?.data || [] } as const;
            } catch { return null; }
          }),
        );
        const map = new Map(results.filter(Boolean).map((r: any) => [r.sym, r.strikes]));
        if (!alive || map.size === 0) return;
        setPositions((prev) => prev.map((p) => {
          const rows = map.get(p.sym);
          if (!rows) return p;
          const row = rows.find((s: any) => s.strike === p.strike);
          const ltp = p.type === "CE" ? row?.ce?.ltp : row?.pe?.ltp;
          return ltp ? { ...p, ltp } : p;
        }));
      } catch { /* keep last LTP */ }
    };
    tick();
    const iv = setInterval(tick, 15000); // live LTP every 15s
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.length, positions.map((p) => p.sym).join(",")]);

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
    // SAFETY: Zero Hero is ONLY allowed on expiry day
    if (!getExpiryTypeForDate(symbol)) return []; // Not expiry day — no Zero Hero trades
    // Session gate — audit-validated Oct 2026 (July book): ZERO_HERO in
    // MIDDAY/CLOSING/POST_CLOSE = 15.8% WR, −₹184K; all other sessions =
    // 43.4% WR, +₹34K. Never generate candidates in the toxic windows.
    const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const istMins = istNow.getHours() * 60 + istNow.getMinutes();
    const toxicSession = (istMins >= 720 && istMins < 780) || istMins >= 900; // 12:00-13:00, 15:00+
    if (toxicSession) return [];
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

        // Unified scoring engine — HERO_ZERO profile
        const optionChain = chain.map((row: any) => ({
          strike: row.strike,
          ce: row.ce ? { ltp: row.ce.ltp, oi: row.ce.oi, oiChg: row.ce.oiChg, volume: row.ce.vol, iv: row.iv || 15, delta: row.ce.delta || 0, theta: 0, gamma: 0, vega: 0 } : null,
          pe: row.pe ? { ltp: row.pe.ltp, oi: row.pe.oi, oiChg: row.pe.oiChg, volume: row.pe.vol, iv: row.iv || 15, delta: row.pe.delta || 0, theta: 0, gamma: 0, vega: 0 } : null,
        }));
        const unifiedDecision = scoreTrade(withCandleContext({
          symbol,
          strategy: "HERO_ZERO",
          direction: type === "CE" ? "BULLISH" : "BEARISH",
          spot,
          optionChain,
          pcr: ctx.oiAnalysis?.pcr || undefined,
          maxPain: ctx.oiAnalysis?.maxPain || undefined,
          vix: vix || undefined,
          lotSize,
          entryPrice: d.ltp,
          stopLoss: r.sl,
          target1: r.tp1,
          target2: r.tp2,
          historicalWinRate: 0.65,
          historicalRR: r.rr,
        }, candles));

        list.push({
          rank: 0, strike: s.strike, type, entry: d.ltp, sl: r.sl, tp1: r.tp1, tp2: r.tp2,
          rr: r.rr, prob: r.prob, conf: r.conf, stars: r.stars,
          daysToExpiry: ctx.expiry?.days_to_expiry ?? 1,
          unifiedScore: unifiedDecision.score,
          unifiedGrade: unifiedDecision.grade,
          hardGatesPassed: unifiedDecision.hardGateStatus.passed,
        });
      }
    }
    list.sort((a, b) => b.conf - a.conf);
    return list.slice(0, 10).map((c, i) => ({ ...c, rank: i + 1 }));
  }, [chain, spot, isEligible, vix, symbol, candles]);

  // ─── FII/DII flow from OI ───────────────────────────────────────
  const flowData = useMemo(() => {
    let totalCallOIChg = 0, totalPutOIChg = 0, totalCallVol = 0, totalPutVol = 0;
    for (const s of chain) {
      if (s.ce) { totalCallOIChg += s.ce.oiChg; totalCallVol += s.ce.vol; }
      if (s.pe) { totalPutOIChg += s.pe.oiChg; totalPutVol += s.pe.vol; }
    }
    const totalOIChg = Math.abs(totalCallOIChg) + Math.abs(totalPutOIChg);
    const ratio = totalOIChg > 0 ? (totalCallOIChg - totalPutOIChg) / totalOIChg : 0;
    // Call OI ↑ = writers selling calls = bearish | Put OI ↑ = writers selling puts = bullish
    const bias = ratio < -0.1 ? "BULLISH" : ratio > 0.1 ? "BEARISH" : "NEUTRAL";
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
            <EnhancedOptionChain chain={chain} spot={spot} atmStrike={atmStrike} maxPain={maxPain} openTrade={openTrade} />
          )}
          {activeTab === "optionsedge" && (
            <OptionsEdgePanel symbol={symbol} onTrade={openTrade} />
          )}
          {activeTab === "smartmoney" && (
            <SmartMoneyTab flowData={flowData} chain={chain} spot={spot} vix={vix} pcr={pcr} maxPain={maxPain} candles={candles} openTrade={openTrade} symbol={symbol} setSymbol={setSymbol} />
          )}
          {activeTab === "instgreeks" && (
            <InstitutionalGreeksPanel onTrade={openTrade} />
          )}
          {activeTab === "greekflow" && (
            <GreekFlowHeatmap onTrade={openTrade} />
          )}
          {activeTab === "dom" && (
            <DOMTab symbol={symbol} />
          )}
          {activeTab === "watchlist" && (
            <WatchlistTab watchlist={watchlist} setWatchlist={setWatchlist} setSymbol={setSymbol} symbol={symbol} />
          )}
          {activeTab === "ide" && (
            <InstitutionalDerivativesView />
          )}
          {activeTab === "top5" && (
            <TodaysTradeView />
          )}
          {activeTab === "mostactive" && (
            <MostActiveContracts />
          )}
          {activeTab === "calculator" && (
            <ExpiryCalculator spot={spot} vix={vix} symbol={symbol} lotSize={lotSize} />
          )}
        </div>
      </div>

      {/* ─── Expiry-Day Option Survival / Zero-Hero Risk Calculator ─── */}
      <ExpiryCalculator spot={spot} vix={vix} symbol={symbol} lotSize={lotSize} />

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
              <EnhancedOptionChain chain={chain} spot={spot} atmStrike={atmStrike} maxPain={maxPain} openTrade={openTrade} />
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
                {z.unifiedGrade && (
                  <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${
                    z.unifiedGrade === "A+" ? "bg-[rgba(212,175,55,.25)] text-[#d4af37]" :
                    z.unifiedGrade === "A" ? "bg-[rgba(31,191,117,.18)] text-[#1fbf75]" :
                    z.unifiedGrade === "B" ? "bg-[rgba(79,143,247,.18)] text-[#4f8ff7]" :
                    "bg-[rgba(125,139,160,.2)] text-[#7d8ba0]"
                  }`} title={`Unified Score: ${z.unifiedScore}/100`}>{z.unifiedGrade}</span>
                )}
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
    <div className="overflow-x-auto">
    <table className="w-full min-w-[640px] border-collapse font-mono text-[12px]">
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
    </div>
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
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full inline-block ${totalCallOIChg >= 0 ? "bg-[#f2495c]" : "bg-[#1fbf75]"}`} />
            {totalCallOIChg >= 0 ? "Call Writing" : "Call Unwinding"}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full inline-block ${totalPutOIChg >= 0 ? "bg-[#1fbf75]" : "bg-[#f2495c]"}`} />
            {totalPutOIChg >= 0 ? "Put Writing" : "Put Unwinding"}
          </span>
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
    async function fetchDOM(initial = false) {
      try {
        if (initial) setLoading(true);
        setError(null);
        const res = await fetch(`/api/dom-analysis?symbol=${symbol}`);
        const json = await res.json();
        if (mounted && json.success && json.data) {
          setData(json.data);
        } else if (mounted && initial) {
          setError(json.error || 'Failed to fetch DOM data');
        }
      } catch (e: any) {
        if (mounted && initial) setError(e.message);
      } finally {
        if (mounted && initial) setLoading(false);
      }
    }
    fetchDOM(true);
    const iv = setInterval(() => fetchDOM(false), 60000); // auto-update every 60s
    return () => { mounted = false; clearInterval(iv); };
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
  // ─── Unified Scoring Engine ───────────────────────────────────────
  const scoredCandidates = useMemo(() => {
    if (!chain.length || !spot) return [];
    try {
      const lotSize = getLotSize(activeSymbol);
      // Build option chain for unified engine
      const optionChain = chain.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? { ltp: row.ce.ltp, oi: row.ce.oi, oiChg: row.ce.oiChg, volume: row.ce.volume, iv: row.iv || 15, delta: row.ce.delta || 0, theta: 0, gamma: 0, vega: 0 } : null,
        pe: row.pe ? { ltp: row.pe.ltp, oi: row.pe.oi, oiChg: row.pe.oiChg, volume: row.pe.volume, iv: row.iv || 15, delta: row.pe.delta || 0, theta: 0, gamma: 0, vega: 0 } : null,
      }));

      // Score each strike with unified engine
      const results: any[] = [];
      const nearStrikes = chain.filter((row: any) => Math.abs(row.strike - spot) / spot < 0.03);

      // OI-flow direction filter (same math as flowData memo):
      // call OI rising = call writing = BEARISH; put OI rising = put writing = BULLISH.
      // SMART_MONEY PE historically lost in EVERY session (0/51, −₹78K) during a
      // bull run — so PE is allowed ONLY when live OI flow confirms bears in
      // control. In a bull market this gate blocks PE automatically.
      let callOiChg = 0, putOiChg = 0;
      for (const row of chain) {
        if (row.ce) callOiChg += row.ce.oiChg || 0;
        if (row.pe) putOiChg += row.pe.oiChg || 0;
      }
      const oiTot = Math.abs(callOiChg) + Math.abs(putOiChg);
      const oiRatio = oiTot > 0 ? (callOiChg - putOiChg) / oiTot : 0;
      const flowBias: "BULLISH" | "BEARISH" | "NEUTRAL" =
        oiRatio < -0.1 ? "BULLISH" : oiRatio > 0.1 ? "BEARISH" : "NEUTRAL";

      // Falling-market detector (TECHNICAL confirmation, Oct 2026):
      // OI flow says who's winning the positioning war; this says whether
      // price is DEMONSTRABLY falling (spot < VWAP + DOWN structure +
      // sustained momentum — ≥2 of 3 layers). PE requires BOTH.
      const falling = isFallingMarket(candles, spot);

      // PE strike window per desk style: ATM/ITM + OTM max 2–3 strikes.
      // Strike interval derived from the chain itself (works for NIFTY 50,
      // SENSEX 100, stock F&O steps alike).
      const sortedStrikes = chain.map((r: any) => r.strike).sort((a: number, b: number) => a - b);
      let strikeStep = 0;
      for (let i = 1; i < sortedStrikes.length; i++) {
        const d = sortedStrikes[i] - sortedStrikes[i - 1];
        if (d > 0 && (!strikeStep || d < strikeStep)) strikeStep = d;
      }
      if (!strikeStep) strikeStep = spot * 0.002; // fallback ~0.2%
      const peMinStrike = spot - 4 * strikeStep;  // ITM depth cap
      const peMaxStrike = spot + 3 * strikeStep;  // OTM cap: 3 strikes
      // PE session gate — PRE_OPEN PE alone was −₹64K (0% WR); market-hours only.
      const peIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const peMins = peIst.getHours() * 60 + peIst.getMinutes();
      const peSessionOk = peMins >= 555 && peMins < 930; // 09:15–15:30 IST

      for (const row of nearStrikes) {
        // CE direction
        const ceInput: MarketDataInput = {
          symbol: activeSymbol,
          strategy: "FO" as StrategyProfile,
          direction: "BULLISH",
          spot,
          optionChain,
          pcr: pcr || undefined,
          maxPain: maxPain || undefined,
          vix: vix || undefined,
          candles: candles as any[] | undefined,
          lotSize,
          entryPrice: row.ce?.ltp || 0,
          stopLoss: row.ce ? row.ce.ltp * 0.7 : 0,
          target1: row.ce ? row.ce.ltp * 1.5 : 0,
          target2: row.ce ? row.ce.ltp * 2.0 : 0,
          historicalWinRate: 0.65,
          historicalRR: 2.0,
          // TODO: migrate to option-plan rupee-risk (20% deployed → 2R/3R/4R targets)
          // TODO: the old 0.7/1.5/2.0 hardcodes will be replaced when the scanner
          //      integrates buildOptionPlan() from option-plan.ts — currently kept for
          //      backwards compat but producing incorrect R:R values.
        };
        const ceDecision = scoreTrade(withCandleContext(ceInput, candles));
        if (ceDecision.entry >= 5 && ceDecision.stopLoss > 0 && ceDecision.stopLoss < ceDecision.entry &&
            (ceDecision.decision === "TRADE" || ceDecision.grade === "WATCH" || ceDecision.score >= 50)) {
          results.push({
            strike: row.strike,
            type: "CE",
            entry: ceDecision.entry,
            sl: ceDecision.stopLoss,
            tp1: ceDecision.target1,
            tp2: ceDecision.target2,
            tp3: ceDecision.target3,
            rr: ceDecision.riskReward,
            confidence: ceDecision.score,
            qualityGrade: ceDecision.grade,
            maxLoss: ceDecision.maxLoss,
            reasons: ceDecision.reasons,
            direction: ceDecision.direction,
            hardGates: ceDecision.hardGateStatus,
          });
        }

        // PE candidates — REGIME-GATED, not banned (Oct 2026 audit):
        // historical PE = 0/51 across all sessions in a bull run (−₹78K).
        // Allowed only when (a) OI flow says BEARISH, (b) price is actually
        // FALLING (technical: VWAP/structure/momentum, ≥2 layers), (c) score ≥65,
        // (d) market hours (no PRE_OPEN), (e) levels sane (entry ≥ ₹5, SL below
        // entry), (f) strike inside ATM/ITM + OTM≤3 window.
        if (
          flowBias === "BEARISH" &&
          peSessionOk &&
          falling.falling &&
          row.strike >= peMinStrike &&
          row.strike <= peMaxStrike
        ) {
const peInput: MarketDataInput = {
          symbol: activeSymbol,
          strategy: "FO" as StrategyProfile,
          direction: "BEARISH",
          spot,
          optionChain,
          pcr: pcr || undefined,
          maxPain: maxPain || undefined,
          vix: vix || undefined,
          candles: candles as any[] | undefined,
          lotSize,
          entryPrice: row.pe?.ltp || 0,
          stopLoss: row.pe ? row.pe.ltp * 0.7 : 0,
          target1: row.pe ? row.pe.ltp * 1.5 : 0,
          target2: row.pe ? row.pe.ltp * 2.0 : 0,
          historicalWinRate: 0.65,
          historicalRR: 2.0,
          // TODO: migrate to option-plan rupee-risk (20% deployed → 2R/3R/4R targets)
          // TODO: the old 0.7/1.5/2.0 hardcodes will be replaced when the scanner
          //      integrates buildOptionPlan() from option-plan.ts — currently kept for
          //      backwards compat but producing incorrect R:R values.
        };
          const peDecision = scoreTrade(withCandleContext(peInput, candles));
          if (peDecision.entry >= 5 && peDecision.stopLoss > 0 && peDecision.stopLoss < peDecision.entry &&
              (peDecision.decision === "TRADE" || peDecision.grade === "WATCH" || peDecision.score >= 65)) {
            results.push({
              strike: row.strike,
              type: "PE",
              entry: peDecision.entry,
              sl: peDecision.stopLoss,
              tp1: peDecision.target1,
              tp2: peDecision.target2,
              tp3: peDecision.target3,
              rr: peDecision.riskReward,
              confidence: peDecision.score,
              qualityGrade: peDecision.grade,
              maxLoss: peDecision.maxLoss,
              reasons: peDecision.reasons,
              direction: peDecision.direction,
              hardGates: peDecision.hardGateStatus,
            });
          }
        }
      }

      return results.sort((a: any, b: any) => b.confidence - a.confidence).slice(0, 10);
    } catch {
      return [];
    }
  }, [chain, spot, candles, vix, pcr, maxPain, activeSymbol]);

  const smcCandidates = scoredCandidates;

  // ─── Render helpers ─────────────────────────────────────────────
  function renderCandTable() {
    if (!smcCandidates.length) return null;
    const h = ["Strike", "Type", "Confidence", "Entry", "SL", "TP1", "TP2", "TP3", "R:R", "Grade", "Sizing"];
    return (
      <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] border-collapse font-mono text-[12px]">
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
      </div>
    );
  }

  function renderDetails() {
    if (!scoredCandidates.length) return null;
    const top = scoredCandidates[0];
    if (!top) return null;
    return (
      <div className="grid grid-cols-2 gap-2 mt-2 text-[11px]">
        <div className="bg-[#0c111a] rounded p-2">
          <div className="font-bold mb-1 text-[#e8a33d]">Unified Score</div>
          <div><span className="text-[#7d8ba0]">Score:</span> <span className={top.confidence >= 80 ? "text-[#1fbf75]" : top.confidence >= 60 ? "text-[#e8a33d]" : "text-[#f2495c]"}>{top.confidence}/100</span></div>
          <div><span className="text-[#7d8ba0]">Grade:</span> <span className="text-[#4f8ff7]">{top.qualityGrade}</span></div>
          <div><span className="text-[#7d8ba0]">Direction:</span> {top.direction}</div>
          <div><span className="text-[#7d8ba0]">R:R:</span> 1:{top.rr?.toFixed(1)}</div>
          <div><span className="text-[#7d8ba0]">Max Loss:</span> <span className="text-[#f2495c]">₹{fmtInt(top.maxLoss)}</span></div>
        </div>
        <div className="bg-[#0c111a] rounded p-2">
          <div className="font-bold mb-1 text-[#2dd4a7]">Hard Gates</div>
          {top.hardGates?.gates?.map((g: any, i: number) => (
            <div key={i} className="flex items-center gap-1">
              <span className={g.status === "PASS" ? "text-[#1fbf75]" : g.status === "FAIL" ? "text-[#f2495c]" : "text-[#e8a33d]"}>{g.status === "PASS" ? "✓" : g.status === "FAIL" ? "✗" : "!"}</span>
              <span className="text-[#7d8ba0]">{g.name}</span>
            </div>
          ))}
          <div className="mt-1"><span className="text-[#7d8ba0]">Regime:</span> <span className="text-[#4f8ff7]">{top.hardGates?.passed ? "ALL PASS" : "GATES FAILED"}</span></div>
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
          <div>Smart Money Scanner <span className="text-[#7d8ba0] font-mono text-[11px]">Unified Scoring Engine</span></div>
          <div className="flex items-center gap-2">
            <span className="text-[#7d8ba0] text-[10px] font-mono">{smcCandidates.length} candidates</span>
          </div>
        </div>
        <div className="p-2.5 overflow-x-auto">
          {!smcCandidates.length ? (
              <div className="text-center py-6 text-[#7d8ba0] text-[12px]">
              <div className="font-bold text-[#e8a33d] mb-1">No SMC Candidates</div>
              <div>
                {(candles?.length ?? 0) >= 5
                  ? "Market structure is ranging — no strong directional signals detected. Candidates require OI confirmation + favorable risk:reward."
                  : "Candle feed unavailable (no structure/volume data) — candidates suppressed until real candles return. Never scoring simulated data."}
              </div>
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
// ─── Watchlist Tab ─────────────────────────────────────────────────
function WatchlistTab({ watchlist, setWatchlist, setSymbol, symbol }: { watchlist: Set<string>; setWatchlist: (s: Set<string>) => void; setSymbol: (s: string) => void; symbol: string }) {
  const [quotes, setQuotes] = useState<Record<string, { ltp: number; changePct: number }>>({});

  // Live LTP + chg% for every instrument — 30s poll of /api/quotes.
  useEffect(() => {
    let alive = true;
    const load = () => {
      const syms = ALL_INSTRUMENTS.map((i) => i.symbol).join(",");
      fetch(`/api/quotes?symbols=${syms}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (alive && j?.success) setQuotes(j.data?.quotes || {});
        })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 30000); // auto-update every 30s
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const toggle = (sym: string) => {
    const next = new Set(watchlist);
    if (next.has(sym)) next.delete(sym); else next.add(sym);
    setWatchlist(next);
  };
  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1f2733] font-bold text-[13px]">⭐ Watchlist <span className="text-[#7d8ba0] font-mono text-[11px]">Click a row to switch instrument · LTP auto-updates 30s</span></div>
      <div className="p-2.5 overflow-auto" style={{ maxHeight: "78vh" }}>
        <table className="w-full min-w-[480px] border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              {["Pin", "Instrument", "LTP", "Chg%", "Lot", "Exchange"].map((h) => (
                <th key={h} className={`text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase ${h === "Lot" ? "text-right" : h === "Chg%" || h === "LTP" ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...ALL_INSTRUMENTS].sort((a, b) => (watchlist.has(b.symbol) ? 1 : 0) - (watchlist.has(a.symbol) ? 1 : 0)).map((i) => {
              const active = i.symbol === symbol;
              const q = quotes[i.symbol];
              return (
                <tr key={i.symbol} className={`border-b border-[#1f2733] cursor-pointer ${active ? "bg-[rgba(45,212,167,.08)]" : "hover:bg-[#151b25]"}`}
                  onClick={() => setSymbol(i.symbol)}>
                  <td className="text-left py-1.5 px-1" onClick={(e) => { e.stopPropagation(); toggle(i.symbol); }}>
                    <span style={{ color: watchlist.has(i.symbol) ? "#e8a33d" : "#7d8ba0", fontSize: 15 }}>{watchlist.has(i.symbol) ? "★" : "☆"}</span>
                  </td>
                  <td className="text-left py-1.5 px-1 font-medium" style={{ color: active ? "#2dd4a7" : "#dfe6ee" }}>{i.label}</td>
                  <td className="text-right py-1.5 px-1" style={{ color: q ? "#dfe6ee" : "#5a6a80" }}>{q ? `₹${q.ltp.toLocaleString("en-IN")}` : "—"}</td>
                  <td className="text-right py-1.5 px-1 font-bold" style={{ color: !q ? "#5a6a80" : q.changePct >= 0 ? "#1fbf75" : "#f2495c" }}>{q ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` : "—"}</td>
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

// ─── Calculation Engine ────────────────────────────────────────────────────────
function calculate(inputs: ExpCalcInputs): ExpCalcResult {
  const {
    optionType,
    position,
    strike,
    entryPremium,
    currentLTP,
    lots,
    lotSize,
    spot,
    iv,
    timeHours,
    settlementPrice,
    settlementMode,
    brokeragePerOrder,
    sttPct,
    exchangeChargesPct,
    gstPct,
    sebiPct,
    stampDutyPct,
  } = inputs;

  // Validation
  if (!spot || spot <= 0) throw new Error("Spot price must be > 0");
  if (!strike || strike <= 0) throw new Error("Strike must be > 0");
  if (!entryPremium || entryPremium <= 0) throw new Error("Entry premium must be > 0");
  if (!lots || lots <= 0) throw new Error("Lots must be > 0");
  if (!lotSize || lotSize <= 0) throw new Error("Lot size must be > 0");
  if (!iv || iv <= 0) throw new Error("IV must be > 0");
  if (!timeHours || timeHours <= 0) throw new Error("Time to expiry must be > 0");

  const long = position === "BUY";
  const isCall = optionType === "CE";
  const settlement = settlementPrice != null && settlementPrice > 0 ? settlementPrice : spot;

  // Expiry value per unit (cash-settled, European-style)
  const expiryValue = isCall ? Math.max(settlement - strike, 0) : Math.max(strike - settlement, 0);

  // P&L per unit
  const pnlPerUnit = long ? expiryValue - entryPremium : entryPremium - expiryValue;

  // Break-even
  const breakEven = isCall ? strike + entryPremium : strike - entryPremium;

  // Distance to strike
  const distanceToStrike = spot - strike;
  const distanceToStrikePct = (distanceToStrike / spot) * 100;

  // Expected move: Spot × (IV/100) × sqrt(T_days/365)
  // T_days = hours / 6.25 (trading hours per day)
  const tDays = timeHours / 6.25;
  const sigma = iv / 100;
  const expectedMove = spot * sigma * Math.sqrt(tDays / 365);

  // Probability of finishing ITM (lognormal model)
  // d2 = [ln(S/K) + (r - 0.5*sigma²)*T] / (sigma*sqrt(T)); r = 0.07
  const r = 0.07;
  const T = tDays / 365;
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(spot / strike) + (r - 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const probITM = isCall ? normalCDF(d2) : 1 - normalCDF(d2);

  // Expected value
  const expectedValuePerUnit = probITM * (expiryValue - entryPremium) - (1 - probITM) * entryPremium;
  const expectedValuePerLot = expectedValuePerUnit * lotSize;

  // Zero-Hero flag: OTM, premium below threshold, required move > 1 std dev
  const otm = isCall ? spot < strike : spot > strike;
  const premiumThreshold = 10;
  const requiredMove = Math.abs(strike - spot);
  const oneStdDev = expectedMove;
  const zeroHeroFlag = otm && entryPremium < premiumThreshold && requiredMove > oneStdDev;
  const zeroHeroReason = zeroHeroFlag
    ? `OTM premium (₹${entryPremium.toFixed(2)}) below ₹${premiumThreshold.toFixed(0)} threshold and required move (${requiredMove.toFixed(0)} pts) exceeds 1 SD expected move (${oneStdDev.toFixed(0)} pts)`
    : "";

  // Max loss
  const maxLossBuyer = long ? entryPremium * lotSize * lots : 0;
  const maxLossSeller = long ? "unlimited" : (entryPremium * lotSize * lots).toFixed(0);

  // Charges
  // STT: on sell side (intraday square-off) or on intrinsic value (ITM settlement)
  const sttOnSell = currentLTP * sttPct / 100;
  const sttOnIntrinsic = expiryValue * sttPct / 100;
  const exchangeCharges = entryPremium * exchangeChargesPct / 100;
  const gstOnBrokerage = brokeragePerOrder * gstPct / 100;
  const sebiCharges = entryPremium * sebiPct / 100;
  const stampDuty = entryPremium * stampDutyPct / 100;

  // Square-off P&L (sell at current LTP, STT on sell premium)
  const squareOffPnL = long ? (currentLTP - entryPremium) * lotSize * lots : (entryPremium - currentLTP) * lotSize * lots;
  const squareOffCharges = sttOnSell * lotSize * lots + exchangeCharges * lotSize * lots + gstOnBrokerage + sebiCharges * lotSize * lots + stampDuty * lotSize * lots;
  const squareOffNet = squareOffPnL - squareOffCharges - brokeragePerOrder;

  // Hold to settlement P&L (STT on intrinsic value if ITM)
  const holdPnL = pnlPerUnit * lotSize * lots;
  const holdCharges = sttOnIntrinsic * lotSize * lots + exchangeCharges * lotSize * lots + gstOnBrokerage + sebiCharges * lotSize * lots + stampDuty * lotSize * lots;
  const holdNet = holdPnL - holdCharges - brokeragePerOrder;

  const totalCharges = Math.max(squareOffCharges, holdCharges);
  const netPnLAfterCharges = long ? holdNet : holdNet;

  // Cost-trap: charges > 50% of small profit
  const costTrapWarning = holdPnL > 0 && holdCharges > holdPnL * 0.5;

  // Risk meter
  let riskMeter: "Low" | "Medium" | "High" | "Extreme" = "Low";
  if (zeroHeroFlag || Math.abs(pnlPerUnit) > entryPremium * 2 || probITM < 30) riskMeter = "Extreme";
  else if (Math.abs(pnlPerUnit) > entryPremium || probITM < 45 || costTrapWarning) riskMeter = "High";
  else if (Math.abs(pnlPerUnit) > entryPremium * 0.5 || probITM < 60) riskMeter = "Medium";

  // Status
  const status = spot > strike * 1.001 ? "ITM" : spot < strike * 0.999 ? "OTM" : "ATM";

  // Scenario table
  const scenarioTable: ScenarioRow[] = [];
  for (let s = strike - 300; s <= strike + 300; s += 50) {
    const ev = isCall ? Math.max(s - strike, 0) : Math.max(strike - s, 0);
    const pnl = long ? ev - entryPremium : entryPremium - ev;
    scenarioTable.push({
      settlement: s,
      expiryValue: ev,
      pnlPerLot: pnl * lotSize,
      status: s > strike * 1.001 ? "ITM" : s < strike * 0.999 ? "OTM" : "ATM",
      isBreakEven: Math.abs(s - breakEven) < 25,
      isSpot: Math.abs(s - spot) < 25,
    });
  }

  return {
    expiryValue,
    pnlPerUnit,
    breakEven,
    distanceToStrike,
    distanceToStrikePct,
    expectedMove,
    probITM: probITM * 100,
    expectedValuePerUnit,
    expectedValuePerLot,
    zeroHeroFlag,
    zeroHeroReason,
    maxLossBuyer,
    maxLossSeller,
    netPnLAfterCharges,
    totalCharges,
    status,
    settlementUsed: settlement,
    settlementLabel: settlementMode === "final" ? "Final (market close)" : "Provisional (current spot)",
    squareOffPnL,
    holdToSettlementPnL: holdNet,
    costTrapWarning,
    riskMeter,
    scenarioTable,
  };
}

// ─── Expiry-Day Option Survival / Zero-Hero Risk Calculator ─────────────────────
// Self-contained calculator for NSE index options (cash-settled, European-style).
// All math is deterministic; no external dependencies.

interface ExpCalcInputs {
  index: string;
  optionType: "CE" | "PE";
  position: "BUY" | "SELL";
  strike: number;
  entryPremium: number;
  currentLTP: number;
  lots: number;
  lotSize: number;
  spot: number;
  iv: number;            // percent, e.g. 15 for 15%
  timeHours: number;     // hours to expiry
  settlementPrice?: number; // optional manual settlement
  settlementMode: "provisional" | "final";
  brokeragePerOrder: number;
  sttPct: number;        // percent
  exchangeChargesPct: number;
  gstPct: number;
  sebiPct: number;
  stampDutyPct: number;
}

interface ExpCalcResult {
  expiryValue: number;
  pnlPerUnit: number;
  breakEven: number;
  distanceToStrike: number;
  distanceToStrikePct: number;
  expectedMove: number;
  probITM: number;
  expectedValuePerUnit: number;
  expectedValuePerLot: number;
  zeroHeroFlag: boolean;
  zeroHeroReason: string;
  maxLossBuyer: number;
  maxLossSeller: string;
  netPnLAfterCharges: number;
  totalCharges: number;
  status: "ITM" | "OTM" | "ATM";
  settlementUsed: number;
  settlementLabel: string;
  squareOffPnL: number;
  holdToSettlementPnL: number;
  costTrapWarning: boolean;
  riskMeter: "Low" | "Medium" | "High" | "Extreme";
  scenarioTable: ScenarioRow[];
}

interface ScenarioRow {
  settlement: number;
  expiryValue: number;
  pnlPerLot: number;
  status: "ITM" | "OTM" | "ATM";
  isBreakEven: boolean;
  isSpot: boolean;
}

// Normal CDF (Abramowitz-Stegun approximation)
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// Round half up to 2 decimals
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function ExpiryCalculator({
  spot,
  vix,
  symbol,
  lotSize: defaultLotSize,
}: {
  spot: number;
  vix: number;
  symbol: string;
  lotSize: number;
}) {
  const [inputs, setInputs] = useState<ExpCalcInputs>({
    index: symbol.includes("NIFTY") ? "NIFTY" : symbol.includes("BANKNIFTY") ? "BANKNIFTY" : symbol.includes("FINNIFTY") ? "FINNIFTY" : "MIDCPNIFTY",
    optionType: "CE",
    position: "BUY",
    strike: spot > 0 ? Math.round(spot / 50) * 50 : 24000,
    entryPremium: 0,
    currentLTP: 0,
    lots: 1,
    lotSize: defaultLotSize > 0 ? defaultLotSize : 50,
    spot: spot > 0 ? spot : 24000,
    iv: vix > 0 ? vix : 15,
    timeHours: 6,
    settlementPrice: undefined,
    settlementMode: "provisional",
    brokeragePerOrder: 20,
    sttPct: 0.0625,      // 0.0625% on sell side (intraday) / 0.125% on ITM sell-to-close
    exchangeChargesPct: 0.003,
    gstPct: 18,
    sebiPct: 0.001,
    stampDutyPct: 0.002,
  });
  const [result, setResult] = useState<ExpCalcResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setError(null);
      const r = calculate(inputs);
      setResult(r);
    } catch (e: any) {
      setResult(null);
      setError(e?.message || "Calculation error");
    }
  }, [
    inputs.index,
    inputs.optionType,
    inputs.position,
    inputs.strike,
    inputs.entryPremium,
    inputs.currentLTP,
    inputs.lots,
    inputs.lotSize,
    inputs.spot,
    inputs.iv,
    inputs.timeHours,
    inputs.settlementPrice,
    inputs.settlementMode,
    inputs.brokeragePerOrder,
    inputs.sttPct,
    inputs.exchangeChargesPct,
    inputs.gstPct,
    inputs.sebiPct,
    inputs.stampDutyPct,
  ]);

  const handleInput = (k: keyof ExpCalcInputs, v: any) => {
    setInputs((prev) => ({ ...prev, [k]: v }));
  };

  const fmt = (n: number | null | undefined): string => {
    if (n == null || isNaN(n)) return "—";
    return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  };

  const pctColor = (v: number) => {
    if (v > 0) return "text-emerald-500";
    if (v < 0) return "text-red-500";
    return "text-[#7d8ba0]";
  };

  const meterColor = (m: string) => {
    switch (m) {
      case "Low": return "text-emerald-500 bg-emerald-500/10 border-emerald-500/30";
      case "Medium": return "text-yellow-500 bg-yellow-500/10 border-yellow-500/30";
      case "High": return "text-orange-500 bg-orange-500/10 border-orange-500/30";
      default: return "text-red-500 bg-red-500/10 border-red-500/30";
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-red-500 text-xs">
        <AlertTriangle className="h-8 w-8 mb-3" />
        <p>Calculator error: {error}</p>
      </div>
    );
  }
  if (!result) return null;

  const atmStrike = Math.round(result.settlementUsed / 50) * 50;

  return (
    <div className="flex flex-col h-full overflow-y-auto p-3 bg-[#0a0e14] text-[#dfe6ee]">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-violet-500" />
          <span className="font-bold text-sm">Expiry-Day Option Survival / Zero-Hero Calculator</span>
        </div>
        <Badge variant="outline" className="text-[9px] px-2 py-1">
          {inputs.settlementMode === "final" ? "FINAL SETTLEMENT" : "PROVISIONAL SETTLEMENT"}
        </Badge>
      </div>

      {/* Disclaimer */}
      <div className="bg-red-500/5 border border-red-500/20 rounded p-2 mb-3 text-[9px] text-red-400/90">
        Educational tool. Probabilities are model estimates, not predictions. Options trading involves substantial risk. Not investment advice.
      </div>

      {/* Inputs Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 mb-3">
        <InputRow label="Index" type="select" value={inputs.index} options={["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]} onChange={(v) => handleInput("index", v)} />
        <InputRow label="Option Type" type="select" value={inputs.optionType} options={["CE", "PE"]} onChange={(v) => handleInput("optionType", v)} />
        <InputRow label="Position" type="select" value={inputs.position} options={["BUY", "SELL"]} onChange={(v) => handleInput("position", v)} />
        <InputRow label="Strike" type="number" value={inputs.strike} step={50} onChange={(v) => handleInput("strike", Number(v))} />
        <InputRow label="Entry Premium" type="number" value={inputs.entryPremium} step={0.05} onChange={(v) => handleInput("entryPremium", Number(v))} />
        <InputRow label="Current LTP" type="number" value={inputs.currentLTP} step={0.05} onChange={(v) => handleInput("currentLTP", Number(v))} />
        <InputRow label="Lots" type="number" value={inputs.lots} step={1} onChange={(v) => handleInput("lots", Number(v))} />
        <InputRow label="Lot Size" type="number" value={inputs.lotSize} step={1} onChange={(v) => handleInput("lotSize", Number(v))} />
        <InputRow label="Spot Price" type="number" value={inputs.spot} step={0.05} onChange={(v) => handleInput("spot", Number(v))} />
        <InputRow label="IV / VIX (%)" type="number" value={inputs.iv} step={0.1} onChange={(v) => handleInput("iv", Number(v))} />
        <InputRow label="Hours to Expiry" type="number" value={inputs.timeHours} step={0.5} onChange={(v) => handleInput("timeHours", Number(v))} />
        <InputRow label="Settlement Price" type="number" value={inputs.settlementPrice ?? ""} step={0.05} onChange={(v) => handleInput("settlementPrice", v === "" ? undefined : Number(v))} />
        <InputRow label="Settlement Mode" type="select" value={inputs.settlementMode} options={["provisional", "final"]} onChange={(v) => handleInput("settlementMode", v)} />
      </div>

      {/* Charges */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
        <InputRow label="Brokerage/Order (₹)" type="number" value={inputs.brokeragePerOrder} step={1} onChange={(v) => handleInput("brokeragePerOrder", Number(v))} />
        <InputRow label="STT (%)" type="number" value={inputs.sttPct} step={0.001} onChange={(v) => handleInput("sttPct", Number(v))} />
        <InputRow label="Exchange (%)" type="number" value={inputs.exchangeChargesPct} step={0.001} onChange={(v) => handleInput("exchangeChargesPct", Number(v))} />
        <InputRow label="GST (%)" type="number" value={inputs.gstPct} step={0.1} onChange={(v) => handleInput("gstPct", Number(v))} />
        <InputRow label="SEBI (%)" type="number" value={inputs.sebiPct} step={0.001} onChange={(v) => handleInput("sebiPct", Number(v))} />
        <InputRow label="Stamp Duty (%)" type="number" value={inputs.stampDutyPct} step={0.001} onChange={(v) => handleInput("stampDutyPct", Number(v))} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Status</div>
          <div className={`font-bold ${result.status === "ITM" ? "text-emerald-500" : result.status === "OTM" ? "text-red-500" : "text-yellow-500"}`}>
            {result.status}
          </div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Expiry Value</div>
          <div className="font-bold text-emerald-500">₹{fmt(result.expiryValue)}</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Break-Even</div>
          <div className="font-bold text-blue-500">₹{fmt(result.breakEven)}</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">ITM Probability</div>
          <div className={`font-bold ${pctColor(result.probITM)}`}>{result.probITM.toFixed(1)}%</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Max Loss (Buyer)</div>
          <div className={`font-bold ${pctColor(-result.maxLossBuyer)}`}>₹{-result.maxLossBuyer}</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Net P&L After Charges</div>
          <div className={`font-bold ${pctColor(result.netPnLAfterCharges)}`}>₹{fmt(result.netPnLAfterCharges)}</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Risk Meter</div>
          <div className={`font-bold ${meterColor(result.riskMeter)}`}>{result.riskMeter}</div>
        </Card>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Distance to Strike</div>
          <div className="font-bold">{fmt(result.distanceToStrike)} pts ({fmt(result.distanceToStrikePct)}%)</div>
          <div className="text-[9px] text-muted-foreground mt-1">Expected Move: ₹{fmt(result.expectedMove)}</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Expected Value</div>
          <div className="font-bold text-emerald-500">₹{fmt(result.expectedValuePerUnit)} / unit</div>
          <div className="text-[9px] text-muted-foreground mt-1">₹{fmt(result.expectedValuePerLot)} / lot</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Settlement</div>
          <div className="font-bold text-blue-500">₹{fmt(result.settlementUsed)}</div>
          <div className="text-[9px] text-muted-foreground mt-1">{result.settlementLabel}</div>
        </Card>
        <Card className="border border-[#1f2733] bg-[#0f1117] p-2">
          <div className="text-[9px] text-[#7d8ba0] mb-1">Max Loss (Seller)</div>
          <div className={`font-bold ${pctColor(-Math.abs(Number(result.maxLossSeller)))}`}>{result.maxLossSeller}</div>
        </Card>
      </div>

      {/* Zero-Hero Flag */}
      {result.zeroHeroFlag && (
        <div className="bg-orange-500/10 border border-orange-500/40 rounded p-2 mb-3">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            <span className="font-bold text-orange-500 text-xs">🚫 ZERO-HERO FLAG — NO TRADE</span>
          </div>
          <p className="text-[10px] text-orange-400">{result.zeroHeroReason}</p>
        </div>
      )}

      {/* Cost-Trap Warning */}
      {result.costTrapWarning && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded p-2 mb-3">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="font-bold text-amber-500 text-xs">⚠️ COST TRAP — Charges eat a large share of profit</span>
          </div>
          <p className="text-[10px] text-amber-400">Square-off before expiry may be better than holding to settlement.</p>
        </div>
      )}

      {/* Payoff Diagram (SVG) */}
      <div className="border border-[#1f2733] bg-[#0f1117] rounded p-2 mb-3">
        <div className="text-[9px] text-[#7d8ba0] font-bold mb-2">Payoff Diagram at Expiry</div>
        <PayoffChart result={result} spot={inputs.spot} />
      </div>

      {/* Scenario Table */}
      <div className="border border-[#1f2733] bg-[#0f1117] rounded overflow-hidden">
        <div className="px-3 py-2 border-b border-[#1f2733] bg-[#10151d]/50">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-bold text-[#dfe6ee]">Settlement Scenario Table (₹{inputs.strike} − 300 to +300 in 50-pt steps)</span>
            <span className="text-[9px] text-muted-foreground">Highlighted: Break-Even</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[9px]">
            <thead>
              <tr className="bg-[#10151d] border-b border-[#1f2733]">
                <th className="px-2 py-1 text-left text-[#7d8ba0]">Settlement</th>
                <th className="px-2 py-1 text-right text-[#7d8ba0]">Expiry Value</th>
                <th className="px-2 py-1 text-right text-[#7d8ba0]">P&L / Lot</th>
                <th className="px-2 py-1 text-right text-[#7d8ba0]">Status</th>
              </tr>
            </thead>
            <tbody>
              {result.scenarioTable.map((row) => (
                <tr
                  key={row.settlement}
                  className={`border-b border-[#1f2733] ${row.isBreakEven ? "bg-emerald-500/20" : row.isSpot ? "bg-blue-500/10" : ""}`}
                >
                  <td className="px-2 py-1">{row.settlement}</td>
                  <td className="px-2 py-1 text-right font-mono">{fmt(row.expiryValue)}</td>
                  <td className={`px-2 py-1 text-right font-mono ${row.pnlPerLot >= 0 ? "text-emerald-500" : "text-red-500"}`}>{fmt(row.pnlPerLot)}</td>
                  <td className="px-2 py-1 text-right">
                    <span className={`text-[9px] ${row.status === "ITM" ? "text-emerald-500" : row.status === "OTM" ? "text-red-500" : "text-yellow-500"} font-bold`}>
                      {row.status}
                    </span>
                    {row.isBreakEven && <span className="ml-1 text-[8px] text-emerald-500">BE</span>}
                    {row.isSpot && <span className="ml-1 text-[8px] text-blue-500">SPOT</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Payoff Chart (SVG) ──────────────────────────────────────────────────────
function PayoffChart({ result, spot }: { result: ExpCalcResult; spot: number }) {
  const width = 420;
  const height = 180;
  const margin = { top: 20, right: 30, bottom: 30, left: 50 };
  const chartW = width - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;

  // Determine x range around strike
  const range = 400;
  const xMin = Math.max(0, result.settlementUsed - range);
  const xMax = result.settlementUsed + range;
  const yValues = result.scenarioTable.map((r) => r.pnlPerLot);
  const yMin = Math.min(0, ...yValues) * 1.2;
  const yMax = Math.max(0, ...yValues) * 1.2;

  const xScale = (v: number) => margin.left + ((v - xMin) / (xMax - xMin)) * chartW;
  const yScale = (v: number) => margin.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  const line = result.scenarioTable
    .map((r) => `${xScale(r.settlement)},${yScale(r.pnlPerLot)}`)
    .join(" ");

  return (
    <svg width={width} height={height} className="w-full max-w-md mx-auto">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerWidth="6" markerHeight="6">
          <path d="M0,0 L0,6 L9,3 z" fill="#2dd4a7" />
        </marker>
      </defs>
      {/* Axis */}
      <line x1={margin.left} y1={yScale(0)} x2={margin.left + chartW} y2={yScale(0)} stroke="#334155" strokeWidth={1} />
      <line x1={xScale(result.settlementUsed)} y1={margin.top} x2={xScale(result.settlementUsed)} y2={margin.top + chartH} stroke="#334155" strokeWidth={1} strokeDasharray="4" />
      {/* Payoff line */}
      <path d={line} stroke="#2dd4a7" strokeWidth={2} fill="none" />
      {/* Zero line label */}
      <text x={margin.left + 5} y={yScale(0) - 5} fill="#94a3b8" fontSize={10}>0</text>
      {/* Strike label */}
      <text x={xScale(result.settlementUsed)} y={margin.top + chartH + 15} fill="#94a3b8" fontSize={10} textAnchor="middle">{result.settlementUsed}</text>
      {/* Spot line */}
      {spot !== result.settlementUsed && (
        <>
          <line x1={xScale(spot)} y1={margin.top} x2={xScale(spot)} y2={margin.top + chartH} stroke="#3b82f6" strokeWidth={1} strokeDasharray="2" />
          <text x={xScale(spot)} y={margin.top - 8} fill="#3b82f6" fontSize={10} textAnchor="middle">Spot {spot}</text>
        </>
      )}
    </svg>
  );
}

// ─── Input Row ─────────────────────────────────────────────────────────────────
function InputRow({
  label,
  type,
  value,
  step,
  options,
  onChange,
}: {
  label: string;
  type: "number" | "select" | "text";
  value: string | number | undefined | null;
  step?: number;
  options?: string[];
  onChange: (v: string | number) => void;
}) {
  const strVal = value == null ? "" : String(value);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] text-[#7d8ba0]">{label}</label>
      {type === "select" ? (
        <select
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[#0d121a] border border-[#1f2733] rounded px-2 py-1.5 text-[10px] text-[#dfe6ee] outline-none focus:border-[#2dd4a7]"
        >
          {options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          step={step}
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[#0d121a] border border-[#1f2733] rounded px-2 py-1.5 text-[10px] text-[#dfe6ee] outline-none focus:border-[#2dd4a7]"
        />
      )}
    </div>
  );
}


