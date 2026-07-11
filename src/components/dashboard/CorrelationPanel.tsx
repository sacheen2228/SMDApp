"use client";

import { useState, useEffect } from "react";

interface CorrelationData {
  niftyPrice: number;
  sensexPrice: number;
  daysAnalyzed: number;
  overallCorrelation: number;
  last5dCorrelation: number;
  last20dCorrelation: number;
  beta: number;
  todayReturnDiff: number;
  avgDiff5d: number;
  diffStd: number;
  niftyVol: number;
  sensexVol: number;
  signal: "TRADE" | "WATCH" | "WAIT";
  reason: string;
  action: string;
  tip: string;
  history: { date: string; nifty: number; sensex: number; corr5d: number; returnDiff: number }[];
}

function fmt(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0";
  return n.toFixed(2);
}

function sf(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0.00";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function corrBand(corr: number): { label: string; color: string } {
  if (corr >= 0.97) return { label: "Locked", color: "emerald" };
  if (corr >= 0.94) return { label: "Normal", color: "blue" };
  if (corr >= 0.90) return { label: "Drifting", color: "amber" };
  return { label: "Fighting", color: "red" };
}

export default function CorrelationPanel() {
  const [data, setData] = useState<CorrelationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/correlation");
      const json = await res.json();
      if (json.success) setData(json);
      else setError(json.error || "Failed");
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const signalConfig = {
    TRADE: { label: "TAKE TRADE", icon: "⚡", bg: "bg-emerald-500/10", border: "border-emerald-500/40", text: "text-emerald-400", badge: "bg-emerald-600 text-white" },
    WATCH: { label: "WATCH", icon: "👀", bg: "bg-amber-500/10", border: "border-amber-500/40", text: "text-amber-400", badge: "bg-amber-600 text-white" },
    WAIT: { label: "WAIT", icon: "💤", bg: "bg-muted/30", border: "border-border", text: "text-muted-foreground", badge: "bg-muted-foreground text-white" },
  };

  return (
    <div className="space-y-3 p-1">
      {/* Header */}
      <div className="flex items-center justify-between bg-muted/20 rounded-xl px-4 py-3 border border-border">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/25">
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" /></svg>
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">NIFTY vs SENSEX</h1>
            <p className="text-sm text-muted-foreground">Pair correlation · Mean reversion · Real data from Yahoo Finance</p>
          </div>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-4 py-2 rounded-xl text-sm font-bold bg-primary hover:bg-primary/80 disabled:opacity-50 text-primary-foreground transition-colors"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent mx-auto mb-3" />
          <p className="text-base text-muted-foreground font-medium">
            {loading ? "Fetching Nifty & Sensex data from Yahoo Finance..." : "Click Refresh to analyze"}
          </p>
        </div>
      )}

      {data && (() => {
        const sig = signalConfig[data.signal];
        const c5 = corrBand(data.last5dCorrelation);
        const c20 = corrBand(data.last20dCorrelation);
        const cAll = corrBand(data.overallCorrelation);

        return (
          <>
            {/* Signal Banner */}
            <div className={`rounded-xl border-2 ${sig.bg} ${sig.border} px-5 py-4 text-center`}>
              <div className={`text-4xl font-black ${sig.text}`}>{sig.icon} {sig.label}</div>
              <div className="text-base text-muted-foreground mt-1">{data.reason}</div>
            </div>

            {/* Action Card */}
            <div className="bg-emerald-500/[0.04] border border-emerald-500/20 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                <span className="text-sm font-bold uppercase tracking-wider text-emerald-400">Action</span>
              </div>
              <div className="text-lg font-bold">{data.action}</div>
              {data.tip && (
                <div className="text-sm text-muted-foreground mt-1 italic">{data.tip}</div>
              )}
            </div>

            {/* Prices */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-blue-500/[0.04] border border-blue-500/20 rounded-xl px-4 py-3 text-center">
                <div className="text-sm text-blue-400 font-bold uppercase tracking-wider">NIFTY</div>
                <div className="text-3xl font-black">{data.niftyPrice.toLocaleString("en-IN")}</div>
              </div>
              <div className="bg-purple-500/[0.04] border border-purple-500/20 rounded-xl px-4 py-3 text-center">
                <div className="text-sm text-purple-400 font-bold uppercase tracking-wider">SENSEX</div>
                <div className="text-3xl font-black">{data.sensexPrice.toLocaleString("en-IN")}</div>
              </div>
            </div>

            {/* Correlation Gauges */}
            <div className="bg-muted/20 rounded-xl border border-border px-4 py-3">
              <div className="flex items-center gap-2 mb-3">
                <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                <span className="text-base font-bold uppercase tracking-wider">Correlation</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Overall", value: data.overallCorrelation, band: cAll },
                  { label: "Last 5 Days", value: data.last5dCorrelation, band: c5 },
                  { label: "Last 20 Days", value: data.last20dCorrelation, band: c20 },
                ].map(item => (
                  <div key={item.label} className="bg-muted/30 rounded-xl border border-border/50 px-3 py-2.5 text-center">
                    <div className="text-sm text-muted-foreground">{item.label}</div>
                    <div className={`text-2xl font-black text-${item.band.color}-400`}>{sf(item.value)}</div>
                    <div className={`text-sm font-bold text-${item.band.color}-400`}>{item.band.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-muted/20 rounded-xl border border-border px-3 py-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <svg className="h-3.5 w-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" /></svg>
                  <span className="text-sm text-muted-foreground font-bold uppercase tracking-wider">Beta</span>
                </div>
                <div className="text-xl font-black">{sf(data.beta)}</div>
                <div className="text-sm text-muted-foreground">Sensex +1% → Nifty +{sf(data.beta)}%</div>
              </div>
              <div className={`bg-muted/20 rounded-xl border px-3 py-2.5 ${
                Math.abs(data.todayReturnDiff) > 0.15 ? 'border-amber-500/30' : 'border-border'
              }`}>
                <div className="flex items-center gap-1.5 mb-1">
                  <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span className="text-sm text-muted-foreground font-bold uppercase tracking-wider">Today Gap</span>
                </div>
                <div className={`text-xl font-black ${Math.abs(data.todayReturnDiff) > 0.15 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {data.todayReturnDiff > 0 ? "+" : ""}{sf(data.todayReturnDiff)}%
                </div>
                <div className="text-sm text-muted-foreground">σ = ±{sf(data.diffStd)}%</div>
              </div>
              <div className="bg-muted/20 rounded-xl border border-border px-3 py-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <svg className="h-3.5 w-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                  <span className="text-sm text-muted-foreground font-bold uppercase tracking-wider">NIFTY Vol</span>
                </div>
                <div className="text-xl font-black">{sf(data.niftyVol)}%</div>
                <div className="text-sm text-muted-foreground">20d annualized</div>
              </div>
              <div className="bg-muted/20 rounded-xl border border-border px-3 py-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <svg className="h-3.5 w-3.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                  <span className="text-sm text-muted-foreground font-bold uppercase tracking-wider">SENSEX Vol</span>
                </div>
                <div className="text-xl font-black">{sf(data.sensexVol)}%</div>
                <div className="text-sm text-muted-foreground">20d annualized</div>
              </div>
            </div>

            {/* Correlation History Chart */}
            {data.history.length > 0 && (
              <div className="bg-muted/20 rounded-xl border border-border px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                  <span className="text-base font-bold uppercase tracking-wider">5-Day Correlation History</span>
                  <span className="text-sm text-muted-foreground ml-auto">{data.history.length} data points</span>
                </div>
                <div className="flex items-end gap-px h-24 mb-1">
                  {data.history.slice(-30).map((h, i) => {
                    const val = h.corr5d;
                    const height = Math.max(3, ((val - 0.80) / 0.20) * 100);
                    const band = corrBand(val);
                    const colorClass = band.color === "emerald" ? "bg-emerald-400" : band.color === "blue" ? "bg-blue-400" : band.color === "amber" ? "bg-amber-400" : "bg-red-400";
                    return (
                      <div
                        key={i}
                        className="flex-1 rounded-t-sm opacity-80 hover:opacity-100 transition-opacity"
                        style={{ height: `${Math.min(100, height)}%`, minWidth: 3 }}
                        title={`${h.date}: ${sf(val)} (${band.label})`}
                      >
                        <div className={`h-full w-full rounded-t-sm ${colorClass}`} />
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground mb-1">
                  <span>30 days ago</span>
                  <span className="text-base font-bold">{sf(data.last5dCorrelation)} now</span>
                  <span>Today</span>
                </div>
                <div className="flex justify-center gap-4 text-sm">
                  <span className="text-emerald-400">● ≥0.97 Locked</span>
                  <span className="text-blue-400">● ≥0.94 Normal</span>
                  <span className="text-amber-400">● ≥0.90 Drifting</span>
                  <span className="text-red-400">● &lt;0.90 Fighting</span>
                </div>
              </div>
            )}

            {/* Return Diff Chart */}
            {data.history.length > 0 && (
              <div className="bg-muted/20 rounded-xl border border-border px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                  <span className="text-base font-bold uppercase tracking-wider">Return Difference</span>
                </div>
                <div className="flex items-end gap-px h-24 mb-1">
                  {data.history.slice(-30).map((h, i) => {
                    const rd = h.returnDiff;
                    const isPos = rd >= 0;
                    const absRd = Math.abs(rd);
                    const height = Math.min(100, absRd * 100);
                    const colorClass = isPos ? "bg-emerald-400/80" : "bg-red-400/80";
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end" style={{ minWidth: 3 }}>
                        <div
                          className={`w-full rounded-sm ${colorClass}`}
                          style={{ height: `${height}%`, minHeight: rd !== 0 ? 2 : 0 }}
                          title={`${h.date}: ${rd > 0 ? "+" : ""}${sf(rd)}%`}
                        />
                        {!isPos && <div className="w-full" style={{ height: `${100 - height}%` }} />}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-sm text-muted-foreground mb-1">
                  <span>Nifty - Sensex daily return</span>
                  <span className={`font-bold ${Math.abs(data.todayReturnDiff) > 0.15 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    Today: {data.todayReturnDiff > 0 ? "+" : ""}{sf(data.todayReturnDiff)}%
                  </span>
                </div>
                <div className="flex justify-center gap-4 text-sm">
                  <span className="text-emerald-400">▲ Nifty outperformed</span>
                  <span className="text-red-400">▼ Sensex outperformed</span>
                </div>
              </div>
            )}

            {/* How it works */}
            <div className="bg-muted/10 rounded-xl border border-border/50 px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">How it works</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Nifty and Sensex usually move together (correlation &gt; 0.97). When they drift apart, they tend to mean-revert.
                Signals trigger when correlation breaks below 0.94 or the return gap exceeds 2σ.
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Data: Yahoo Finance · Window: 5d rolling · Analyzed {data.daysAnalyzed} trading days
              </p>
            </div>
          </>
        );
      })()}
    </div>
  );
}
