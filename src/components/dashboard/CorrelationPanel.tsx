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

function corrLabel(corr: number): { label: string; color: string; emoji: string } {
  if (corr >= 0.97) return { label: "Best Friends", color: "#22c55e", emoji: "🟢" };
  if (corr >= 0.94) return { label: "Normal", color: "#3b82f6", emoji: "🔵" };
  if (corr >= 0.90) return { label: "Drifting Apart", color: "#f97316", emoji: "🟠" };
  return { label: "Fighting!", color: "#ef4444", emoji: "🔴" };
}

function signalStyle(signal: string) {
  if (signal === "TRADE") return { bg: "#22c55e", text: "🟢 TAKE TRADE" };
  if (signal === "WATCH") return { bg: "#f97316", text: "👀 WATCH" };
  return { bg: "#6b7280", text: "😴 WAIT" };
}

function sf(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0";
  return n.toFixed(2);
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

  useEffect(() => {
    fetchData();
  }, []);

  const corr = data ? corrLabel(data.last5dCorrelation) : null;
  const sig = data ? signalStyle(data.signal) : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <span className="text-lg">📊</span> NIFTY vs SENSEX Correlation
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-3 py-1 rounded text-xs font-bold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
        >
          {loading ? "Analyzing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-600 rounded p-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="text-center text-gray-400 py-8 text-sm">
          {loading ? "Fetching Nifty & Sensex data..." : "Click Refresh to analyze"}
        </div>
      )}

      {data && (
        <>
          {/* Big Signal Banner */}
          <div
            className="rounded-lg p-4 text-center"
            style={{ backgroundColor: `${sig?.bg}22`, border: `2px solid ${sig?.bg}` }}
          >
            <div className="text-3xl font-bold text-white">{sig?.text}</div>
            <div className="text-sm text-gray-300 mt-1">{data.reason}</div>
          </div>

          {/* Action Card */}
          <div className="bg-green-900/30 border border-green-600 rounded-lg p-3">
            <div className="text-xs text-green-400 font-bold mb-1">💡 ACTION</div>
            <div className="text-sm text-green-200 font-semibold">{data.action}</div>
            {data.tip && (
              <div className="text-xs text-gray-400 mt-2 italic">{data.tip}</div>
            )}
          </div>

          {/* Prices */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-blue-900/30 border border-blue-600 rounded-lg p-3 text-center">
              <div className="text-xs text-blue-400 font-bold">NIFTY</div>
              <div className="text-xl font-bold text-white">
                {data.niftyPrice.toLocaleString("en-IN")}
              </div>
            </div>
            <div className="bg-purple-900/30 border border-purple-600 rounded-lg p-3 text-center">
              <div className="text-xs text-purple-400 font-bold">SENSEX</div>
              <div className="text-xl font-bold text-white">
                {data.sensexPrice.toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          {/* Correlation Gauges */}
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
            <div className="text-xs text-gray-400 font-bold mb-3">🔗 CORRELATION</div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Overall", value: data.overallCorrelation },
                { label: "Last 5 Days", value: data.last5dCorrelation },
                { label: "Last 20 Days", value: data.last20dCorrelation },
              ].map((item) => {
                const c = corrLabel(item.value);
                return (
                  <div key={item.label} className="text-center">
                    <div className="text-xs text-gray-400">{item.label}</div>
                    <div className="text-lg font-bold" style={{ color: c.color }}>
                      {sf(item.value)}
                    </div>
                    <div className="text-xs" style={{ color: c.color }}>
                      {c.emoji} {c.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
              <div className="text-xs text-gray-400 font-bold">📐 BETA</div>
              <div className="text-lg font-bold text-white">{sf(data.beta)}</div>
              <div className="text-xs text-gray-500">
                Sensex +1% → Nifty +{sf(data.beta)}%
              </div>
            </div>
            <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
              <div className="text-xs text-gray-400 font-bold">📏 TODAY GAP</div>
              <div
                className="text-lg font-bold"
                style={{ color: Math.abs(data.todayReturnDiff) > 0.15 ? "#f97316" : "#22c55e" }}
              >
                {data.todayReturnDiff > 0 ? "+" : ""}
                {sf(data.todayReturnDiff)}%
              </div>
              <div className="text-xs text-gray-500">
                Normal: ±{sf(data.diffStd)}%
              </div>
            </div>
            <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
              <div className="text-xs text-gray-400 font-bold">⚡ NIFTY VOL</div>
              <div className="text-lg font-bold text-white">{sf(data.niftyVol)}%</div>
              <div className="text-xs text-gray-500">20-day annualized</div>
            </div>
            <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
              <div className="text-xs text-gray-400 font-bold">⚡ SENSEX VOL</div>
              <div className="text-lg font-bold text-white">{sf(data.sensexVol)}%</div>
              <div className="text-xs text-gray-500">20-day annualized</div>
            </div>
          </div>

          {/* Correlation History Mini-Chart */}
          {data.history.length > 0 && (
            <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
              <div className="text-xs text-gray-400 font-bold mb-2">📈 5-DAY CORRELATION HISTORY</div>
              <div className="flex items-end gap-px h-16">
                {data.history.slice(-30).map((h, i) => {
                  const val = h.corr5d;
                  const height = Math.max(4, ((val - 0.85) / 0.15) * 100);
                  const color = val >= 0.97 ? "#22c55e" : val >= 0.94 ? "#3b82f6" : val >= 0.90 ? "#f97316" : "#ef4444";
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-t"
                      style={{
                        height: `${Math.min(100, height)}%`,
                        backgroundColor: color,
                        minWidth: 2,
                      }}
                      title={`${h.date}: ${sf(val)}`}
                    />
                  );
                })}
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>30 days ago</span>
                <span>Today</span>
              </div>
              <div className="flex justify-center gap-4 mt-2 text-xs">
                <span style={{ color: "#22c55e" }}>● ≥0.97 Normal</span>
                <span style={{ color: "#3b82f6" }}>● ≥0.94 OK</span>
                <span style={{ color: "#f97316" }}>● ≥0.90 Drifting</span>
                <span style={{ color: "#ef4444" }}>● &lt;0.90 Fighting</span>
              </div>
            </div>
          )}

          {/* How it works */}
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 text-xs text-gray-400">
            <div className="font-bold text-gray-300 mb-1">📖 How it works</div>
            <div>Nifty and Sensex usually move together (correlation &gt; 0.97). When they drift apart, they tend to come back. We bet on that comeback.</div>
            <div className="mt-1">Data: Yahoo Finance | Window: 5 days | Signal threshold: correlation &lt; 0.94 or gap &gt; 2× normal</div>
          </div>

          <div className="text-xs text-gray-600 text-right">
            Analyzed {data.daysAnalyzed} trading days
          </div>
        </>
      )}
    </div>
  );
}
