"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BacktestReport } from "./BacktestReport";
import {
  CalendarIcon,
  TrendingUp,
  TrendingDown,
  Clock,
  Target,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Play,
  Activity,
  Zap,
  Shield,
  TrendingUpIcon,
} from "lucide-react";
import { SYMBOL_CONFIGS } from "@/lib/symbol-config";

interface BacktestTabProps {
  trades: any[];
  symbol: string;
}

function formatDate(d: Date) {
  return d.toISOString().split("T")[0];
}

function getDayTrades(trades: any[], date: string) {
  if (!Array.isArray(trades)) return [];
  return trades.filter((t) => {
    if (!t.openedAt) return false;
    return t.openedAt.startsWith(date);
  });
}

// ─── Mini Candlestick Chart ────────────────────────────────────
function CandlestickChart({
  candles,
  srLevels,
  trades,
}: {
  candles: any[];
  srLevels: any[];
  trades: any[];
}) {
  if (!candles || candles.length === 0) return null;

  const width = 800;
  const height = 300;
  const padding = { top: 20, right: 60, bottom: 30, left: 10 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Price range
  const allHighs = candles.map((c: any) => c.high);
  const allLows = candles.map((c: any) => c.low);
  const srPrices = srLevels.map((l: any) => l.price);
  const minPrice = Math.min(...allLows, ...srPrices) * 0.999;
  const maxPrice = Math.max(...allHighs, ...srPrices) * 1.001;
  const priceRange = maxPrice - minPrice;

  const priceToY = (price: number) =>
    padding.top + chartH - ((price - minPrice) / priceRange) * chartH;

  const candleWidth = Math.max(2, Math.floor(chartW / candles.length) - 1);
  const gap = chartW / candles.length;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const y = padding.top + chartH * (1 - pct);
        const price = minPrice + priceRange * pct;
        return (
          <g key={pct}>
            <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#333" strokeWidth={0.5} />
            <text x={width - padding.right + 4} y={y + 3} fill="#9e9e9e" fontSize={8}>
              {Math.round(price)}
            </text>
          </g>
        );
      })}

      {/* S/R Levels */}
      {srLevels.map((level: any, i: number) => {
        const y = priceToY(level.price);
        const color = level.type === "RESISTANCE" ? "#ff5252" : "#4caf50";
        return (
          <g key={i}>
            <line
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              stroke={color}
              strokeWidth={1}
              strokeDasharray="4,3"
              opacity={0.6}
            />
            <text x={width - padding.right + 4} y={y + 3} fill={color} fontSize={7} fontWeight="bold">
              {level.name}
            </text>
          </g>
        );
      })}

      {/* Candles */}
      {candles.map((candle: any, i: number) => {
        const x = padding.left + i * gap + gap / 2;
        const isBull = candle.close >= candle.open;
        const color = isBull ? "#26a69a" : "#ef5350";

        const bodyTop = priceToY(Math.max(candle.open, candle.close));
        const bodyBottom = priceToY(Math.min(candle.open, candle.close));
        const bodyHeight = Math.max(1, bodyBottom - bodyTop);

        return (
          <g key={i}>
            {/* Wick */}
            <line
              x1={x}
              y1={priceToY(candle.high)}
              x2={x}
              y2={priceToY(candle.low)}
              stroke={color}
              strokeWidth={1}
            />
            {/* Body */}
            <rect
              x={x - candleWidth / 2}
              y={bodyTop}
              width={candleWidth}
              height={bodyHeight}
              fill={isBull ? "transparent" : color}
              stroke={color}
              strokeWidth={0.8}
            />
          </g>
        );
      })}

      {/* Trade markers */}
      {trades.map((trade: any, i: number) => {
        const candleIdx = trade.candleIndex;
        if (candleIdx < 0 || candleIdx >= candles.length) return null;
        const x = padding.left + candleIdx * gap + gap / 2;
        const entryY = priceToY(trade.entry);
        const isWin = trade.status === "WIN";

        return (
          <g key={i}>
            {/* Entry arrow */}
            <circle cx={x} cy={entryY - 8} r={4} fill={isWin ? "#4caf50" : "#ff5252"} />
            <text x={x} y={entryY - 5} textAnchor="middle" fill="#fff" fontSize={5} fontWeight="bold">
              {isWin ? "W" : trade.status === "LOSS" ? "L" : "E"}
            </text>
            {/* SL/TP lines */}
            <line
              x1={x - 8}
              y1={priceToY(trade.sl)}
              x2={x + 8}
              y2={priceToY(trade.sl)}
              stroke="#ff5252"
              strokeWidth={0.5}
              strokeDasharray="2,2"
            />
            <line
              x1={x - 8}
              y1={priceToY(trade.tp)}
              x2={x + 8}
              y2={priceToY(trade.tp)}
              stroke="#4caf50"
              strokeWidth={0.5}
              strokeDasharray="2,2"
            />
          </g>
        );
      })}

      {/* Time axis */}
      {candles
        .filter((_: any, i: number) => i % 15 === 0)
        .map((candle: any, i: number) => {
          const idx = candles.indexOf(candle);
          const x = padding.left + idx * gap + gap / 2;
          return (
            <text key={i} x={x} y={height - 5} fill="#666" fontSize={7} textAnchor="middle">
              {candle.time}
            </text>
          );
        })}
    </svg>
  );
}

