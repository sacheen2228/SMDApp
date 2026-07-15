// ScannerPanel — Intraday Stock Scanner UI
// Displays high-probability NSE stock setups with detailed analysis

"use client";

import { useState, useEffect, memo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import {
  Scan,
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  Activity,
  BarChart3,
  Zap,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ArrowUp,
  ArrowDown,
  Minus,
  Clock,
  Eye,
  EyeOff,
  Filter,
  FilterX,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  Star,
  StarOff,
  Globe,
  Wifi,
  WifiOff,
  Settings,
  Table2,
  ArrowUpDown,
} from "lucide-react";
import {
  getGradeColor,
  getDirectionColor,
  getConvictionColor,
  type ScanResult,
  type StockCandidate,
} from "@/lib/intraday-scanner";

interface ScannerPanelProps {
  symbol: string;
  spotPrice: number;
}

function formatOI(oi: number): string {
  if (Math.abs(oi) >= 10000000) return (oi / 10000000).toFixed(1) + " Cr";
  if (Math.abs(oi) >= 100000) return (oi / 100000).toFixed(1) + " L";
  if (Math.abs(oi) >= 1000) return (oi / 1000).toFixed(1) + "K";
  return oi.toString();
}

function formatCurrency(n: number): string {
  if (n == null || isNaN(n)) return "₹0";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function getMarketTrendColor(trend: string): string {
  if (trend.includes("BULLISH")) return "bg-emerald-600 text-white";
  if (trend.includes("BEARISH")) return "bg-red-600 text-white";
  if (trend === "VOLATILE") return "bg-orange-600 text-white";
  return "bg-yellow-600 text-white";
}

interface Filters {
  sector: string | null;
  direction: string | null;
  minScore: number;
  maxScore: number;
  minRsi: number;
  maxRsi: number;
  minRvol: number;
  conviction: string | null;
  onlyFavorites: boolean;
  sortBy: string;
  sortOrder: "asc" | "desc";
}

const DEFAULT_FILTERS: Filters = {
  sector: null,
  direction: null,
  minScore: 0,
  maxScore: 100,
  minRsi: 0,
  maxRsi: 100,
  minRvol: 0,
  conviction: null,
  onlyFavorites: false,
  sortBy: "totalScore",
  sortOrder: "desc",
};

function StockCard({ stock, rank }: { stock: StockCandidate; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const isBullish = stock.direction === "BULLISH";
  const isBearish = stock.direction === "BEARISH";

  return (
    <Card className={`border-2 ${isBullish ? "border-emerald-500/30" : isBearish ? "border-red-500/30" : "border-border"}`}>
      <CardHeader className="p-3 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
              rank === 1 ? "bg-amber-500 text-white" :
              rank === 2 ? "bg-gray-400 text-white" :
              rank === 3 ? "bg-orange-600 text-white" :
              "bg-muted text-muted-foreground"
            }`}>
              {rank}
            </div>
            <div>
              <CardTitle className="text-sm font-bold">{stock.symbol}</CardTitle>
              <p className="text-[10px] text-muted-foreground">{stock.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={getGradeColor(stock.grade)}>{stock.grade}</Badge>
            <Badge className={getConvictionColor(stock.conviction)}>{stock.conviction}</Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3 pt-0 space-y-3">
        {/* Price + Direction */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-lg font-bold tabular-nums">{formatCurrency(stock.currentPrice)}</span>
            <span className={`ml-2 text-xs font-semibold ${stock.change >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)} ({stock.changePct.toFixed(2)}%)
            </span>
          </div>
          <div className={`flex items-center gap-1 px-2 py-1 rounded-lg ${
            isBullish ? "bg-emerald-500/10" : isBearish ? "bg-red-500/10" : "bg-muted"
          }`}>
            {isBullish ? <ArrowUp className="h-4 w-4 text-emerald-500" /> :
             isBearish ? <ArrowDown className="h-4 w-4 text-red-500" /> :
             <Minus className="h-4 w-4 text-muted-foreground" />}
            <span className={`text-xs font-bold ${getDirectionColor(stock.direction)}`}>
              {stock.direction}
            </span>
          </div>
        </div>

        {/* Score Bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground">Probability Score</span>
            <span className="font-bold">{stock.totalScore}/100</span>
          </div>
          <Progress value={stock.totalScore} className="h-1.5" />
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div className="text-center">
            <div className="text-muted-foreground">RSI</div>
            <div className="font-bold">{stock.rsi}</div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground">RVOL</div>
            <div className="font-bold">{stock.rvol}x</div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground">PCR</div>
            <div className="font-bold">{stock.pcr}</div>
          </div>
        </div>

        {/* Trade Setup */}
        <div className="bg-muted/30 rounded-lg p-2 space-y-1">
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground flex items-center gap-1">
              <Target className="h-2.5 w-2.5" /> Entry
            </span>
            <span className="font-bold">{formatCurrency(stock.entry)}</span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground flex items-center gap-1">
              <Shield className="h-2.5 w-2.5" /> Stop Loss
            </span>
            <span className="font-bold text-red-500">{formatCurrency(stock.stopLoss)}</span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-emerald-500">Target 1</span>
            <span className="font-bold">{formatCurrency(stock.target1)}</span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-emerald-500">Target 2</span>
            <span className="font-bold">{formatCurrency(stock.target2)}</span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground">Risk:Reward</span>
            <span className="font-bold">1:{stock.riskReward > 0 ? stock.riskReward.toFixed(1) : "-"}</span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" /> Holding Time
            </span>
            <span className="font-medium">{stock.holdingTime}</span>
          </div>
          {stock.monthlyOptionTrade && (
            <>
              <Separator className="my-1" />
              <div className="text-[10px] text-emerald-500 font-semibold leading-relaxed">
                {stock.monthlyOptionTrade.summary}
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Expiry</span>
                <span className="font-medium">{stock.monthlyOptionTrade.expiryLabel}</span>
              </div>
            </>
          )}
        </div>

        {/* Expand/Collapse */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-6 text-[10px]"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <EyeOff className="h-2.5 w-2.5 mr-1" /> : <Eye className="h-2.5 w-2.5 mr-1" />}
          {expanded ? "Hide Details" : "Show Details"}
        </Button>

        {/* Expanded Details */}
        {expanded && (
          <div className="space-y-3 text-[10px]">
            <Separator />

            {/* Reasons */}
            <div>
              <span className="font-semibold text-muted-foreground">Reasons for Selection:</span>
              <ul className="mt-1 space-y-0.5">
                {stock.reasons.map((reason, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <CheckCircle className="h-2.5 w-2.5 text-emerald-500 mt-0.5 shrink-0" />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Technical Summary */}
            <div>
              <span className="font-semibold text-muted-foreground">Technical:</span>
              <p className="mt-0.5">{stock.technicalSummary}</p>
            </div>

            {/* Options Summary */}
            <div>
              <span className="font-semibold text-muted-foreground">Options:</span>
              <p className="mt-0.5">{stock.optionsSummary}</p>
              {stock.monthlyOptionTrade && (
                <p className="mt-1 text-emerald-500 font-medium leading-relaxed">
                  {stock.monthlyOptionTrade.summary}
                </p>
              )}
            </div>

            {/* Volume Summary */}
            <div>
              <span className="font-semibold text-muted-foreground">Volume:</span>
              <p className="mt-0.5">{stock.volumeSummary}</p>
            </div>

            {/* Institutional Activity */}
            <div>
              <span className="font-semibold text-muted-foreground">Institutional:</span>
              <p className="mt-0.5">{stock.institutionalActivity}</p>
            </div>

            {/* Support/Resistance */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="font-semibold text-muted-foreground">Support:</span>
                <div className="mt-0.5 space-y-0.5">
                  {stock.supportLevels.map((level, i) => (
                    <div key={i} className="text-emerald-500">{formatCurrency(level)}</div>
                  ))}
                </div>
              </div>
              <div>
                <span className="font-semibold text-muted-foreground">Resistance:</span>
                <div className="mt-0.5 space-y-0.5">
                  {stock.resistanceLevels.map((level, i) => (
                    <div key={i} className="text-red-500">{formatCurrency(level)}</div>
                  ))}
                </div>
              </div>
            </div>

            {/* Score Breakdown */}
            <div>
              <span className="font-semibold text-muted-foreground">Score Breakdown:</span>
              <div className="mt-1 space-y-1">
                <div className="flex justify-between">
                  <span>Market</span>
                  <span>{stock.marketScore}/100</span>
                </div>
                <div className="flex justify-between">
                  <span>Sector</span>
                  <span>{stock.sectorScore}/100</span>
                </div>
                <div className="flex justify-between">
                  <span>Technical</span>
                  <span>{stock.technicalScore}/100</span>
                </div>
                <div className="flex justify-between">
                  <span>Options</span>
                  <span>{stock.optionsScore}/100</span>
                </div>
                <div className="flex justify-between">
                  <span>Volume</span>
                  <span>{stock.volumeScore}/100</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export const ScannerPanel = memo(function ScannerPanel({
  symbol,
  spotPrice,
}: ScannerPanelProps) {
  const [useLive, setUseLive] = useState(true);
  const [sectorFilter, setSectorFilter] = useState<string | null>(null);

  const [dataSource, setDataSource] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery<any>({
    queryKey: ["scanner", symbol, useLive],
    queryFn: async () => {
      setDataSource(null);
      setLiveError(null);
      const res = await fetch(`/api/scanner?symbol=${symbol}&live=${useLive}`);
      if (!res.ok) throw new Error("Scanner failed");
      const json = await res.json();
      if (json.dataSource) setDataSource(json.dataSource);
      if (json.liveError) setLiveError(json.liveError);
      return json.data;
    },
    refetchInterval: 60000, // Refresh every minute
    staleTime: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Scan className="h-12 w-12 mb-4 animate-pulse text-primary" />
        <p className="text-lg font-medium">Scanning NSE stocks...</p>
        <p className="text-sm mt-1">Analyzing 50+ stocks for high-probability setups</p>
      </div>
    );
  }

  const result: ScanResult | null = data;

  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="h-12 w-12 mb-4 text-amber-500" />
        <p className="text-lg font-medium">No scan results</p>
        <p className="text-sm mt-1">Click refresh to run the scanner</p>
      </div>
    );
  }

  const filteredCandidates = (result.candidates || [])
    .filter((c) => !sectorFilter || c.sector === sectorFilter)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .slice(0, 15);

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
              <Scan className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold">Intraday Scanner</h2>
              <p className="text-[10px] text-muted-foreground">
                {(result.candidates || []).length} high-probability setups found
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
            <Button
              variant={useLive ? "default" : "outline"}
              size="sm"
              className={`h-7 text-[10px] gap-1 ${useLive ? "bg-emerald-600 hover:bg-emerald-700" : ""}`}
              onClick={() => setUseLive(!useLive)}
            >
              {useLive ? <Zap className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
              {useLive ? "Live" : "Demo"}
            </Button>
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
      {useLive && dataSource && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30 text-[10px] text-green-600">
          <div className="flex items-center gap-1.5">
            <CheckCircle className="h-3 w-3 shrink-0" />
            <span className="font-semibold">Live Data:</span>
            <span>Connected via {dataSource}</span>
          </div>
        </div>
      )}
      {useLive && liveError && !dataSource && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-600">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{liveError}</span>
          </div>
        </div>
      )}

      <div className="p-4 space-y-4">
        {/* Market Direction Card */}
        <Card className="border-2 border-primary/20">
          <CardHeader className="p-3 pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-bold flex items-center gap-1">
                <Activity className="h-3 w-3" /> Market Direction
              </CardTitle>
              <Badge className={getMarketTrendColor(result.marketDirection.trend)}>
                {result.marketDirection.trend.replace("_", " ")}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Score</span>
                <span className="font-bold">{result.marketDirection.score}/100</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">VIX</span>
                <span className="font-bold">{result.marketDirection.vixLevel}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Nifty</span>
                <span className="font-bold">{result.marketDirection.niftyTrend}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Breadth</span>
                <span className="font-bold">{result.marketDirection.breadth}</span>
              </div>
            </div>
            <p className="text-[9px] text-muted-foreground">{result.marketDirection.details}</p>
          </CardContent>
        </Card>

        {/* Overall Verdict */}
        <Card className="bg-muted/30">
          <CardContent className="p-3">
            <div className="grid grid-cols-2 gap-3 text-[10px]">
              <div>
                <span className="text-muted-foreground">Overall Bias</span>
                <div className={`font-bold ${result.overallBias === "BULLISH" ? "text-emerald-500" : result.overallBias === "BEARISH" ? "text-red-500" : ""}`}>
                  {result.overallBias}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Best Bullish</span>
                <div className="font-bold text-emerald-500">
                  {result.bestBullish?.symbol || "—"}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Best Bearish</span>
                <div className="font-bold text-red-500">
                  {result.bestBearish?.symbol || "—"}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Key Risk</span>
                <div className="font-medium">{result.keyRisks[0]}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stocks to Avoid */}
        {result.stocksToAvoid.length > 0 && (
          <Card className="border-amber-500/30">
            <CardContent className="p-3">
              <div className="flex items-center gap-1 text-[10px] text-amber-500">
                <AlertTriangle className="h-3 w-3" />
                <span className="font-semibold">Avoid:</span>
                <span>{result.stocksToAvoid.join(", ")}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Sector Strength */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-bold flex items-center gap-1">
                <BarChart3 className="h-3 w-3" /> Sector Strength
              </CardTitle>
              {sectorFilter && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 text-[9px] px-1.5 text-muted-foreground hover:text-foreground"
                  onClick={() => setSectorFilter(null)}
                >
                  All sectors
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="flex flex-wrap gap-1">
              {result.sectors.slice(0, 12).map((sector) => {
                const isActive = sectorFilter === sector.sector;
                return (
                  <Badge
                    key={sector.sector}
                    variant={isActive ? "default" : "outline"}
                    className={`text-[9px] cursor-pointer transition-all hover:scale-105 ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : sector.strength >= 70 ? "border-emerald-500 text-emerald-500 hover:bg-emerald-500/10" :
                          sector.strength >= 50 ? "border-yellow-500 text-yellow-500 hover:bg-yellow-500/10" :
                          "border-red-500 text-red-500 hover:bg-red-500/10"
                    }`}
                    onClick={() => setSectorFilter(isActive ? null : sector.sector)}
                  >
                    {sector.sector} {sector.strength}
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Candidates */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-muted-foreground">
            {sectorFilter ? `${sectorFilter} Setups` : "Top Setups"} ({filteredCandidates.length})
          </h3>
          {filteredCandidates.map((stock, idx) => (
            <StockCard key={stock.symbol} stock={stock} rank={idx + 1} />
          ))}
        </div>

        {/* Risk Disclosure */}
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-3">
            <p className="text-[9px] text-muted-foreground leading-relaxed">
              <strong className="text-amber-500">Risk Disclosure:</strong> This is for educational and informational purposes only and is not financial, investment, or trading advice. Intraday trading carries substantial risk and can result in partial or total loss of capital. Past performance and technical patterns do not guarantee future results. Do your own research, use predefined stop-losses, and consult a qualified financial advisor.
            </p>
          </CardContent>
        </Card>

        {/* Timestamp */}
        <div className="text-center text-[9px] text-muted-foreground pb-4">
          Scan completed at: {new Date(result.timestamp).toLocaleString("en-IN")}
          <br />
          Data quality: {result.dataQuality}
        </div>
      </div>
    </div>
  );
});
