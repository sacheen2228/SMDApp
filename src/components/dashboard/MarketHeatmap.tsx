"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useState, useMemo, useEffect } from "react";
import { LayoutGrid, Filter, X, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const MARKETS = [
  { id: "NIFTY50", name: "NIFTY 50", count: 50 },
  { id: "NIFTYNEXT50", name: "NIFTY NEXT 50", count: 50 },
  { id: "NIFTY100", name: "NIFTY 100", count: 100 },
  { id: "NIFTY200", name: "NIFTY 200", count: 200 },
  { id: "NIFTY500", name: "NIFTY 500", count: 500 },
  { id: "SENSEX", name: "SENSEX", count: 30 },
  { id: "BANKNIFTY", name: "BANK NIFTY", count: 12 },
  { id: "FINNIFTY", name: "FINNIFTY", count: 20 },
  { id: "MIDCAPNIFTY", name: "MIDCAP NIFTY", count: 75 },
  { id: "SMALLCAPNIFTY", name: "SMALLCAP NIFTY", count: 100 },
];

const SECTORS = [
  "IT", "BANKING", "FINANCIAL SERVICES", "AUTO", "PHARMA", "FMCG",
  "METAL", "ENERGY", "REALTY", "MEDIA", "PSU BANK", "PRIVATE BANK",
  "OIL & GAS", "CONSUMER DURABLES", "HEALTHCARE", "INFRASTRUCTURE",
  "TELECOM", "CEMENT", "CHEMICAL", "NBFC", "INSURANCE", "POWER",
  "MINING", "RETAIL", "AUTO ANCILLARIES", "CAPITAL GOODS", "TEXTILES",
];

const CHANGE_BUCKETS = [
  { id: "gt3", label: "> +3%", min: 3, max: Infinity },
  { id: "2to3", label: "+2% to +3%", min: 2, max: 3 },
  { id: "1to2", label: "+1% to +2%", min: 1, max: 2 },
  { id: "0to1", label: "0% to +1%", min: 0, max: 1 },
  { id: "0to-1", label: "0% to -1%", min: -1, max: 0 },
  { id: "-1to-2", label: "-1% to -2%", min: -2, max: -1 },
  { id: "-2to-3", label: "-2% to -3%", min: -3, max: -2 },
  { id: "lt-3", label: "< -3%", min: -Infinity, max: -3 },
];

const VOLUME_FILTERS = [
  { id: "high", label: "High Volume" },
  { id: "normal", label: "Normal Volume" },
  { id: "low", label: "Low Volume" },
];

const REL_VOL_FILTERS = [
  { id: "gt3", label: "> 3x", min: 3 },
  { id: "gt2", label: "> 2x", min: 2 },
  { id: "gt15", label: "> 1.5x", min: 1.5 },
  { id: "gt1", label: "> 1x", min: 1 },
];

const MARKET_CAP_FILTERS = [
  { id: "large", label: "Large Cap" },
  { id: "mid", label: "Mid Cap" },
  { id: "small", label: "Small Cap" },
];

const TREND_FILTERS = [
  { id: "strong_bullish", label: "Strong Bullish" },
  { id: "bullish", label: "Bullish" },
  { id: "neutral", label: "Neutral" },
  { id: "bearish", label: "Bearish" },
  { id: "strong_bearish", label: "Strong Bearish" },
];

const SETUP_FILTERS = [
  { id: "breakout", label: "Breakout" },
  { id: "breakdown", label: "Breakdown" },
  { id: "pullback", label: "Pullback" },
  { id: "reversal", label: "Reversal" },
  { id: "momentum", label: "Momentum" },
  { id: "range", label: "Range" },
  { id: "vwap_reclaim", label: "VWAP Reclaim" },
  { id: "vwap_rejection", label: "VWAP Rejection" },
];

const FO_FILTERS = [
  { id: "fo_only", label: "F&O Only" },
  { id: "high_oi", label: "High OI" },
  { id: "rising_oi", label: "Rising OI" },
  { id: "falling_oi", label: "Falling OI" },
  { id: "long_buildup", label: "Long Buildup" },
  { id: "short_buildup", label: "Short Buildup" },
  { id: "short_covering", label: "Short Covering" },
  { id: "long_unwinding", label: "Long Unwinding" },
];

function getColor(changePct: number): string {
  if (changePct > 3) return "bg-emerald-600";
  if (changePct > 2) return "bg-emerald-500";
  if (changePct > 1) return "bg-emerald-400/80";
  if (changePct > 0.3) return "bg-emerald-400/50";
  if (changePct > -0.3) return "bg-zinc-600";
  if (changePct > -1) return "bg-red-400/50";
  if (changePct > -2) return "bg-red-400/80";
  if (changePct > -3) return "bg-red-500";
  return "bg-red-600";
}

function getTextColor(changePct: number): string {
  if (Math.abs(changePct) > 1.5) return "text-white";
  return "text-zinc-100";
}

interface StockData {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePct: number;
  volume: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  weekHigh52: number;
  weekLow52: number;
  sector: string;
  marketCap?: number;
  avgVolume?: number;
  relVolume?: number;
  trend?: string;
  setup?: string;
  foData?: {
    oi: number;
    oiChange: number;
    oiChangePct: number;
    volume: number;
    classification: string;
  };
}

interface HeatmapCellProps {
  stock: StockData;
  size: "sm" | "md" | "lg";
  onClick: (s: StockData) => void;
}

function HeatmapCell({ stock, size, onClick }: HeatmapCellProps) {
  const color = getColor(stock.changePct);
  const textColor = getTextColor(stock.changePct);

  const sizeClasses = {
    sm: "min-w-[60px] min-h-[40px] p-1",
    md: "min-w-[80px] min-h-[55px] p-1.5",
    lg: "min-w-[100px] min-h-[70px] p-2",
  };

  const relVol = stock.relVolume ? `${stock.relVolume.toFixed(1)}x` : "";
  const foClass = stock.foData?.classification || "";

  return (
    <button
      onClick={() => onClick(stock)}
      className={`${color} ${sizeClasses[size]} ${textColor} rounded-sm flex flex-col justify-between items-center 
        hover:brightness-125 hover:ring-1 hover:ring-white/30 transition-all cursor-pointer text-center 
        relative overflow-hidden`}
      title={`${stock.symbol}: ${stock.changePct >= 0 ? "+" : ""}${stock.changePct}% | Vol: ${(stock.volume/100000).toFixed(1)}L | ${stock.sector}`}
    >
      <div className="flex flex-col items-center w-full">
        <span className="text-[9px] font-bold leading-tight truncate w-full">{stock.symbol}</span>
        <span className={`text-[10px] font-black ${stock.changePct >= 0 ? "text-emerald-100" : "text-red-100"}`}>
          {stock.changePct >= 0 ? "+" : ""}{stock.changePct}%
        </span>
        {relVol && <span className="text-[8px] text-zinc-300/80">{relVol}</span>}
        {foClass && <span className="text-[7px] bg-white/10 px-1 rounded"> {foClass} </span>}
      </div>
    </button>
  );
}

interface MarketHeatmapProps {
  onStockClick?: (symbol: string) => void;
  initialMarket?: string;
}

export function MarketHeatmap({ onStockClick, initialMarket = "NIFTY50" }: MarketHeatmapProps) {
  const [selected, setSelected] = useState<StockData | null>(null);
  const [view, setView] = useState<"bySector" | "flat">("bySector");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState(initialMarket);

  // Filter states
  const [changeFilter, setChangeFilter] = useState<string[]>([]);
  const [volumeFilter, setVolumeFilter] = useState<string[]>([]);
  const [relVolFilter, setRelVolFilter] = useState<string[]>([]);
  const [marketCapFilter, setMarketCapFilter] = useState<string[]>([]);
  const [sectorFilter, setSectorFilter] = useState<string[]>([]);
  const [trendFilter, setTrendFilter] = useState<string[]>([]);
  const [setupFilter, setSetupFilter] = useState<string[]>([]);
  const [foFilter, setFoFilter] = useState<string[]>([]);
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 10000]);
  const [sizeBy, setSizeBy] = useState<"marketCap" | "tradedValue" | "volume" | "indexWeight">("indexWeight");

  const handleStockClick = (stock: StockData) => {
    setSelected(stock);
    onStockClick?.(stock.symbol);
  };

  // Fetch all markets data (in production, this would be per-market)
  const { data: allData, isLoading } = useQuery({
    queryKey: ["market-heatmap-all"],
    queryFn: async () => {
      const res = await fetch("/api/market/heatmap?allMarkets=true");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // For now, use the single market data - in production fetch per market
  const { data: marketData } = useQuery({
    queryKey: ["market-heatmap", selectedMarket],
    queryFn: () => fetch(`/api/market/heatmap?market=${selectedMarket}`).then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: true,
  });

  const data = marketData || allData?.markets?.[selectedMarket];

  // Apply filters client-side
  const filteredStocks = useMemo(() => {
    if (!data?.stocks) return [];

    return data.stocks.filter((stock: StockData) => {
      // Change % filter
      if (changeFilter.length > 0) {
        const matches = changeFilter.some(f => {
          const bucket = CHANGE_BUCKETS.find(b => b.id === f);
          if (!bucket) return false;
          return stock.changePct >= (bucket.min || -Infinity) && stock.changePct <= (bucket.max || Infinity);
        });
        if (!matches) return false;
      }

      // Volume filter
      if (volumeFilter.length > 0) {
        const avgVol = stock.avgVolume || 1000000;
        const relVol = stock.volume / avgVol;
        const matches = volumeFilter.some(f => {
          if (f === "high") return relVol > 2;
          if (f === "normal") return relVol >= 0.8 && relVol <= 2;
          if (f === "low") return relVol < 0.8;
          return false;
        });
        if (!matches) return false;
      }

      // Relative volume filter
      if (relVolFilter.length > 0) {
        const avgVol = stock.avgVolume || 1000000;
        const relVol = stock.volume / avgVol;
        const matches = relVolFilter.some(f => {
          const filter = REL_VOL_FILTERS.find(r => r.id === f);
          return filter && relVol >= filter.min;
        });
        if (!matches) return false;
      }

      // Market cap filter (placeholder - would need real market cap data)
      if (marketCapFilter.length > 0) {
        // Placeholder logic - in production use actual market cap
        const matches = marketCapFilter.some(f => {
          if (f === "large") return (stock.marketCap || 100000) > 50000;
          if (f === "mid") return (stock.marketCap || 50000) > 10000 && (stock.marketCap || 50000) <= 50000;
          if (f === "small") return (stock.marketCap || 5000) <= 10000;
          return false;
        });
        if (!matches) return false;
      }

      // Sector filter
      if (sectorFilter.length > 0 && !sectorFilter.includes(stock.sector)) {
        return false;
      }

      // Trend filter
      if (trendFilter.length > 0 && !trendFilter.includes(stock.trend || "neutral")) {
        return false;
      }

      // Setup filter
      if (setupFilter.length > 0 && !setupFilter.includes(stock.setup || "WATCH")) {
        return false;
      }

      // F&O filter
      if (foFilter.length > 0) {
        const classification = stock.foData?.classification || "";
        const matches = foFilter.some(f => {
          if (f === "fo_only") return !!stock.foData;
          if (f === "high_oi") return (stock.foData?.oi || 0) > 1000000;
          if (f === "rising_oi") return (stock.foData?.oiChangePct || 0) > 5;
          if (f === "falling_oi") return (stock.foData?.oiChangePct || 0) < -5;
          return classification === f.toUpperCase().replace("_", " ");
        });
        if (!matches) return false;
      }

      // Price range filter
      if (stock.ltp < priceRange[0] || stock.ltp > priceRange[1]) {
        return false;
      }

      return true;
    });
  }, [data?.stocks, changeFilter, volumeFilter, relVolFilter, marketCapFilter, sectorFilter, trendFilter, setupFilter, foFilter, priceRange]);

  // Group filtered stocks by sector
  const sectors = useMemo(() => {
    const sectorMap = new Map<string, StockData[]>();
    for (const stock of filteredStocks) {
      if (!sectorMap.has(stock.sector)) sectorMap.set(stock.sector, []);
      sectorMap.get(stock.sector)!.push(stock);
    }
    return Array.from(sectorMap.entries()).map(([name, stocks]) => ({
      name,
      stocks,
      avgChangePct: stocks.reduce((sum, s) => sum + s.changePct, 0) / stocks.length,
      advanceCount: stocks.filter(s => s.changePct > 0).length,
      declineCount: stocks.filter(s => s.changePct < 0).length,
    })).sort((a, b) => b.avgChangePct - a.avgChangePct);
  }, [filteredStocks]);

  const hasActiveFilters = changeFilter.length > 0 || volumeFilter.length > 0 || relVolFilter.length > 0 ||
    marketCapFilter.length > 0 || sectorFilter.length > 0 || trendFilter.length > 0 ||
    setupFilter.length > 0 || foFilter.length > 0 || priceRange[0] > 0 || priceRange[1] < 10000;

  if (isLoading || !data) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-4">
          <div className="animate-pulse grid grid-cols-5 gap-1">
            {Array.from({ length: 20 }).map((_, i) => (
              <div key={i} className="h-12 bg-zinc-800 rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 bg-[#0f1117] border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-3 w-3 text-zinc-400" />
          <span className="text-xs font-bold text-zinc-300">MARKET HEATMAP</span>
          <Badge variant="outline" className="text-[9px]">{data.stocks?.length || filteredStocks.length} stocks</Badge>
          {hasActiveFilters && (
            <Badge variant="secondary" className="text-[9px] bg-emerald-500/20 text-emerald-400">
              FILTERED
            </Badge>
          )}
        </div>

        {/* Market Selector */}
        <Select value={selectedMarket} onValueChange={setSelectedMarket} className="w-40">
          <SelectTrigger className="text-[10px] h-7 bg-zinc-800 border-zinc-700">
            <SelectValue placeholder="Select Market" />
          </SelectTrigger>
          <SelectContent>
            {MARKETS.map(m => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} <span className="text-zinc-500 ml-2">({m.count})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="h-6" />

        {/* Size By Selector */}
        <Select value={sizeBy} onValueChange={setSizeBy} className="w-36">
          <SelectTrigger className="text-[10px] h-7 bg-zinc-800 border-zinc-700">
            <SelectValue placeholder="Size By" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="marketCap">Market Cap</SelectItem>
            <SelectItem value="tradedValue">Traded Value</SelectItem>
            <SelectItem value="volume">Volume</SelectItem>
            <SelectItem value="indexWeight">Index Weight</SelectItem>
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="h-6" />

        {/* Filters Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          className={showFilters ? "bg-emerald-500/20 text-emerald-400" : ""}
        >
          <SlidersHorizontal className="h-3 w-3 mr-1" />
          <span className="text-[10px]">Filters</span>
          {hasActiveFilters && <span className="ml-1 text-[9px] bg-emerald-500 text-black rounded-full px-1">{changeFilter.length + volumeFilter.length + relVolFilter.length + sectorFilter.length + trendFilter.length + setupFilter.length + foFilter.length}</span>}
        </Button>

        <div className="flex-1" />

        {/* View Toggle */}
        <div className="flex gap-1">
          <Button variant={view === "bySector" ? "default" : "ghost"} size="sm" onClick={() => setView("bySector")} className="text-[9px] px-2">
            By Sector
          </Button>
          <Button variant={view === "flat" ? "default" : "ghost"} size="sm" onClick={() => setView("flat")} className="text-[9px] px-2">
            Flat
          </Button>
        </div>
      </div>

      {/* Filter Panel */}
      <Collapsible open={showFilters} onOpenChange={setShowFilters}>
        <CollapsibleTrigger className="hidden" />
        <CollapsibleContent className="bg-zinc-950 border-b border-zinc-800 p-3 animate-slide-down overflow-x-auto">
          <div className="flex flex-wrap gap-4 min-w-max" style={{ minWidth: "1200px" }}>

            {/* Change % Filter */}
            <div className="flex flex-col gap-1 min-w-[180px]">
              <Label className="text-[10px] font-bold text-zinc-400">CHANGE %</Label>
              <div className="flex flex-wrap gap-1">
                {CHANGE_BUCKETS.map(bucket => (
                  <Button
                    key={bucket.id}
                    variant={changeFilter.includes(bucket.id) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setChangeFilter(prev => prev.includes(bucket.id) ? prev.filter(x => x !== bucket.id) : [...prev, bucket.id])}
                    className={`text-[9px] px-1.5 py-0.5 ${
                      bucket.min > 0 ? "text-emerald-400 hover:bg-emerald-500/10" :
                      bucket.max < 0 ? "text-red-400 hover:bg-red-500/10" :
                      "text-zinc-400"
                    }`}
                  >
                    {bucket.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Volume Filter */}
            <div className="flex flex-col gap-1 min-w-[140px]">
              <Label className="text-[10px] font-bold text-zinc-400">VOLUME</Label>
              <div className="flex flex-wrap gap-1">
                {VOLUME_FILTERS.map(f => (
                  <Button
                    key={f.id}
                    variant={volumeFilter.includes(f.id) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setVolumeFilter(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                    className="text-[9px] px-1.5 py-0.5"
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Relative Volume */}
            <div className="flex flex-col gap-1 min-w-[140px]">
              <Label className="text-[10px] font-bold text-zinc-400">REL VOLUME</Label>
              <div className="flex flex-wrap gap-1">
                {REL_VOL_FILTERS.map(f => (
                  <Button
                    key={f.id}
                    variant={relVolFilter.includes(f.id) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setRelVolFilter(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                    className="text-[9px] px-1.5 py-0.5"
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Market Cap */}
            <div className="flex flex-col gap-1 min-w-[140px]">
              <Label className="text-[10px] font-bold text-zinc-400">MARKET CAP</Label>
              <div className="flex flex-wrap gap-1">
                {MARKET_CAP_FILTERS.map(f => (
                  <Button
                    key={f.id}
                    variant={marketCapFilter.includes(f.id) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setMarketCapFilter(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                    className="text-[9px] px-1.5 py-0.5"
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Sector */}
            <div className="flex flex-col gap-1 min-w-[180px]">
              <Label className="text-[10px] font-bold text-zinc-400">SECTOR</Label>
              <Select value={sectorFilter.join(",")} onValueChange={val => setSectorFilter(val.split(",").filter(Boolean))} multiple>
                <SelectTrigger className="text-[10px] h-7 bg-zinc-800 border-zinc-700 w-full">
                  <SelectValue placeholder="All Sectors" />
                </SelectTrigger>
                <SelectContent>
                  {SECTORS.map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Trend */}
            <div className="flex flex-col gap-1 min-w-[160px]">
              <Label className="text-[10px] font-bold text-zinc-400">TREND</Label>
              <div className="flex flex-wrap gap-1">
                {TREND_FILTERS.map(f => (
                  <Button
                    key={f.id}
                    variant={trendFilter.includes(f.id) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setTrendFilter(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                    className={`text-[9px] px-1.5 py-0.5 ${
                      f.id.includes("bullish") ? "text-emerald-400" : f.id.includes("bearish") ? "text-red-400" : "text-zinc-400"
                    }`}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Setup */}
            <div className="flex flex-col gap-1 min-w-[180px]">
              <Label className="text-[10px] font-bold text-zinc-400">SETUP</Label>
              <div className="flex flex-wrap gap-1">
                {SETUP_FILTERS.map(f => (
                  <Button
                    key={f.id}
                    variant={setupFilter.includes(f.id) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setSetupFilter(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                    className="text-[9px] px-1.5 py-0.5"
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* F&O */}
            <div className="flex flex-col gap-1 min-w-[180px]">
              <Label className="text-[10px] font-bold text-zinc-400">F&O</Label>
              <div className="flex flex-wrap gap-1">
                {FO_FILTERS.map(f => (
                  <Button
                    key={f.id}
                    variant={foFilter.includes(f.id) ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setFoFilter(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                    className="text-[9px] px-1.5 py-0.5"
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Price Range */}
            <div className="flex flex-col gap-1 min-w-[160px]">
              <Label className="text-[10px] font-bold text-zinc-400">PRICE RANGE</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  placeholder="Min"
                  value={priceRange[0]}
                  onChange={e => setPriceRange(prev => [parseFloat(e.target.value) || 0, prev[1]])}
                  className="w-20 text-[10px] bg-zinc-800 border-zinc-700"
                />
                <span className="text-zinc-500 text-[10px]">–</span>
                <Input
                  type="number"
                  placeholder="Max"
                  value={priceRange[1] === 10000 ? "" : priceRange[1]}
                  onChange={e => setPriceRange(prev => [prev[0], parseFloat(e.target.value) || 10000])}
                  className="w-20 text-[10px] bg-zinc-800 border-zinc-700"
                />
              </div>
            </div>

            {/* Clear All */}
            <div className="flex items-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setChangeFilter([]);
                  setVolumeFilter([]);
                  setRelVolFilter([]);
                  setMarketCapFilter([]);
                  setSectorFilter([]);
                  setTrendFilter([]);
                  setSetupFilter([]);
                  setFoFilter([]);
                  setPriceRange([0, 10000]);
                }}
                className="text-red-400 hover:bg-red-500/10 h-7"
              >
                <X className="h-3 w-3 mr-1" />
                Clear All
              </Button>
            </div>

          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Heatmap */}
      <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden flex-1" style={{ minHeight: 0 }}>
        <CardContent className="p-3 pt-0 h-full overflow-auto">
          {view === "bySector" ? (
            <div className="space-y-2">
              {sectors.map(sector => (
                <div key={sector.name}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[9px] font-bold text-zinc-500">{sector.name}</span>
                    <div className="flex items-center gap-2">
                      <span className={`text-[9px] font-bold ${sector.avgChangePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {sector.avgChangePct >= 0 ? "+" : ""}{sector.avgChangePct.toFixed(2)}%
                      </span>
                      <span className="text-[9px] text-zinc-500">
                        ↑{sector.advanceCount} ↓{sector.declineCount}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-0.5">
                    {sector.stocks.map((stock: StockData) => (
                      <HeatmapCell key={stock.symbol} stock={stock} size="sm" onClick={handleStockClick} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-0.5">
              {filteredStocks.map((stock: StockData) => (
                <HeatmapCell key={stock.symbol} stock={stock} size="md" onClick={handleStockClick} />
              ))}
            </div>
          )}

          {filteredStocks.length === 0 && (
            <div className="flex items-center justify-center h-40 text-zinc-500 text-sm">
              No stocks match current filters
            </div>
          )}

          {/* Selected stock detail */}
          {selected && (
            <div className="mt-3 bg-zinc-800/50 border border-zinc-700 rounded p-3 animate-slide-up">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-bold text-white">{selected.symbol}</span>
                  <span className="text-[10px] text-zinc-500 ml-2">{selected.name}</span>
                  <Badge className="ml-2 text-[8px] bg-zinc-700">{selected.sector}</Badge>
                </div>
                <button onClick={() => setSelected(null)} className="text-zinc-500 text-xs">✕</button>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[10px]">
                <div>
                  <span className="text-zinc-500">LTP</span>
                  <div className="font-bold">₹{selected.ltp?.toFixed(2)}</div>
                </div>
                <div>
                  <span className="text-zinc-500">Change</span>
                  <div className={`font-bold ${selected.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {selected.changePct >= 0 ? "+" : ""}{selected.changePct}%
                  </div>
                </div>
                <div>
                  <span className="text-zinc-500">Sector</span>
                  <div className="font-bold">{selected.sector}</div>
                </div>
                <div>
                  <span className="text-zinc-500">Volume</span>
                  <div className="font-bold">{(selected.volume / 100000).toFixed(1)}L</div>
                </div>
                <div>
                  <span className="text-zinc-500">Rel Vol</span>
                  <div className={`font-bold ${(selected.relVolume || 1) > 1.5 ? "text-emerald-400" : "text-zinc-400"}`}>
                    {(selected.relVolume || 1).toFixed(1)}x
                  </div>
                </div>
                <div>
                  <span className="text-zinc-500">52W Pos</span>
                  <div className="font-bold">
                    {selected.weekHigh52 && selected.weekLow52 && selected.weekHigh52 > selected.weekLow52
                      ? (((selected.ltp - selected.weekLow52) / (selected.weekHigh52 - selected.weekLow52)) * 100).toFixed(0) + "%"
                      : "—"}
                  </div>
                </div>
                <div>
                  <span className="text-zinc-500">F&O</span>
                  <div className={`font-bold ${selected.foData?.classification ? "text-emerald-400" : "text-zinc-500"}`}>
                    {selected.foData?.classification || "—"}
                  </div>
                </div>
                <div>
                  <span className="text-zinc-500">Setup</span>
                  <div className="font-bold text-yellow-400">{selected.setup || "WATCH"}</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}