// ─── Equity Curve Chart ────────────────────────────────────────
function EquityCurveChart({ equityCurve }: { equityCurve: any[] }) {
  if (!equityCurve || equityCurve.length === 0) return null;

  const width = 800;
  const height = 180;
  const padding = { top: 15, right: 50, bottom: 25, left: 10 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const equities = equityCurve.map((e: any) => e.equity);
  const minEq = Math.min(...equities) * 0.998;
  const maxEq = Math.max(...equities) * 1.002;
  const range = maxEq - minEq;

  const eqToY = (eq: number) => padding.top + chartH - ((eq - minEq) / range) * chartH;
  const gap = chartW / (equityCurve.length - 1 || 1);

  // Drawdown area
  const maxDD = Math.max(...equityCurve.map((e: any) => e.drawdown));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {/* Grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const y = padding.top + chartH * (1 - pct);
        const val = minEq + range * pct;
        return (
          <g key={pct}>
            <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#333" strokeWidth={0.5} />
            <text x={width - padding.right + 4} y={y + 3} fill="#9e9e9e" fontSize={7}>
              {(val / 100000).toFixed(1)}L
            </text>
          </g>
        );
      })}

      {/* Equity line */}
      <polyline
        points={equityCurve
          .map((e: any, i: number) => {
            const x = padding.left + i * gap;
            const y = eqToY(e.equity);
            return `${x},${y}`;
          })
          .join(" ")}
        fill="none"
        stroke="#2196f3"
        strokeWidth={1.5}
      />

      {/* Drawdown area (red) */}
      {maxDD > 0 && (
        <polygon
          points={[
            ...equityCurve.map((e: any, i: number) => {
              const x = padding.left + i * gap;
              const y = eqToY(e.equity);
              return `${x},${y}`;
            }),
            ...equityCurve
              .map((e: any, i: number) => {
                const x = padding.left + i * gap;
                const y = eqToY(e.equity - e.drawdown);
                return `${x},${y}`;
              })
              .reverse(),
          ].join(" ")}
          fill="#ff5252"
          opacity={0.15}
        />
      )}

      {/* Time axis */}
      {equityCurve
        .filter((_: any, i: number) => i % Math.max(1, Math.floor(equityCurve.length / 8)) === 0)
        .map((e: any, i: number) => {
          const idx = equityCurve.indexOf(e);
          const x = padding.left + idx * gap;
          return (
            <text key={i} x={x} y={height - 5} fill="#666" fontSize={7} textAnchor="middle">
              {e.date.substring(5)}
            </text>
          );
        })}
    </svg>
  );
}

