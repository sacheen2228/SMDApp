// DailyDerivativesPanel — top-level "Daily Derivatives" view (next to BTST).
// Fetches the derivatives-only daily recommendation (BUY_CALL / BUY_PUT /
// NO_TRADE) from /api/daily-ide and renders the trade plan. NIFTY / SENSEX.
"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, TrendingUp, TrendingDown, ShieldOff, RefreshCw } from "lucide-react";

interface DailyRec {
  symbol: string;
  generatedAt: string;
  action: "BUY_CALL" | "BUY_PUT" | "NO_TRADE";
  strike: number | null;
  type: "CE" | "PE" | null;
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  confidence: number;
  expectedMove: number;
  expectedMovePct: number;
  support: number;
  resistance: number;
  callProbability: number;
  putProbability: number;
  reasoning: string[];
}

const SYMBOLS = ["NIFTY", "SENSEX"] as const;

function DailyDerivativesPanel({ symbol: initialSymbol = "NIFTY" }: { symbol?: string }) {
  const [symbol, setSymbol] = useState<string>(SYMBOLS.includes(initialSymbol as any) ? (initialSymbol as any) : "NIFTY");
  const [rec, setRec] = useState<DailyRec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/daily-ide?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "failed");
      setRec(json.recommendation);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const isTrade = rec?.action !== "NO_TRADE";
  const accent = rec?.action === "BUY_CALL" ? "emerald" : rec?.action === "BUY_PUT" ? "rose" : "slate";

  return (
    <div className="p-3 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-violet-500" />
          <span className="text-[13px] font-bold text-foreground">Daily Derivatives</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
            {SYMBOLS.map((s) => (
              <button key={s} onClick={() => setSymbol(s)}
                className={`h-6 text-[10px] px-2 font-bold rounded ${symbol === s ? "bg-violet-600 text-white" : "text-muted-foreground hover:text-violet-400"}`}>
                {s}
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-muted hover:bg-muted/70 text-muted-foreground">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="text-[12px] text-rose-400 p-3">{error}</div>}
      {!rec && loading && <div className="text-[12px] text-muted-foreground p-3">Loading…</div>}

      {rec && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2 mb-3">
            {rec.action === "BUY_CALL" && <TrendingUp className="h-4 w-4 text-emerald-500" />}
            {rec.action === "BUY_PUT" && <TrendingDown className="h-4 w-4 text-rose-500" />}
            {rec.action === "NO_TRADE" && <ShieldOff className="h-4 w-4 text-slate-400" />}
            <span className={`text-[15px] font-bold ${accent === "emerald" ? "text-emerald-400" : accent === "rose" ? "text-rose-400" : "text-slate-300"}`}>
              {rec.action === "BUY_CALL" ? "BUY CALL" : rec.action === "BUY_PUT" ? "BUY PUT" : "NO TRADE"}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground font-mono">
              Confidence {rec.confidence}% · CALL {rec.callProbability} / PUT {rec.putProbability}
            </span>
          </div>

          {isTrade && rec.strike != null ? (
            <div className="grid grid-cols-2 gap-2 text-[12px] mb-3">
              <Field label="Strike" value={`${rec.strike} ${rec.type}`} />
              <Field label="Entry" value={`₹${rec.entry?.toFixed(2)}`} />
              <Field label="Stop Loss" value={`₹${rec.stopLoss?.toFixed(2)}`} danger />
              <Field label="Target 1" value={`₹${rec.tp1?.toFixed(2)}`} />
              <Field label="Target 2" value={`₹${rec.tp2?.toFixed(2)}`} />
              <Field label="Target 3" value={`₹${rec.tp3?.toFixed(2)}`} />
              <Field label="Expected Move" value={`₹${rec.expectedMove?.toFixed(0)} (${rec.expectedMovePct}%)`} />
              <Field label="S/R" value={`₹${rec.support?.toFixed(0)} / ₹${rec.resistance?.toFixed(0)}`} />
            </div>
          ) : (
            <div className="text-[12px] text-muted-foreground mb-3">
              No qualifying trade — confidence below the minimum threshold (engine waits for a clear, high-probability setup).
            </div>
          )}

          {rec.reasoning?.length > 0 && (
            <div className="border-t border-border pt-2 space-y-1">
              {rec.reasoning.map((r, i) => (
                <div key={i} className="text-[11px] text-[#9aa7b8] leading-snug">• {r}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={`font-mono ${danger ? "text-rose-400" : "text-foreground"}`}>{value}</span>
    </div>
  );
}

export default DailyDerivativesPanel;
