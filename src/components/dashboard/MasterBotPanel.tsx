"use client";

import { useState, useEffect } from "react";

interface TradePlan {
  setup: string;
  index: string;
  direction: string;
  strike: number;
  spot: number;
  entryPremium: number;
  slPremium: number;
  tpPremium: number;
  lots: number;
  totalPremium: number;
  maxRisk: number;
  rr: number;
  confidence: string;
  timeframe: string;
  expiryNote: string;
  exitTime: string;
  reasons: string[];
}

interface MarketSnapshot {
  nifty: number;
  sensex: number;
  niftyChange: number;
  sensexChange: number;
  corr5d: number;
  returnDiff: number;
  niftyVol: number;
  timeframeStatus: Record<string, { corr: number; diff: number; status: string }>;
}

interface BotResponse {
  plan: TradePlan[];
  snapshot: MarketSnapshot;
  signals: { timeframe: string; setup: string; direction: string; strength: string; details: string }[];
}

function sf(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0";
  return n.toFixed(2);
}

export default function MasterBotPanel() {
  const [data, setData] = useState<BotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/master-bot");
      const json = await res.json();
      if (json.error) setError(json.error);
      else setData(json);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const snap = data?.snapshot;
  const plan = data?.plan?.[0];
  const signals = data?.signals || [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <span className="text-lg">🎯</span> Master Trade Bot
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-3 py-1 rounded text-xs font-bold bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white"
        >
          {loading ? "⏳ Analyzing..." : "🔄 Refresh"}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded p-3 text-red-300 text-sm">
          ❌ {error}
        </div>
      )}

      {/* Market Snapshot */}
      {snap && (
        <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
          <div className="text-xs text-gray-400 mb-2 font-semibold">📊 MARKET SNAPSHOT</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-400">NIFTY:</span>{" "}
              <span className="text-white font-bold">{sf(snap.nifty)}</span>
              <span className={`ml-1 ${snap.niftyChange >= 0 ? "text-green-400" : "text-red-400"}`}>
                {snap.niftyChange >= 0 ? "+" : ""}{sf(snap.niftyChange)}%
              </span>
            </div>
            <div>
              <span className="text-gray-400">SENSEX:</span>{" "}
              <span className="text-white font-bold">{sf(snap.sensex)}</span>
              <span className={`ml-1 ${snap.sensexChange >= 0 ? "text-green-400" : "text-red-400"}`}>
                {snap.sensexChange >= 0 ? "+" : ""}{sf(snap.sensexChange)}%
              </span>
            </div>
            <div>
              <span className="text-gray-400">Correlation:</span>{" "}
              <span className="text-white font-bold">{sf(snap.corr5d)}</span>
            </div>
            <div>
              <span className="text-gray-400">Return Diff:</span>{" "}
              <span className="text-white font-bold">{sf(snap.returnDiff)}%</span>
            </div>
            <div>
              <span className="text-gray-400">Nifty Vol:</span>{" "}
              <span className="text-white font-bold">{sf(snap.niftyVol)}%</span>
            </div>
          </div>

          {/* Timeframe Status */}
          {Object.keys(snap.timeframeStatus).length > 0 && (
            <div className="mt-3 pt-2 border-t border-gray-700">
              <div className="text-xs text-gray-400 mb-1">Multi-Timeframe View</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(snap.timeframeStatus).map(([tf, s]) => (
                  <div key={tf} className="bg-gray-900/50 rounded px-2 py-1 text-xs">
                    <span>{s.status}</span>{" "}
                    <span className="text-gray-300">{tf}</span>{" "}
                    <span className="text-gray-400">({sf(s.corr)})</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Signals Found */}
      {signals.length > 0 && (
        <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
          <div className="text-xs text-gray-400 mb-2 font-semibold">🔍 SIGNALS DETECTED ({signals.length})</div>
          <div className="space-y-1">
            {signals.map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-gray-900/50 rounded px-2 py-1">
                <span className={`font-bold ${s.strength === "STRONG" || s.strength === "HIGH" ? "text-green-400" : "text-yellow-400"}`}>
                  {s.strength}
                </span>
                <span className="text-gray-400">{s.timeframe}</span>
                <span className="text-white">{s.setup}</span>
                <span className="text-gray-500">→</span>
                <span className="text-blue-300">{s.direction}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trade Plan */}
      {plan && (
        <div className={`rounded-lg p-4 border-2 ${
          plan.confidence === "HIGH"
            ? "bg-green-900/20 border-green-600"
            : "bg-yellow-900/20 border-yellow-600"
        }`}>
          <div className="text-xs text-gray-400 mb-2 font-semibold">🎯 RECOMMENDED TRADE</div>

          {/* Big Signal */}
          <div className="text-center mb-3">
            <div className={`text-2xl font-black ${
              plan.direction === "CALL" ? "text-green-400" : "text-red-400"
            }`}>
              {plan.direction} {plan.index} {plan.strike}
            </div>
            <div className="text-sm text-gray-300">
              {plan.setup} • {plan.confidence} Confidence
            </div>
          </div>

          {/* Trade Details */}
          <div className="grid grid-cols-2 gap-2 text-sm mb-3">
            <div className="bg-gray-900/50 rounded p-2">
              <div className="text-gray-400 text-xs">Spot Price</div>
              <div className="text-white font-bold">{sf(plan.spot)}</div>
            </div>
            <div className="bg-gray-900/50 rounded p-2">
              <div className="text-gray-400 text-xs">Strike</div>
              <div className="text-white font-bold">{plan.strike}</div>
            </div>
            <div className="bg-green-900/30 rounded p-2">
              <div className="text-gray-400 text-xs">Entry Premium</div>
              <div className="text-green-400 font-bold">₹{sf(plan.entryPremium)}</div>
            </div>
            <div className="bg-red-900/30 rounded p-2">
              <div className="text-gray-400 text-xs">Stop Loss</div>
              <div className="text-red-400 font-bold">₹{sf(plan.slPremium)}</div>
            </div>
            <div className="bg-blue-900/30 rounded p-2">
              <div className="text-gray-400 text-xs">Target</div>
              <div className="text-blue-400 font-bold">₹{sf(plan.tpPremium)}</div>
            </div>
            <div className="bg-gray-900/50 rounded p-2">
              <div className="text-gray-400 text-xs">R:R Ratio</div>
              <div className="text-white font-bold">{sf(plan.rr)}</div>
            </div>
          </div>

          {/* Position Sizing */}
          <div className="bg-gray-900/50 rounded p-3 text-sm mb-3">
            <div className="text-xs text-gray-400 mb-1">📦 POSITION SIZE</div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="text-gray-400">Lots:</span>{" "}
                <span className="text-white font-bold">{plan.lots}</span>
              </div>
              <div>
                <span className="text-gray-400">Total Premium:</span>{" "}
                <span className="text-yellow-400 font-bold">₹{sf(plan.totalPremium)}</span>
              </div>
              <div>
                <span className="text-gray-400">Max Risk:</span>{" "}
                <span className="text-red-400 font-bold">₹{sf(plan.maxRisk)}</span>
              </div>
            </div>
          </div>

          {/* Reasons */}
          {plan.reasons.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-gray-400 mb-1">📝 WHY THIS TRADE</div>
              {plan.reasons.map((r, i) => (
                <div key={i} className="text-xs text-gray-300 bg-gray-900/50 rounded px-2 py-1 mb-1">
                  ✅ {r}
                </div>
              ))}
            </div>
          )}

          {/* Expiry & Exit */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">
              ⏰ Exit by: <span className="text-white font-bold">{plan.exitTime}</span>
            </span>
            {plan.expiryNote && (
              <span className="text-yellow-400 font-semibold">{plan.expiryNote}</span>
            )}
          </div>
        </div>
      )}

      {/* No Trade */}
      {!loading && data && signals.length === 0 && (
        <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700 text-center">
          <div className="text-3xl mb-2">😴</div>
          <div className="text-gray-300 font-semibold mb-1">No Clear Trade Signal</div>
          <div className="text-gray-500 text-sm">
            Market conditions don&apos;t meet entry criteria. Wait for better setup.
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700 text-center">
          <div className="text-3xl mb-2 animate-pulse">🤖</div>
          <div className="text-gray-300 font-semibold">Analyzing 5 timeframes...</div>
          <div className="text-gray-500 text-sm mt-1">Daily • 1H • 15M • 5M • 3M</div>
        </div>
      )}

      {/* Rules */}
      <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
        <div className="text-xs text-gray-400 mb-2 font-semibold">📋 BOT RULES</div>
        <div className="space-y-1 text-xs text-gray-400">
          <div>• <span className="text-gray-300">2% max risk per trade</span> — never more</div>
          <div>• <span className="text-gray-300">R:R minimum 2:1</span> — no exceptions</div>
          <div>• <span className="text-gray-300">Expiry day = ITM only</span> — exit by 1 PM</div>
          <div>• <span className="text-gray-300">Pre-expiry = ATM/ITM</span> — time decay kills</div>
          <div>• <span className="text-gray-300">Nifty expires Tuesday</span> • <span className="text-gray-300">Sensex expires Thursday</span></div>
          <div>• <span className="text-gray-300">Multi-timeframe confirmation</span> = stronger signal</div>
        </div>
      </div>
    </div>
  );
}
