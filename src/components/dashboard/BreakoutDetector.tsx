// BreakoutDetector — Live Candlestick Breakout + Fakeout Detection
// Shows real-time strategy signals, S/R levels, and trade results

"use client";

import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Target,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Activity,
  Zap,
  Shield,
  Clock,
} from "lucide-react";
import { SYMBOL_CONFIGS } from "@/lib/symbol-config";

// ─── Candlestick Chart ─────────────────────────────────────────
function MiniChart({ candles, trades }: { candles: any[]; trades: any[] }) {
  if (!candles || candles.length === 0) return null;

  const width = 700;
  const height = 160;
  const pad = { top: 10, right: 40, bottom: 20, left: 10 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const allHigh = candles.map((c: any) => c.high);
  const allLow = candles.map((c: any) => c.low);
  const min = Math.min(...allLow) * 0.999;
  const max = Math.max(...allHigh) * 1.001;
  const range = max - min;

  const y = (p: number) => pad.top + ch - ((p - min) / range) * ch;
  const gap = cw / candles.length;
  const cw2 = Math.max(2, gap - 1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {[0, 0.5, 1].map((p) => (
        <g key={p}>
          <line x1={pad.left} y1={y(min + range * p)} x2={width - pad.right} y2={y(min + range * p)} stroke="#333" strokeWidth={0.5} />
          <text x={width - pad.right + 3} y={y(min + range * p) + 3} fill="#666" fontSize={7}>{Math.round(min + range * p)}</text>
        </g>
      ))}
      {candles.map((c: any, i: number) => {
        const x = pad.left + i * gap + gap / 2;
        const bull = c.close >= c.open;
        const col = bull ? "#26a69a" : "#ef5350";
        const bt = y(Math.max(c.open, c.close));
        const bb = y(Math.min(c.open, c.close));
        return (
          <g key={i}>
            <line x1={x} y1={y(c.high)} x2={x} y2={y(c.low)} stroke={col} strokeWidth={0.8} />
            <rect x={x - cw2 / 2} y={bt} width={cw2} height={Math.max(1, bb - bt)} fill={bull ? "transparent" : col} stroke={col} strokeWidth={0.6} />
          </g>
        );
      })}
      {trades.map((t: any, i: number) => {
        const ci = t.candleIndex;
        if (ci < 0 || ci >= candles.length) return null;
        const x = pad.left + ci * gap + gap / 2;
        const ey = y(t.entry);
        const win = t.status === "WIN";
        return (
          <g key={i}>
            <circle cx={x} cy={ey - 6} r={3.5} fill={win ? "#4caf50" : "#ff5252"} />
            <text x={x} y={ey - 3.5} textAnchor="middle" fill="#fff" fontSize={4.5} fontWeight="bold">
              {win ? "W" : t.status === "LOSS" ? "L" : "E"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Main Component ─────────────────────────────────────────────
export const BreakoutDetector = memo(function BreakoutDetector() {
  const [symbol, setSymbol] = useState("NIFTY");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["breakout", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/breakout?symbol=${symbol}`);
      return res.json();
    },
    refetchInterval: 30000,
  });

  const signals = data?.data || {};
  const srLevels = signals.srLevels || [];
  const recentSignals = signals.recentSignals || [];
  const stats = signals.stats || {};
  const candles = signals.candles || [];
  const trade = signals.signal;

  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-[#e0e0e0]">
            Candlestick Breakout + Fakeout Detection
          </h1>
          <p className="text-[10px] text-[#9e9e9e]">
            {SYMBOL_CONFIGS[symbol]?.name || symbol} • Live Strategy Engine
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {Object.keys(SYMBOL_CONFIGS).map((sym) => (
              <Button
                key={sym}
                onClick={() => setSymbol(sym)}
                variant="ghost"
                size="sm"
                className={`h-7 px-3 text-[10px] font-bold ${
                  symbol === sym
                    ? "bg-[#e91e63] text-white"
                    : "text-[#9e9e9e] hover:text-[#e0e0e0]"
                }`}
              >
                {sym}
              </Button>
            ))}
          </div>
          <Button onClick={() => refetch()} variant="ghost" size="sm" className="h-7 w-7 p-0">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card className="border-[#2d2d2d] bg-[#1e1e1e]">
          <CardContent className="p-6 text-center text-[#9e9e9e] text-xs">
            Loading strategy signals...
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Current Signal */}
          {trade ? (
            <Card
              className="border"
              style={{
                borderColor: trade.type === "BREAKOUT_SIGNAL" ? "#4caf5060" : trade.type === "FAKEOUT_ALERT" ? "#ff980060" : "#333",
                backgroundColor: trade.type === "BREAKOUT_SIGNAL" ? "#1b2a1b" : trade.type === "FAKEOUT_ALERT" ? "#2a2a1b" : "#1e1e1e",
              }}
            >
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {trade.type === "BREAKOUT_SIGNAL" ? (
                      <CheckCircle className="w-4 h-4 text-[#4caf50]" />
                    ) : trade.type === "FAKEOUT_ALERT" ? (
                      <AlertTriangle className="w-4 h-4 text-[#ff9800]" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#757575]" />
                    )}
                    <span className="text-xs font-bold text-[#e0e0e0]">
                      {trade.type === "BREAKOUT_SIGNAL"
                        ? "VALID BREAKOUT"
                        : trade.type === "FAKEOUT_ALERT"
                          ? "FAKEOUT ALERT"
                          : "NO PATTERN"}
                    </span>
                    <Badge className="text-[9px] bg-[#333] text-[#ccc]">
                      {Math.round(trade.confidence || 0)}% confidence
                    </Badge>
                  </div>
                  <span className="text-[9px] text-[#9e9e9e]">{trade.marketTime}</span>
                </div>

                {/* Entry / SL / Target */}
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div className="text-center p-2 rounded bg-[#111]">
                    <div className="text-[8px] text-[#9e9e9e] mb-1">ENTRY</div>
                    <div className="text-sm font-bold text-[#e0e0e0]">
                      ₹{Math.round(trade.entryPrice || trade.level || 0).toLocaleString("en-IN")}
                    </div>
                  </div>
                  <div className="text-center p-2 rounded bg-[#111]">
                    <div className="text-[8px] text-[#9e9e9e] mb-1">STOP LOSS</div>
                    <div className="text-sm font-bold text-[#ff5252]">
                      ₹{Math.round(trade.slPrice || 0).toLocaleString("en-IN")}
                    </div>
                  </div>
                  <div className="text-center p-2 rounded bg-[#111]">
                    <div className="text-[8px] text-[#9e9e9e] mb-1">TARGET</div>
                    <div className="text-sm font-bold text-[#4caf50]">
                      ₹{Math.round(trade.targetPrice || 0).toLocaleString("en-IN")}
                    </div>
                  </div>
                </div>

                {/* R:R + Pattern */}
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-[#9e9e9e]">
                    Pattern: <span className="text-[#e0e0e0] font-bold">{trade.pattern || "none"}</span>
                  </span>
                  <span className="text-[#9e9e9e]">
                    R:R: <span className="text-[#e0e0e0] font-bold">{trade.riskReward || "—"}</span>
                  </span>
                  <span className="text-[#9e9e9e]">
                    Level: <span className="text-[#e0e0e0] font-bold">{trade.levelName}</span>
                  </span>
                </div>

                {/* Action */}
                <div className="flex gap-2 mt-3">
                  <button
                    className="flex-1 py-2 rounded font-bold text-xs"
                    style={{
                      backgroundColor: trade.direction === "bullish" ? "#1b5e20" : "#b71c1c",
                      color: "#fff",
                    }}
                  >
                    BUY {trade.direction === "bullish" ? "CE" : "PE"}
                  </button>
                  <button
                    className="flex-1 py-2 rounded font-bold text-xs"
                    style={{
                      backgroundColor: trade.direction === "bullish" ? "#b71c1c" : "#1b5e20",
                      color: "#fff",
                    }}
                  >
                    SELL {trade.direction === "bullish" ? "PE" : "CE"}
                  </button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-[#2d2d2d] bg-[#1e1e1e]">
              <CardContent className="p-4 text-center text-[#9e9e9e] text-xs">
                No signal currently. Strategy is scanning for breakout patterns.
              </CardContent>
            </Card>
          )}

          {/* Candlestick Chart */}
          {candles.length > 0 && (
            <Card className="border-[#2d2d2d] bg-[#1e1e1e]">
              <CardContent className="p-2">
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="w-3.5 h-3.5 text-[#9e9e9e]" />
                  <span className="text-[9px] text-[#9e9e9e] font-bold uppercase">Live Candles</span>
                  <span className="text-[8px] text-[#666]">• {candles.length} bars</span>
                </div>
                <MiniChart candles={candles} trades={recentSignals} />
              </CardContent>
            </Card>
          )}

          {/* Stats Row */}
          <div className="grid grid-cols-5 gap-2">
            {[
              { label: "Signals", value: stats.total || 0, color: "#e0e0e0" },
              { label: "Valid", value: stats.valid || 0, color: "#4caf50" },
              { label: "Fakeouts", value: stats.fakeouts || 0, color: "#ff9800" },
              { label: "Win Rate", value: `${stats.winRate || 0}%`, color: (stats.winRate || 0) >= 50 ? "#4caf50" : "#ff5252" },
              { label: "VIX", value: Math.round(signals.vix || 0), color: "#e0e0e0" },
            ].map((s) => (
              <Card key={s.label} className="border-[#2d2d2d] bg-[#1e1e1e]">
                <CardContent className="p-2 text-center">
                  <div className="text-[8px] text-[#9e9e9e]">{s.label}</div>
                  <div className="text-sm font-bold" style={{ color: s.color }}>{s.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* S/R Levels */}
          {srLevels.length > 0 && (
            <Card className="border-[#2d2d2d] bg-[#1e1e1e]">
              <CardContent className="p-2">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-3.5 h-3.5 text-[#9e9e9e]" />
                  <span className="text-[9px] text-[#9e9e9e] font-bold uppercase">Support / Resistance</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {srLevels.map((l: any, i: number) => (
                    <div
                      key={i}
                      className="px-3 py-1.5 rounded text-[10px] font-bold"
                      style={{
                        backgroundColor: l.type === "RESISTANCE" ? "#ff525215" : "#4caf5015",
                        color: l.type === "RESISTANCE" ? "#ff5252" : "#4caf50",
                        border: `1px solid ${l.type === "RESISTANCE" ? "#ff525230" : "#4caf5030"}`,
                      }}
                    >
                      {l.name}: ₹{Math.round(l.price).toLocaleString("en-IN")}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent Signals */}
          {recentSignals.length > 0 && (
            <Card className="border-[#2d2d2d] bg-[#1e1e1e]">
              <CardContent className="p-2">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="w-3.5 h-3.5 text-[#9e9e9e]" />
                  <span className="text-[9px] text-[#9e9e9e] font-bold uppercase">Recent Signals</span>
                </div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {recentSignals.map((sig: any, i: number) => (
                    <div key={i} className="flex items-center gap-3 p-2 rounded bg-[#111] text-[10px]">
                      {sig.type === "BREAKOUT_SIGNAL" ? (
                        <TrendingUp className="w-3.5 h-3.5 text-[#4caf50] shrink-0" />
                      ) : sig.type === "FAKEOUT_ALERT" ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-[#ff9800] shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-[#757575] shrink-0" />
                      )}
                      <span className="text-[#9e9e9e] flex-1">
                        {sig.pattern || "no pattern"} • ₹{Math.round(sig.entryPrice || sig.level || 0).toLocaleString("en-IN")}
                      </span>
                      <Badge
                        className="text-[8px]"
                        style={{
                          backgroundColor: sig.type === "BREAKOUT_SIGNAL" ? "#4caf5020" : sig.type === "FAKEOUT_ALERT" ? "#ff980020" : "#75757520",
                          color: sig.type === "BREAKOUT_SIGNAL" ? "#4caf50" : sig.type === "FAKEOUT_ALERT" ? "#ff9800" : "#757575",
                        }}
                      >
                        {sig.type === "BREAKOUT_SIGNAL" ? "VALID" : sig.type === "FAKEOUT_ALERT" ? "FAKEOUT" : "SKIP"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
});
