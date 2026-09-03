// ═══════════════════════════════════════════════════════════════════════════
// Challenge Tab — ₹15K → ₹1L Smart Trading Challenge
// Auto-execute + Copy Trading + Trade Feed
// ═══════════════════════════════════════════════════════════════════════════

"use client";
import { useState, useEffect, useCallback } from "react";
import { Activity, Trophy, TrendingUp, TrendingDown, Target, AlertTriangle, Zap, BarChart3, RefreshCw, Play, Square, RotateCcw, Copy, Check, Clock, Circle } from "lucide-react";

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
  quantity: number;
  lotSize: number;
  pnl?: number;
  score: number;
  status: string;
  exitReason?: string;
  orderId?: string;
}

interface ChallengeData {
  challenge: any;
  scan: any;
  tradeFeed: TradeFeedEntry[];
  tradeStats: {
    total: number;
    open: number;
    closed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
  };
  openTrades: TradeFeedEntry[];
}

function fmt(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatusDot({ status }: { status: string }) {
  if (status === "OPEN") return <Circle className="h-2 w-2 fill-[#e8a33d] text-[#e8a33d]" />;
  if (status === "WIN") return <Check className="h-2 w-2 text-[#1fbf75]" />;
  if (status === "LOSS") return <Circle className="h-2 w-2 fill-[#f2495c] text-[#f2495c]" />;
  return <Circle className="h-2 w-2 fill-[#7d8ba0] text-[#7d8ba0]" />;
}

export default function ChallengeTab() {
  const [data, setData] = useState<ChallengeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [execMode, setExecMode] = useState<"PAPER" | "LIVE">("PAPER");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/challenge");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed");
      setData(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  // Auto-refresh every 15s
  useEffect(() => { const t = setInterval(fetchData, 15000); return () => clearInterval(t); }, [fetchData]);

  const executeTrade = async (mode: "PAPER" | "LIVE") => {
    setExecuting(true);
    setExecMode(mode);
    try {
      const res = await fetch("/api/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json();
      if (!json.success) setError(json.error);
      await fetchData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExecuting(false);
    }
  };

  const closeTrade = async (tradeId: string, exitPrice: number) => {
    try {
      await fetch("/api/challenge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradeId, exitPrice, exitReason: "MANUAL" }),
      });
      await fetchData();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const resetChallenge = async () => {
    if (!confirm("Reset challenge? Current progress will be lost.")) return;
    await fetch("/api/challenge", { method: "DELETE" });
    await fetchData();
  };

  const copyTrade = (trade: TradeFeedEntry) => {
    const text = `${trade.direction} ${trade.quantity} ${trade.symbol} @ ₹${trade.entry} | SL: Stop | Score: ${trade.score} | ${trade.strategy}`;
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(trade.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64 text-[#7d8ba0]">
        {loading ? <Activity className="h-5 w-5 animate-spin mr-2" /> : "Failed to load challenge data"}
      </div>
    );
  }

  const { challenge: ch, scan, tradeFeed, tradeStats, openTrades } = data;
  const isFailed = ch.status === "FAILED";
  const isTarget = ch.status === "TARGET_REACHED";
  const isActive = ch.status === "ACTIVE";

  return (
    <div className="flex flex-col gap-2 p-2 overflow-auto h-full">
      {error && <div className="text-[11px] text-[#f2495c] bg-[#f2495c]/10 border border-[#f2495c]/30 rounded p-2">{error}</div>}

      {/* ─── Challenge Header ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Trophy className={`h-4 w-4 ${isTarget ? "text-[#e8a33d]" : isFailed ? "text-[#f2495c]" : "text-[#7d8ba0]"}`} />
            <span className="text-sm font-bold">CHALLENGE #{ch.number}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
              isActive ? "bg-[#1fbf75]/20 text-[#1fbf75]" :
              isTarget ? "bg-[#e8a33d]/20 text-[#e8a33d]" :
              isFailed ? "bg-[#f2495c]/20 text-[#f2495c]" :
              "bg-[#7d8ba0]/20 text-[#7d8ba0]"
            }`}>{ch.status}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
              execMode === "LIVE" ? "bg-[#f2495c]/20 text-[#f2495c]" : "bg-[#7d8ba0]/20 text-[#7d8ba0]"
            }`}>{execMode}</span>
          </div>
          <div className="flex gap-1">
            <button onClick={fetchData} className="px-2 py-1 rounded bg-[#1f2733] hover:bg-[#2a3441] text-[10px] font-bold text-[#7d8ba0]">
              <RefreshCw className="h-3 w-3" />
            </button>
            <button onClick={resetChallenge} className="px-2 py-1 rounded bg-[#1f2733] hover:bg-[#2a3441] text-[10px] font-bold text-[#f2495c]">
              <RotateCcw className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center mb-2">
          <div>
            <div className="text-[9px] text-[#7d8ba0]">STARTING</div>
            <div className="text-sm font-bold">{fmt(ch.startingCapital)}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">CURRENT</div>
            <div className={`text-sm font-bold ${ch.currentCapital >= ch.startingCapital ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
              {fmt(ch.currentCapital)}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">TARGET</div>
            <div className="text-sm font-bold text-[#e8a33d]">{fmt(ch.targetCapital)}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">PROGRESS</div>
            <div className="text-sm font-bold">{ch.progressPct}%</div>
          </div>
        </div>

        <div className="w-full h-1.5 bg-[#1a2230] rounded-full overflow-hidden mb-2">
          <div className="h-full bg-[#1fbf75] rounded-full" style={{ width: `${ch.progressPct}%` }} />
        </div>

        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-[9px] text-[#7d8ba0]">P&L</div>
            <div className={`text-[11px] font-bold ${ch.currentCapital >= ch.startingCapital ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
              {fmt(ch.currentCapital - ch.startingCapital)}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">MAX DD</div>
            <div className="text-[11px] font-bold text-[#f2495c]">{ch.maxDrawdownPct.toFixed(1)}%</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">TODAY</div>
            <div className={`text-[11px] font-bold ${ch.todayPnL >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
              {fmt(ch.todayPnL)}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">PF</div>
            <div className={`text-[11px] font-bold ${ch.profitFactor >= 1.5 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>{ch.profitFactor.toFixed(2)}</div>
          </div>
        </div>
      </div>

      {/* ─── Milestones ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="text-[11px] font-bold mb-2">MILESTONES</div>
        <div className="flex gap-1">
          {ch.milestones.map((m: any) => (
            <div key={m.target} className={`flex-1 text-center rounded p-1 ${m.reached ? "bg-[#1fbf75]/20" : "bg-[#1a2230]"}`}>
              <div className={`text-[10px] font-bold ${m.reached ? "text-[#1fbf75]" : "text-[#7d8ba0]"}`}>{m.label}</div>
              <div className="text-[8px] text-[#7d8ba0]">{m.reached ? "✓" : `${m.progress}%`}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Scan + Decision ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-bold">MARKET SCAN</div>
          <div className="text-[9px] text-[#7d8ba0]">{scan.marketContext.regime} | VIX {scan.marketContext.vix?.toFixed(1)}</div>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center mb-2">
          <div>
            <div className="text-[9px] text-[#7d8ba0]">NIFTY 500</div>
            <div className="text-[11px] font-bold">{scan.summary.nifty500Scanned}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">INDEX F&O</div>
            <div className="text-[11px] font-bold">{scan.summary.indexFO}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">STOCK F&O</div>
            <div className="text-[11px] font-bold">{scan.summary.stockFO}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">SWING</div>
            <div className="text-[11px] font-bold">{scan.summary.equitySwing}</div>
          </div>
        </div>

        {/* Decision + Execute */}
        <div className={`rounded-lg p-2 mb-2 ${
          scan.decision === "TRADE" ? "bg-[#1fbf75]/10 border border-[#1fbf75]/30" :
          scan.decision === "WATCH" ? "bg-[#e8a33d]/10 border border-[#e8a33d]/30" :
          "bg-[#7d8ba0]/10 border border-[#7d8ba0]/30"
        }`}>
          <div className="flex items-center justify-between">
            <span className={`text-sm font-bold ${
              scan.decision === "TRADE" ? "text-[#1fbf75]" :
              scan.decision === "WATCH" ? "text-[#e8a33d]" : "text-[#7d8ba0]"
            }`}>
              {scan.decision === "TRADE" ? "🟢 TRADE" : scan.decision === "WATCH" ? "🟡 WATCH" : "⚪ NO TRADE"}
            </span>
            {isActive && scan.decision !== "NO_TRADE" && (
              <div className="flex gap-1">
                <button
                  onClick={() => executeTrade("PAPER")}
                  disabled={executing}
                  className="px-3 py-1 rounded bg-[#1f2733] hover:bg-[#2a3441] text-[10px] font-bold text-[#7d8ba0] disabled:opacity-40"
                >
                  {executing && execMode === "PAPER" ? "..." : "📝 Paper"}
                </button>
                <button
                  onClick={() => executeTrade("LIVE")}
                  disabled={executing}
                  className="px-3 py-1 rounded bg-[#f2495c] hover:bg-[#f2495c]/80 text-[10px] font-bold text-white disabled:opacity-40"
                >
                  {executing && execMode === "LIVE" ? "..." : "⚡ Live"}
                </button>
              </div>
            )}
          </div>
          {scan.noTradeReason && <div className="text-[10px] text-[#7d8ba0] mt-1">{scan.noTradeReason}</div>}
        </div>
      </div>

      {/* ─── Best Trade Card ─── */}
      {scan.bestTrade && (
        <div className="rounded-lg border border-[#1fbf75]/30 bg-[#10151d] p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-bold text-[#1fbf75]">BEST TRADE — {scan.bestTrade.symbol}</div>
            <div className="flex items-center gap-1">
              <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                scan.bestTrade.instrument === "EQUITY" ? "bg-[#3b82f6]/20 text-[#3b82f6]" :
                scan.bestTrade.instrument === "CALL" ? "bg-[#1fbf75]/20 text-[#1fbf75]" :
                scan.bestTrade.instrument === "PUT" ? "bg-[#f2495c]/20 text-[#f2495c]" :
                scan.bestTrade.instrument === "FUTURES" ? "bg-[#e8a33d]/20 text-[#e8a33d]" :
                "bg-[#7d8ba0]/20 text-[#7d8ba0]"
              }`}>{scan.bestTrade.instrument}</span>
              <span className="text-[10px] font-bold text-[#e8a33d]">{scan.bestTrade.score}/100</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div><span className="text-[#7d8ba0]">Entry:</span> <span className="font-bold">{fmt(scan.bestTrade.entry)}</span></div>
            <div><span className="text-[#7d8ba0]">SL:</span> <span className="font-bold text-[#f2495c]">{fmt(scan.bestTrade.stopLoss)}</span></div>
            <div><span className="text-[#7d8ba0]">TP:</span> <span className="font-bold text-[#1fbf75]">{fmt(scan.bestTrade.target1)}</span></div>
            <div><span className="text-[#7d8ba0]">Qty:</span> <span className="font-bold">{scan.bestTrade.position.quantity}</span></div>
            <div><span className="text-[#7d8ba0]">Max Loss:</span> <span className="font-bold text-[#f2495c]">{fmt(scan.bestTrade.position.maxLoss)}</span></div>
            <div><span className="text-[#7d8ba0]">R:R:</span> <span className="font-bold">1:{scan.bestTrade.riskReward.toFixed(1)}</span></div>
          </div>
          {scan.bestTrade.reasoning?.length > 0 && (
            <div className="mt-2 text-[9px] text-[#9fb0c3]">
              {scan.bestTrade.reasoning.slice(0, 3).map((r: string, i: number) => <div key={i}>• {r}</div>)}
            </div>
          )}
        </div>
      )}

      {/* ─── Top 10 ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="text-[11px] font-bold mb-2">TOP 10 OPPORTUNITIES</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-[#7d8ba0] border-b border-[#1f2733]">
                <th className="text-left py-1 px-1">#</th>
                <th className="text-left py-1 px-1">SYMBOL</th>
                <th className="text-left py-1 px-1">TYPE</th>
                <th className="text-right py-1 px-1">SCORE</th>
                <th className="text-right py-1 px-1">ENTRY</th>
                <th className="text-right py-1 px-1">R:R</th>
                <th className="text-left py-1 px-1">SETUP</th>
                <th className="text-center py-1 px-1">COPY</th>
              </tr>
            </thead>
            <tbody>
              {scan.topOpportunities.map((opp: any) => (
                <tr key={opp.rank} className={`border-b border-[#1f2733]/50 ${opp.rank === 1 ? "bg-[#1fbf75]/5" : "hover:bg-[#1a2230]"}`}>
                  <td className="py-1 px-1 font-bold">{opp.rank}</td>
                  <td className="py-1 px-1 font-bold">{opp.symbol}</td>
                  <td className="py-1 px-1">
                    <span className={`text-[9px] px-1 rounded ${
                      opp.instrument === "EQUITY" ? "bg-[#3b82f6]/20 text-[#3b82f6]" :
                      opp.instrument === "CALL" ? "bg-[#1fbf75]/20 text-[#1fbf75]" :
                      opp.instrument === "PUT" ? "bg-[#f2495c]/20 text-[#f2495c]" :
                      "bg-[#e8a33d]/20 text-[#e8a33d]"
                    }`}>{opp.instrument}</span>
                  </td>
                  <td className={`text-right py-1 px-1 font-bold ${opp.score >= 80 ? "text-[#1fbf75]" : opp.score >= 60 ? "text-[#e8a33d]" : "text-[#7d8ba0]"}`}>{opp.score}</td>
                  <td className="text-right py-1 px-1">{fmt(opp.entry)}</td>
                  <td className="text-right py-1 px-1">1:{opp.riskReward.toFixed(1)}</td>
                  <td className="py-1 px-1 text-[9px]">{opp.strategy}</td>
                  <td className="text-center py-1 px-1">
                    <button onClick={() => copyTrade(opp)} className="text-[#7d8ba0] hover:text-[#1fbf75]">
                      {copiedId === opp.id ? <Check className="h-3 w-3 text-[#1fbf75]" /> : <Copy className="h-3 w-3" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Trade Feed (Copy Trading) ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-bold">TRADE FEED — COPY TRADING</div>
          <div className="flex items-center gap-2 text-[9px] text-[#7d8ba0]">
            <span>{tradeStats.total} trades</span>
            <span>{tradeStats.winRate}% WR</span>
            <span className={tradeStats.totalPnl >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}>{fmt(tradeStats.totalPnl)}</span>
          </div>
        </div>

        {openTrades.length > 0 && (
          <div className="mb-2">
            <div className="text-[9px] text-[#e8a33d] font-bold mb-1">OPEN ({openTrades.length})</div>
            {openTrades.map(t => (
              <div key={t.id} className="flex items-center justify-between py-1 px-2 bg-[#e8a33d]/5 rounded mb-1 text-[10px]">
                <div className="flex items-center gap-2">
                  <StatusDot status={t.status} />
                  <span className="font-bold">{t.symbol}</span>
                  <span className={`px-1 rounded text-[9px] ${t.direction === "BUY" ? "bg-[#1fbf75]/20 text-[#1fbf75]" : "bg-[#f2495c]/20 text-[#f2495c]"}`}>{t.direction}</span>
                  <span className="text-[#7d8ba0]">{t.instrument}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span>{t.quantity} @ {fmt(t.entry)}</span>
                  <span className="text-[#7d8ba0]">{t.strategy}</span>
                  <span className={`text-[9px] px-1 rounded ${t.mode === "LIVE" ? "bg-[#f2495c]/20 text-[#f2495c]" : "bg-[#7d8ba0]/20 text-[#7d8ba0]"}`}>{t.mode}</span>
                  <button onClick={() => copyTrade(t)} className="text-[#7d8ba0] hover:text-[#1fbf75]">
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tradeFeed.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-[#7d8ba0] border-b border-[#1f2733]">
                  <th className="text-left py-1 px-1">STATUS</th>
                  <th className="text-left py-1 px-1">TIME</th>
                  <th className="text-left py-1 px-1">SYMBOL</th>
                  <th className="text-left py-1 px-1">SIDE</th>
                  <th className="text-left py-1 px-1">TYPE</th>
                  <th className="text-right py-1 px-1">ENTRY</th>
                  <th className="text-right py-1 px-1">EXIT</th>
                  <th className="text-right py-1 px-1">QTY</th>
                  <th className="text-right py-1 px-1">P&L</th>
                  <th className="text-left py-1 px-1">MODE</th>
                  <th className="text-center py-1 px-1">COPY</th>
                </tr>
              </thead>
              <tbody>
                {tradeFeed.map(t => (
                  <tr key={t.id} className="border-b border-[#1f2733]/50 hover:bg-[#1a2230]">
                    <td className="py-1 px-1"><StatusDot status={t.status} /></td>
                    <td className="py-1 px-1 text-[#7d8ba0]">{timeAgo(t.timestamp)}</td>
                    <td className="py-1 px-1 font-bold">{t.symbol}</td>
                    <td className="py-1 px-1">
                      <span className={`px-1 rounded text-[9px] ${t.direction === "BUY" ? "bg-[#1fbf75]/20 text-[#1fbf75]" : "bg-[#f2495c]/20 text-[#f2495c]"}`}>{t.direction}</span>
                    </td>
                    <td className="py-1 px-1">{t.instrument}</td>
                    <td className="text-right py-1 px-1">{fmt(t.entry)}</td>
                    <td className="text-right py-1 px-1">{t.exit ? fmt(t.exit) : "—"}</td>
                    <td className="text-right py-1 px-1">{t.quantity}</td>
                    <td className={`text-right py-1 px-1 font-bold ${!t.pnl ? "text-[#7d8ba0]" : t.pnl > 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
                      {t.pnl !== undefined ? fmt(t.pnl) : "—"}
                    </td>
                    <td className="py-1 px-1">
                      <span className={`text-[9px] px-1 rounded ${t.mode === "LIVE" ? "bg-[#f2495c]/20 text-[#f2495c]" : "bg-[#7d8ba0]/20 text-[#7d8ba0]"}`}>{t.mode}</span>
                    </td>
                    <td className="text-center py-1 px-1">
                      <button onClick={() => copyTrade(t)} className="text-[#7d8ba0] hover:text-[#1fbf75]">
                        {copiedId === t.id ? <Check className="h-3 w-3 text-[#1fbf75]" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-4 text-[10px] text-[#7d8ba0]">No trades yet — execute a trade to start copy trading</div>
        )}
      </div>

      {/* ─── Challenge Failed ─── */}
      {isFailed && (
        <div className="rounded-lg border border-[#f2495c] bg-[#f2495c]/10 p-4 text-center">
          <div className="text-lg font-bold text-[#f2495c] mb-1">🛑 CHALLENGE FAILED</div>
          <div className="text-[11px] text-[#7d8ba0]">{ch.drawdown.failureReason}</div>
          <button onClick={resetChallenge} className="mt-2 px-4 py-1 rounded bg-[#f2495c] text-white text-[11px] font-bold">
            Start Challenge #{ch.number + 1}
          </button>
        </div>
      )}

      {isTarget && (
        <div className="rounded-lg border border-[#e8a33d] bg-[#e8a33d]/10 p-4 text-center">
          <div className="text-lg font-bold text-[#e8a33d] mb-1">🏆 TARGET REACHED!</div>
          <div className="text-[11px] text-[#7d8ba0]">{fmt(ch.currentCapital)} achieved from {fmt(ch.startingCapital)}</div>
        </div>
      )}
    </div>
  );
}
