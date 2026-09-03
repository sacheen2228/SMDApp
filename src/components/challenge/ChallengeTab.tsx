// ═══════════════════════════════════════════════════════════════════════════
// Challenge Tab — ₹15K → ₹1L Smart Trading Challenge
// ═══════════════════════════════════════════════════════════════════════════

"use client";
import { useState, useEffect, useCallback } from "react";
import { Activity, Trophy, TrendingUp, TrendingDown, Target, AlertTriangle, Zap, BarChart3, RefreshCw, Play, Square, RotateCcw } from "lucide-react";

interface ChallengeData {
  challenge: {
    number: number;
    status: string;
    startingCapital: number;
    currentCapital: number;
    peakCapital: number;
    targetCapital: number;
    progressPct: number;
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
      currentCapital: number;
      peakCapital: number;
      totalDrawdownPct: number;
      dailyDrawdownPct: number;
      challengeFailed: boolean;
      failureReason?: string;
    };
  };
  scan: {
    timestamp: string;
    decision: string;
    topOpportunities: any[];
    bestTrade?: any;
    summary: {
      nifty500Scanned: number;
      indexFO: number;
      stockFO: number;
      equitySwing: number;
      casSignals: number;
      heroZeroCandidates: number;
      totalSetups: number;
    };
    marketContext: {
      regime: string;
      vix: number;
      breadth: string;
      sessionPhase: string;
    };
    capital: {
      current: number;
      available: number;
      riskBudget: number;
      drawdownPct: number;
    };
    noTradeReason?: string;
  };
}

function fmt(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full h-1.5 bg-[#1a2230] rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full`} style={{ width: `${w}%` }} />
    </div>
  );
}

