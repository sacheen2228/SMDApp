// ═══════════════════════════════════════════════════════════════════════════
// Challenge Tab — ₹15K → ₹1L Challenge + Copy Trading
// FIXED: copy button, close trade, VIX display, progress, icons
// ═══════════════════════════════════════════════════════════════════════════

"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Trophy,
  Target,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Zap,
  RefreshCw,
  Copy,
  BarChart3,
  Activity,
  ChevronDown,
  ChevronUp,
  Play,
  Pause,
  RotateCcw,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  ArrowRight,
} from "lucide-react";

// ── Types ──
interface ChallengeState {
  number: number;
  status: string;
  startingCapital: number;
  currentCapital: number;
  peakCapital: number;
  targetCapital: number;
  progressPct: number;
  progressLabel: string;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  consecutiveLosses: number;
  milestones: Array<{ target: number; label: string; reached: boolean; progress: number }>;
  todayPnL: number;
  drawdown: {
    totalDrawdownPct: number;
    dailyDrawdownPct: number;
    challengeFailed: boolean;
    failureReason?: string;
  };
  equityCurve: Array<{ timestamp: string; capital: number }>;
}

interface ScanResult {
  timestamp: string;
  decision: string;
  topOpportunities: Array<{
    rank: number;
    symbol: string;
    instrument: string;
    strategy: string;
    score: number;
    confidence: number;
    direction: string;
    entry: number;
    stopLoss: number;
    target1: number;
    target2: number;
    riskReward: number;
    volume: number;
    reasoning: string[];
    position: { quantity: number; lotSize: number; canTrade: boolean; reason?: string };
    data: { ltp: number; changePct: number };
  }>;
  bestTrade?: any;
  summary: {
    nifty500Scanned: number;
    nifty500Valid: number;
    nifty500Candidates: number;
    indexFOAvailable: number;
    indexFOCandidates: number;
    stockFOAvailable: number;
    stockFOCandidates: number;
    equitySwingCandidates: number;
    totalSetups: number;
    dataSource: string;
  };
  marketContext: {
    regime: string;
    vix: number;
    vixAvailable: boolean;
    breadth: string;
  };
  capital: { current: number; available: number; riskBudget: number };
  noTradeReason?: string;
}

interface TradeFeedEntry {
  id: string;
  timestamp: string;
  mode: string;
  symbol: string;
  strategy: string;
  direction: string;
  instrument: string;
  entry: number;
  exit?: number;
  stopLoss: number;
  target: number;
  quantity: number;
  lotSize: number;
  pnl?: number;
  score: number;
  status: string;
  exitReason?: string;
}

// ── Helper: format currency ──
function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

// ── Status badge colors ──
function statusColor(status: string) {
  switch (status) {
    case "WIN": return "text-emerald-400 bg-emerald-400/10";
    case "LOSS": return "text-red-400 bg-red-400/10";
    case "BREAKEVEN": return "text-yellow-400 bg-yellow-400/10";
    case "OPEN": return "text-blue-400 bg-blue-400/10";
    case "EXPIRED": return "text-gray-400 bg-gray-400/10";
    default: return "text-gray-400 bg-gray-400/10";
  }
}

function decisionColor(d: string) {
  switch (d) {
    case "TRADE": return "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
    case "WATCH": return "text-yellow-400 bg-yellow-400/10 border-yellow-400/30";
    case "NO_TRADE": return "text-gray-400 bg-gray-400/10 border-gray-400/30";
    default: return "text-gray-400 bg-gray-400/10";
  }
}

