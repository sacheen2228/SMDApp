"use client";

import { useState, useEffect, useCallback } from "react";
import { Flame, Star, RefreshCw, TrendingUp, TrendingDown, Shield, Target, Zap, Activity, AlertTriangle, ChevronRight, Crosshair } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface BTSTFactor {
  trend: number;
  smartMoney: number;
  oi: number;
  volume: number;
  sector: number;
  breadth: number;
}

interface BTSTCandidate {
  symbol: string;
  name?: string;
  sector?: string;
  price: number;
  factors: BTSTFactor;
  total: number;
  confidence: number;
  grade: "A+" | "A" | "B" | "C" | "SKIP";
  trendLabel: string;
  sectorLabel: string;
  relativeStrength: number;
  volumeMultiple: number;
  deliveryLabel: string;
  oiLabel: string;
  pcr: number;
  smartMoney: "Active" | "Building" | "Absent";
  gapRisk: "Low" | "Medium" | "High";
  expectedGapPct: number;
  expectedMovePct: number;
  expectedRiskPct: number;
  riskReward: number;
  holding: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  positionSize: { qty: number; capital: number; riskPerTrade: number };
  reasons: string[];
}

interface BTSTScan {
  timestamp: string;
  candidates: BTSTCandidate[];
  count: number;
  aPlus: number;
  a: number;
  b: number;
  scanWindow: string;
}

const GRADE_COLOR: Record<string, string> = {
  "A+": "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  "A": "text-emerald-400 border-emerald-500/30",
  "B": "text-amber-400 border-amber-500/30",
  "C": "text-zinc-400 border-zinc-600/30",
  "SKIP": "text-zinc-600 border-zinc-700/30",
};

function StarRating({ count }: { count: number }) {
  const stars = count === "A+" ? 5 : count === "A" ? 4 : count === "B" ? 3 : count === "C" ? 2 : 1;
  return (
    <span className="inline-flex gap-px">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} className={`size-3 ${i < stars ? "text-amber-400 fill-amber-400" : "text-zinc-700"}`} />
      ))}
    </span>
  );
}

function FactorBar({ label, score, max }: { label: string; score: number; max: number }) {
  const pct = Math.round((score / max) * 100);
  const color = pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-zinc-500 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-zinc-300 w-10 text-right">{score}/{max}</span>
    </div>
  );
}

export function BTSTDashboard() {
  const [data, setData] = useState<BTSTScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<BTSTCandidate | null>(null);
  const [view, setView] = useState<"scanner" | "performance">("scanner");

  const load = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/btst${force ? "" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "No data");
      setData(json.data);
      setError(false);
      if (json.data.candidates.length > 0) setSelected(json.data.candidates[0]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/btst", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        if (json.data.candidates.length > 0) setSelected(json.data.candidates[0]);
      }
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  return (
    <div className="h-full flex flex-col gap-3 p-3 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Flame className="size-4 text-cyan-400" />
          <h2 className="text-sm font-bold text-zinc-200">BTST AI Dashboard</h2>
          <Badge variant="outline" className="text-[9px] text-cyan-400 border-cyan-500/30">
            Buy Today Sell Tomorrow
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
            <Button variant={view === "scanner" ? "default" : "ghost"} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${view === "scanner" ? "bg-cyan-600 text-white" : "text-muted-foreground"}`}
              onClick={() => setView("scanner")}>
              Scanner
            </Button>
            <Button variant={view === "performance" ? "default" : "ghost"} size="sm"
              className={`h-6 text-[9px] px-1.5 font-bold ${view === "performance" ? "bg-cyan-600 text-white" : "text-muted-foreground"}`}
              onClick={() => setView("performance")}>
              Performance
            </Button>
          </div>
          {view === "scanner" && (
            <>
              {data && (
                <span className="text-[10px] text-zinc-500">
                  {data.aPlus} A+ · {data.a} A · {data.b} B
                </span>
              )}
              <Button
                size="sm"
            onClick={runScan}
            disabled={scanning}
            className="h-7 text-[10px] bg-cyan-600 hover:bg-cyan-500"
          >
            <RefreshCw className={`size-3 mr-1 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "Scanning…" : "Run Scan"}
          </Button>
            </>
          )}
        </div>
      </div>

      {view === "performance" ? (
        <BTSTPerformance />
      ) : loading ? (
        <div className="flex-1 grid place-items-center">
          <div className="text-zinc-500 text-xs">Loading BTST scan…</div>
        </div>
      ) : error ? (
        <div className="flex-1 grid place-items-center">
          <div className="text-zinc-500 text-xs text-center px-4">
            BTST scan unavailable. Market may be closed or data source unreachable.
          </div>
        </div>
      ) : !data || data.candidates.length === 0 ? (
        <div className="flex-1 grid place-items-center">
          <div className="text-zinc-500 text-xs text-center px-4 max-w-sm">
            No BTST candidates found yet. The scanner runs automatically between 3:10–3:20 PM IST.
            Click <span className="text-cyan-400">Run Scan</span> to generate A+/A/B ideas now.
          </div>
        </div>
      ) : (
        <div className="flex-1 flex gap-3 overflow-hidden">
          {/* Left: candidate list */}
          <Card className="w-72 shrink-0 bg-[#0d1117] border-white/5 flex flex-col overflow-hidden">
            <CardHeader className="py-2 px-3 border-b border-white/5">
              <CardTitle className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                <Target className="size-3 text-cyan-400" />
                BTST Scanner
              </CardTitle>
            </CardHeader>
            <ScrollArea className="flex-1">
              {data.candidates.map((c) => (
                <button
                  key={c.symbol}
                  onClick={() => setSelected(c)}
                  className={`w-full flex items-center justify-between px-3 py-2 border-b border-white/5 text-left hover:bg-white/5 transition-colors ${
                    selected?.symbol === c.symbol ? "bg-cyan-500/10" : ""
                  }`}
                >
                  <div>
                    <div className="text-[11px] font-bold text-zinc-200">{c.symbol}</div>
                    <div className="text-[9px] text-zinc-500">{c.sector || "—"}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StarRating count={c.grade} />
                    <Badge variant="outline" className={`text-[8px] px-1 py-0 h-3.5 ${GRADE_COLOR[c.grade]}`}>
                      {c.grade}
                    </Badge>
                  </div>
                </button>
              ))}
            </ScrollArea>
          </Card>

          {/* Right: AI dashboard for selected stock */}
          {selected && <BTSTDetail candidate={selected} />}
        </div>
      )}
    </div>
  );
}

