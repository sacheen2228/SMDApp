// DailyDerivativesPanel — "Daily Derivatives" view using DailyDerivativesService
// Displays: India VIX, PCR, Max Pain, OI Walls, ATM Greeks, Signals, Sentiment
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TargetReach } from "@/lib/option-plan";
import {
  CalendarClock,
  TrendingUp,
  TrendingDown,
  ShieldOff,
  RefreshCw,
  AlertTriangle,
  Activity,
  Gauge,
  Target,
  BarChart2,
  Zap,
  Compass,
  RotateCcw,
  Crosshair,
  ShieldCheck,
  Waves,
  Landmark,
  Users,
} from "lucide-react";

interface Signal {
  index: number;
  time: number | string;
  type: "CROSSOVER" | "PULLBACK" | "BREAKOUT" | "RETEST" | "FAKEOUT" | "REVERSAL";
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  targets: number[];
  strength: number;
  reason: string;
}

interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  /** Where delta came from: the provider's own greeks, our BS(IV) computation, or unknown. */
  deltaSource?: "provider" | "bs" | null;
}

interface TradePlanCard {
  optionType: "CE" | "PE";
  strike: number;
  entry: number;
  stopLoss: number;
  targets: number[];
  rr: number;
  lots: number;
  deployed: number;
  riskAmount: number;
  tradable: boolean;
  otmSteps: number;
  reason: string;
  livePremium?: number;
  setup?: string;
  targetReach?: TargetReach[];
}

interface DirectionVote {
  factor: string;
  vote: "CALL" | "PUT" | "NEUTRAL";
  detail: string;
}

interface DirectionBias {
  side: "CALL" | "PUT" | "NEUTRAL";
  callVotes: number;
  putVotes: number;
  confidence: number;
  votes: DirectionVote[];
}

interface CvdProxy {
  mode: "CANDLE_PROXY" | "FUTURES_CANDLE_SIGN";
  available: boolean;
  bars: number;
  windowBars: number;
  cumulative: number;
  deltaPercent: number;
  estimatedBuyVolume: number;
  estimatedSellVolume: number;
  totalVolume: number;
  priceChangePercent: number;
  cvdChange: number;
  verdict: "BULLISH" | "BEARISH" | "BULLISH_DIVERGENCE" | "BEARISH_DIVERGENCE" | "NEUTRAL" | "UNAVAILABLE";
  points: { time: number | string; cvd: number; delta: number; volume: number; price: number }[];
  source?: string;
  contract?: string;
  oiFirst?: number;
  oiLast?: number;
  oiChange?: number;
  oiChangePct?: number;
  buildup?: "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL" | null;
  divergence?: string | null;
  note?: string;
}

interface CvdFallback {
  source: "moapi";
  contract: string;
  dayVolume: number;
  openInterest: number | null;
  asOf: string;
  note: string;
}

interface DailyDerivativesReport {
  underlying: "NIFTY" | "SENSEX";
  timestamp: string;
  spot: number;
  indiaVix: number;
  indiaVixChange: number;
  /** True when NSE VIX was unreachable and the 15.70 fallback was used. */
  indiaVixEstimated?: boolean;
  pcr: number;
  maxPain: number;
  callWall: number;
  putWall: number;
  totalCallOI: number;
  totalPutOI: number;
  atmStrike: number;
  atmIV: number;
  atmGreeks?: Greeks;
  /** provider greeks | the data layer's BS(IV) | the card's implied-premium fallback */
  atmGreeksSource?: "provider" | "bs" | "implied" | null;
  /** The LIVE chain's per-strike Greeks (CE/PE) — never a fabricated zero. */
  greeks?: { strike: number; ce?: Greeks; pe?: Greeks }[];
  chainFallbackUsed?: boolean;
  chainTimestamp?: string;
  indiaVixSource?: "nse" | "atm-iv" | "estimate";
  topCallOI: { strike: number; oi: number; oiChange: number }[];
  topPutOI: { strike: number; oi: number; oiChange: number }[];
  expiry: string;
  daysToExpiry: number;
  latestSignals: Signal[];
  sentiment: "Extreme Greed" | "Bullish" | "Neutral" | "Bearish" | "Extreme Fear";
  sentimentScore: number;
  tradePlans: TradePlanCard[];
  planAsOf?: string;
  preferredSide: "CALL" | "PUT" | null;
  directionBias: DirectionBias;
  /** Which provider priced the card (NSE / MOAPI / BHAVCOPY / ...) */
  dataSource: string;
  freshness?: string;
  candleSource: string;
  candleInterval: string;
  candleDegraded: string | null;
  candleCount: number;
  warmupBars: number;
  /** The shared session module's verdict — lets the UI say "market closed"
   *  instead of "Engine warming up" on a non-trading day. */
  marketSession?: {
    session: string;
    label: string;
    description: string;
    isMarketOpen: boolean;
  };
  sellerIntel?: SellerIntel;
  cvd?: CvdProxy;
  /** Rel volume of the last CLOSED futures bar vs its 20-bar avg — the honest fake-breakout half. */
  futuresRelVol?: {
    ratio: number;
    average: number;
    current: number;
    barTime?: number | string;
  } | null;
  cvdFallback?: CvdFallback;
}

interface SellerIntel {
  symbol: string;
  asOf: string;
  lotSize: number;
  verdict: {
    signal: "BUY_CE" | "BUY_PE" | "WAIT";
    direction: "BULLISH" | "BEARISH" | "NEUTRAL";
    score: number;
    confidence: number;
    reasons: string[];
    warnings: string[];
    entryConfirmed: boolean;
    requiresRetest: boolean;
  };
  market: {
    underlyingChangePct: number;
    vwap: number;
    currentPrice: number;
    breakoutConfirmed: boolean;
    retestConfirmed: boolean;
  };
  zones: {
    strike: number;
    type: "CE" | "PE";
    status: string;
    zoneLow: number;
    zoneHigh: number;
    pressureScore: number;
    classification: string;
    direction: string;
  }[];
  topWriting: SellerBoardRow[];
  topCovering: SellerBoardRow[];
  exposure: {
    callDex: number;
    putDex: number;
    netDex: number;
    totalGex: number;
    gammaFlip: number;
    dealerRegime: string;
    dealerBias: string;
    gammaWalls: { strike: number; type: "CE" | "PE"; gex: number; oi: number }[];
  };
  dataNotes: string[];
}

interface SellerBoardRow {
  strike: number;
  type: "CE" | "PE";
  oi: number;
  oiChangePct: number;
  premiumChangePct: number;
  classification: string;
  score: number;
  volumeRatio: number;
  delta: number;
}

interface ApiResponse {
  success: boolean;
  data?: DailyDerivativesReport;
  error?: string;
}