function instrumentIcon(inst: string) {
  switch (inst) {
    case "CALL": return <TrendingUp className="w-3.5 h-3.5" />;
    case "PUT": return <TrendingDown className="w-3.5 h-3.5" />;
    case "FUTURES": return <BarChart3 className="w-3.5 h-3.5" />;
    case "EQUITY": return <Activity className="w-3.5 h-3.5" />;
    default: return <Zap className="w-3.5 h-3.5" />;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ChallengeTab Component
// ═══════════════════════════════════════════════════════════════════════════

export default function ChallengeTab() {
  const [challenge, setChallenge] = useState<ChallengeState | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [tradeFeed, setTradeFeed] = useState<TradeFeedEntry[]>([]);
  const [tradeStats, setTradeStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState<number | null>(null);
  const [closingTradeId, setClosingTradeId] = useState<string | null>(null);
  const [closePrice, setClosePrice] = useState<string>("");
  const [expandedOpp, setExpandedOpp] = useState<number | null>(null);
  const [copyMode, setCopyMode] = useState<"PAPER" | "LIVE">("PAPER");
  const [copiedIds, setCopiedIds] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const refreshRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch challenge data
  const fetchData = useCallback(async (refresh = false) => {
    try {
      const url = `/api/challenge${refresh ? "?refresh=1" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setChallenge(data.challenge);
        setScan(data.scan);
        setTradeFeed(data.tradeFeed);
        setTradeStats(data.tradeStats);
      }
    } catch (e) {
      console.error("Failed to fetch challenge:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh
  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  useEffect(() => {
    if (autoRefresh) {
      refreshRef.current = setInterval(() => fetchData(false), 15000);
    }
    return () => { if (refreshRef.current) clearInterval(refreshRef.current); };
  }, [autoRefresh, fetchData]);

  // Execute trade
  const executeTrade = async (oppIndex: number) => {
    setExecuting(oppIndex);
    try {
      const res = await fetch("/api/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: copyMode, opportunityIndex: oppIndex }),
      });
      const data = await res.json();
      if (data.success) {
        fetchData(true);
      }
    } finally {
      setExecuting(null);
    }
  };

  // Close trade
  const closeTrade = async (tradeId: string) => {
    if (!closePrice) return;
    setClosingTradeId(tradeId);
    try {
      const res = await fetch("/api/challenge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradeId, exitPrice: parseFloat(closePrice), exitReason: "MANUAL" }),
      });
      const data = await res.json();
      if (data.success) {
        setClosePrice("");
        setClosingTradeId(null);
        fetchData(true);
      }
    } finally {
      setClosingTradeId(null);
    }
  };

  // Reset challenge
  const resetChallenge = async () => {
    if (!confirm("Reset challenge? Current challenge will be archived.")) return;
    await fetch("/api/challenge", { method: "DELETE" });
    fetchData(true);
  };

  // Copy signal
  const copySignal = (opp: any) => {
    const text = `${opp.strategy} ${opp.direction} ${opp.symbol} @ ₹${opp.entry} | SL ₹${opp.stopLoss} | TP ₹${opp.target1} | R:R 1:${opp.riskReward.toFixed(1)} | Score ${opp.score}`;
    navigator.clipboard.writeText(text);
    setCopiedIds(new Set([...copiedIds, opp.symbol + opp.timestamp]));
    setTimeout(() => setCopiedIds(new Set([...copiedIds].filter(id => id !== opp.symbol + opp.timestamp))), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-neutral-400">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400 mr-3" />
        Loading challenge data...
      </div>
    );
  }

  if (!challenge || !scan) {
    return <div className="text-center text-neutral-400 py-12">No challenge data available</div>;
  }

  const progressWidth = Math.max(0, Math.min(100, challenge.progressPct));
  const behind = challenge.progressPct < 0;
  const capitalGain = challenge.currentCapital - challenge.startingCapital;
  const capitalGainPct = (capitalGain / challenge.startingCapital) * 100;

  return (
    <div className="space-y-4 p-4 max-w-[1400px] mx-auto">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Trophy className="w-6 h-6 text-amber-400" />
          <div>
            <h2 className="text-lg font-bold text-white">
              Challenge #{challenge.number}{" "}
              <span className={`text-sm font-normal px-2 py-0.5 rounded-full ${
                challenge.status === "ACTIVE" ? "bg-emerald-400/10 text-emerald-400" :
                challenge.status === "FAILED" ? "bg-red-400/10 text-red-400" :
                challenge.status === "TARGET_REACHED" ? "bg-amber-400/10 text-amber-400" :
                "bg-neutral-700 text-neutral-400"
              }`}>
                {challenge.status}
              </span>
            </h2>
            <p className="text-xs text-neutral-400">
              ₹{fmt(challenge.startingCapital)} → ₹{fmt(challenge.targetCapital)} • {challenge.progressLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              autoRefresh ? "bg-emerald-400/10 text-emerald-400" : "bg-neutral-800 text-neutral-400"
            }`}
          >
            {autoRefresh ? "AUTO" : "MANUAL"}
          </button>
          <button onClick={() => fetchData(true)} className="p-1.5 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={resetChallenge} className="p-1.5 rounded-lg bg-neutral-800 text-neutral-400 hover:text-red-400">
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Progress Bar (FIXED: shows negative) ── */}
      <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-neutral-400">Progress to Target</span>
          <span className={`text-sm font-bold ${behind ? "text-red-400" : "text-emerald-400"}`}>
            {challenge.progressPct.toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-neutral-800 rounded-full h-3 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              behind ? "bg-red-500" : "bg-gradient-to-r from-amber-500 to-emerald-500"
            }`}
            style={{ width: `${progressWidth}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-xs text-neutral-500">
          <span>₹{fmt(challenge.startingCapital)}</span>
          <span className={behind ? "text-red-400" : "text-emerald-400"}>
            ₹{fmt(challenge.currentCapital)} ({capitalGain >= 0 ? "+" : ""}{capitalGainPct.toFixed(1)}%)
          </span>
          <span>₹{fmt(challenge.targetCapital)}</span>
        </div>
      </div>

      {/* ── Stats Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard icon={<Target className="w-4 h-4" />} label="Capital" value={`₹${fmt(challenge.currentCapital)}`}
          sub={`Peak ₹${fmt(challenge.peakCapital)}`} color={capitalGain >= 0 ? "emerald" : "red"} />
        <StatCard icon={<BarChart3 className="w-4 h-4" />} label="Win Rate" value={`${challenge.winRate}%`}
          sub={`${challenge.winCount}W / ${challenge.lossCount}L`} color={challenge.winRate >= 50 ? "emerald" : "red"} />
        <StatCard icon={<TrendingUp className="w-4 h-4" />} label="Profit Factor"
          value={challenge.profitFactor === 0 ? "—" : challenge.profitFactor >= 99 ? "∞" : challenge.profitFactor.toFixed(2)}
          sub={challenge.totalTrades === 0 ? "No trades" : `${challenge.totalTrades} trades`}
          color={challenge.profitFactor >= 2 ? "emerald" : challenge.profitFactor > 0 ? "amber" : "neutral"} />
        <StatCard icon={<AlertTriangle className="w-4 h-4" />} label="Max Drawdown" value={`${challenge.maxDrawdownPct.toFixed(1)}%`}
          sub={`Daily ${challenge.drawdown.dailyDrawdownPct.toFixed(1)}%`} color={challenge.maxDrawdownPct > 15 ? "red" : "amber"} />
        <StatCard icon={<Zap className="w-4 h-4" />} label="Today P&L" value={`₹${fmt(challenge.todayPnL)}`}
          sub={challenge.consecutiveLosses > 0 ? `${challenge.consecutiveLosses} losses` : "Streak OK"}
          color={challenge.todayPnL >= 0 ? "emerald" : "red"} />
        <StatCard icon={<Shield className="w-4 h-4" />} label="VIX"
          value={scan.marketContext.vixAvailable ? scan.marketContext.vix.toFixed(1) : "—"}
          sub={scan.marketContext.regime || "N/A"} color="amber" />
      </div>

      {/* ── Milestones ── */}
      <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
        <h3 className="text-sm font-semibold text-neutral-300 mb-3">Milestones</h3>
        <div className="flex gap-2 flex-wrap">
          {challenge.milestones.map((m, i) => (
            <div key={i} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
              m.reached ? "bg-amber-400/10 text-amber-400 border border-amber-400/30" : "bg-neutral-800 text-neutral-500 border border-neutral-700"
            }`}>
              {m.reached ? <CheckCircle className="w-3.5 h-3.5" /> : <Target className="w-3.5 h-3.5" />}
              {m.label}
            </div>
          ))}
        </div>
      </div>

      {/* ── Top Opportunities ── */}
      <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-neutral-300">
            Top Setups ({scan.topOpportunities.length}/{scan.summary.totalSetups} total)
          </h3>
          <span className={`text-xs px-2 py-0.5 rounded-full border ${decisionColor(scan.decision)}`}>
            {scan.decision}
          </span>
        </div>

        {scan.noTradeReason && (
          <div className="text-xs text-neutral-500 bg-neutral-800/50 rounded-lg px-3 py-2 mb-3">
            {scan.noTradeReason}
          </div>
        )}

        <div className="space-y-2">
          {scan.topOpportunities.map((opp, i) => {
            const isExpanded = expandedOpp === i;
            const canExec = opp.position.canTrade && scan.decision === "TRADE";
            const isCopied = copiedIds.has(opp.symbol + opp.timestamp);

            return (
              <div key={i} className="bg-neutral-800/50 rounded-lg border border-neutral-700/50 overflow-hidden">
                <div className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-neutral-800/80"
                  onClick={() => setExpandedOpp(isExpanded ? null : i)}>
                  <span className="text-xs text-neutral-500 w-5">#{opp.rank}</span>
                  {instrumentIcon(opp.instrument)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white text-sm">{opp.symbol}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        opp.direction.includes("BUY") || opp.direction === "LONG" || opp.direction === "CALL"
                          ? "bg-emerald-400/10 text-emerald-400"
                          : "bg-red-400/10 text-red-400"
                      }`}>{opp.direction}</span>
                      <span className="text-xs text-neutral-500">{opp.instrument}</span>
                    </div>
                    <div className="text-xs text-neutral-400 mt-0.5">
                      ₹{opp.entry} • SL ₹{opp.stopLoss} • TP ₹{opp.target1} • R:R 1:{opp.riskReward.toFixed(1)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-lg font-bold ${
                      opp.score >= 80 ? "text-emerald-400" : opp.score >= 60 ? "text-amber-400" : "text-neutral-400"
                    }`}>{opp.score}</div>
                    <div className="text-xs text-neutral-500">score</div>
                  </div>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-neutral-500" /> : <ChevronDown className="w-4 h-4 text-neutral-500" />}
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 border-t border-neutral-700/50 pt-2">
                    <div className="text-xs text-neutral-400 space-y-1 mb-3">
                      <div><span className="text-neutral-500">Strategy:</span> {opp.strategy}</div>
                      <div><span className="text-neutral-500">Volume:</span> {(opp.volume / 100000).toFixed(1)}L • R:R 1:{opp.riskReward.toFixed(1)}</div>
                      <div><span className="text-neutral-500">Qty:</span> {opp.position.quantity} {opp.position.lotSize > 1 ? `(lot ${opp.position.lotSize})` : ""}</div>
                      {opp.reasoning.map((r, j) => (
                        <div key={j} className="flex items-center gap-1.5">
                          <ArrowRight className="w-3 h-3 text-amber-400" />
                          <span>{r}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); executeTrade(i); }}
                        disabled={!canExec || executing === i}
                        className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          canExec && executing === null
                            ? copyMode === "LIVE"
                              ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
                              : "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
                            : "bg-neutral-800 text-neutral-600 cursor-not-allowed"
                        }`}
                      >
                        {executing === i ? "EXECUTING..." : copyMode === "LIVE" ? "⚡ LIVE EXECUTE" : "📝 PAPER EXECUTE"}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); copySignal(opp); }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-700"
                      >
                        {isCopied ? "✓ Copied" : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Mode Toggle ── */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-neutral-400">Execution Mode:</span>
        <button
          onClick={() => setCopyMode("PAPER")}
          className={`px-3 py-1 rounded-lg text-xs font-medium ${
            copyMode === "PAPER" ? "bg-emerald-400/10 text-emerald-400 border border-emerald-400/30" : "bg-neutral-800 text-neutral-500"
          }`}
        >📝 Paper</button>
        <button
          onClick={() => setCopyMode("LIVE")}
          className={`px-3 py-1 rounded-lg text-xs font-medium ${
            copyMode === "LIVE" ? "bg-red-400/10 text-red-400 border border-red-400/30" : "bg-neutral-800 text-neutral-500"
          }`}
        >⚡ Live</button>
        <span className="text-xs text-neutral-500">• {scan.summary.nifty500Scanned} stocks • {scan.summary.totalSetups} setups • VIX {scan.marketContext.vixAvailable ? scan.marketContext.vix.toFixed(1) : "—"}</span>
      </div>

      {/* ── Trade Feed ── */}
      <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-neutral-300">
            Trade Feed ({tradeFeed.length})
          </h3>
          {tradeStats && (
            <div className="flex gap-3 text-xs text-neutral-400">
              <span>{tradeStats.wins}W / {tradeStats.losses}L</span>
              <span>P&L ₹{fmt(tradeStats.totalPnl)}</span>
              <span>PF {tradeStats.profitFactor === 0 ? "—" : tradeStats.profitFactor >= 99 ? "∞" : tradeStats.profitFactor}</span>
            </div>
          )}
        </div>

        {tradeFeed.length === 0 ? (
          <div className="text-center text-neutral-500 text-sm py-6">
            No trades yet. Execute a setup above to start.
          </div>
        ) : (
          <div className="space-y-1.5">
            {tradeFeed.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2 bg-neutral-800/50 rounded-lg">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusColor(t.status)}`}>
                  {t.status}
                </span>
                {instrumentIcon(t.instrument)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white text-sm">{t.symbol}</span>
                    <span className={`text-xs ${t.direction.includes("BUY") ? "text-emerald-400" : "text-red-400"}`}>{t.direction}</span>
                    <span className="text-xs text-neutral-500">{t.instrument}</span>
                  </div>
                  <div className="text-xs text-neutral-400">
                    ₹{t.entry} → {t.exit ? `₹${t.exit}` : "—"} • Qty {t.quantity} • Score {t.score}
                  </div>
                </div>
                <div className="text-right">
                  {t.pnl !== undefined ? (
                    <div className={`text-sm font-bold ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {t.pnl >= 0 ? "+" : ""}₹{fmt(t.pnl)}
                    </div>
                  ) : (
                    <div className="text-xs text-neutral-500">OPEN</div>
                  )}
                  <div className="text-xs text-neutral-500">{t.mode}</div>
                </div>
                {/* Close button for open trades */}
                {t.status === "OPEN" && (
                  <div className="flex items-center gap-1">
                    {closingTradeId === t.id ? (
                      <input
                        type="number"
                        value={closePrice}
                        onChange={(e) => setClosePrice(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && closeTrade(t.id)}
                        placeholder="Exit ₹"
                        className="w-20 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-white"
                        autoFocus
                      />
                    ) : (
                      <button
                        onClick={() => setClosingTradeId(t.id)}
                        className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-700"
                      >
                        Close
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Market Context ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniCard label="Regime" value={scan.marketContext.regime || "N/A"} />
        <MiniCard label="VIX" value={scan.marketContext.vixAvailable ? scan.marketContext.vix.toFixed(1) : "—"} />
        <MiniCard label="Breadth" value={scan.marketContext.breadth || "N/A"} />
        <MiniCard label="Data" value={scan.summary.dataSource} />
      </div>
    </div>
  );
}

// ── Stat Card ──
function StatCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  const c = {
    emerald: "text-emerald-400",
    red: "text-red-400",
    amber: "text-amber-400",
    neutral: "text-neutral-400",
  }[color] || "text-neutral-400";

  return (
    <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-3">
      <div className="flex items-center gap-1.5 text-neutral-500 mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className={`text-lg font-bold ${c}`}>{value}</div>
      <div className="text-xs text-neutral-500 truncate">{sub}</div>
    </div>
  );
}

// ── Mini Card ──
function MiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-2 text-center">
      <div className="text-xs text-neutral-500 mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-white">{value}</div>
    </div>
  );
}