export default function ChallengeTab() {
  const [data, setData] = useState<ChallengeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [trading, setTrading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const executeTrade = async () => {
    setTrading(true);
    try {
      await fetch("/api/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      await fetchData();
    } finally { setTrading(false); }
  };

  const resetChallenge = async () => {
    if (!confirm("Reset challenge? Current progress will be lost.")) return;
    await fetch("/api/challenge", { method: "DELETE" });
    await fetchData();
  };

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64 text-[#7d8ba0]">
        {loading ? <Activity className="h-5 w-5 animate-spin mr-2" /> : "Failed to load challenge data"}
      </div>
    );
  }

  const { challenge: ch, scan } = data;
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
          </div>
          <div className="flex gap-1">
            <button onClick={fetchData} className="px-2 py-1 rounded bg-[#1f2733] hover:bg-[#2a3441] text-[10px] font-bold text-[#7d8ba0]">
              <RefreshCw className="h-3 w-3 inline" />
            </button>
            <button onClick={resetChallenge} className="px-2 py-1 rounded bg-[#1f2733] hover:bg-[#2a3441] text-[10px] font-bold text-[#f2495c]">
              <RotateCcw className="h-3 w-3 inline" />
            </button>
          </div>
        </div>

        {/* Capital Display */}
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

        {/* Progress Bar */}
        <MiniBar value={ch.progressPct} max={100} color="bg-[#1fbf75]" />

        {/* P&L + Drawdown */}
        <div className="grid grid-cols-3 gap-2 text-center mt-2">
          <div>
            <div className="text-[9px] text-[#7d8ba0]">P&L</div>
            <div className={`text-[11px] font-bold ${ch.currentCapital >= ch.startingCapital ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
              {fmt(ch.currentCapital - ch.startingCapital)}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">MAX DD</div>
            <div className="text-[11px] font-bold text-[#f2495c]">{pct(ch.maxDrawdownPct)}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">TODAY</div>
            <div className={`text-[11px] font-bold ${ch.todayPnL >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
              {fmt(ch.todayPnL)}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Milestones ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="text-[11px] font-bold mb-2">MILESTONES</div>
        <div className="flex gap-1">
          {ch.milestones.map(m => (
            <div key={m.target} className={`flex-1 text-center rounded p-1 ${m.reached ? "bg-[#1fbf75]/20" : "bg-[#1a2230]"}`}>
              <div className={`text-[10px] font-bold ${m.reached ? "text-[#1fbf75]" : "text-[#7d8ba0]"}`}>{m.label}</div>
              <div className="text-[8px] text-[#7d8ba0]">{m.reached ? "✓" : `${m.progress}%`}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Stats ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="text-[11px] font-bold mb-2">STATISTICS</div>
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-[9px] text-[#7d8ba0]">TRADES</div>
            <div className="text-[11px] font-bold">{ch.totalTrades}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">WIN RATE</div>
            <div className={`text-[11px] font-bold ${ch.winRate >= 50 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>{pct(ch.winRate)}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">PF</div>
            <div className={`text-[11px] font-bold ${ch.profitFactor >= 1.5 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>{ch.profitFactor.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-[9px] text-[#7d8ba0]">EXPECT</div>
            <div className={`text-[11px] font-bold ${ch.expectancy >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>{fmt(ch.expectancy)}</div>
          </div>
        </div>
      </div>

      {/* ─── Market Scan Summary ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-bold">MARKET SCAN</div>
          <div className="text-[9px] text-[#7d8ba0]">{scan.marketContext.regime} | VIX {scan.marketContext.vix.toFixed(1)}</div>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center">
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
        <div className="text-center mt-1">
          <span className="text-[9px] text-[#7d8ba0]">Total setups: </span>
          <span className="text-[10px] font-bold">{scan.summary.totalSetups}</span>
        </div>
      </div>

      {/* ─── Decision ─── */}
      <div className={`rounded-lg border p-3 ${
        scan.decision === "TRADE" ? "border-[#1fbf75]/50 bg-[#1fbf75]/5" :
        scan.decision === "WATCH" ? "border-[#e8a33d]/50 bg-[#e8a33d]/5" :
        "border-[#7d8ba0]/50 bg-[#7d8ba0]/5"
      }`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {scan.decision === "TRADE" ? <Zap className="h-4 w-4 text-[#1fbf75]" /> :
             scan.decision === "WATCH" ? <Activity className="h-4 w-4 text-[#e8a33d]" /> :
             <AlertTriangle className="h-4 w-4 text-[#7d8ba0]" />}
            <span className={`text-sm font-bold ${
              scan.decision === "TRADE" ? "text-[#1fbf75]" :
              scan.decision === "WATCH" ? "text-[#e8a33d]" : "text-[#7d8ba0]"
            }`}>
              {scan.decision === "TRADE" ? "🟢 TRADE" : scan.decision === "WATCH" ? "🟡 WATCH" : "⚪ NO TRADE"}
            </span>
          </div>
          {isActive && (
            <button
              onClick={executeTrade}
              disabled={trading || scan.decision === "NO_TRADE"}
              className="px-3 py-1 rounded bg-[#1fbf75] hover:bg-[#1fbf75]/80 text-[10px] font-bold text-black disabled:opacity-40"
            >
              {trading ? "Executing..." : "Execute Trade"}
            </button>
          )}
        </div>
        {scan.noTradeReason && (
          <div className="text-[10px] text-[#7d8ba0]">{scan.noTradeReason}</div>
        )}
      </div>

      {/* ─── Best Trade Card ─── */}
      {scan.bestTrade && (
        <div className="rounded-lg border border-[#1fbf75]/30 bg-[#10151d] p-3">
          <div className="text-[11px] font-bold mb-2 text-[#1fbf75]">BEST TRADE</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[9px] text-[#7d8ba0]">SYMBOL</div>
              <div className="text-sm font-bold">{scan.bestTrade.symbol}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">STRATEGY</div>
              <div className="text-[11px] font-bold">{scan.bestTrade.strategy}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">ENTRY</div>
              <div className="text-[11px] font-bold">{fmt(scan.bestTrade.entry)}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">STOP LOSS</div>
              <div className="text-[11px] font-bold text-[#f2495c]">{fmt(scan.bestTrade.stopLoss)}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">TARGET</div>
              <div className="text-[11px] font-bold text-[#1fbf75]">{fmt(scan.bestTrade.target1)}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">R:R</div>
              <div className="text-[11px] font-bold">1:{scan.bestTrade.riskReward.toFixed(1)}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">QUANTITY</div>
              <div className="text-[11px] font-bold">{scan.bestTrade.position.quantity}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">MAX LOSS</div>
              <div className="text-[11px] font-bold text-[#f2495c]">{fmt(scan.bestTrade.position.maxLoss)}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">SCORE</div>
              <div className="text-[11px] font-bold">{scan.bestTrade.score}/100</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">INSTRUMENT</div>
              <div className="text-[11px] font-bold">{scan.bestTrade.instrument}</div>
            </div>
          </div>
          {scan.bestTrade.reasoning.length > 0 && (
            <div className="mt-2">
              <div className="text-[9px] text-[#7d8ba0] mb-1">REASONING</div>
              {scan.bestTrade.reasoning.map((r: string, i: number) => (
                <div key={i} className="text-[10px] text-[#9fb0c3]">• {r}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Top 10 Opportunities ─── */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="text-[11px] font-bold mb-2">TOP 10 OPPORTUNITIES</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-[#7d8ba0] border-b border-[#1f2733]">
                <th className="text-left py-1 px-1">#</th>
                <th className="text-left py-1 px-1">SYMBOL</th>
                <th className="text-left py-1 px-1">INSTRUMENT</th>
                <th className="text-right py-1 px-1">SCORE</th>
                <th className="text-right py-1 px-1">ENTRY</th>
                <th className="text-right py-1 px-1">R:R</th>
                <th className="text-right py-1 px-1">VOL</th>
                <th className="text-left py-1 px-1">SETUP</th>
              </tr>
            </thead>
            <tbody>
              {scan.topOpportunities.map((opp: any) => (
                <tr key={opp.rank} className={`border-b border-[#1f2733]/50 ${opp.rank === 1 ? "bg-[#1fbf75]/5" : "hover:bg-[#1a2230]"}`}>
                  <td className="py-1 px-1 font-bold">{opp.rank}</td>
                  <td className="py-1 px-1 font-bold">{opp.symbol}</td>
                  <td className="py-1 px-1">{opp.instrument}</td>
                  <td className={`text-right py-1 px-1 font-bold ${opp.score >= 80 ? "text-[#1fbf75]" : opp.score >= 60 ? "text-[#e8a33d]" : "text-[#7d8ba0]"}`}>
                    {opp.score}
                  </td>
                  <td className="text-right py-1 px-1">{fmt(opp.entry)}</td>
                  <td className="text-right py-1 px-1">1:{opp.riskReward.toFixed(1)}</td>
                  <td className="text-right py-1 px-1">{opp.relativeVolume.toFixed(1)}x</td>
                  <td className="py-1 px-1 text-[9px]">{opp.strategy}</td>
                </tr>
              ))}
              {scan.topOpportunities.length === 0 && (
                <tr><td colSpan={8} className="py-4 text-center text-[#7d8ba0]">No opportunities found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Challenge Failed Banner ─── */}
      {isFailed && (
        <div className="rounded-lg border border-[#f2495c] bg-[#f2495c]/10 p-4 text-center">
          <div className="text-lg font-bold text-[#f2495c] mb-1">🛑 CHALLENGE FAILED</div>
          <div className="text-[11px] text-[#7d8ba0]">{ch.drawdown.failureReason}</div>
          <button onClick={resetChallenge} className="mt-2 px-4 py-1 rounded bg-[#f2495c] text-white text-[11px] font-bold">
            Start Challenge #{ch.number + 1}
          </button>
        </div>
      )}

      {/* ─── Target Reached Banner ─── */}
      {isTarget && (
        <div className="rounded-lg border border-[#e8a33d] bg-[#e8a33d]/10 p-4 text-center">
          <div className="text-lg font-bold text-[#e8a33d] mb-1">🏆 TARGET REACHED!</div>
          <div className="text-[11px] text-[#7d8ba0]">{fmt(ch.currentCapital)} achieved from {fmt(ch.startingCapital)}</div>
        </div>
      )}
    </div>
  );
}
