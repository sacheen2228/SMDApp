// WeeklyEquityScannerPanel — Weekly Equity Scanner UI
// Swing-trading equity research assistant for NSE stocks with realistic
// upside over the next 5-7 trading days. Implements the AI Pro Prompt output
// format: table sorted ascending by price, max 15-20 stocks, max 3 per sector.

"use client";

import { useState, useEffect, memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Scan,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  Shield,
  ChevronDown,
  ChevronUp,
  Clock,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Rocket,
  Flame,
  Gauge,
} from "lucide-react";
import type { WeeklyScanResult, WeeklyCandidate } from "@/lib/weekly-equity-scanner";
import { ProResearchModal } from "@/components/dashboard/ProResearchModal";

function fmtINR(n: number): string {
  if (n == null || isNaN(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  if (n == null || isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function confidenceColor(c: number): string {
  if (c >= 75) return "bg-emerald-600";
  if (c >= 60) return "bg-emerald-500/80";
  if (c >= 45) return "bg-yellow-500/80";
  return "bg-red-500/80";
}

function trendIcon(trend: string) {
  if (trend === "UP") return <ArrowUp className="h-3 w-3 text-emerald-500" />;
  if (trend === "DOWN") return <ArrowDown className="h-3 w-3 text-red-500" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

function rocketStageColor(stage: string): string {
  switch (stage) {
    case "IGNITION": return "text-orange-500";
    case "CONTINUATION": return "text-emerald-500";
    case "EXHAUSTION": return "text-red-500";
    case "DISTRIBUTION": return "text-red-600";
    default: return "text-muted-foreground";
  }
}

function rocketStageBadge(stage: string): string {
  switch (stage) {
    case "IGNITION": return "bg-orange-500/15 border-orange-500/40 text-orange-500";
    case "CONTINUATION": return "bg-emerald-500/15 border-emerald-500/40 text-emerald-500";
    case "EXHAUSTION": return "bg-red-500/15 border-red-500/40 text-red-500";
    case "DISTRIBUTION": return "bg-red-600/15 border-red-600/40 text-red-600";
    default: return "bg-muted text-muted-foreground";
  }
}

function actionColor(action: string): string {
  if (action.includes("ENTRY")) return "text-emerald-500";
  if (action.includes("WAIT")) return "text-amber-500";
  if (action.includes("AVOID")) return "text-red-500";
  if (action.includes("TRIM")) return "text-orange-500";
  return "text-muted-foreground";
}

function CandidateRow({ c, onProResearch }: { c: WeeklyCandidate; onProResearch: (symbol: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [depth, setDepth] = useState<any>(null);
  const [depthLoading, setDepthLoading] = useState(false);

  const checkDepth = async (symbol: string) => {
    setDepthLoading(true);
    setDepth(null);
    try {
      const res = await fetch(`/api/orderbook?symbol=${symbol}`, { signal: AbortSignal.timeout(15000) });
      const json = await res.json();
      setDepth(json);
    } catch (err) {
      setDepth({ success: false, error: "Order book request failed" });
    } finally {
      setDepthLoading(false);
    }
  };

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => setExpanded(!expanded)}
      >
        <TableCell className="font-bold text-xs">
          <div className="flex items-center gap-1">
            {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
            {c.symbol}
          </div>
        </TableCell>
        <TableCell className="text-xs tabular-nums">{fmtINR(c.price)}</TableCell>
        <TableCell className={`text-xs font-semibold tabular-nums ${c.weekChgPct >= 0 ? "text-emerald-500" : "text-red-500"}`}>
          {fmtPct(c.weekChgPct)}
        </TableCell>
        <TableCell className="text-xs tabular-nums">{c.rsi.toFixed(0)}</TableCell>
        <TableCell className="text-xs tabular-nums">{c.rvol.toFixed(1)}x</TableCell>
        <TableCell className="text-xs tabular-nums">{c.adx.toFixed(0)}</TableCell>
        <TableCell className="text-xs">
          <div className="flex items-center gap-1">
            {trendIcon(c.weeklyTrend)}
            <span>{c.weeklyTrend}</span>
          </div>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{c.sector}</TableCell>
        <TableCell className="text-xs tabular-nums text-emerald-500">{fmtINR(c.support)}</TableCell>
        <TableCell className="text-xs tabular-nums text-red-500">{fmtINR(c.resistance)}</TableCell>
        <TableCell className="text-xs tabular-nums">{fmtINR(c.entryZone.low)}–{fmtINR(c.entryZone.high)}</TableCell>
        <TableCell className="text-xs tabular-nums font-semibold text-red-500">{fmtINR(c.stopLoss)}</TableCell>
        <TableCell className="text-xs tabular-nums text-emerald-500">{fmtINR(c.target1)}</TableCell>
        <TableCell className="text-xs tabular-nums text-emerald-500">{fmtINR(c.target2)}</TableCell>
        <TableCell className="text-xs tabular-nums">1:{c.riskReward > 0 ? c.riskReward.toFixed(1) : "—"}</TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5 min-w-[70px]">
            <Progress value={c.confidence} className="h-1.5 w-10" indicatorClassName={confidenceColor(c.confidence)} />
            <span className="text-[10px] font-bold tabular-nums">{c.confidence}</span>
          </div>
        </TableCell>
        <TableCell className="text-xs tabular-nums">
          {c.volumeStructure.vwapPosition === "ABOVE" ? (
            <span className="text-emerald-500 flex items-center gap-0.5"><ArrowUp className="h-3 w-3" />VWAP</span>
          ) : (
            <span className="text-red-500 flex items-center gap-0.5"><ArrowDown className="h-3 w-3" />VWAP</span>
          )}
        </TableCell>
        <TableCell className="text-xs tabular-nums">
          {c.volumeStructure.anchoredVwapPosition === "ABOVE" ? (
            <span className="text-emerald-500 flex items-center gap-0.5"><ArrowUp className="h-3 w-3" />A-VWAP</span>
          ) : (
            <span className="text-red-500 flex items-center gap-0.5"><ArrowDown className="h-3 w-3" />A-VWAP</span>
          )}
        </TableCell>
        <TableCell className="text-xs tabular-nums">
          {c.volumeStructure.priceInValueArea ? (
            <span className="text-emerald-500">In VA</span>
          ) : c.volumeStructure.vah > 0 && c.price > c.volumeStructure.vah ? (
            <span className="text-amber-500">Above VA</span>
          ) : (
            <span className="text-red-500">Below VA</span>
          )}
        </TableCell>
        <TableCell className="text-xs tabular-nums">
          {c.rocket ? (
            <Badge className={`text-[8px] ${rocketStageBadge(c.rocket.stage)}`}>
              <Rocket className="h-2.5 w-2.5 mr-0.5" />{c.rocket.stage}
            </Badge>
          ) : (
            <span className="text-muted-foreground text-[10px]">—</span>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/20">
          <TableCell colSpan={20} className="p-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
              <div className="space-y-1">
                <div className="flex items-center gap-1 font-bold text-emerald-500">
                  <TrendingUp className="h-3 w-3" /> Bull Case
                </div>
                <p className="text-muted-foreground leading-relaxed">{c.bullCase}</p>
                <div className="pt-1">
                  <span className="font-semibold text-muted-foreground">EMAs:</span>{" "}
                  20 <span className="tabular-nums">{fmtINR(c.ema20)}</span> · 50 <span className="tabular-nums">{fmtINR(c.ema50)}</span> · 200 <span className="tabular-nums">{fmtINR(c.ema200)}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1 font-bold text-red-500">
                  <TrendingDown className="h-3 w-3" /> Bear Case
                </div>
                <p className="text-muted-foreground leading-relaxed">{c.bearCase}</p>
                <div className="pt-1">
                  <span className="font-semibold text-muted-foreground">Weekly RSI:</span>{" "}
                  <span className="tabular-nums">{c.weeklyRsi.toFixed(0)}</span> · {" "}
                  <span className={c.weeklyCloseAboveEma20 ? "text-emerald-500" : "text-red-500"}>
                    {c.weeklyCloseAboveEma20 ? "above W-EMA20" : "below W-EMA20"}
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="font-bold">Reasoning</div>
                <p className="text-muted-foreground">{c.confidenceNote}</p>
                <div className="pt-1">
                  <span className="font-semibold text-muted-foreground">Sector:</span>{" "}
                  {c.sector} · <span className={c.sectorStrength >= 60 ? "text-emerald-500" : c.sectorStrength <= 40 ? "text-red-500" : ""}>
                    {c.sectorTrendLabel} ({c.sectorStrength})
                  </span>
                </div>
                {c.flags.length > 0 && (
                  <div className="pt-1">
                    <span className="font-semibold text-amber-500">Flags:</span>
                    <ul className="list-disc list-inside text-amber-500/90 space-y-0.5">
                      {c.flags.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  </div>
                )}
                <div className="pt-2 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[10px] gap-1 border-violet-500/40 text-violet-500 hover:bg-violet-500/10"
                    onClick={(e) => { e.stopPropagation(); onProResearch(c.symbol); }}
                  >
                    <Sparkles className="h-3 w-3" /> Pro Mode — Deep Research
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[10px] gap-1 border-sky-500/40 text-sky-500 hover:bg-sky-500/10"
                    onClick={(e) => { e.stopPropagation(); checkDepth(c.symbol); }}
                    disabled={depthLoading}
                  >
                    <Gauge className="h-3 w-3" /> {depthLoading ? "Checking…" : "Order Book (Stage 5)"}
                  </Button>
                </div>
                {depth && (
                  <div className="pt-2 text-[9px] leading-relaxed">
                    {depth.success && depth.data ? (
                      <div>
                        <span className="font-semibold text-emerald-500">Depth OK:</span>{" "}
                        Bid {depth.data.totalBuyQty.toLocaleString()} · Ask {depth.data.totalSellQty.toLocaleString()} · Last ₹{depth.data.lastPrice}
                        <div className="text-muted-foreground mt-0.5">{depth.data.source}</div>
                      </div>
                    ) : (
                      <div>
                        <span className="font-semibold text-amber-500">Depth unavailable:</span>{" "}
                        <span className="text-muted-foreground">{depth.reason || depth.error || "No Level 2 feed"}</span>
                        <div className="text-muted-foreground mt-0.5">{depth.alternative}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* Stage 3 — volume structure desk note */}
            <div className="mt-3 pt-2 border-t text-[10px] text-muted-foreground">
              <div className="flex items-center gap-1 font-bold mb-1 text-primary">
                <Gauge className="h-3 w-3" /> Volume Structure (Stage 3)
              </div>
              <p className="leading-relaxed">{c.volumeStructure.read}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-muted-foreground/80">
                <span>Session VWAP <span className="tabular-nums text-foreground">{fmtINR(c.volumeStructure.sessionVwap)}</span></span>
                <span>Anch. VWAP <span className="tabular-nums text-foreground">{fmtINR(c.volumeStructure.anchoredVwap)}</span></span>
                <span>POC <span className="tabular-nums text-foreground">{fmtINR(c.volumeStructure.poc)}</span></span>
                <span>VAH <span className="tabular-nums text-foreground">{fmtINR(c.volumeStructure.vah)}</span></span>
                <span>VAL <span className="tabular-nums text-foreground">{fmtINR(c.volumeStructure.val)}</span></span>
                <span>ATR(14) <span className="tabular-nums text-foreground">{fmtINR(c.volumeStructure.atr14)}</span></span>
                <span>ATR Stop <span className="tabular-nums text-red-500">{fmtINR(c.volumeStructure.atrStopLong)}</span></span>
              </div>
            </div>
            {/* Stage 4 — rocket read */}
            {c.rocket && (
              <div className="mt-3 pt-2 border-t text-[10px] text-muted-foreground">
                <div className="flex items-center gap-1 font-bold mb-1 text-orange-500">
                  <Rocket className="h-3 w-3" /> Rocket Move (Stage 4) — {c.rocket.stage}
                </div>
                <p className="leading-relaxed">
                  Day move <span className={c.rocket.dayChgPct >= 0 ? "text-emerald-500" : "text-red-500"}>{fmtPct(c.rocket.dayChgPct)}</span> ·
                  RVOL <span className="tabular-nums">{c.rocket.rvol.toFixed(1)}x</span> ·
                  {c.rocket.gapHeld ? " gap held" : " gap filled"} ·
                  {" "}dist from 20-EMA <span className="tabular-nums">{c.rocket.distFromEma20Atr.toFixed(1)}x ATR</span> ·
                  <span className={actionColor(c.rocket.recommendedAction)}> {c.rocket.recommendedAction}</span>
                </p>
                <p className="mt-0.5">Catalyst: <span className={c.rocket.catalyst.startsWith("N") ? "text-amber-500" : "text-emerald-500"}>{c.rocket.catalyst}</span></p>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export const WeeklyEquityScannerPanel = memo(function WeeklyEquityScannerPanel() {
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [proSymbol, setProSymbol] = useState<string | null>(null);
  const [proDossier, setProDossier] = useState<any>(null);
  const [proLoading, setProLoading] = useState(false);

  const runProResearch = async (symbol: string) => {
    setProSymbol(symbol);
    setProDossier(null);
    setProLoading(true);
    try {
      const res = await fetch(`/api/weekly-scanner?mode=pro&symbol=${symbol}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error("Pro research failed");
      const json = await res.json();
      setProDossier(json.data);
    } catch (err) {
      setProDossier(null);
      console.error("[ProResearch] Failed:", err);
    } finally {
      setProLoading(false);
    }
  };

  const { data, isLoading, refetch, isFetching, isError } = useQuery<any>({
    queryKey: ["weekly-scanner"],
    queryFn: async () => {
      setDataSource(null);
      const res = await fetch(`/api/weekly-scanner`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error("Weekly scanner failed");
      const json = await res.json();
      if (json.dataSource) setDataSource(json.dataSource);
      return json.data;
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Scan className="h-12 w-12 mb-4 animate-pulse text-primary" />
        <p className="text-lg font-medium">Scanning 200+ F&O stocks for weekly setups...</p>
        <p className="text-sm mt-1">Fetching 1-year candles & building AI reasoning layer</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="h-12 w-12 mb-4 text-amber-500" />
        <p className="text-lg font-medium">Weekly scan failed</p>
        <p className="text-sm mt-1">Live equity data unavailable — Yahoo Finance returned no real quotes.</p>
        <Button variant="outline" size="sm" className="mt-3 h-7 text-[10px] gap-1" onClick={() => refetch()}>
          <RefreshCw className="h-3 w-3" /> Retry
        </Button>
      </div>
    );
  }

  const result: WeeklyScanResult = data;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
              <Scan className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold">Weekly Equity Scanner</h2>
              <p className="text-[10px] text-muted-foreground">
                Swing-trading setups · next 5–7 trading days · ₹100–₹5,000
                {result.dataQuality === "LIVE" && (
                  <Badge className="ml-1 bg-emerald-600 text-[8px]">LIVE</Badge>
                )}
                {result.dataQuality === "PARTIAL" && (
                  <Badge className="ml-1 bg-yellow-600 text-[8px]">PARTIAL</Badge>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-[10px] text-muted-foreground text-right mr-1">
              <div>{result.breadth}</div>
              <div className="flex items-center justify-end gap-1">
                {result.niftyTrend.toLowerCase().includes("up") ? (
                  <TrendingUp className="h-3 w-3 text-emerald-500" />
                ) : result.niftyTrend.toLowerCase().includes("down") ? (
                  <TrendingDown className="h-3 w-3 text-red-500" />
                ) : (
                  <Minus className="h-3 w-3 text-muted-foreground" />
                )}
                {result.niftyTrend} · VIX {result.vixLevel}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px] gap-1"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Live Data Source Banner */}
      {dataSource && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30 text-[10px] text-green-600">
          <div className="flex items-center gap-1.5">
            <CheckCircle className="h-3 w-3 shrink-0" />
            <span className="font-semibold">Live Data:</span>
            <span>Connected via {dataSource} · {result.totalScanned} symbols scanned, {result.passedFilters} passed all filters</span>
          </div>
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Market Context */}
        <Card className="border-primary/20">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 text-[11px]">
              <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-bold">Market Context:</span>
              <span className="text-muted-foreground">{result.marketContext}</span>
            </div>
          </CardContent>
        </Card>

        {/* Stage 4 — Rocket Movers strip */}
        {result.rocketMovers && result.rocketMovers.length > 0 && (
          <Card className="border-orange-500/30 bg-gradient-to-br from-orange-500/5 to-red-500/5">
            <CardHeader className="p-3 pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs font-bold flex items-center gap-1 text-orange-500">
                  <Rocket className="h-3.5 w-3.5" /> Rocket Movers ({result.rocketMovers.length})
                </CardTitle>
                <span className="text-[9px] text-muted-foreground">
                  Stage 4 · explosive momentum detection · RVOL &gt;3x
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-3 pt-0 overflow-x-auto">
              <div className="flex gap-2 flex-nowrap min-w-max">
                {result.rocketMovers.map((r) => (
                  <div key={r.symbol} className="flex-none w-[210px] rounded-lg border border-orange-500/20 bg-background/60 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[11px]">{r.symbol}</span>
                      <Badge className={`text-[8px] ${rocketStageBadge(r.stage)}`}>
                        <Flame className="h-2.5 w-2.5 mr-0.5" />{r.stage}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[10px] tabular-nums">
                      <span className="text-muted-foreground">Price</span>{" "}
                      <span className="font-semibold">{fmtINR(r.price)}</span> ·{" "}
                      <span className={r.dayChgPct >= 0 ? "text-emerald-500 font-semibold" : "text-red-500 font-semibold"}>
                        {fmtPct(r.dayChgPct)}
                      </span>
                    </div>
                    <div className="text-[10px] tabular-nums text-muted-foreground mt-0.5">
                      RVOL <span className="font-semibold text-foreground">{r.rvol.toFixed(1)}x</span> ·{" "}
                      {r.gapHeld ? "gap held" : "gap filled"}
                    </div>
                    <div className="text-[10px] mt-1 leading-snug">
                      <span className={actionColor(r.recommendedAction)}>{r.recommendedAction}</span>
                    </div>
                    <div className="text-[9px] mt-1 text-muted-foreground leading-snug">
                      <span className={r.catalyst.startsWith("N") ? "text-amber-500" : "text-emerald-500"}>{r.catalyst}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results Table */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-bold flex items-center gap-1">
                <Target className="h-3 w-3" /> Candidates ({result.candidates.length})
              </CardTitle>
              <span className="text-[9px] text-muted-foreground">
                Sorted by price ↑ · max 3 per sector · max 20
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="text-[9px]">
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Wk %</TableHead>
                  <TableHead className="text-right">RSI</TableHead>
                  <TableHead className="text-right">RVOL</TableHead>
                  <TableHead className="text-right">ADX</TableHead>
                  <TableHead className="text-center">Wk Trend</TableHead>
                  <TableHead>Sector</TableHead>
                  <TableHead className="text-right">Support</TableHead>
                  <TableHead className="text-right">Resistance</TableHead>
                  <TableHead className="text-right">Entry Zone</TableHead>
                  <TableHead className="text-right">SL</TableHead>
                  <TableHead className="text-right">T1</TableHead>
                  <TableHead className="text-right">T2</TableHead>
                  <TableHead className="text-right">R:R</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead className="text-center" title="Stage 3 — session VWAP position">VWAP</TableHead>
                  <TableHead className="text-center" title="Stage 3 — anchored VWAP position">Anch.</TableHead>
                  <TableHead className="text-center" title="Stage 3 — volume profile value area">Val. Area</TableHead>
                  <TableHead className="text-center" title="Stage 4 — rocket move stage">Rocket</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.candidates.map((c) => (
                  <CandidateRow key={c.symbol} c={c} onProResearch={runProResearch} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Disclaimer */}
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-3">
            <p className="text-[9px] text-muted-foreground leading-relaxed">
              <strong className="text-amber-500">Disclaimer:</strong> This is an educational research tool. It is not financial, investment, or trading advice. Markets are uncertain — always use stop-losses, size positions responsibly, and consult a qualified financial advisor before acting.
            </p>
          </CardContent>
        </Card>

        {/* Timestamp */}
        <div className="text-center text-[9px] text-muted-foreground pb-4">
          Scan completed at: {new Date(result.timestamp).toLocaleString("en-IN")}
          <br />
          Data source: {dataSource || "Yahoo Finance"} · Data quality: {result.dataQuality}
        </div>
      </div>

      <ProResearchModal
        open={proSymbol !== null}
        onClose={() => setProSymbol(null)}
        loading={proLoading}
        dossier={proDossier}
      />
    </div>
  );
});