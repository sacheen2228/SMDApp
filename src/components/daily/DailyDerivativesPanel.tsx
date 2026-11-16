// DailyDerivativesPanel — "Daily Derivatives" view using DailyDerivativesService
// Displays: India VIX, PCR, Max Pain, OI Walls, ATM Greeks, Signals, Sentiment
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  TrendingUp,
  TrendingDown,
  ShieldOff,
  RefreshCw,
  AlertTriangle,
  Activity,
  Gauge,
  Target,
  BarChart2,
  Zap,
} from "lucide-react";

interface Signal {
  index: number;
  time: number | string;
  type: "CROSSOVER" | "PULLBACK" | "BREAKOUT" | "RETEST" | "FAKEOUT";
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  targets: number[];
  strength: number;
  reason: string;
}

interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

interface TradePlanCard {
  optionType: "CE" | "PE";
  strike: number;
  entry: number;
  stopLoss: number;
  targets: number[];
  rr: number;
  lots: number;
  deployed: number;
  riskAmount: number;
  tradable: boolean;
  otmSteps: number;
  reason: string;
}

interface DailyDerivativesReport {
  underlying: "NIFTY" | "SENSEX";
  timestamp: string;
  spot: number;
  indiaVix: number;
  indiaVixChange: number;
  pcr: number;
  maxPain: number;
  callWall: number;
  putWall: number;
  totalCallOI: number;
  totalPutOI: number;
  atmStrike: number;
  atmIV: number;
  atmGreeks?: Greeks;
  topCallOI: { strike: number; oi: number; oiChange: number }[];
  topPutOI: { strike: number; oi: number; oiChange: number }[];
  expiry: string;
  daysToExpiry: number;
  latestSignals: Signal[];
  sentiment: "Extreme Greed" | "Bullish" | "Neutral" | "Bearish" | "Extreme Fear";
  sentimentScore: number;
  tradePlans: TradePlanCard[];
  preferredSide: "CALL" | "PUT" | null;
  candleSource: string;
  candleInterval: string;
  candleDegraded: string | null;
  candleCount: number;
}

interface ApiResponse {
  success: boolean;
  data?: DailyDerivativesReport;
  error?: string;
}

const SYMBOLS = ["NIFTY", "SENSEX"] as const;
const SENTIMENT_COLORS: Record<string, string> = {
  "Extreme Greed": "text-emerald-400",
  "Bullish": "text-emerald-400",
  "Neutral": "text-amber-400",
  "Bearish": "text-rose-400",
  "Extreme Fear": "text-rose-400",
};
const SENTIMENT_BG: Record<string, string> = {
  "Extreme Greed": "bg-emerald-500/20",
  "Bullish": "bg-emerald-500/10",
  "Neutral": "bg-amber-500/10",
  "Bearish": "bg-rose-500/10",
  "Extreme Fear": "bg-rose-500/20",
};

