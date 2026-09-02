"use client";

import { useState, useEffect, useCallback } from "react";
import { Crosshair, Activity, TrendingUp, TrendingDown, BarChart3, Zap, AlertTriangle, ChevronDown, Play, Square } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────
type Mode = "live" | "backtest";
type Strategy = "AUTO" | "CALL" | "PUT" | "STRADDLE" | "STRANGLE";
type StrikeSelection = "AUTO" | "ITM" | "ATM" | "OTM" | "OPTIMIZED";

interface LiveSignal {
  strategy: string;
  confidence: number;
  reasoning: string[];
  ceStrike: number;
  peStrike: number;
  cePremium: number;
  pePremium: number;
  combinedPremium: number;
  maxRisk: number;
  maxReward: number;
  breakevenUpper: number;
  breakevenLower: number;
  riskReward: number;
  casScore: number;
  expectedMove: number;
  expectedMovePct: number;
}

interface BacktestResult {
  success: boolean;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  grossPnL: number;
  totalCharges: number;
  netPnL: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  largestWin: number;
  largestLoss: number;
  returnOnCapital: number;
  equityCurve: Array<{ date: string; equity: number; drawdown: number }>;
  trades: any[];
  strategyComparison: Record<string, any>;
  dataQualityScore: number;
  incompleteTradesRemoved: number;
}