// ─── Performance Summary Card ──────────────────────────────────
function PerformanceSummary({ perf }: { perf: any }) {
  if (!perf) return null;

  const items = [
    { label: "Total Trades", value: perf.totalTrades, color: "#e0e0e0" },
    { label: "Win Rate", value: `${perf.winRate}%`, color: perf.winRate >= 50 ? "#4caf50" : "#ff5252" },
    { label: "Total P&L", value: `₹${perf.totalPnL.toLocaleString("en-IN")}`, color: perf.totalPnL >= 0 ? "#4caf50" : "#ff5252" },
    { label: "Profit Factor", value: perf.profitFactor, color: perf.profitFactor >= 1.5 ? "#4caf50" : perf.profitFactor >= 1 ? "#ff9800" : "#ff5252" },
    { label: "Sharpe Ratio", value: perf.sharpeRatio, color: perf.sharpeRatio >= 1 ? "#4caf50" : "#ff9800" },
    { label: "Max Drawdown", value: `₹${perf.maxDrawdown.toLocaleString("en-IN")}`, color: "#ff5252" },
    { label: "Expectancy", value: `₹${perf.expectancy.toLocaleString("en-IN")}`, color: perf.expectancy >= 0 ? "#4caf50" : "#ff5252" },
    { label: "Kelly %", value: `${perf.kellyPct}%`, color: perf.kellyPct >= 20 ? "#4caf50" : "#ff9800" },
  ];

  return (
    <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
      {items.map((item) => (
        <Card key={item.label} className="border-border/50">
          <CardContent className="p-2 text-center">
            <p className="text-[8px] text-muted-foreground uppercase">{item.label}</p>
            <p className="text-sm font-bold" style={{ color: item.color }}>
              {item.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────
export function BacktestTab({ trades, symbol }: BacktestTabProps) {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [mode, setMode] = useState<"single" | "performance">("single");

  const dateStr = formatDate(selectedDate);
  const dayTrades = useMemo(() => getDayTrades(trades, dateStr), [trades, dateStr]);

  // Fetch backtest results from API
  const { data: backtestData, isLoading, refetch } = useQuery({
    queryKey: ["backtest", symbol, dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/backtest?symbol=${symbol}&date=${dateStr}`);
      return res.json();
    },
    staleTime: 60000,
  });

  // Multi-day performance backtest (last 30 days)
  const [perfRange, setPerfRange] = useState<{ start: string; end: string }>(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return { start: formatDate(start), end: formatDate(end) };
  });
  const [runPerf, setRunPerf] = useState(0);

  const { data: perfData, isLoading: perfLoading } = useQuery({
    queryKey: ["backtest-perf", symbol, perfRange.start, perfRange.end, runPerf],
    queryFn: async () => {
      const res = await fetch(
        `/api/backtest?symbol=${symbol}&startDate=${perfRange.start}&endDate=${perfRange.end}`
      );
      return res.json();
    },
    enabled: runPerf > 0,
    staleTime: 60000,
  });

  const bt = backtestData?.data;
  const perf = perfData?.data?.performance;
  const equityCurve = perfData?.data?.equityCurve || [];
  const dailyResults = perfData?.data?.dailyResults || [];

  const stats = useMemo(() => {
    const closed = dayTrades.filter(
      (t) => t.status === "tp_hit" || t.status === "sl_hit" || t.pnl !== 0
    );
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;
    const totalPnL = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return { closed: closed.length, wins, losses, totalPnL, total: dayTrades.length };
  }, [dayTrades]);

  // Generate recent 7 days for quick nav
  const recentDays = useMemo(() => {
    const days: { label: string; date: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = formatDate(d);
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      days.push({
        label: `${dayNames[d.getDay()]} ${d.getDate()}`,
        date: ds,
        count: trades.filter((t) => t.openedAt?.startsWith(ds)).length,
      });
    }
    return days;
  }, [trades]);

  return (
    <div className="space-y-3">
      {/* Mode Selector + Date Picker Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Mode Toggle */}
          <div className="flex items-center border border-border/50 rounded-lg overflow-hidden bg-[#111]">
            <Button
              variant={mode === "single" ? "default" : "ghost"}
              size="sm"
              className={`h-9 text-[11px] px-4 rounded-none font-bold ${
                mode === "single" ? "bg-blue-600 text-white" : "text-muted-foreground"
              }`}
              onClick={() => setMode("single")}
            >
              <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
              Single Day
            </Button>
            <Button
              variant={mode === "performance" ? "default" : "ghost"}
              size="sm"
              className={`h-9 text-[11px] px-4 rounded-none font-bold ${
                mode === "performance" ? "bg-emerald-600 text-white" : "text-muted-foreground"
              }`}
              onClick={() => setMode("performance")}
            >
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              Performance Report
            </Button>
          </div>

          {mode === "single" && (
            <>
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                    <CalendarIcon className="h-3.5 w-3.5" />
                    {selectedDate.toLocaleDateString("en-IN", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={(d) => {
                      if (d) {
                        setSelectedDate(d);
                        setCalendarOpen(false);
                      }
                    }}
                    className="rounded-md"
                  />
                </PopoverContent>
              </Popover>

              {/* Quick Nav */}
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => {
                    const d = new Date(selectedDate);
                    d.setDate(d.getDate() - 1);
                    setSelectedDate(d);
                  }}
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => {
                    const d = new Date(selectedDate);
                    d.setDate(d.getDate() + 1);
                    if (d <= new Date()) setSelectedDate(d);
                  }}
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </>
          )}
        </div>

        {mode === "performance" ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>From</span>
              <input
                type="date"
                value={perfRange.start}
                onChange={(e) => setPerfRange((r) => ({ ...r, start: e.target.value }))}
                className="h-7 px-2 text-[10px] border border-border/50 rounded bg-background"
              />
              <span>To</span>
              <input
                type="date"
                value={perfRange.end}
                onChange={(e) => setPerfRange((r) => ({ ...r, end: e.target.value }))}
                className="h-7 px-2 text-[10px] border border-border/50 rounded bg-background"
              />
            </div>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-[10px]"
              onClick={() => setRunPerf((n) => n + 1)}
              disabled={perfLoading}
            >
              {perfLoading ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {perfLoading ? "Running..." : "Run Backtest"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-medium">{stats.total} journal trades</span>
            {stats.closed > 0 && (
              <>
                <span>|</span>
                <span className="text-emerald-500">{stats.wins}W</span>
                <span className="text-red-500">{stats.losses}L</span>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 ml-2"
              onClick={() => refetch()}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {/* Quick Day Selector (single-day mode only) */}
      {mode === "single" && (
        <div className="flex items-center gap-1 overflow-x-auto">
          {recentDays.map((day) => {
            const isSelected = day.date === dateStr;
            return (
              <Button
                key={day.date}
                variant={isSelected ? "default" : "ghost"}
                size="sm"
                className={`h-7 text-[10px] px-2 shrink-0 font-medium ${
                  isSelected ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                }`}
                onClick={() => setSelectedDate(new Date(day.date + "T00:00:00"))}
              >
                {day.label}
                {day.count > 0 && (
                  <span className="ml-1 text-[8px] opacity-60">({day.count})</span>
                )}
              </Button>
            );
          })}
        </div>
      )}

      {/* ═══ PERFORMANCE MODE ═══════════════════════════════════════ */}
      {mode === "performance" && (
        <>
          {perfLoading ? (
            <Card className="border-border/50">
              <CardContent className="p-8 text-center">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Running backtest across {Math.round((new Date(perfRange.end).getTime() - new Date(perfRange.start).getTime()) / 86400000)} days...
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Breakout strategy + OI/Greek quality scoring
                </p>
              </CardContent>
            </Card>
          ) : perf ? (
            <>
              {/* Performance Summary */}
              <PerformanceSummary perf={perf} />

              {/* Verdict Card */}
              <Card className={`border ${
                perf.totalPnL > 0 ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
              }`}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {perf.totalPnL > 0 ? (
                        <TrendingUp className="h-5 w-5 text-emerald-500" />
                      ) : (
                        <TrendingDown className="h-5 w-5 text-red-500" />
                      )}
                      <div>
                        <p className="text-sm font-bold">
                          Strategy is {perf.totalPnL > 0 ? "PROFITABLE" : "IN LOSS"} —{" "}
                          <span className={perf.totalPnL >= 0 ? "text-emerald-500" : "text-red-500"}>
                            {perf.totalPnL >= 0 ? "+" : ""}₹{perf.totalPnL.toLocaleString("en-IN")}
                          </span>
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {perf.totalTrades} trades over {perf.tradingDays} trading days •{" "}
                          {perf.winRate}% win rate • {perf.wins}W / {perf.losses}L / {perf.expired}E
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge className={`text-[10px] ${
                        perf.profitFactor >= 1.5
                          ? "bg-emerald-500/20 text-emerald-500"
                          : perf.profitFactor >= 1
                            ? "bg-yellow-500/20 text-yellow-500"
                            : "bg-red-500/20 text-red-500"
                      }`}>
                        {perf.profitFactor >= 1.5 ? "STRONG" : perf.profitFactor >= 1 ? "BREAKEVEN" : "WEAK"}
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Equity Curve */}
              <Card className="border-border/50">
                <CardContent className="p-2">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Activity className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Equity Curve — Starting ₹10,00,000
                      </span>
                    </div>
                    <div className="flex gap-3 text-[8px]">
                      <span className="text-[#2196f3]">● Equity</span>
                      <span className="text-[#ff5252]">● Drawdown</span>
                    </div>
                  </div>
                  <EquityCurveChart equityCurve={equityCurve} />
                </CardContent>
              </Card>

              {/* Detailed Metrics */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <Card className="border-border/50">
                  <CardContent className="p-2 text-center">
                    <p className="text-[8px] text-muted-foreground">Avg P&L/Trade</p>
                    <p className={`text-sm font-bold ${perf.avgPnLPerTrade >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      {perf.avgPnLPerTrade >= 0 ? "+" : ""}₹{perf.avgPnLPerTrade.toLocaleString("en-IN")}
                    </p>
                  </CardContent>
                </Card>
                <Card className="border-border/50">
                  <CardContent className="p-2 text-center">
                    <p className="text-[8px] text-muted-foreground">Avg P&L/Day</p>
                    <p className={`text-sm font-bold ${perf.avgPnLPerDay >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      {perf.avgPnLPerDay >= 0 ? "+" : ""}₹{perf.avgPnLPerDay.toLocaleString("en-IN")}
                    </p>
                  </CardContent>
                </Card>
                <Card className="border-border/50">
                  <CardContent className="p-2 text-center">
                    <p className="text-[8px] text-muted-foreground">Best Day</p>
                    <p className="text-sm font-bold text-emerald-500">
                      +₹{perf.bestDay.pnl.toLocaleString("en-IN")}
                    </p>
                    <p className="text-[7px] text-muted-foreground">{perf.bestDay.date}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/50">
                  <CardContent className="p-2 text-center">
                    <p className="text-[8px] text-muted-foreground">Worst Day</p>
                    <p className="text-sm font-bold text-red-500">
                      ₹{perf.worstDay.pnl.toLocaleString("en-IN")}
                    </p>
                    <p className="text-[7px] text-muted-foreground">{perf.worstDay.date}</p>
                  </CardContent>
                </Card>
              </div>

              {/* Streaks + Hold */}
              <div className="grid grid-cols-3 gap-2">
                <Card className="border-border/50">
                  <CardContent className="p-2 text-center">
                    <p className="text-[8px] text-muted-foreground">Max Win Streak</p>
                    <p className="text-lg font-bold text-emerald-500">{perf.winStreak}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/50">
                  <CardContent className="p-2 text-center">
                    <p className="text-[8px] text-muted-foreground">Max Loss Streak</p>
                    <p className="text-lg font-bold text-red-500">{perf.lossStreak}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/50">
                  <CardContent className="p-2 text-center">
                    <p className="text-[8px] text-muted-foreground">Avg Hold (bars)</p>
                    <p className="text-lg font-bold text-[#e0e0e0]">{perf.avgHoldBars}</p>
                    <p className="text-[7px] text-muted-foreground">×5min = {Math.round(perf.avgHoldBars * 5)}min</p>
                  </CardContent>
                </Card>
              </div>

              {/* Grade Distribution */}
              {Object.keys(perf.gradeDistribution).length > 0 && (
                <Card className="border-border/50">
                  <CardContent className="p-2">
                    <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Quality Grade Distribution
                    </p>
                    <div className="flex gap-3">
                      {["A+", "A", "B", "C", "D"].map((grade) => {
                        const count = perf.gradeDistribution[grade] || 0;
                        const pct = perf.totalTrades > 0 ? Math.round((count / perf.totalTrades) * 100) : 0;
                        const colors: Record<string, string> = {
                          "A+": "#4caf50", A: "#8bc34a", B: "#ff9800", C: "#ff5722", D: "#f44336",
                        };
                        return (
                          <div key={grade} className="flex-1 text-center">
                            <div className="text-[10px] font-bold" style={{ color: colors[grade] }}>
                              {grade}
                            </div>
                            <div className="h-16 bg-[#111] rounded mt-1 relative overflow-hidden">
                              <div
                                className="absolute bottom-0 w-full rounded-t transition-all"
                                style={{
                                  height: `${pct}%`,
                                  backgroundColor: colors[grade] + "40",
                                  borderTop: `2px solid ${colors[grade]}`,
                                }}
                              />
                            </div>
                            <div className="text-[9px] text-muted-foreground mt-1">
                              {count} ({pct}%)
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Daily Breakdown */}
              {dailyResults.length > 0 && (
                <Card className="border-border/50">
                  <CardContent className="p-2">
                    <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Daily Breakdown
                    </p>
                    <div className="max-h-64 overflow-y-auto space-y-1">
                      {dailyResults.map((day: any) => (
                        <div
                          key={day.date}
                          className="flex items-center justify-between p-1.5 rounded text-[10px]"
                          style={{
                            backgroundColor:
                              day.dailyPnL > 0
                                ? "#4caf5010"
                                : day.dailyPnL < 0
                                  ? "#ff525210"
                                  : "transparent",
                          }}
                        >
                          <span className="text-muted-foreground w-20">{day.date.substring(5)}</span>
                          <span className="w-8 text-center">{day.trades.length}</span>
                          <span className={`w-8 text-center ${day.dailyWinRate >= 50 ? "text-emerald-500" : "text-red-500"}`}>
                            {day.dailyWinRate}%
                          </span>
                          <span
                            className={`w-24 text-right font-bold ${
                              day.dailyPnL >= 0 ? "text-emerald-500" : "text-red-500"
                            }`}
                          >
                            {day.dailyPnL >= 0 ? "+" : ""}₹{day.dailyPnL.toLocaleString("en-IN")}
                          </span>
                          <span className={`w-24 text-right text-muted-foreground`}>
                            ₹{day.cumulativePnL.toLocaleString("en-IN")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <Card className="border-border/50">
              <CardContent className="p-8 text-center">
                <BarChart3 className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Click "Run Backtest" to analyze strategy performance</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Runs breakout + OI/Greek scoring across {Math.round((new Date(perfRange.end).getTime() - new Date(perfRange.start).getTime()) / 86400000)} days
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ═══ SINGLE DAY MODE ════════════════════════════════════════ */}
      {mode === "single" && (
        <>
          {/* Backtest Strategy Results */}
          {isLoading ? (
            <Card className="border-border/50">
              <CardContent className="p-4 text-center text-muted-foreground text-xs">
                Loading backtest data...
              </CardContent>
            </Card>
          ) : bt ? (
            <>
              {/* Day OHLC + Summary */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Open</p>
                <p className="text-sm font-bold">₹{bt.dayOHLC.open.toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">High</p>
                <p className="text-sm font-bold text-emerald-500">₹{bt.dayOHLC.high.toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Low</p>
                <p className="text-sm font-bold text-red-500">₹{bt.dayOHLC.low.toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Close</p>
                <p className="text-sm font-bold">₹{bt.dayOHLC.close.toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Change</p>
                <p className={`text-sm font-bold ${bt.dayOHLC.change >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {bt.dayOHLC.change >= 0 ? "+" : ""}{bt.dayOHLC.changePct.toFixed(2)}%
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Candlestick Chart */}
          <Card className="border-border/50">
            <CardContent className="p-2">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {SYMBOL_CONFIGS[symbol]?.name || symbol} — {bt.totalCandles} candles
                  </span>
                </div>
                <div className="flex gap-2 text-[8px]">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#ff5252]" /> Resistance
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#4caf50]" /> Support
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#2196f3]" /> Entry
                  </span>
                </div>
              </div>
              <CandlestickChart
                candles={bt.candles}
                srLevels={bt.srLevels}
                trades={bt.trades}
              />
            </CardContent>
          </Card>

          {/* Strategy Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Signals</p>
                <p className="text-lg font-bold">{bt.summary.total}</p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Win Rate</p>
                <p className={`text-lg font-bold ${bt.summary.winRate >= 50 ? "text-emerald-500" : "text-red-500"}`}>
                  {bt.summary.winRate}%
                </p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Total P&L</p>
                <p className={`text-lg font-bold ${bt.summary.totalPnL >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {bt.summary.totalPnL >= 0 ? "+" : ""}₹{bt.summary.totalPnL.toLocaleString("en-IN")}
                </p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Profit Factor</p>
                <p className={`text-lg font-bold ${bt.summary.profitFactor >= 1 ? "text-emerald-500" : "text-red-500"}`}>
                  {bt.summary.profitFactor}
                </p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="p-2 text-center">
                <p className="text-[9px] text-muted-foreground">Avg P&L</p>
                <p className={`text-lg font-bold ${bt.summary.avgPnL >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {bt.summary.avgPnL >= 0 ? "+" : ""}₹{bt.summary.avgPnL.toLocaleString("en-IN")}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Trade List */}
          {bt.trades.length > 0 && (
            <Card className="border-border/50">
              <CardContent className="p-2 space-y-1.5">
                <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Breakout Trades — {bt.summary.wins}W / {bt.summary.losses}L / {bt.summary.expired}E
                </p>
                {bt.trades.map((t: any, i: number) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-md border border-border/50 p-2"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`h-6 w-6 rounded flex items-center justify-center ${
                          t.type === "CALL"
                            ? "bg-emerald-500/10"
                            : "bg-red-500/10"
                        }`}
                      >
                        {t.status === "WIN" ? (
                          <CheckCircle className="h-3 w-3 text-emerald-500" />
                        ) : t.status === "LOSS" ? (
                          <XCircle className="h-3 w-3 text-red-500" />
                        ) : (
                          <AlertTriangle className="h-3 w-3 text-yellow-500" />
                        )}
                      </div>
                      <div>
                        <p className="text-[10px] font-bold">
                          {t.type} {t.direction.toUpperCase()} • {t.signal.pattern || "breakout"}
                        </p>
                        <p className="text-[8px] text-muted-foreground flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" />
                          {t.entryTime} → {t.exitTime || "—"}
                          {t.holdBars > 0 && ` • ${t.holdBars} bars`}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="flex items-center gap-2 text-[9px]">
                        <span className="text-muted-foreground">Entry</span>
                        <span className="font-bold">₹{t.entry.toLocaleString("en-IN")}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[9px]">
                        <span className="text-muted-foreground">SL</span>
                        <span className="text-red-500">₹{t.sl.toLocaleString("en-IN")}</span>
                        <span className="text-muted-foreground">TP</span>
                        <span className="text-emerald-500">₹{t.tp.toLocaleString("en-IN")}</span>
                      </div>
                      <p
                        className={`text-xs font-bold mt-0.5 ${
                          (t.pnl || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                        }`}
                      >
                        {t.pnl !== null ? (
                          <>
                            {t.pnl >= 0 ? "+" : ""}₹{t.pnl.toLocaleString("en-IN")}
                            <span className="text-[8px] ml-1 opacity-60">({t.status})</span>
                          </>
                        ) : (
                          <Badge variant="outline" className="text-[8px]">
                            OPEN
                          </Badge>
                        )}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* S/R Levels */}
          {bt.srLevels.length > 0 && (
            <Card className="border-border/50">
              <CardContent className="p-2">
                <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Support / Resistance Levels
                </p>
                <div className="flex flex-wrap gap-2">
                  {bt.srLevels.map((l: any, i: number) => (
                    <div
                      key={i}
                      className="px-2 py-1 rounded text-[9px] font-bold"
                      style={{
                        backgroundColor: l.type === "RESISTANCE" ? "#ff525220" : "#4caf5020",
                        color: l.type === "RESISTANCE" ? "#ff5252" : "#4caf50",
                        border: `1px solid ${l.type === "RESISTANCE" ? "#ff525240" : "#4caf5040"}`,
                      }}
                    >
                      {l.name}: ₹{Math.round(l.price).toLocaleString("en-IN")}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}

      {/* Journal Trades (existing) */}
      {mode === "single" && dayTrades.length > 0 && (
        <Card className="border-border/50">
          <CardContent className="p-2 space-y-1.5">
            <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
              Journal Trades on {selectedDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
            </p>
            {dayTrades.map((t: any) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-md border border-border/50 p-2"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`h-6 w-6 rounded flex items-center justify-center ${
                      t.type === "CALL"
                        ? "bg-emerald-500/10"
                        : t.type === "PUT"
                          ? "bg-red-500/10"
                          : "bg-muted"
                    }`}
                  >
                    {t.type === "CALL" ? (
                      <TrendingUp className="h-3 w-3 text-emerald-500" />
                    ) : t.type === "PUT" ? (
                      <TrendingDown className="h-3 w-3 text-red-500" />
                    ) : (
                      <Target className="h-3 w-3 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <p className="text-[10px] font-bold">
                      {t.strike} {t.type} {t.expiry ? `• ${t.expiry}` : ""}
                    </p>
                    <p className="text-[8px] text-muted-foreground flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" />
                      {t.openedAt
                        ? new Date(t.openedAt).toLocaleTimeString("en-IN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—"}
                      {t.closedAt && (
                        <>
                          {" → "}
                          {new Date(t.closedAt).toLocaleTimeString("en-IN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  {t.pnl !== 0 && t.pnl !== undefined && t.pnl !== null ? (
                    <p
                      className={`text-xs font-bold ${
                        t.pnl >= 0 ? "text-emerald-500" : "text-red-500"
                      }`}
                    >
                      {t.pnl >= 0 ? "+" : ""}₹{t.pnl.toLocaleString("en-IN")}
                    </p>
                  ) : (
                    <Badge
                      variant="outline"
                      className={`text-[8px] ${
                        t.status === "open"
                          ? "border-yellow-500/30 text-yellow-500"
                          : "border-muted-foreground/30"
                      }`}
                    >
                      {t.status === "open" ? "OPEN" : t.status?.toUpperCase()}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
        </>
      )}

      {/* Backtest Report — all trades (cumulative, single-day only) */}
      {mode === "single" && <BacktestReport trades={trades} symbol={symbol} />}
    </div>
  );
}