function BTSTDetail({ candidate: c }: { candidate: BTSTCandidate }) {
  return (
    <ScrollArea className="flex-1">
      <div className="space-y-3 pr-1">
        {/* Score summary */}
        <Card className="bg-[#0d1117] border-white/5">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                  {c.symbol}
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${GRADE_COLOR[c.grade]}`}>
                    {c.grade}
                  </Badge>
                </div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{c.sector || "—"}</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-cyan-400">{c.total}<span className="text-sm text-zinc-500">/100</span></div>
                <div className="text-[10px] text-zinc-500">Confidence {c.confidence}%</div>
              </div>
            </div>

            {/* Factor bars */}
            <div className="mt-3 space-y-1.5">
              <FactorBar label="Trend" score={c.factors.trend} max={25} />
              <FactorBar label="Smart Money" score={c.factors.smartMoney} max={20} />
              <FactorBar label="OI" score={c.factors.oi} max={20} />
              <FactorBar label="Volume" score={c.factors.volume} max={15} />
              <FactorBar label="Sector" score={c.factors.sector} max={10} />
              <FactorBar label="Breadth" score={c.factors.breadth} max={10} />
            </div>

            <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/5">
              <div className="flex items-center gap-1.5">
                <StarRating count={c.grade} />
                <span className="text-[10px] text-zinc-400">{c.grade}</span>
              </div>
              <div className="flex items-center gap-4 text-[10px]">
                <span className="text-zinc-500">Exp Move <span className="text-emerald-400">▲{c.expectedMovePct}%</span></span>
                <span className="text-zinc-500">Exp Risk <span className="text-red-400">{c.expectedRiskPct}%</span></span>
                <span className="text-zinc-500">R:R <span className="text-cyan-400 font-bold">{c.riskReward}</span></span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Live metrics grid */}
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Trend" value={c.trendLabel} tone={c.trendLabel.includes("Strong") ? "good" : c.trendLabel === "Weak" ? "bad" : "mid"} />
          <Metric label="Sector" value={c.sectorLabel} tone={c.sectorLabel === "Strong" ? "good" : c.sectorLabel === "Weak" ? "bad" : "mid"} />
          <Metric label="Relative Strength" value={`${c.relativeStrength >= 0 ? "+" : ""}${c.relativeStrength.toFixed(1)}%`} tone={c.relativeStrength >= 0 ? "good" : "bad"} />
          <Metric label="Volume" value={`${c.volumeMultiple}x`} tone={c.volumeMultiple >= 1.5 ? "good" : "mid"} />
          <Metric label="Delivery" value={c.deliveryLabel} tone={c.deliveryLabel === "High" ? "good" : c.deliveryLabel === "Low" ? "bad" : "mid"} />
          <Metric label="OI" value={c.oiLabel} tone={c.oiLabel === "Bullish" ? "good" : c.oiLabel === "Bearish" ? "bad" : "mid"} />
          <Metric label="PCR" value={c.pcr.toFixed(2)} tone={c.pcr < 1.2 ? "good" : "mid"} />
          <Metric label="Smart Money" value={c.smartMoney} tone={c.smartMoney === "Active" ? "good" : c.smartMoney === "Building" ? "mid" : "bad"} />
          <Metric label="Gap Risk" value={c.gapRisk} tone={c.gapRisk === "Low" ? "good" : c.gapRisk === "Medium" ? "mid" : "bad"} />
          <Metric label="Expected Gap" value={`${c.expectedGapPct >= 0 ? "▲" : "▼"} ${Math.abs(c.expectedGapPct)}%`} tone={c.expectedGapPct >= 0 ? "good" : "bad"} />
        </div>

        {/* Trade levels */}
        <Card className="bg-[#0d1117] border-white/5">
          <CardHeader className="py-2 px-3 border-b border-white/5">
            <CardTitle className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
              <Crosshair className="size-3 text-cyan-400" />
              Trade Plan · Holding {c.holding}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 grid grid-cols-5 gap-2 text-center">
            <Level label="Entry" value={c.entry} color="text-zinc-200" />
            <Level label="SL" value={c.sl} color="text-red-400" />
            <Level label="TP1" value={c.tp1} color="text-emerald-400" />
            <Level label="TP2" value={c.tp2} color="text-emerald-400" />
            <Level label="TP3" value={c.tp3} color="text-emerald-400" />
          </CardContent>
          <div className="px-3 pb-3 flex items-center justify-between text-[10px] text-zinc-500 border-t border-white/5 pt-2">
            <span>Qty: <span className="text-zinc-300 font-mono">{c.positionSize.qty}</span></span>
            <span>Capital: <span className="text-zinc-300 font-mono">₹{c.positionSize.capital.toLocaleString("en-IN")}</span></span>
            <span>Risk: <span className="text-red-400 font-mono">₹{c.positionSize.riskPerTrade.toLocaleString("en-IN")}</span></span>
          </div>
        </Card>

        {c.reasons.length > 0 && (
          <Card className="bg-[#0d1117] border-white/5">
            <CardContent className="p-3 space-y-1">
              {c.reasons.map((r, i) => (
                <div key={i} className="text-[10px] text-zinc-400 flex items-start gap-1.5">
                  <ChevronRight className="size-3 text-cyan-500 mt-0.5 shrink-0" />
                  {r}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "good" | "mid" | "bad" }) {
  const color = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-zinc-300";
  return (
    <div className="bg-[#0d1117] border border-white/5 rounded-lg px-3 py-2">
      <div className="text-[9px] text-zinc-500">{label}</div>
      <div className={`text-[12px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function Level({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="text-[9px] text-zinc-500">{label}</div>
      <div className={`text-[12px] font-mono font-bold ${color}`}>₹{value.toFixed(0)}</div>
    </div>
  );
}

// ─── BTST Performance / Backtest Tracker ───────────────────────────
// Independent localStorage trade log + metrics (separate from intraday engine).
interface BTSTTrade {
  id: string;
  symbol: string;
  entry: number;
  exit: number;
  qty: number;
  date: string;
  pnl: number;
  pnlPct: number;
  result: "WIN" | "LOSS";
}

const BTST_LOG_KEY = "smdapp_btst_trades";

function loadTrades(): BTSTTrade[] {
  try {
    const raw = localStorage.getItem(BTST_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function computeMetrics(trades: BTSTTrade[]) {
  const closed = trades.filter((t) => t.result !== undefined as any);
  const wins = trades.filter((t) => t.result === "WIN");
  const losses = trades.filter((t) => t.result === "LOSS");
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgReturn = trades.length
    ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length
    : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const expectancy = trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;
  const maxDrawdown = trades.reduce((md, t, i) => {
    const cum = trades.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0);
    return Math.min(md, cum);
  }, 0);
  return { total: trades.length, wins: wins.length, losses: losses.length, winRate, avgReturn, profitFactor, expectancy, maxDrawdown };
}

function BTSTPerformance() {
  const [trades, setTrades] = useState<BTSTTrade[]>([]);
  const [symbol, setSymbol] = useState("");
  const [entry, setEntry] = useState("");
  const [exit, setExit] = useState("");
  const [qty, setQty] = useState("");

  useEffect(() => {
    setTrades(loadTrades());
  }, []);

  const save = (list: BTSTTrade[]) => {
    localStorage.setItem(BTST_LOG_KEY, JSON.stringify(list));
    setTrades(list);
  };

  const addTrade = () => {
    const e = parseFloat(entry);
    const x = parseFloat(exit);
    const q = parseInt(qty);
    if (!symbol || !e || !x || !q) return;
    const pnl = (x - e) * q;
    const pnlPct = ((x - e) / e) * 100;
    const t: BTSTTrade = {
      id: `${Date.now()}`,
      symbol: symbol.toUpperCase(),
      entry: e,
      exit: x,
      qty: q,
      date: new Date().toISOString().slice(0, 10),
      pnl,
      pnlPct,
      result: pnl >= 0 ? "WIN" : "LOSS",
    };
    save([t, ...trades]);
    setSymbol("");
    setEntry("");
    setExit("");
    setQty("");
  };

  const clearAll = () => {
    if (confirm("Clear all BTST trade logs?")) save([]);
  };

  const m = computeMetrics(trades);

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-3 pr-1">
        {/* Metrics band */}
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Win Rate" value={`${m.winRate.toFixed(0)}%`} tone={m.winRate >= 55 ? "good" : m.winRate >= 45 ? "mid" : "bad"} />
          <Metric label="Avg O/N Return" value={`${m.avgReturn >= 0 ? "+" : ""}${m.avgReturn.toFixed(2)}%`} tone={m.avgReturn >= 0 ? "good" : "bad"} />
          <Metric label="Profit Factor" value={m.profitFactor.toFixed(2)} tone={m.profitFactor >= 1.5 ? "good" : m.profitFactor >= 1 ? "mid" : "bad"} />
          <Metric label="Trades" value={`${m.total}`} tone="mid" />
          <Metric label="Expectancy" value={`₹${m.expectancy.toFixed(0)}`} tone={m.expectancy >= 0 ? "good" : "bad"} />
          <Metric label="Max Drawdown" value={`₹${m.maxDrawdown.toFixed(0)}`} tone={m.maxDrawdown < 0 ? "bad" : "good"} />
        </div>

        {/* Add trade */}
        <Card className="bg-[#0d1117] border-white/5">
          <CardHeader className="py-2 px-3 border-b border-white/5">
            <CardTitle className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
              <Shield className="size-3 text-cyan-400" />
              Log BTST Trade
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 grid grid-cols-5 gap-2">
            <input
              placeholder="Symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 font-mono"
            />
            <input
              placeholder="Entry"
              type="number"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 font-mono"
            />
            <input
              placeholder="Exit"
              type="number"
              value={exit}
              onChange={(e) => setExit(e.target.value)}
              className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 font-mono"
            />
            <input
              placeholder="Qty"
              type="number"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 font-mono"
            />
            <Button size="sm" onClick={addTrade} className="h-7 text-[10px] bg-cyan-600 hover:bg-cyan-500">
              Add
            </Button>
          </CardContent>
        </Card>

        {/* Trade log */}
        <Card className="bg-[#0d1117] border-white/5">
          <CardHeader className="py-2 px-3 border-b border-white/5 flex items-center justify-between">
            <CardTitle className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
              <Activity className="size-3 text-cyan-400" />
              Trade Log ({trades.length})
            </CardTitle>
            {trades.length > 0 && (
              <button onClick={clearAll} className="text-[9px] text-zinc-500 hover:text-red-400">
                Clear
              </button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {trades.length === 0 ? (
              <div className="p-4 text-center text-zinc-500 text-[10px]">
                No BTST trades logged yet. Add a completed trade to track performance.
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {trades.map((t) => (
                  <div key={t.id} className="flex items-center justify-between px-3 py-1.5 text-[10px]">
                    <span className="font-bold text-zinc-200">{t.symbol}</span>
                    <span className="text-zinc-500">{t.date}</span>
                    <span className={t.result === "WIN" ? "text-emerald-400" : "text-red-400"}>
                      {t.result} {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                    </span>
                    <span className={`font-mono ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      ₹{t.pnl.toFixed(0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