// ─── Main Component ───────────────────────────────────────────────
export function CASStraddleTab() {
  const [mode, setMode] = useState<Mode>("live");
  const [symbol, setSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY");
  const [loading, setLoading] = useState(false);

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Crosshair className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-bold">CAS Straddle / Strangle</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Mode Toggle */}
          <div className="flex rounded bg-[#10151d] border border-[#1f2733] p-0.5">
            {(["live", "backtest"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-1 rounded text-[11px] font-bold transition-colors ${mode === m ? "bg-emerald-500/20 text-emerald-400" : "text-[#7d8ba0] hover:text-[#dfe6ee]"}`}>
                {m === "live" ? "LIVE" : "BACKTEST"}
              </button>
            ))}
          </div>
          {/* Index Toggle */}
          <div className="flex rounded bg-[#10151d] border border-[#1f2733] p-0.5">
            {(["NIFTY", "SENSEX"] as const).map((s) => (
              <button key={s} onClick={() => setSymbol(s)}
                className={`px-3 py-1 rounded text-[11px] font-bold transition-colors ${symbol === s ? "bg-emerald-500/20 text-emerald-400" : "text-[#7d8ba0] hover:text-[#dfe6ee]"}`}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      {mode === "live" ? <LiveMode symbol={symbol} /> : <BacktestMode symbol={symbol} />}
    </div>
  );
}

// ─── Live Mode ────────────────────────────────────────────────────
function LiveMode({ symbol }: { symbol: string }) {
  const [signal, setSignal] = useState<LiveSignal | null>(null);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy>("AUTO");
  const [strikeSelection, setStrikeSelection] = useState<StrikeSelection>("AUTO");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cas-straddle?symbol=${symbol}&strategy=${strategy}&strike=${strikeSelection}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed");
      setSignal(json.signal);
      setSnapshot(json.snapshot);
      setSource(json.source || "");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, strategy, strikeSelection]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const strategyColor = (s: string) => {
    if (s === "CALL") return "text-[#1fbf75]";
    if (s === "PUT") return "text-[#f2495c]";
    if (s === "STRADDLE" || s === "STRANGLE") return "text-[#e8a33d]";
    return "text-[#7d8ba0]";
  };

  return (
    <div className="flex flex-col gap-2 overflow-auto">
      {/* Controls */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select label="Strategy" value={strategy} onChange={v => setStrategy(v as Strategy)}
          options={["AUTO", "CALL", "PUT", "STRADDLE", "STRANGLE"]} />
        <Select label="Strike" value={strikeSelection} onChange={v => setStrikeSelection(v as StrikeSelection)}
          options={["AUTO", "ITM", "ATM", "OTM", "OPTIMIZED"]} />
        {loading && <Activity className="h-3 w-3 animate-spin text-emerald-400" />}
        <button onClick={fetchData} className="px-2 py-1 rounded bg-[#1f2733] hover:bg-[#2a3441] text-[11px] font-bold text-[#7d8ba0]">↻ Refresh</button>
      </div>

      {error && <div className="text-[11px] text-[#f2495c] bg-[#f2495c]/10 border border-[#f2495c]/30 rounded p-2">{error}</div>}

      {signal && (
        <>
          {/* Signal Header */}
          <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-lg font-extrabold ${strategyColor(signal.strategy)}`}>{signal.strategy}</span>
                {signal.confidence > 0 && (
                  <span className={`text-[11px] px-2 py-0.5 rounded ${signal.confidence >= 70 ? "bg-[#1fbf75]/20 text-[#1fbf75]" : signal.confidence >= 50 ? "bg-[#e8a33d]/20 text-[#e8a33d]" : "bg-[#7d8ba0]/20 text-[#7d8ba0]"}`}>
                    {signal.confidence}%
                  </span>
                )}
              </div>
              <span className="text-[10px] text-[#7d8ba0]">CAS Score: {signal.casScore}/100</span>
            </div>

            {signal.strategy !== "NO_TRADE" && (
              <div className="grid grid-cols-4 gap-2 text-center mt-2">
                <MetricCard label="Spot" value={`₹${snapshot?.spot?.toLocaleString("en-IN") || "--"}`} />
                <MetricCard label="Expected Move" value={`₹${signal.expectedMove.toFixed(1)}`} sub={`${signal.expectedMovePct.toFixed(2)}%`} />
                <MetricCard label="Combined Premium" value={`₹${signal.combinedPremium.toFixed(1)}`} />
                <MetricCard label="R:R" value={`1:${signal.riskReward.toFixed(1)}`} />
              </div>
            )}
          </div>

          {/* Strike Details */}
          {signal.strategy !== "NO_TRADE" && (
            <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
              <div className="text-[11px] font-bold mb-2">Strike Details</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {signal.ceStrike > 0 && <MetricCard label="CE Strike" value={`₹${signal.ceStrike.toLocaleString("en-IN")}`} sub={`₹${signal.cePremium.toFixed(1)}`} />}
                {signal.peStrike > 0 && <MetricCard label="PE Strike" value={`₹${signal.peStrike.toLocaleString("en-IN")}`} sub={`₹${signal.pePremium.toFixed(1)}`} />}
                <MetricCard label="Breakeven Upper" value={`₹${signal.breakevenUpper.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} />
                <MetricCard label="Breakeven Lower" value={`₹${signal.breakevenLower.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} />
              </div>
            </div>
          )}

          {/* Reasoning */}
          <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
            <div className="text-[11px] font-bold mb-1.5">Signal Reasoning</div>
            <ul className="text-[10px] text-[#9fb0c3] space-y-0.5">
              {signal.reasoning.map((r, i) => <li key={i}>• {r}</li>)}
            </ul>
          </div>

          <div className="text-[10px] text-[#7d8ba0]">
            CAS Straddle/Strangle — shared engine for live and backtest.
            Source: {source}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Backtest Mode ────────────────────────────────────────────────
function BacktestMode({ symbol }: { symbol: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Config state
  const [strategy, setStrategy] = useState<Strategy>("AUTO");
  const [strikeSelection, setStrikeSelection] = useState<StrikeSelection>("AUTO");
  const [expiryType, setExpiryType] = useState<"weekly" | "monthly">("weekly");
  const [initialCapital, setInitialCapital] = useState("100000");
  const [maxRiskPct, setMaxRiskPct] = useState("2");
  const [entryTime, setEntryTime] = useState("09:20");
  const [exitTime, setExitTime] = useState("15:20");
  const [targetPct, setTargetPct] = useState("20");
  const [stopLossPct, setStopLossPct] = useState("50");
  const [chargesMode, setChargesMode] = useState<"realistic" | "custom">("realistic");
  const [slippageMode, setSlippageMode] = useState<"realistic" | "custom">("realistic");
  const [sortBy, setSortBy] = useState<string>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterStrategy, setFilterStrategy] = useState<string>("ALL");

  const runBacktest = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/cas-straddle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          strategy,
          strikeSelection,
          expiryType,
          initialCapital: Number(initialCapital),
          maxRiskPct: Number(maxRiskPct),
          entryTime,
          exitTime,
          targetPct: Number(targetPct),
          stopLossPct: Number(stopLossPct),
          chargesMode,
          slippageMode,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Backtest failed");
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const sortedTrades = result?.trades
    ?.filter(t => filterStrategy === "ALL" || t.strategy === filterStrategy)
    ?.sort((a, b) => {
      const aVal = a[sortBy] ?? 0;
      const bVal = b[sortBy] ?? 0;
      if (sortDir === "asc") return aVal > bVal ? 1 : -1;
      return aVal < bVal ? 1 : -1;
    }) || [];

  return (
    <div className="flex flex-col gap-2 overflow-auto">
      {/* Config Panel */}
      <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
        <div className="text-[11px] font-bold mb-2">Backtest Configuration</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Select label="Strategy" value={strategy} onChange={v => setStrategy(v as Strategy)}
            options={["AUTO", "CALL", "PUT", "STRADDLE", "STRANGLE"]} />
          <Select label="Strike" value={strikeSelection} onChange={v => setStrikeSelection(v as StrikeSelection)}
            options={["AUTO", "ITM", "ATM", "OTM", "OPTIMIZED"]} />
          <Select label="Expiry" value={expiryType} onChange={v => setExpiryType(v as any)}
            options={["weekly", "monthly"]} />
          <Input label="Initial Capital" value={initialCapital} onChange={setInitialCapital} prefix="₹" />
          <Input label="Max Risk %" value={maxRiskPct} onChange={setMaxRiskPct} suffix="%" />
          <Input label="Entry Time" value={entryTime} onChange={setEntryTime} />
          <Input label="Exit Time" value={exitTime} onChange={setExitTime} />
          <Input label="Target %" value={targetPct} onChange={setTargetPct} suffix="%" />
          <Input label="Stop Loss %" value={stopLossPct} onChange={setStopLossPct} suffix="%" />
          <Select label="Charges" value={chargesMode} onChange={v => setChargesMode(v as any)}
            options={["realistic", "custom"]} />
          <Select label="Slippage" value={slippageMode} onChange={v => setSlippageMode(v as any)}
            options={["realistic", "custom"]} />
        </div>
        <div className="mt-3">
          <button onClick={runBacktest} disabled={running}
            className="px-4 py-2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-bold text-[11px] hover:bg-emerald-500/30 disabled:opacity-50">
            {running ? "Running..." : "Run Backtest"}
          </button>
        </div>
      </div>

      {error && <div className="text-[11px] text-[#f2495c] bg-[#f2495c]/10 border border-[#f2495c]/30 rounded p-2">{error}</div>}

      {/* Results */}
      {result && (
        <>
          {/* Summary Header */}
          <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold">{symbol} Backtest Results</span>
              <span className="text-[10px] text-[#7d8ba0]">Data Quality: {result.dataQualityScore}/100</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              <MetricCard label="Trades" value={String(result.totalTrades)} />
              <MetricCard label="Win Rate" value={`${result.winRate}%`} tone={result.winRate >= 50 ? "text-[#1fbf75]" : "text-[#f2495c]"} />
              <MetricCard label="Net P&L" value={`₹${result.netPnL.toLocaleString("en-IN")}`} tone={result.netPnL >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"} />
              <MetricCard label="Profit Factor" value={result.profitFactor.toFixed(2)} tone={result.profitFactor >= 1.5 ? "text-[#1fbf75]" : "text-[#e8a33d]"} />
              <MetricCard label="Max Drawdown" value={`${result.maxDrawdownPct}%`} tone="text-[#f2495c]" />
              <MetricCard label="Return on Capital" value={`${result.returnOnCapital}%`} tone={result.returnOnCapital >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"} />
            </div>
          </div>

          {/* Detailed Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCard label="Winning" value={String(result.winningTrades)} tone="text-[#1fbf75]" />
            <MetricCard label="Losing" value={String(result.losingTrades)} tone="text-[#f2495c]" />
            <MetricCard label="Avg Profit" value={`₹${result.avgProfit.toLocaleString("en-IN")}`} tone="text-[#1fbf75]" />
            <MetricCard label="Avg Loss" value={`₹${result.avgLoss.toLocaleString("en-IN")}`} tone="text-[#f2495c]" />
            <MetricCard label="Largest Win" value={`₹${result.largestWin.toLocaleString("en-IN")}`} tone="text-[#1fbf75]" />
            <MetricCard label="Largest Loss" value={`₹${result.largestLoss.toLocaleString("en-IN")}`} tone="text-[#f2495c]" />
            <MetricCard label="Gross P&L" value={`₹${result.grossPnL.toLocaleString("en-IN")}`} />
            <MetricCard label="Total Charges" value={`₹${result.totalCharges.toLocaleString("en-IN")}`} />
          </div>

          {/* Strategy Comparison */}
          {Object.keys(result.strategyComparison).length > 0 && (
            <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
              <div className="text-[11px] font-bold mb-2">Strategy Comparison</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-[#7d8ba0] border-b border-[#1f2733]">
                      <th className="text-left py-1 px-2">Strategy</th>
                      <th className="text-right py-1 px-2">Trades</th>
                      <th className="text-right py-1 px-2">Win %</th>
                      <th className="text-right py-1 px-2">Net P&L</th>
                      <th className="text-right py-1 px-2">Profit Factor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(result.strategyComparison).map(([key, stats]) => (
                      <tr key={key} className="border-b border-[#1f2733]/50 hover:bg-[#1a2230]">
                        <td className="py-1 px-2 font-bold">{key}</td>
                        <td className="text-right py-1 px-2">{stats.trades}</td>
                        <td className="text-right py-1 px-2">{stats.winRate.toFixed(1)}%</td>
                        <td className={`text-right py-1 px-2 font-bold ${stats.netPnL >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
                          ₹{stats.netPnL.toLocaleString("en-IN")}
                        </td>
                        <td className="text-right py-1 px-2">{stats.profitFactor.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Equity Curve */}
          {result.equityCurve.length > 0 && (
            <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
              <div className="text-[11px] font-bold mb-2">Portfolio Equity Curve</div>
              <EquityCurve data={result.equityCurve} initialCapital={Number(initialCapital)} />
            </div>
          )}

          {/* Trade Log */}
          {sortedTrades.length > 0 && (
            <div className="rounded-lg border border-[#1f2733] bg-[#10151d] p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold">Trade Log ({sortedTrades.length})</span>
                <div className="flex gap-1">
                  <Select label="" value={filterStrategy} onChange={setFilterStrategy}
                    options={["ALL", "CALL", "PUT", "STRADDLE", "STRANGLE"]} />
                </div>
              </div>
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-[9px]">
                  <thead className="sticky top-0 bg-[#10151d]">
                    <tr className="text-[#7d8ba0] border-b border-[#1f2733]">
                      {["date", "strategy", "spot", "ceStrike", "peStrike", "combinedPremium", "casScore", "exitReason", "netPnL", "returnPct"].map(col => (
                        <th key={col} className="text-left py-1 px-1.5 cursor-pointer hover:text-[#dfe6ee]"
                          onClick={() => { setSortBy(col); setSortDir(d => d === "asc" ? "desc" : "asc"); }}>
                          {col.replace(/([A-Z])/g, " $1").toUpperCase()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTrades.map((t, i) => (
                      <tr key={i} className="border-b border-[#1f2733]/30 hover:bg-[#1a2230]">
                        <td className="py-1 px-1.5">{t.date}</td>
                        <td className="py-1 px-1.5 font-bold">{t.strategy}</td>
                        <td className="py-1 px-1.5">₹{t.spot?.toLocaleString("en-IN")}</td>
                        <td className="py-1 px-1.5">{t.ceStrike ? `₹${t.ceStrike.toLocaleString("en-IN")}` : "-"}</td>
                        <td className="py-1 px-1.5">{t.peStrike ? `₹${t.peStrike.toLocaleString("en-IN")}` : "-"}</td>
                        <td className="py-1 px-1.5">₹{t.combinedPremium?.toFixed(1)}</td>
                        <td className="py-1 px-1.5">{t.casScore}</td>
                        <td className="py-1 px-1.5">{t.exitReason}</td>
                        <td className={`py-1 px-1.5 font-bold ${t.netPnL >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
                          ₹{t.netPnL?.toLocaleString("en-IN")}
                        </td>
                        <td className={`py-1 px-1.5 ${t.returnPct >= 0 ? "text-[#1fbf75]" : "text-[#f2495c]"}`}>
                          {t.returnPct?.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.incompleteTradesRemoved > 0 && (
            <div className="text-[10px] text-[#e8a33d] flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {result.incompleteTradesRemoved} trades excluded due to incomplete data
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Equity Curve (simple bar chart) ──────────────────────────────
function EquityCurve({ data, initialCapital }: { data: Array<{ date: string; equity: number; drawdown: number }>; initialCapital: number }) {
  if (data.length === 0) return null;
  const min = Math.min(...data.map(d => d.equity));
  const max = Math.max(...data.map(d => d.equity));
  const range = max - min || 1;

  return (
    <div className="relative h-32">
      <div className="absolute inset-0 flex items-end gap-px">
        {data.map((d, i) => {
          const h = ((d.equity - min) / range) * 100;
          const color = d.equity >= initialCapital ? "#1fbf75" : "#f2495c";
          return (
            <div key={i} className="flex-1 flex flex-col justify-end" title={`${d.date}: ₹${d.equity.toLocaleString("en-IN")}`}>
              <div className="rounded-t" style={{ height: `${h}%`, backgroundColor: color, minHeight: 2, opacity: 0.8 }} />
            </div>
          );
        })}
      </div>
      <div className="absolute top-0 left-0 text-[9px] text-[#1fbf75]">₹{max.toLocaleString("en-IN")}</div>
      <div className="absolute bottom-0 left-0 text-[9px] text-[#f2495c]">₹{min.toLocaleString("en-IN")}</div>
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────────────
function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded bg-[#0d1117] border border-[#1f2733]/50 p-2">
      <div className="text-[9px] text-[#7d8ba0]">{label}</div>
      <div className={`text-sm font-extrabold ${tone || "text-[#dfe6ee]"}`}>{value}</div>
      {sub && <div className="text-[9px] text-[#7d8ba0]">{sub}</div>}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {label && <label className="text-[9px] text-[#7d8ba0]">{label}</label>}
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)}
          className="w-full appearance-none bg-[#0d1117] border border-[#1f2733] rounded px-2 py-1 text-[11px] text-[#dfe6ee] pr-5 cursor-pointer">
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <ChevronDown className="absolute right-1 top-1/2 -translate-y-1/2 h-3 w-3 text-[#7d8ba0] pointer-events-none" />
      </div>
    </div>
  );
}

function Input({ label, value, onChange, prefix, suffix }: { label: string; value: string; onChange: (v: string) => void; prefix?: string; suffix?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[9px] text-[#7d8ba0]">{label}</label>
      <div className="flex items-center bg-[#0d1117] border border-[#1f2733] rounded px-2 py-1">
        {prefix && <span className="text-[11px] text-[#7d8ba0] mr-1">{prefix}</span>}
        <input type="text" value={value} onChange={e => onChange(e.target.value)}
          className="flex-1 bg-transparent text-[11px] text-[#dfe6ee] outline-none min-w-0" />
        {suffix && <span className="text-[11px] text-[#7d8ba0] ml-1">{suffix}</span>}
      </div>
    </div>
  );
}