const SYMBOLS = ["NIFTY", "SENSEX"] as const;
const SENTIMENT_COLORS: Record<string, string> = {
  "Extreme Greed": "text-emerald-400",
  "Bullish": "text-emerald-400",
  "Neutral": "text-amber-400",
  "Bearish": "text-rose-400",
  "Extreme Fear": "text-rose-400",
};
const SENTIMENT_BG: Record<string, string> = {
  "Extreme Greed": "bg-emerald-500/20",
  "Bullish": "bg-emerald-500/10",
  "Neutral": "bg-amber-500/10",
  "Bearish": "bg-rose-500/10",
  "Extreme Fear": "bg-rose-500/20",
};

const CVD_VERDICT_META: Record<string, { label: string; color: string; bg: string }> = {
  BULLISH: { label: "BUYER CONTROL", color: "text-emerald-400", bg: "bg-emerald-500/20" },
  BEARISH: { label: "SELLER CONTROL", color: "text-rose-400", bg: "bg-rose-500/20" },
  BULLISH_DIVERGENCE: { label: "BULLISH DIVERGENCE", color: "text-amber-400", bg: "bg-amber-500/20" },
  BEARISH_DIVERGENCE: { label: "BEARISH DIVERGENCE", color: "text-amber-400", bg: "bg-amber-500/20" },
  NEUTRAL: { label: "NEUTRAL FLOW", color: "text-muted-foreground", bg: "bg-muted" },
  UNAVAILABLE: { label: "NO DATA", color: "text-muted-foreground", bg: "bg-muted" },
};

const BUILDUP_META: Record<string, { label: string; color: string; bg: string }> = {
  LONG_BUILDUP: { label: "LONG BUILDUP", color: "text-emerald-400", bg: "bg-emerald-500/15" },
  SHORT_BUILDUP: { label: "SHORT BUILDUP", color: "text-rose-400", bg: "bg-rose-500/15" },
  SHORT_COVERING: { label: "SHORT COVERING", color: "text-sky-400", bg: "bg-sky-500/15" },
  LONG_UNWINDING: { label: "LONG UNWINDING", color: "text-amber-400", bg: "bg-amber-500/15" },
  NEUTRAL: { label: "OI NEUTRAL", color: "text-muted-foreground", bg: "bg-muted" },
};

function cvdBiasBadge(
  verdict: string,
  biasSide: "CALL" | "PUT" | "NEUTRAL" | undefined,
): { label: string; color: string; bg: string } {
  if (verdict === "UNAVAILABLE") return { label: "NO DATA", color: "text-muted-foreground", bg: "bg-muted" };
  if (verdict === "BULLISH_DIVERGENCE" || verdict === "BEARISH_DIVERGENCE") {
    return { label: "DIVERGENCE — REVIEW", color: "text-amber-400", bg: "bg-amber-500/15" };
  }
  if (verdict === "NEUTRAL" || !biasSide || biasSide === "NEUTRAL") {
    return { label: "NEUTRAL", color: "text-muted-foreground", bg: "bg-muted" };
  }
  const confirms =
    (verdict === "BULLISH" && biasSide === "CALL") || (verdict === "BEARISH" && biasSide === "PUT");
  return confirms
    ? { label: "CONFIRMS BIAS", color: "text-emerald-400", bg: "bg-emerald-500/15" }
    : { label: "CONFLICTS BIAS", color: "text-rose-400", bg: "bg-rose-500/15" };
}

function CvdSparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 28 - ((v - min) / range) * 26;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const zeroY = 28 - ((0 - min) / range) * 26;
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="w-full h-16">
      <line x1="0" y1={zeroY} x2="100" y2={zeroY} stroke="var(--ty-muted-fg)" strokeWidth="0.4" strokeDasharray="2 2" opacity="0.5" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function DailyDerivativesPanel({ symbol: initialSymbol = "NIFTY" }: { symbol?: string }) {
  const [symbol, setSymbol] = useState<string>(SYMBOLS.includes(initialSymbol as any) ? (initialSymbol as any) : "NIFTY");
  const [report, setReport] = useState<DailyDerivativesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Side live feeds — the same provider pipeline the other tabs read
  // (NSE FII/DII, OI classification, premium acceleration).
  const [fiiDii, setFiiDii] = useState<any>(null);
  const [institutional, setInstitutional] = useState<any>(null);
  const [greekFlow, setGreekFlow] = useState<any>(null);
  /** True while the side feeds are still in flight — a slow provider is not "unavailable". */
  const [feedsLoading, setFeedsLoading] = useState(true);
  // Monotonic request id — a stale response never clobbers a newer one.
  const reqIdRef = useRef(0);

  /**
   * The side live feeds — FII/DII, institutional positioning and the premium
   * acceleration engine. They are heavy (the greek-flow engine runs the whole
   * acceleration stack), so they load ONCE per mount / symbol and on the
   * manual Refresh — never on the 5-minute card refresh, which would hammer
   * the providers. A dead feed degrades to "unavailable" on its own and never
   * blocks the card.
   */
  const loadFeeds = useCallback(async () => {
    setFeedsLoading(true);
    const timed = (url: string, ms = 60000) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ms);
      return fetch(url, { signal: ac.signal }).then((r) => r.json()).finally(() => clearTimeout(timer));
    };
    const [f, i, g] = await Promise.allSettled([
      timed("/api/fii-dii"),
      // Index-level feed — the persisted snapshot path (`fast=1`): the full
      // NSE participant-OI scan can take ~5 minutes, the snapshot answers in
      // seconds. The payload says which path produced it.
      timed("/api/institutional-positioning?fast=1", 45000),
      timed("/api/greek-flow?symbol=" + encodeURIComponent(symbol)),
    ]);
    setFeedsLoading(false);
    // Keep the WHOLE payload: /api/fii-dii puts the flows at the top level
    // and only the provenance meta under `data` — merge them so the card can
    // read both the numbers and the source stamp from one object.
    if (f.status === "fulfilled") {
      const v: any = f.value ?? null;
      setFiiDii(v ? { ...(v.data ?? {}), ...v } : null);
    }
    if (i.status === "fulfilled") setInstitutional(i.value ?? null);
    if (g.status === "fulfilled") setGreekFlow(g.value ?? null);
  }, [symbol]);

  const load = useCallback(async (force = false) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/daily-derivatives?symbol=${encodeURIComponent(symbol)}${force ? "&refresh=1" : ""}`,
        { cache: "no-store" }
      );
      const json: ApiResponse = await res.json();
      if (reqId !== reqIdRef.current) return; // superseded by a newer load
      if (!json.success) throw new Error(json.error || "failed");
      setReport(json.data!);
    } catch (e: any) {
      if (reqId === reqIdRef.current) setError(e?.message || "Failed to load");
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [symbol]);

  // Follow the parent symbol when it changes to a supported symbol — the
  // initial value was only read on mount before, so a NIFTY → SENSEX switch
  // elsewhere in the app left this panel stuck on NIFTY.
  useEffect(() => {
    if (SYMBOLS.includes(initialSymbol as any) && initialSymbol !== symbol) {
      setSymbol(initialSymbol as any);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSymbol]);

  useEffect(() => { load(); }, [load]);
  // The side feeds start only AFTER the card is up (they are heavy — the
  // greek-flow engine runs the whole acceleration stack) and only once per
  // symbol, so they never queue behind the primary report request.
  const feedsForSymbol = useRef<string | null>(null);
  useEffect(() => {
    if (!report) return;
    if (feedsForSymbol.current === symbol) return;
    feedsForSymbol.current = symbol;
    loadFeeds();
  }, [report, symbol, loadFeeds]);
  useEffect(() => {
    const t = setInterval(load, 300000); // 5 min refresh
    return () => clearInterval(t);
  }, [load]);

  const formatNumber = (n: number): string => {
    const sign = n < 0 ? "-" : "";
    const a = Math.abs(n);
    if (a >= 10000000) return sign + (a / 10000000).toFixed(2) + " Cr";
    if (a >= 100000) return sign + (a / 100000).toFixed(2) + " L";
    if (a >= 1000) return sign + (a / 1000).toFixed(1) + " K";
    return n.toString();
  };

  const formatOI = (n: number): string => {
    const sign = n < 0 ? "-" : "";
    const a = Math.abs(n);
    if (a >= 10000000) return sign + (a / 10000000).toFixed(2) + " Cr";
    if (a >= 100000) return sign + (a / 100000).toFixed(2) + " L";
    return n.toLocaleString("en-IN");
  };

  const SignalBadge = ({ type, side, strength, time, reason }: { type: string; side: string; strength: number; time?: string; reason?: string }) => {
    const isLong = side === "LONG";
    const bg = isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400";
    const icon = type === "BREAKOUT" ? <Zap className="h-2.5 w-2.5" /> :
                 type === "CROSSOVER" ? <Activity className="h-2.5 w-2.5" /> :
                 type === "PULLBACK" ? <RotateCcw className="h-2.5 w-2.5" /> :
                 type === "RETEST" ? <Target className="h-2.5 w-2.5" /> :
                 type === "REVERSAL" ? <Compass className="h-2.5 w-2.5" /> :
                 <AlertTriangle className="h-2.5 w-2.5" />;
    return (
      <span title={reason} className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${bg}`}>
        {icon} {type} {isLong ? "↑" : "↓"} ({strength}){time ? <span className="font-mono font-normal opacity-70">{time}</span> : null}
      </span>
    );
  };

  const MetricCard = ({ label, value, icon: Icon, color = "text-violet-400", subValue }: { label: string; value: string | number; icon: React.ComponentType<{ className?: string }>; color?: string; subValue?: string }) => (
    <div className="bg-card/50 border border-border/50 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`h-4 w-4 ${color}`} />
        <span className="text-[12px] text-muted-foreground font-medium">{label}</span>
      </div>
      <div className="font-mono text-[16px] font-bold text-foreground">{value}</div>
      {subValue && <div className="text-[11px] text-muted-foreground mt-0.5">{subValue}</div>}
    </div>
  );

  const cvd = report?.cvd;
  const cvdMeta = CVD_VERDICT_META[cvd?.verdict ?? "UNAVAILABLE"] ?? CVD_VERDICT_META.UNAVAILABLE;
  const cvdBias = cvdBiasBadge(cvd?.verdict ?? "UNAVAILABLE", report?.directionBias?.side);
  const cvdSeries = (cvd?.points ?? []).slice(-24).map((p) => p.cvd);
  const buildupMeta = cvd?.buildup ? BUILDUP_META[cvd.buildup] : undefined;

  if (!report && loading) {
    return (
      <div className="p-3 max-w-3xl mx-auto">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-violet-500 mx-auto mb-2" />
            <p className="text-base text-muted-foreground">Loading Daily Derivatives...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 max-w-5xl mx-auto space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-violet-500" />
          <span className="text-[15px] font-bold text-foreground">Daily Derivatives</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`h-6 text-[12px] px-2 font-bold rounded ${symbol === s ? "bg-violet-600 text-white" : "text-muted-foreground hover:text-violet-400"}`}
              >
                {s}
              </button>
            ))}
          </div>
          <button onClick={() => { load(true); loadFeeds(); }} disabled={loading} className="flex items-center gap-1 text-[12px] px-2 py-1 rounded bg-muted hover:bg-muted/70 text-muted-foreground">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="text-[14px] text-rose-400 p-3 bg-rose-500/10 rounded">{error}</div>}

      {/* LIVE PROVENANCE — which provider priced this card, and when */}
      {report && (
        <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
          <span className="px-1.5 py-0.5 rounded bg-muted/40 font-mono">{report.dataSource}</span>
          {report.freshness && <span className="px-1.5 py-0.5 rounded bg-muted/40 font-mono">{report.freshness}</span>}
          {report.chainFallbackUsed && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono">FALLBACK PROVIDER</span>
          )}
          {report.chainTimestamp && (
            <span className="font-mono">
              priced {new Date(report.chainTimestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
            </span>
          )}
          {report.atmGreeksSource && (
            <span className="font-mono">
              ATM greeks: {report.atmGreeksSource === "provider" ? "provider" : report.atmGreeksSource === "bs" ? "BS from provider IV" : "implied from premium"}
            </span>
          )}
          {report.indiaVixSource && (
            <span className="font-mono">
              VIX: {report.indiaVixSource === "nse" ? "NSE" : report.indiaVixSource === "atm-iv" ? "chain ATM IV" : "stated estimate"}
            </span>
          )}
        </div>
      )}

      {report && (
        <>
          {/* Top Metrics Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
            <MetricCard
              label="Spot"
              value={report.spot.toFixed(2)}
              icon={Gauge}
              color="text-cyan-400"
              subValue={`${report.underlying} • ${new Date(report.timestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}`}
            />
            <MetricCard
              label="India VIX"
              value={report.indiaVixEstimated ? `~${report.indiaVix.toFixed(2)}` : report.indiaVix.toFixed(2)}
              icon={Activity}
              color={report.indiaVix > 20 ? "text-rose-400" : report.indiaVix < 13 ? "text-emerald-400" : "text-amber-400"}
              subValue={
                report.indiaVixSource === "atm-iv"
                  ? "chain ATM IV"
                  : report.indiaVixSource === "estimate"
                  ? "stated estimate"
                  : report.indiaVixEstimated
                  ? "fallback"
                  : `${report.indiaVixChange >= 0 ? "+" : ""}${report.indiaVixChange.toFixed(2)}`
              }
            />
            <MetricCard
              label="PCR"
              value={report.pcr.toFixed(3)}
              icon={BarChart2}
              color={report.pcr > 1.2 ? "text-emerald-400" : report.pcr < 0.8 ? "text-rose-400" : "text-amber-400"}
              subValue={report.pcr > 1 ? "Bullish" : report.pcr < 0.85 ? "Bearish" : "Neutral"}
            />
            <MetricCard
              label="Max Pain"
              value={report.maxPain.toLocaleString("en-IN")}
              icon={Target}
              color="text-sky-400"
            />
            <MetricCard
              label="Call Wall"
              value={report.callWall.toLocaleString("en-IN")}
              icon={TrendingUp}
              color="text-rose-400"
            />
            <MetricCard
              label="Put Wall"
              value={report.putWall.toLocaleString("en-IN")}
              icon={TrendingDown}
              color="text-emerald-400"
            />
            <MetricCard
              label="ATM IV"
              value={`${report.atmIV}%`}
              icon={Zap}
              color="text-purple-400"
              subValue={`Strike: ${report.atmStrike}`}
            />
          </div>

          {/* OI Summary Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCard
              label="Total Call OI"
              value={formatOI(report.totalCallOI)}
              icon={TrendingUp}
              color="text-rose-400"
            />
            <MetricCard
              label="Total Put OI"
              value={formatOI(report.totalPutOI)}
              icon={TrendingDown}
              color="text-emerald-400"
            />
            <MetricCard
              label="ATM Delta"
              value={report.atmGreeks?.delta?.toFixed(3) || "—"}
              icon={Gauge}
              color="text-cyan-400"
            />
            <MetricCard
              label="ATM Theta"
              value={report.atmGreeks?.theta?.toFixed(2) || "—"}
              icon={CalendarClock}
              color="text-amber-400"
            />
          </div>

          {/* Sentiment & Expiry */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-card/50 border border-border/50 rounded-lg">
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-muted-foreground">Market Sentiment:</span>
              <span className={`px-3 py-1 rounded-full text-[13px] font-bold ${SENTIMENT_COLORS[report.sentiment]} ${SENTIMENT_BG[report.sentiment]}`}>
                {report.sentiment} ({report.sentimentScore}/100)
              </span>
            </div>
            <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
              <span>Expiry: <span className="font-mono text-foreground">{report.expiry.split("T")[0]}</span></span>
              <span>•</span>
              <span>DTE: <span className="font-mono text-foreground">{report.daysToExpiry} days</span></span>
              <span>•</span>
              <span>ATM Strike: <span className="font-mono text-foreground">{report.atmStrike}</span></span>
            </div>
          </div>

          {/* Direction Bias — which side and why */}
          {report.directionBias && (
            <div className={`rounded-lg border p-3 ${report.directionBias.side === "CALL" ? "border-emerald-500/40 bg-emerald-500/5" : report.directionBias.side === "PUT" ? "border-rose-500/40 bg-rose-500/5" : "border-border/50 bg-card/50"}`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <Compass className="h-4 w-4 text-violet-400" />
                  <span className="text-[13px] font-bold text-foreground">Direction</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {report.directionBias.callVotes} CE vs {report.directionBias.putVotes} PE · {report.directionBias.confidence}% conf
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[12px] font-bold ${
                    report.directionBias.side === "CALL" ? "bg-emerald-500/20 text-emerald-400"
                    : report.directionBias.side === "PUT" ? "bg-rose-500/20 text-rose-400"
                    : "bg-amber-500/20 text-amber-400"
                  }`}>
                    {report.directionBias.side === "NEUTRAL" ? "NO EDGE — WAIT" : `GO ${report.directionBias.side === "CALL" ? "CE" : "PE"}`}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-1">
                {report.directionBias.votes.map((v, i) => (
                  <div key={i} className={`rounded p-1.5 text-[11px] ${
                    v.vote === "CALL" ? "bg-emerald-500/10" : v.vote === "PUT" ? "bg-rose-500/10" : "bg-muted/40"
                  }`}>
                    <div className={`font-bold ${v.vote === "CALL" ? "text-emerald-400" : v.vote === "PUT" ? "text-rose-400" : "text-muted-foreground"}`}>
                      {v.factor}: {v.vote === "NEUTRAL" ? "—" : v.vote}
                    </div>
                    <div className="text-muted-foreground leading-snug mt-0.5">{v.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* LIVE PIPELINE FEEDS — FII/DII, institutional positioning, premium acceleration.
              The same provider feeds the other tabs read; each degrades to
              "unavailable" on its own and never blocks the card. */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* FII / DII */}
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-amber-400" />
                  <span className="text-[13px] font-bold text-foreground">FII / DII Flow</span>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {fiiDii?.sourceLabel || fiiDii?.source || ""}
                </span>
              </div>
              {fiiDii && fiiDii.fiiNet != null ? (
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div className="bg-card/70 rounded p-2">
                    <div className="text-muted-foreground text-[10px]">FII net</div>
                    <div className={`font-mono font-bold ${fiiDii.fiiNet >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      ₹{fiiDii.fiiNet.toFixed(0)} Cr
                    </div>
                  </div>
                  <div className="bg-card/70 rounded p-2">
                    <div className="text-muted-foreground text-[10px]">DII net</div>
                    <div className={`font-mono font-bold ${fiiDii.diiNet >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      ₹{fiiDii.diiNet.toFixed(0)} Cr
                    </div>
                  </div>
                  <div className="col-span-2 text-[10px] text-muted-foreground">
                    FII buy ₹{fiiDii.fiiBuy.toFixed(0)} Cr / sell ₹{fiiDii.fiiSell.toFixed(0)} Cr ·
                    DII buy ₹{fiiDii.diiBuy.toFixed(0)} Cr / sell ₹{fiiDii.diiSell.toFixed(0)} Cr
                    {fiiDii.ageLabel ? ` · ${fiiDii.ageLabel}` : ""}
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">
                  {!fiiDii && feedsLoading ? "loading…" : fiiDii?.reason || fiiDii?.error || "FII/DII feed unavailable"}
                </div>
              )}
            </div>

            {/* Institutional positioning */}
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-rose-400" />
                  <span className="text-[13px] font-bold text-foreground">Institutional Positioning</span>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {institutional?.source === "db" ? "persisted snapshot" : institutional?.source === "nse" ? "NSE scan" : ""}
                  {institutional?.dateLabel || institutional?.date ? ` · ${institutional?.dateLabel || institutional?.date}` : ""}
                </span>
              </div>
              {institutional && institutional.bias ? (
                <div className="space-y-1.5 text-[12px]">
                  <div className="flex items-center justify-between bg-card/70 rounded p-2">
                    <span className="text-muted-foreground text-[10px]">Smart money bias</span>
                    <span className={`font-mono font-bold uppercase ${
                      institutional.bias.dominantDirection === "bullish" ? "text-emerald-400"
                      : institutional.bias.dominantDirection === "bearish" ? "text-rose-400"
                      : "text-muted-foreground"
                    }`}>
                      {institutional.bias.dominantDirection} · {institutional.bias.bullishPct}% bull / {institutional.bias.bearishPct}% bear
                    </span>
                  </div>
                  <div className="flex items-center justify-between bg-card/70 rounded p-2">
                    <span className="text-muted-foreground text-[10px]">Source alignment</span>
                    <span className="font-mono">{institutional.alignment?.overallAlignment ?? "—"}%</span>
                  </div>
                  {institutional.aiSummary && (
                    <div className="text-[10px] text-muted-foreground leading-snug line-clamp-4">
                      {institutional.aiSummary}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">
                  {!institutional && feedsLoading ? "loading…" : institutional?.warning || institutional?.error || "Institutional positioning unavailable"}
                </div>
              )}
            </div>

            {/* Premium acceleration (greek flow) */}
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-violet-400" />
                  <span className="text-[13px] font-bold text-foreground">Premium Acceleration</span>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {greekFlow?.availability?.strikesAnalysed != null
                    ? `${greekFlow.availability.strikesAnalysed} strikes`
                    : ""}
                </span>
              </div>
              {greekFlow?.result ? (
                <div className="space-y-1.5 text-[12px]">
                  <div className="flex items-center justify-between bg-card/70 rounded p-2">
                    <span className="text-muted-foreground text-[10px]">Expected move (1σ)</span>
                    <span className="font-mono">
                      {greekFlow.availability?.expectedMove?.available
                        ? `±${greekFlow.availability.expectedMove.value}`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between bg-card/70 rounded p-2">
                    <span className="text-muted-foreground text-[10px]">VIX used</span>
                    <span className="font-mono">
                      {greekFlow.availability?.vix?.used ?? "—"}
                      <span className="text-[9px] text-muted-foreground ml-1">
                        ({greekFlow.availability?.vix?.source || "—"})
                      </span>
                    </span>
                  </div>
                  {greekFlow.availability?.legsUnavailable > 0 && (
                    <div className="text-[10px] text-amber-400">
                      {greekFlow.availability.legsUnavailable} legs the chain could not price — excluded, never zeroed.
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">
                  {!greekFlow && feedsLoading ? "loading…" : greekFlow?.error || "Premium acceleration feed unavailable"}
                </div>
              )}
            </div>
          </div>

          {/* CVD — context only, never a trade vote */}
          {cvd && (
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Waves className="h-4 w-4 text-cyan-400" />
                  <span className="text-[13px] font-bold text-foreground">
                    {cvd.mode === "FUTURES_CANDLE_SIGN" ? "CVD — Futures (real traded volume)" : "CVD — 5m Candle Sign"}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {cvd.contract ? `${cvd.contract} · ${cvd.source ?? "breeze"} · ` : ""}
                    {"close > open = up-bar · close < open = down-bar · "}
                    {cvd.bars} bars · last {cvd.windowBars}-bar window
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${cvdMeta.bg} ${cvdMeta.color}`}>
                    {cvdMeta.label}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${cvdBias.bg} ${cvdBias.color}`}>
                    {cvdBias.label}
                  </span>
                </div>
              </div>
              {cvd.available ? (
                <>
                  <div className={`mb-2 ${cvdMeta.color}`}>
                    <CvdSparkline values={cvdSeries} />
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-1.5 text-[12px]">
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">CVD</div>
                      <div className={`font-mono font-bold ${cvd.cumulative >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {cvd.cumulative >= 0 ? "+" : ""}{formatNumber(Math.round(cvd.cumulative))}
                      </div>
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">Delta %</div>
                      <div className={`font-mono font-bold ${cvd.deltaPercent >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {cvd.deltaPercent >= 0 ? "+" : ""}{cvd.deltaPercent.toFixed(1)}%
                      </div>
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">Up-bar Vol</div>
                      <div className="font-mono text-emerald-400 font-bold">{formatNumber(Math.round(cvd.estimatedBuyVolume))}</div>
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">Down-bar Vol</div>
                      <div className="font-mono text-rose-400 font-bold">{formatNumber(Math.round(cvd.estimatedSellVolume))}</div>
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">Price Δ ({cvd.windowBars} bars)</div>
                      <div className={`font-mono font-bold ${cvd.priceChangePercent >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {cvd.priceChangePercent >= 0 ? "+" : ""}{cvd.priceChangePercent.toFixed(2)}%
                      </div>
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">OI Δ (session)</div>
                      {cvd.oiChange != null ? (
                        <>
                          <div className={`font-mono font-bold ${cvd.oiChange >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {cvd.oiChange >= 0 ? "+" : ""}{formatNumber(Math.round(cvd.oiChange))}
                          </div>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {cvd.oiChangePct != null ? `${cvd.oiChangePct >= 0 ? "+" : ""}${cvd.oiChangePct.toFixed(2)}%` : ""}
                          </div>
                        </>
                      ) : (
                        <div className="font-mono text-muted-foreground">n/a</div>
                      )}
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground" title="Last CLOSED futures bar vs its prior 20-bar average — the honest fake-breakout test, pair it with ΔOI">
                        Rel Vol
                      </div>
                      {report.futuresRelVol ? (
                        <>
                          <div className={`font-mono font-bold ${report.futuresRelVol.ratio >= 2 ? "text-emerald-400" : report.futuresRelVol.ratio >= 1 ? "text-amber-400" : "text-muted-foreground"}`}>
                            {report.futuresRelVol.ratio.toFixed(2)}x
                          </div>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {report.futuresRelVol.ratio >= 2 ? "conviction bar" : `avg ${formatNumber(Math.round(report.futuresRelVol.average))}`}
                          </div>
                        </>
                      ) : (
                        <div className="font-mono text-muted-foreground">n/a</div>
                      )}
                    </div>
                  </div>
                  {buildupMeta && (
                    <div className="mt-2 flex items-center gap-2 flex-wrap text-[12px]">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${buildupMeta.bg} ${buildupMeta.color}`}>
                        {buildupMeta.label}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        price vs open interest (session) · OI {formatNumber(Math.round(cvd.oiLast ?? 0))}
                        {cvd.oiFirst != null ? ` (from ${formatNumber(Math.round(cvd.oiFirst))})` : ""}
                      </span>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
                    {cvd.mode === "FUTURES_CANDLE_SIGN" ? (
                      <>
                        Real traded volume and open interest from {cvd.contract ?? "the futures contract"} (Breeze). Buy/sell split is
                        signed by candle direction because no aggressor-side tape exists for these indices. Display only — it never votes
                        on direction and never changes strike, SL/TP, sizing or alerts.
                      </>
                    ) : (
                      <>
                        Volume is signed by candle direction because no trade-side (aggressor) feed is wired for this index.
                        It never votes on direction, and it does not change strike, SL/TP, sizing or alerts.
                      </>
                    )}
                  </p>
                </>
              ) : report.cvdFallback ? (
                <div className="space-y-1">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 text-[12px]">
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">Futures Day Volume (MOAPI)</div>
                      <div className="font-mono text-foreground font-bold">
                        {formatNumber(Math.round(report.cvdFallback.dayVolume))}
                      </div>
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">Contract</div>
                      <div className="font-mono text-foreground font-bold">{report.cvdFallback.contract}</div>
                    </div>
                    <div className="bg-muted/40 rounded p-1.5">
                      <div className="text-muted-foreground">Open Interest</div>
                      <div className="font-mono text-muted-foreground">
                        {report.cvdFallback.openInterest != null ? formatNumber(report.cvdFallback.openInterest) : "n/a (MO publishes none)"}
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {report.cvdFallback.note} CVD curve and ΔOI stay empty rather than showing a fake zero.
                  </p>
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  No session volume available for CVD — the card stays empty instead of showing a neutral-looking zero.
                </p>
              )}
            </div>
          )}

          {/* Trade Plans — Strike • Entry • SL • TP */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-emerald-400" />
                <span className="text-[13px] font-bold text-foreground">Trade Plan — Strike • Entry • SL • TP</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">₹45k budget · risk 20% of deployed · TP 2R/3R/4R</span>
                {report.planAsOf && (
                  <span className="text-[11px] text-violet-300/90">levels as of {report.planAsOf}</span>
                )}
              </div>
            </div>
            {(report.tradePlans || []).length === 0 ? (
              <div className="text-[13px] text-muted-foreground text-center py-2">No tradable contract found</div>
            ) : (
              <div className="space-y-2">
                {report.tradePlans.map((p, i) => {
                  const preferred = report.preferredSide != null && p.optionType === (report.preferredSide === "PUT" ? "PE" : "CE");
                  const isCE = p.optionType === "CE";
                  return (
                    <div
                      key={i}
                      className={`rounded-lg p-2.5 border ${preferred ? "border-violet-500/40 bg-violet-500/5" : "border-border/40 bg-muted/20"}`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${isCE ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-emerald-400"}`}>
                            {p.optionType} {p.strike.toLocaleString("en-IN")}
                          </span>
                          {preferred && (
                            <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-violet-500/20 text-violet-300">
                              ★ PREFERRED ({report.preferredSide})
                            </span>
                          )}
                          {!preferred && report.preferredSide && (
                            <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-muted text-muted-foreground">
                              against bias
                            </span>
                          )}
                          {p.setup && (
                            <span
                              title="Newest candle setup for this side (BREAKOUT / RETEST / REVERSAL / …)"
                              className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-sky-500/15 text-sky-300"
                            >
                              {p.setup}
                            </span>
                          )}
                          {p.otmSteps > 0 && (
                            <span className="text-[11px] text-muted-foreground">{p.otmSteps} OTM</span>
                          )}
                        </div>
                        {p.tradable ? (
                          <span className="text-[11px] font-mono text-muted-foreground">
                            {p.lots} lot{p.lots === 1 ? "" : "s"} · ₹{Math.round(p.deployed).toLocaleString("en-IN")} dep · ₹{Math.round(p.riskAmount).toLocaleString("en-IN")} risk
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-rose-500/20 text-rose-400">NOT TRADABLE</span>
                        )}
                      </div>
                      <div className="grid grid-cols-5 gap-1 text-[12px]">
                        <div className="bg-muted/40 rounded p-1.5 text-center">
                          <div className="text-muted-foreground">Entry</div>
                          <div className="font-mono text-foreground font-bold">{p.entry.toFixed(2)}</div>
                          {p.livePremium != null && Math.abs(p.livePremium - p.entry) >= 0.05 && (
                            <div className={`font-mono text-[11px] ${p.livePremium >= p.entry ? "text-emerald-400" : "text-rose-400"}`}>
                              live {p.livePremium.toFixed(2)}
                            </div>
                          )}
                        </div>
                        <div className="bg-rose-500/5 rounded p-1.5 text-center">
                          <div className="text-rose-300">SL</div>
                          <div className="font-mono text-rose-400 font-bold">{p.stopLoss > 0 ? p.stopLoss.toFixed(2) : "—"}</div>
                        </div>
                        {[0, 1, 2].map((k) => {
                          const reach = p.targetReach?.[k];
                          return (
                            <div key={k} className="bg-emerald-500/5 rounded p-1.5 text-center">
                              <div className="text-emerald-300">TP{k + 1}</div>
                              <div className="font-mono text-emerald-400 font-bold">
                                {p.targets?.[k] != null ? p.targets[k].toFixed(2) : "—"}
                              </div>
                              {reach && (
                                <div
                                  title={reach.note}
                                  className={`text-[10px] font-mono ${reach.achievable ? "text-muted-foreground" : "text-rose-400 font-bold"}`}
                                >
                                  {reach.achievable
                                    ? `spot ${reach.requiredSpot.toFixed(0)}`
                                    : `⚠ wall ${reach.wall?.strike ?? "?"}`}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {p.reason && <div className="text-[11px] text-muted-foreground mt-1.5 leading-snug">{p.reason}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Seller Intelligence — OI · Greeks · Pressure · Invalidation */}
          {report.sellerIntel && (
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Crosshair className="h-4 w-4 text-sky-400" />
                  <span className="text-[13px] font-bold text-foreground">Seller Intelligence — OI · Greeks · Pressure · Invalidation</span>
                </div>
                <span className="text-[11px] text-muted-foreground">zero-lag · same chain fetch</span>
              </div>

              {/* Verdict */}
              <div className="flex items-center flex-wrap gap-2 mb-2">
                <span
                  className={`px-2 py-0.5 rounded text-[12px] font-bold ${
                    report.sellerIntel.verdict.signal === "BUY_CE"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : report.sellerIntel.verdict.signal === "BUY_PE"
                        ? "bg-rose-500/20 text-rose-400"
                        : "bg-amber-500/15 text-amber-400"
                  }`}
                >
                  {report.sellerIntel.verdict.signal === "WAIT" ? "WAIT" : report.sellerIntel.verdict.signal.replace("_", " ")}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  score {report.sellerIntel.verdict.score}/100 · conf {report.sellerIntel.verdict.confidence}%
                </span>
                <span className={`text-[12px] font-bold ${
                  report.sellerIntel.verdict.direction === "BULLISH" ? "text-emerald-400"
                    : report.sellerIntel.verdict.direction === "BEARISH" ? "text-rose-400"
                      : "text-muted-foreground"
                }`}>
                  {report.sellerIntel.verdict.direction}
                </span>
                {report.sellerIntel.verdict.entryConfirmed && (
                  <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-emerald-500/15 text-emerald-300">entry confirmed</span>
                )}
                {report.sellerIntel.verdict.requiresRetest && (
                  <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-amber-500/15 text-amber-300">needs retest</span>
                )}
              </div>
              {(report.sellerIntel.verdict.reasons.length > 0 || report.sellerIntel.verdict.warnings.length > 0) && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {report.sellerIntel.verdict.reasons.map(r => (
                    <span key={r} className="px-1.5 py-0.5 rounded text-[11px] bg-sky-500/10 text-sky-300 font-mono">{r}</span>
                  ))}
                  {report.sellerIntel.verdict.warnings.map(w => (
                    <span key={w} className="px-1.5 py-0.5 rounded text-[11px] bg-amber-500/10 text-amber-300 font-mono">{w}</span>
                  ))}
                </div>
              )}

              {/* Exposure — DEX / GEX */}
              <div className="grid grid-cols-3 gap-1 text-[12px] mb-2">
                <div className="bg-muted/40 rounded p-1.5 text-center">
                  <div className="text-muted-foreground">DEX CE</div>
                  <div className="font-mono text-rose-300 font-bold">₹{formatNumber(Math.round(report.sellerIntel.exposure.callDex))}</div>
                </div>
                <div className="bg-muted/40 rounded p-1.5 text-center">
                  <div className="text-muted-foreground">DEX PE</div>
                  <div className="font-mono text-emerald-300 font-bold">₹{formatNumber(Math.round(report.sellerIntel.exposure.putDex))}</div>
                </div>
                <div className="bg-muted/40 rounded p-1.5 text-center">
                  <div className="text-muted-foreground">Net DEX</div>
                  <div className={`font-mono font-bold ${report.sellerIntel.exposure.netDex >= 0 ? "text-rose-300" : "text-emerald-300"}`}>
                    ₹{formatNumber(Math.round(report.sellerIntel.exposure.netDex))}
                  </div>
                </div>
                <div className="bg-muted/40 rounded p-1.5 text-center">
                  <div className="text-muted-foreground">GEX total</div>
                  <div className="font-mono text-sky-300 font-bold">₹{formatNumber(Math.round(report.sellerIntel.exposure.totalGex))}</div>
                </div>
                <div className="bg-muted/40 rounded p-1.5 text-center">
                  <div className="text-muted-foreground">Γ flip</div>
                  <div className="font-mono text-foreground font-bold">{report.sellerIntel.exposure.gammaFlip > 0 ? report.sellerIntel.exposure.gammaFlip.toFixed(0) : "—"}</div>
                </div>
                <div className="bg-muted/40 rounded p-1.5 text-center">
                  <div className="text-muted-foreground">Dealer</div>
                  <div className={`text-[11px] font-bold ${report.sellerIntel.exposure.dealerRegime === "LONG_GAMMA" ? "text-emerald-400" : report.sellerIntel.exposure.dealerRegime === "SHORT_GAMMA" ? "text-rose-400" : "text-muted-foreground"}`}>
                    {report.sellerIntel.exposure.dealerRegime} · {report.sellerIntel.exposure.dealerBias}
                  </div>
                </div>
              </div>

              {/* Market confirmation strip */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground mb-2 font-mono">
                <span>chg {report.sellerIntel.market.underlyingChangePct >= 0 ? "+" : ""}{report.sellerIntel.market.underlyingChangePct.toFixed(2)}%</span>
                <span>VWAP {report.sellerIntel.market.vwap.toFixed(0)}</span>
                <span className={report.sellerIntel.market.currentPrice > report.sellerIntel.market.vwap ? "text-emerald-400" : "text-rose-400"}>
                  price {report.sellerIntel.market.currentPrice.toFixed(0)}
                </span>
                <span className={report.sellerIntel.market.breakoutConfirmed ? "text-emerald-400" : ""}>
                  breakout {report.sellerIntel.market.breakoutConfirmed ? "✓" : "✗"}
                </span>
                <span className={report.sellerIntel.market.retestConfirmed ? "text-emerald-400" : ""}>
                  retest {report.sellerIntel.market.retestConfirmed ? "✓" : "✗"}
                </span>
              </div>

              {/* Writing / Covering boards */}
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <div className="text-[11px] font-bold text-rose-400 mb-1">Writer pressure (OI added)</div>
                  {report.sellerIntel.topWriting.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground">none ≥2% ΔOI</div>
                  ) : (
                    <div className="space-y-0.5">
                      {report.sellerIntel.topWriting.map((r, i) => (
                        <div key={i} className="flex items-center justify-between text-[11px] font-mono bg-rose-500/5 rounded px-1.5 py-1">
                          <span className="text-foreground">{r.strike} {r.type}</span>
                          <span className={r.oiChangePct >= 0 ? "text-rose-300" : "text-emerald-300"}>
                            ΔOI {r.oiChangePct >= 0 ? "+" : ""}{r.oiChangePct.toFixed(1)}%
                          </span>
                          <span className={r.premiumChangePct >= 0 ? "text-emerald-300" : "text-rose-300"}>
                            prem {r.premiumChangePct >= 0 ? "+" : ""}{r.premiumChangePct.toFixed(1)}%
                          </span>
                          <span className="text-muted-foreground">sc {r.score}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[11px] font-bold text-emerald-400 mb-1">Short covering (OI pulled)</div>
                  {report.sellerIntel.topCovering.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground">none ≥2% ΔOI</div>
                  ) : (
                    <div className="space-y-0.5">
                      {report.sellerIntel.topCovering.map((r, i) => (
                        <div key={i} className="flex items-center justify-between text-[11px] font-mono bg-emerald-500/5 rounded px-1.5 py-1">
                          <span className="text-foreground">{r.strike} {r.type}</span>
                          <span className="text-emerald-300">ΔOI {r.oiChangePct.toFixed(1)}%</span>
                          <span className={r.premiumChangePct >= 0 ? "text-emerald-300" : "text-rose-300"}>
                            prem {r.premiumChangePct >= 0 ? "+" : ""}{r.premiumChangePct.toFixed(1)}%
                          </span>
                          <span className="text-muted-foreground">sc {r.score}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Seller zones / invalidation */}
              {report.sellerIntel.zones.length > 0 && (
                <div className="mb-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <ShieldCheck className="h-3 w-3 text-sky-400" />
                    <span className="text-[11px] font-bold text-foreground">Seller zones — invalidation levels</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {report.sellerIntel.zones.slice(0, 8).map((z, i) => (
                      <span
                        key={i}
                        title={`${z.classification} · score ${z.pressureScore} · ${z.direction}`}
                        className={`px-1.5 py-0.5 rounded text-[11px] font-mono border ${
                          z.status === "PRESSURE_BUILDING" ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                            : z.status === "POTENTIAL_COVERING" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                              : z.status === "DEFENDED_CANDIDATE" ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                                : z.status === "INVALIDATED" ? "border-border/40 bg-muted/30 text-muted-foreground line-through"
                                  : "border-border/40 bg-muted/20 text-muted-foreground"
                        }`}
                      >
                        {z.strike} {z.type} · {z.zoneLow.toFixed(0)}–{z.zoneHigh.toFixed(0)} · {z.status.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {report.sellerIntel.dataNotes.length > 0 && (
                <div className="text-[10px] text-muted-foreground/80 font-mono leading-snug">
                  {report.sellerIntel.dataNotes.join(" · ")}
                </div>
              )}
            </div>
          )}

          {/* Top Call OI */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-rose-400" />
              <span className="text-[13px] font-bold text-rose-400">Top 5 Call OI Strikes</span>
            </div>
            <div className="grid grid-cols-5 gap-1 text-[12px]">
              {report.topCallOI.map((t, i) => (
                <div key={i} className="text-center p-1.5 bg-rose-500/5 rounded">
                  <div className="font-mono text-foreground">{t.strike}</div>
                  <div className="text-rose-300">OI: {formatOI(t.oi)}</div>
                  <div className={`text-[11px] ${t.oiChange > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    Δ: {t.oiChange > 0 ? "+" : ""}{formatOI(t.oiChange)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Top Put OI */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="h-4 w-4 text-emerald-400" />
              <span className="text-[13px] font-bold text-emerald-400">Top 5 Put OI Strikes</span>
            </div>
            <div className="grid grid-cols-5 gap-1 text-[12px]">
              {report.topPutOI.map((t, i) => (
                <div key={i} className="text-center p-1.5 bg-emerald-500/5 rounded">
                  <div className="font-mono text-foreground">{t.strike}</div>
                  <div className="text-emerald-300">OI: {formatOI(t.oi)}</div>
                  <div className={`text-[11px] ${t.oiChange > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    Δ: {t.oiChange > 0 ? "+" : ""}{formatOI(t.oiChange)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Latest Signals */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="h-4 w-4 text-violet-400" />
              <span className="text-[13px] font-bold text-foreground">Latest Technical Signals (EMA 9/15 + ADX/ATR)</span>
            </div>
            {report.marketSession && !report.marketSession.isMarketOpen ? (
              <div className="text-[13px] text-sky-400/90 text-center py-2">
                Market closed — {report.marketSession.description}
                <span className="block text-[11px] text-muted-foreground mt-1">
                  No candles or signals can arrive until the next trading session
                </span>
              </div>
            ) : report.latestSignals.length === 0 ? (
              report.candleCount < (report.warmupBars || 30) ? (
                <div className="text-[13px] text-amber-400/90 text-center py-2">
                  Engine warming up — {report.candleCount}/{report.warmupBars || 30} bars · EMA 9/15 + ADX14 need {report.warmupBars || 30}
                </div>
              ) : (
                <div className="text-[13px] text-muted-foreground text-center py-2">
                  No setups — filters not met (ADX ≥ 20, EMA gap, DI agree)
                </div>
              )
            ) : (
              <div className="flex flex-wrap gap-2">
                {report.latestSignals.map((s, i) => (
                  <SignalBadge
                    key={i}
                    type={s.type}
                    side={s.side}
                    strength={s.strength}
                    time={new Date(s.time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })}
                    reason={s.reason}
                  />
                ))}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground mt-1.5">
              Candles: {report.candleCount} @ {report.candleInterval} ({report.candleSource}
              {report.candleDegraded ? ` — ${report.candleDegraded}` : ""})
              {report.marketSession && !report.marketSession.isMarketOpen
                ? " · market closed"
                : report.candleCount < (report.warmupBars || 30)
                  ? ` · warming up ${report.candleCount}/${report.warmupBars || 30}`
                  : ""}
            </div>
          </div>

          {/* LIVE CHAIN GREEKS — every strike the chain could price */}
          {report.greeks && report.greeks.length > 0 && (
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Waves className="h-4 w-4 text-cyan-400" />
                <span className="text-[13px] font-bold text-foreground">Live Chain Greeks</span>
                <span className="text-[10px] text-muted-foreground">
                  {report.greeks.length} strikes · {report.dataSource}
                  {report.chainFallbackUsed ? " · FALLBACK PROVIDER" : ""}
                </span>
              </div>
              <div className="overflow-x-auto" style={{ maxHeight: 300 }}>
                <table className="w-full text-[11px] font-mono">
                  <thead className="text-muted-foreground sticky top-0 bg-card/95">
                    <tr>
                      <th className="text-left py-1 px-1">Strike</th>
                      <th className="text-right px-1">CE Δ</th>
                      <th className="text-right px-1">CE Γ</th>
                      <th className="text-right px-1">CE Θ</th>
                      <th className="text-right px-1">CE Vega</th>
                      <th className="text-right px-1">CE IV</th>
                      <th className="text-right px-1">PE Δ</th>
                      <th className="text-right px-1">PE Γ</th>
                      <th className="text-right px-1">PE Θ</th>
                      <th className="text-right px-1">PE Vega</th>
                      <th className="text-right px-1">PE IV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.greeks.map((g) => (
                      <tr
                        key={g.strike}
                        className={`border-t border-border/40 ${
                          g.strike === report.atmStrike ? "bg-amber-500/10 font-bold" : ""
                        }`}
                      >
                        <td className="py-0.5 px-1">
                          {g.strike.toLocaleString("en-IN")}
                          {g.strike === report.atmStrike ? " ATM" : ""}
                        </td>
                        <td className="text-right px-1">{g.ce ? g.ce.delta.toFixed(3) : "—"}</td>
                        <td className="text-right px-1">{g.ce ? g.ce.gamma.toFixed(5) : "—"}</td>
                        <td className="text-right px-1">{g.ce ? g.ce.theta.toFixed(2) : "—"}</td>
                        <td className="text-right px-1">{g.ce ? g.ce.vega.toFixed(2) : "—"}</td>
                        <td className="text-right px-1">{g.ce ? `${g.ce.iv.toFixed(2)}%` : "—"}</td>
                        <td className="text-right px-1">{g.pe ? g.pe.delta.toFixed(3) : "—"}</td>
                        <td className="text-right px-1">{g.pe ? g.pe.gamma.toFixed(5) : "—"}</td>
                        <td className="text-right px-1">{g.pe ? g.pe.theta.toFixed(2) : "—"}</td>
                        <td className="text-right px-1">{g.pe ? g.pe.vega.toFixed(2) : "—"}</td>
                        <td className="text-right px-1">{g.pe ? `${g.pe.iv.toFixed(2)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[10px] text-muted-foreground mt-1.5">
                Greeks come from the live chain (the provider&apos;s own values, or Black-Scholes from
                the provider&apos;s IV) — a leg the chain could not price stays blank, never zero.
              </div>
            </div>
          )}

          {/* ATM Greeks Detail */}
          {report.atmGreeks && (
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="h-4 w-4 text-purple-400" />
                <span className="text-[13px] font-bold text-foreground">ATM Greeks</span>
                <span className="text-[10px] text-muted-foreground">
                  {report.atmGreeksSource === "provider"
                    ? "live chain — provider greeks"
                    : report.atmGreeksSource === "bs"
                    ? "live chain — Black-Scholes from the provider's IV"
                    : "implied from the premium (the chain carried no greeks)"}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[12px]">
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Delta</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.delta.toFixed(3)}</div>
                </div>
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Gamma</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.gamma.toFixed(4)}</div>
                </div>
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Theta (daily)</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.theta.toFixed(2)}</div>
                </div>
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Vega</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.vega.toFixed(2)}</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default DailyDerivativesPanel;