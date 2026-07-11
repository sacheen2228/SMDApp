'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, RefreshCw, FileSpreadsheet, FileText, Database, Beaker, Calendar, TrendingUp, TrendingDown, Minus, AlertCircle, Crosshair, Search, CheckCircle2, XCircle, Clock, Trophy, Target, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function formatINR(val: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(val);
}

function formatPct(val: number) {
  return val > 0 ? `+${val}%` : `${val}%`;
}

type TabView = "report" | "audit";

export function BacktestPanel() {
  const SYMBOLS = ["ALL", "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
  const LOT_SIZES: Record<string, number> = {
    ALL: 65, NIFTY: 65, BANKNIFTY: 25, FINNIFTY: 20, MIDCPNIFTY: 50, SENSEX: 20,
  };

  const todayStr = new Date().toISOString().split("T")[0];
  const [sl, setSl] = useState("10");
  const [rr, setRr] = useState("3");
  const [tf, setTf] = useState("15m");
  const [date, setDate] = useState(todayStr);
  const [symbol, setSymbol] = useState("ALL");
  const [dataSource, setDataSource] = useState<"live" | "demo">("live");
  const [tab, setTab] = useState<TabView>("report");
  const [expandedTrade, setExpandedTrade] = useState<number | null>(null);

  const isToday = date === todayStr;

  const tradesQuery = useQuery({
    queryKey: ["trades-date-v2", date, symbol],
    queryFn: async () => {
      const res = await fetch(`/api/trades/today?date=${date}&symbol=${symbol}`);
      return res.json();
    },
    staleTime: 15000,
    refetchInterval: isToday ? 30000 : 60000,
  });

  const liveTrades = tradesQuery.data?.trades || [];
  const hasLiveTrades = liveTrades.length > 0;
  const usingLiveData = dataSource === "live" && hasLiveTrades;

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["backtest-v4", sl, rr, tf, usingLiveData ? "live" : "demo", date, symbol],
    queryFn: async () => {
      if (usingLiveData) {
        const defaultLot = LOT_SIZES[symbol] || 65;
        const csv = "time,symbol,type,strike,entry,exit,status,pnl,stopLoss,target1,target2,target3,exitReason,tpHitLevel,lotSize\n" +
          liveTrades.map((t: any) =>
            `${t.time},${t.symbol},${t.type},${t.strike},${t.entry},${t.exit || ""},${t.dbStatus},${t.pnl},${t.stopLoss || ""},${t.target1 || ""},${t.target2 || ""},${t.target3 || ""},${t.exitReason || ""},${t.tpHitLevel || ""},${t.lotSize || t.positionSize || defaultLot}`
          ).join("\n");
        const res = await fetch("/api/backtest-analyzer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            csv,
            live: true,
            dataSource: "live",
            source: date === todayStr ? `Today (${date})` : date,
            date,
            symbol,
          }),
        });
        return res.json();
      }
      const res = await fetch(`/api/backtest-analyzer?sl=${sl}&rr=${rr}&tf=${tf}`);
      return res.json();
    },
    staleTime: 15000,
  });

  const stats = data?.stats;
  const trades = data?.trades || [];
  const isDemo = data?.is_demo === true;
  const source = data?.source || "";

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-amber-500" />
          Daily Trade Report
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border overflow-hidden">
            <button
              onClick={() => setTab("report")}
              className={`px-2.5 py-1 text-xs font-medium ${tab === "report" ? "bg-amber-600 text-white" : "bg-muted text-muted-foreground"}`}
            >
              <BarChart3 className="w-3 h-3 inline mr-1" />Report
            </button>
            <button
              onClick={() => setTab("audit")}
              className={`px-2.5 py-1 text-xs font-medium ${tab === "audit" ? "bg-amber-600 text-white" : "bg-muted text-muted-foreground"}`}
            >
              <Search className="w-3 h-3 inline mr-1" />Audit Trail
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Data source badge */}
      {data && (
        <div className="flex items-center gap-2">
          {isDemo ? (
            <Badge variant="secondary" className="text-[10px]">
              <Beaker className="w-3 h-3 mr-1" />Demo Fallback
            </Badge>
          ) : (
            <Badge variant="default" className="text-[10px] bg-emerald-600">
              <Database className="w-3 h-3 mr-1" />Live — {source}
            </Badge>
          )}
          {stats && (
            <span className="text-[10px] text-muted-foreground">
              {stats.total_trades} trades · Updated {new Date().toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Date picker + status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="p-3">
          <label className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
            <Calendar className="w-3 h-3" /> Select Date
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            max={todayStr}
            className="w-full bg-background border rounded px-2 py-1.5 text-sm"
          />
        </Card>

        <Card className={`p-3 col-span-2 ${isToday ? 'bg-amber-500/5 border-amber-500/20' : ''}`}>
          {tradesQuery.isLoading ? (
            <div className="text-sm text-muted-foreground animate-pulse">Loading trades...</div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm mb-2">
                <Database className={`w-4 h-4 ${isToday ? 'text-amber-500' : 'text-muted-foreground'}`} />
                <span className="font-medium">
                  {isToday ? "Today's Trades" : `Trades on ${date}`}
                </span>
                <Badge variant={hasLiveTrades ? "default" : "secondary"} className="text-[10px]">
                  {tradesQuery.data?.total || 0} trades
                </Badge>
              </div>
              {hasLiveTrades ? (
                <div className="flex flex-wrap gap-4 text-sm">
                  <div className="flex items-center gap-1">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-emerald-500 font-medium">{tradesQuery.data.tp} TP</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                    <span className="text-red-500 font-medium">{tradesQuery.data.sl} SL</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-blue-500" />
                    <span className="text-blue-500 font-medium">{tradesQuery.data.active} Active</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Minus className="w-3.5 h-3.5 text-gray-500" />
                    <span className="text-gray-500 font-medium">{tradesQuery.data.expired || 0} Exp</span>
                  </div>
                  <div className={`font-semibold ${tradesQuery.data.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    P&L: {formatINR(tradesQuery.data.totalPnl)}
                  </div>
                  {(tradesQuery.data.tp + tradesQuery.data.sl) > 0 && (
                    <div className="text-muted-foreground">
                      WR: {Math.round((tradesQuery.data.tp / (tradesQuery.data.tp + tradesQuery.data.sl)) * 100)}%
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">No trades found for this date</div>
              )}
            </>
          )}
        </Card>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Data</label>
          <div className="flex rounded-lg border overflow-hidden">
            <button
              onClick={() => setDataSource("live")}
              className={`px-2.5 py-1 text-xs font-medium ${
                dataSource === "live"
                  ? "bg-amber-600 text-white"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              Live Trades
            </button>
            <button
              onClick={() => setDataSource("demo")}
              className={`px-2.5 py-1 text-xs font-medium ${
                dataSource === "demo"
                  ? "bg-amber-600 text-white"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              Demo
            </button>
          </div>
          {dataSource === "live" && !hasLiveTrades && (
            <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/30">
              <AlertCircle className="w-3 h-3 mr-1" />No live data → Demo
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Symbol</label>
          <Select value={symbol} onValueChange={setSymbol}>
            <SelectTrigger className="w-24 h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SYMBOLS.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">SL (pts)</label>
          <Select value={sl} onValueChange={setSl}>
            <SelectTrigger className="w-20 h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[5, 10, 15, 20, 25, 30].map(v => (
                <SelectItem key={v} value={String(v)}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">R:R</label>
          <Select value={rr} onValueChange={setRr}>
            <SelectTrigger className="w-20 h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5].map(v => (
                <SelectItem key={v} value={String(v)}>1:{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">TF</label>
          <Select value={tf} onValueChange={setTf}>
            <SelectTrigger className="w-20 h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["1m", "3m", "5m", "15m"].map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {stats && (
          <div className="flex gap-1 ml-2">
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/backtest-analyzer?sl=${sl}&rr=${rr}&tf=${tf}&format=csv`} download>
                <FileSpreadsheet className="w-4 h-4 mr-1" /> CSV
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/backtest-analyzer?sl=${sl}&rr=${rr}&tf=${tf}&format=html`} target="_blank">
                <FileText className="w-4 h-4 mr-1" /> HTML
              </a>
            </Button>
          </div>
        )}
      </div>

      {isLoading && <div className="text-center py-8 text-muted-foreground animate-pulse">Generating report...</div>}

      {data?.error && (
        <Card className="p-4 bg-red-500/10 border-red-500/30">
          <p className="text-sm text-red-500">{data.error}</p>
        </Card>
      )}

      {tab === "report" && stats && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <Trophy className="w-4 h-4 text-emerald-500" />
                <span className="text-xs text-muted-foreground">Win Rate</span>
              </div>
              <div className="text-xl font-bold">{stats.win_rate}%</div>
              <div className="text-xs text-muted-foreground">{stats.wins}W / {stats.losses}L / {stats.open || 0}O</div>
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-amber-500" />
                <span className="text-xs text-muted-foreground">Total P&amp;L</span>
              </div>
              <div className={`text-xl font-bold ${stats.total_pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {formatINR(stats.total_pnl)}
              </div>
              <div className="text-xs text-muted-foreground">PF: {stats.profit_factor}</div>
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="w-4 h-4 text-red-500" />
                <span className="text-xs text-muted-foreground">Max Drawdown</span>
              </div>
              <div className="text-xl font-bold text-red-500">{formatINR(stats.max_drawdown)}</div>
              <div className="text-xs text-muted-foreground">{stats.total_trades} trades</div>
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <Target className="w-4 h-4 text-blue-500" />
                <span className="text-xs text-muted-foreground">Avg R:R</span>
              </div>
              <div className="text-xl font-bold">{stats.avg_rr_achieved}</div>
              <div className="text-xs text-muted-foreground">
                Best: {formatINR(stats.best_trade)} / Worst: {formatINR(stats.worst_trade)}
              </div>
            </Card>
          </div>

          {/* TP/SL breakdown */}
          {!isDemo && stats.tp1_hits !== undefined && (
            <Card className="p-3">
              <div className="text-sm font-medium mb-2 flex items-center gap-2">
                <Crosshair className="w-4 h-4 text-amber-500" />
                Exit Breakdown
              </div>
              <div className="grid grid-cols-5 gap-2 text-center text-xs">
                <div className="bg-emerald-500/10 rounded p-2">
                  <div className="text-lg font-bold text-emerald-500">{stats.tp1_hits}</div>
                  <div className="text-muted-foreground">TP1</div>
                </div>
                <div className="bg-emerald-500/10 rounded p-2">
                  <div className="text-lg font-bold text-emerald-500">{stats.tp2_hits}</div>
                  <div className="text-muted-foreground">TP2</div>
                </div>
                <div className="bg-emerald-500/10 rounded p-2">
                  <div className="text-lg font-bold text-emerald-500">{stats.tp3_hits}</div>
                  <div className="text-muted-foreground">TP3</div>
                </div>
                <div className="bg-blue-500/10 rounded p-2">
                  <div className="text-lg font-bold text-blue-500">{stats.trailing_sl_hits}</div>
                  <div className="text-muted-foreground">Trail SL</div>
                </div>
                <div className="bg-red-500/10 rounded p-2">
                  <div className="text-lg font-bold text-red-500">{stats.sl_hits}</div>
                  <div className="text-muted-foreground">SL</div>
                </div>
              </div>
            </Card>
          )}

          {/* Extended metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Card className="p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Gross Profit</div>
              <div className="text-sm font-semibold text-emerald-500">{formatINR(stats.gross_profit)}</div>
            </Card>
            <Card className="p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Gross Loss</div>
              <div className="text-sm font-semibold text-red-500">{formatINR(stats.gross_loss)}</div>
            </Card>
            <Card className="p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Avg Win</div>
              <div className="text-sm font-semibold">{formatINR(stats.avg_win)}</div>
            </Card>
            <Card className="p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Avg Loss</div>
              <div className="text-sm font-semibold">{formatINR(stats.avg_loss)}</div>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Card className="p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Max Consecutive Wins</div>
              <div className="text-lg font-bold text-emerald-500">{stats.max_consecutive_wins}</div>
            </Card>
            <Card className="p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Max Consecutive Losses</div>
              <div className="text-lg font-bold text-red-500">{stats.max_consecutive_losses}</div>
            </Card>
          </div>

          {/* Trade log table */}
          <Card className="p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium flex items-center gap-2">
                Trade Log
                {!isDemo && (
                  <Badge variant="default" className="text-[10px] bg-emerald-600">
                    <Database className="w-3 h-3 mr-1" />Live
                  </Badge>
                )}
              </h3>
              <Badge variant="outline" className="text-[10px]">{trades.length} trades</Badge>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="text-left p-1">Time</th>
                    <th className="text-left p-1">Sym</th>
                    <th className="text-left p-1">Type</th>
                    <th className="text-right p-1">Strike</th>
                    <th className="text-right p-1">Entry</th>
                    <th className="text-right p-1">Exit</th>
                    <th className="text-right p-1">Status</th>
                    <th className="text-right p-1">P&amp;L</th>
                    {!isDemo && <th className="text-right p-1">Level</th>}
                    {!isDemo && <th className="text-right p-1">Audit</th>}
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t: any, i: number) => (
                    <React.Fragment key={i}>
                      <tr
                        className={`border-b border-border/50 cursor-pointer hover:bg-muted/50 ${t.status === 'tp' || t.status === 'TP' ? 'bg-emerald-500/5' : t.status === 'sl' || t.status === 'SL' ? 'bg-red-500/5' : ''}`}
                        onClick={() => setExpandedTrade(expandedTrade === i ? null : i)}
                      >
                        <td className="p-1">
                          {t.time?.split(" ")[1]?.slice(0, 5) || t.time?.split("T")[1]?.split(".")[0]?.slice(0, 5) || t.time}
                        </td>
                        <td className="p-1">{t.symbol}</td>
                        <td className="p-1">{t.type}</td>
                        <td className="text-right p-1">{t.strike}</td>
                        <td className="text-right p-1">{formatINR(t.entry)}</td>
                        <td className="text-right p-1">{t.exit ? formatINR(t.exit) : '—'}</td>
                        <td className="text-right p-1">
                          <Badge
                            variant={t.status === 'tp' || t.status === 'TP' ? 'default' : t.status === 'sl' || t.status === 'SL' ? 'destructive' : 'secondary'}
                            className="text-[10px]"
                          >
                            {t.status === 'tp' || t.status === 'TP' ? '✅ TP' : t.status === 'sl' || t.status === 'SL' ? '❌ SL' : t.status === 'active' ? '⏳' : t.status}
                          </Badge>
                        </td>
                        <td className={`text-right p-1 font-mono ${t.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                          {formatINR(t.pnl)}
                        </td>
                        {!isDemo && (
                          <td className="text-right p-1">
                            {t.tpHitLevel ? (
                              <Badge variant="outline" className="text-[10px]">{t.tpHitLevel}</Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        )}
                        {!isDemo && (
                          <td className="text-right p-1">
                            {t.pnl_verified === "✅" ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 inline" />
                            ) : t.pnl_verified === "⚠️" ? (
                              <XCircle className="w-3.5 h-3.5 text-red-500 inline" />
                            ) : (
                              <Minus className="w-3.5 h-3.5 text-muted-foreground inline" />
                            )}
                          </td>
                        )}
                      </tr>
                      {/* Expandable audit trail */}
                      {expandedTrade === i && t.audit_log && (
                        <tr>
                          <td colSpan={10} className="p-2 bg-muted/30 border-b">
                            <div className="text-[10px] font-mono space-y-0.5">
                              {t.audit_log.map((line: string, j: number) => (
                                <div key={j} className={line.includes("⚠️") ? "text-red-400" : line.includes("✅") ? "text-emerald-400" : "text-muted-foreground"}>
                                  {line}
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* Audit Trail tab */}
      {tab === "audit" && trades.length > 0 && (
        <Card className="p-3">
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Search className="w-4 h-4 text-amber-500" />
            Full Audit Trail
          </h3>
          <div className="space-y-3 max-h-[600px] overflow-y-auto">
            {trades.map((t: any, i: number) => (
              <div key={i} className="bg-muted/30 rounded p-3 text-[11px] font-mono border border-border/50">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-[10px]">Trade #{i + 1}</Badge>
                  <span className="font-semibold">{t.symbol} {t.type} @ {t.strike}</span>
                  <Badge
                    variant={t.status === 'tp' || t.status === 'TP' ? 'default' : t.status === 'sl' || t.status === 'SL' ? 'destructive' : 'secondary'}
                    className="text-[10px]"
                  >
                    {t.status}
                  </Badge>
                </div>
                {(t.audit_log || []).map((line: string, j: number) => (
                  <div key={j} className={`pl-2 ${line.includes("⚠️") ? "text-red-400" : line.includes("✅") ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {line}
                  </div>
                ))}
                {!t.audit_log && (
                  <div className="text-muted-foreground pl-2">
                    Entry: {formatINR(t.entry)} → Exit: {formatINR(t.exit)} | P&L: {formatINR(t.pnl)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "audit" && trades.length === 0 && !isLoading && (
        <Card className="p-6 text-center text-muted-foreground">
          <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No trades to audit. Select a date with trades or switch to Demo.</p>
        </Card>
      )}
    </div>
  );
}