function DailyDerivativesPanel({ symbol: initialSymbol = "NIFTY" }: { symbol?: string }) {
  const [symbol, setSymbol] = useState<string>(SYMBOLS.includes(initialSymbol as any) ? (initialSymbol as any) : "NIFTY");
  const [report, setReport] = useState<DailyDerivativesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/daily-derivatives?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const json: ApiResponse = await res.json();
      if (!json.success) throw new Error(json.error || "failed");
      setReport(json.data!);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 300000); // 5 min refresh
    return () => clearInterval(t);
  }, [load]);

  const formatNumber = (n: number): string => {
    if (n >= 10000000) return (n / 10000000).toFixed(2) + " Cr";
    if (n >= 100000) return (n / 100000).toFixed(2) + " L";
    if (n >= 1000) return (n / 1000).toFixed(1) + " K";
    return n.toString();
  };

  const formatOI = (n: number): string => {
    if (n >= 10000000) return (n / 10000000).toFixed(2) + " Cr";
    if (n >= 100000) return (n / 100000).toFixed(2) + " L";
    return n.toLocaleString("en-IN");
  };

  const SignalBadge = ({ type, side, strength }: { type: string; side: string; strength: number }) => {
    const isLong = side === "LONG";
    const bg = isLong ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400";
    const icon = type === "BREAKOUT" ? <Zap className="h-2.5 w-2.5" /> :
                 type === "CROSSOVER" ? <Activity className="h-2.5 w-2.5" /> :
                 type === "PULLBACK" ? <Target className="h-2.5 w-2.5" /> :
                 <AlertTriangle className="h-2.5 w-2.5" />;
    return (
      <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold ${bg}`}>
        {icon} {type} {isLong ? "↑" : "↓"} ({strength})
      </span>
    );
  };

  const MetricCard = ({ label, value, icon: Icon, color = "text-violet-400", subValue }: { label: string; value: string | number; icon: React.ComponentType<{ className?: string }>; color?: string; subValue?: string }) => (
    <div className="bg-card/50 border border-border/50 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`h-4 w-4 ${color}`} />
        <span className="text-[10px] text-muted-foreground font-medium">{label}</span>
      </div>
      <div className="font-mono text-[14px] font-bold text-foreground">{value}</div>
      {subValue && <div className="text-[9px] text-muted-foreground mt-0.5">{subValue}</div>}
    </div>
  );

  if (!report && loading) {
    return (
      <div className="p-3 max-w-3xl mx-auto">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-violet-500 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Loading Daily Derivatives...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 max-w-5xl mx-auto space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-violet-500" />
          <span className="text-[13px] font-bold text-foreground">Daily Derivatives</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`h-6 text-[10px] px-2 font-bold rounded ${symbol === s ? "bg-violet-600 text-white" : "text-muted-foreground hover:text-violet-400"}`}
              >
                {s}
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading} className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-muted hover:bg-muted/70 text-muted-foreground">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="text-[12px] text-rose-400 p-3 bg-rose-500/10 rounded">{error}</div>}

      {report && (
        <>
          {/* Top Metrics Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
            <MetricCard
              label="Spot"
              value={report.spot.toFixed(2)}
              icon={Gauge}
              color="text-cyan-400"
              subValue={`${report.underlying} • ${new Date(report.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`}
            />
            <MetricCard
              label="India VIX"
              value={report.indiaVix.toFixed(2)}
              icon={Activity}
              color={report.indiaVix > 20 ? "text-rose-400" : report.indiaVix < 13 ? "text-emerald-400" : "text-amber-400"}
              subValue={`${report.indiaVixChange >= 0 ? "+" : ""}${report.indiaVixChange.toFixed(2)}`}
            />
            <MetricCard
              label="PCR"
              value={report.pcr.toFixed(3)}
              icon={BarChart2}
              color={report.pcr > 1.2 ? "text-emerald-400" : report.pcr < 0.8 ? "text-rose-400" : "text-amber-400"}
              subValue={report.pcr > 1 ? "Bullish" : report.pcr < 0.85 ? "Bearish" : "Neutral"}
            />
            <MetricCard
              label="Max Pain"
              value={report.maxPain.toLocaleString("en-IN")}
              icon={Target}
              color="text-sky-400"
            />
            <MetricCard
              label="Call Wall"
              value={report.callWall.toLocaleString("en-IN")}
              icon={TrendingUp}
              color="text-rose-400"
            />
            <MetricCard
              label="Put Wall"
              value={report.putWall.toLocaleString("en-IN")}
              icon={TrendingDown}
              color="text-emerald-400"
            />
            <MetricCard
              label="ATM IV"
              value={`${report.atmIV}%`}
              icon={Zap}
              color="text-purple-400"
              subValue={`Strike: ${report.atmStrike}`}
            />
          </div>

          {/* OI Summary Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCard
              label="Total Call OI"
              value={formatOI(report.totalCallOI)}
              icon={TrendingUp}
              color="text-rose-400"
            />
            <MetricCard
              label="Total Put OI"
              value={formatOI(report.totalPutOI)}
              icon={TrendingDown}
              color="text-emerald-400"
            />
            <MetricCard
              label="ATM Delta"
              value={report.atmGreeks?.delta?.toFixed(3) || "—"}
              icon={Gauge}
              color="text-cyan-400"
            />
            <MetricCard
              label="ATM Theta"
              value={report.atmGreeks?.theta?.toFixed(2) || "—"}
              icon={CalendarClock}
              color="text-amber-400"
            />
          </div>

          {/* Sentiment & Expiry */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-card/50 border border-border/50 rounded-lg">
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted-foreground">Market Sentiment:</span>
              <span className={`px-3 py-1 rounded-full text-[11px] font-bold ${SENTIMENT_COLORS[report.sentiment]} ${SENTIMENT_BG[report.sentiment]}`}>
                {report.sentiment} ({report.sentimentScore}/100)
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span>Expiry: <span className="font-mono text-foreground">{report.expiry.slice(0, 10)}</span></span>
              <span>•</span>
              <span>DTE: <span className="font-mono text-foreground">{report.daysToExpiry} days</span></span>
              <span>•</span>
              <span>ATM Strike: <span className="font-mono text-foreground">{report.atmStrike}</span></span>
            </div>
          </div>

          {/* Trade Plans — Strike • Entry • SL • TP */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-emerald-400" />
                <span className="text-[11px] font-bold text-foreground">Trade Plan — Strike • Entry • SL • TP</span>
              </div>
              <span className="text-[9px] text-muted-foreground">₹45k budget · SL 20% · TP 2R/3R/4R</span>
            </div>
            {(report.tradePlans || []).length === 0 ? (
              <div className="text-[11px] text-muted-foreground text-center py-2">No tradable contract found</div>
            ) : (
              <div className="space-y-2">
                {report.tradePlans.map((p, i) => {
                  const preferred = p.optionType === (report.preferredSide === "PUT" ? "PE" : "CE");
                  const isCE = p.optionType === "CE";
                  return (
                    <div
                      key={i}
                      className={`rounded-lg p-2.5 border ${preferred ? "border-violet-500/40 bg-violet-500/5" : "border-border/40 bg-muted/20"}`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${isCE ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-emerald-400"}`}>
                            {p.optionType} {p.strike.toLocaleString("en-IN")}
                          </span>
                          {preferred && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-500/20 text-violet-300">
                              ★ PREFERRED ({report.preferredSide})
                            </span>
                          )}
                          {p.otmSteps > 0 && (
                            <span className="text-[9px] text-muted-foreground">{p.otmSteps} OTM</span>
                          )}
                        </div>
                        {p.tradable ? (
                          <span className="text-[9px] font-mono text-muted-foreground">
                            {p.lots} lot{p.lots === 1 ? "" : "s"} · ₹{Math.round(p.deployed).toLocaleString("en-IN")} dep · ₹{Math.round(p.riskAmount).toLocaleString("en-IN")} risk
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-500/20 text-rose-400">NOT TRADABLE</span>
                        )}
                      </div>
                      <div className="grid grid-cols-5 gap-1 text-[10px]">
                        <div className="bg-muted/40 rounded p-1.5 text-center">
                          <div className="text-muted-foreground">Entry</div>
                          <div className="font-mono text-foreground font-bold">{p.entry.toFixed(2)}</div>
                        </div>
                        <div className="bg-rose-500/5 rounded p-1.5 text-center">
                          <div className="text-rose-300">SL</div>
                          <div className="font-mono text-rose-400 font-bold">{p.stopLoss > 0 ? p.stopLoss.toFixed(2) : "—"}</div>
                        </div>
                        {[0, 1, 2].map((k) => (
                          <div key={k} className="bg-emerald-500/5 rounded p-1.5 text-center">
                            <div className="text-emerald-300">TP{k + 1}</div>
                            <div className="font-mono text-emerald-400 font-bold">
                              {p.targets?.[k] != null ? p.targets[k].toFixed(2) : "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                      {p.reason && <div className="text-[9px] text-muted-foreground mt-1.5 leading-snug">{p.reason}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top Call OI */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-rose-400" />
              <span className="text-[11px] font-bold text-rose-400">Top 5 Call OI Strikes</span>
            </div>
            <div className="grid grid-cols-5 gap-1 text-[10px]">
              {report.topCallOI.map((t, i) => (
                <div key={i} className="text-center p-1.5 bg-rose-500/5 rounded">
                  <div className="font-mono text-foreground">{t.strike}</div>
                  <div className="text-rose-300">OI: {formatOI(t.oi)}</div>
                  <div className={`text-[9px] ${t.oiChange > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    Δ: {t.oiChange > 0 ? "+" : ""}{formatOI(t.oiChange)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Top Put OI */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="h-4 w-4 text-emerald-400" />
              <span className="text-[11px] font-bold text-emerald-400">Top 5 Put OI Strikes</span>
            </div>
            <div className="grid grid-cols-5 gap-1 text-[10px]">
              {report.topPutOI.map((t, i) => (
                <div key={i} className="text-center p-1.5 bg-emerald-500/5 rounded">
                  <div className="font-mono text-foreground">{t.strike}</div>
                  <div className="text-emerald-300">OI: {formatOI(t.oi)}</div>
                  <div className={`text-[9px] ${t.oiChange > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    Δ: {t.oiChange > 0 ? "+" : ""}{formatOI(t.oiChange)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Latest Signals */}
          <div className="bg-card/50 border border-border/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="h-4 w-4 text-violet-400" />
              <span className="text-[11px] font-bold text-foreground">Latest Technical Signals (EMA 9/15 + ADX/ATR)</span>
            </div>
            {report.latestSignals.length === 0 ? (
              <div className="text-[11px] text-muted-foreground text-center py-2">No recent signals</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {report.latestSignals.map((s, i) => (
                  <SignalBadge key={i} type={s.type} side={s.side} strength={s.strength} />
                ))}
              </div>
            )}
            <div className="text-[9px] text-muted-foreground mt-1.5">
              Candles: {report.candleCount} @ {report.candleInterval} ({report.candleSource}
              {report.candleDegraded ? ` — ${report.candleDegraded}` : ""})
            </div>
          </div>

          {/* ATM Greeks Detail */}
          {report.atmGreeks && (
            <div className="bg-card/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="h-4 w-4 text-purple-400" />
                <span className="text-[11px] font-bold text-foreground">ATM Greeks (Black-Scholes)</span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[10px]">
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Delta</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.delta.toFixed(3)}</div>
                </div>
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Gamma</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.gamma.toFixed(4)}</div>
                </div>
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Theta (daily)</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.theta.toFixed(2)}</div>
                </div>
                <div className="bg-purple-500/5 rounded p-2 text-center">
                  <div className="text-purple-300">Vega</div>
                  <div className="font-mono text-foreground">{report.atmGreeks.vega.toFixed(2)}</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default DailyDerivativesPanel;