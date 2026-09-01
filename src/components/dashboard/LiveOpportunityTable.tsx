// ─── Live Opportunity Table ────────────────────────────────────────────
// Real-time table of expiry liquidity opportunities

"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useMemo } from "react";
import {
  TrendingUp,
  TrendingDown,
  Zap,
  Target,
  Shield,
  ChevronUp,
  ChevronDown,
  Filter,
  X,
  Search,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Opportunity {
  symbol: string;
  name: string;
  expiry: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
  setup: string;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  rr: number;
  confidence: string;
  casGap: number;
  oiFlow: string;
  volumeRatio: number;
  ivState: string;
  futuresConfirmed: boolean;
  reasons: string[];
  risks: string[];
  signal: string;
  status: string;
  timestamp: number;
}

function ScoreBadge({ score }: { score: number }) {
  const grade = score >= 80 ? "A+" : score >= 65 ? "A" : score >= 50 ? "B" : "C";
  const color = score >= 80 ? "bg-emerald-600" :
    score >= 65 ? "bg-emerald-500/30 text-emerald-400" :
    score >= 50 ? "bg-yellow-500/30 text-yellow-400" : "bg-zinc-600 text-zinc-400";
  return <Badge className={`${color} text-xs font-bold`}>{score}/100 {grade}</Badge>;
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const color = confidence === "VERY HIGH" ? "bg-emerald-600" :
    confidence === "HIGH" ? "bg-emerald-500/20 text-emerald-400" :
    confidence === "MEDIUM" ? "bg-yellow-500/20 text-yellow-400" : "bg-zinc-600 text-zinc-400";
  return <Badge variant="outline" className={`${color} text-[9px]`}>{confidence}</Badge>;
}

function DirectionBadge({ direction }: { direction: string }) {
  const color = direction === "BULLISH" ? "bg-emerald-600 text-white" :
    direction === "BEARISH" ? "bg-red-600 text-white" :
    "bg-zinc-600 text-zinc-400";
  const icon = direction === "BULLISH" ? <TrendingUp className="h-3 w-3" /> :
    direction === "BEARISH" ? <TrendingDown className="h-3 w-3" /> : null;
  return (
    <Badge className={`${color} text-[9px] font-bold flex items-center gap-1`}>
      {icon} {direction}
    </Badge>
  );
}

function SignalBadge({ signal }: { signal: string }) {
  const colors: Record<string, string> = {
    LONG_CALL: "bg-emerald-600 text-white",
    LONG_PUT: "bg-red-600 text-white",
    CALL_SHORT_COVERING: "bg-emerald-500/30 text-emerald-400",
    PUT_SHORT_COVERING: "bg-red-500/30 text-red-400",
    FUTURES_LONG: "bg-blue-600 text-white",
    FUTURES_SHORT: "bg-orange-600 text-white",
    WATCH: "bg-yellow-600 text-white",
    NO_TRADE: "bg-zinc-600 text-zinc-400",
  };
  return <Badge className={`${colors[signal] || "bg-zinc-600"} text-[9px] font-bold`}>{signal}</Badge>;
}

function ConfidenceBar({ label, value, max = 100, color = "bg-emerald-500" }: { label: string; value: number; max?: number; color?: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="text-zinc-500 w-16">{label}</span>
      <div className="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-bold w-6 text-right">{value}</span>
    </div>
  );
}

export function LiveOpportunityTable() {
  const [sortCol, setSortCol] = useState<keyof Opportunity | null>(null);
  const [sortAsc, setSortAsc] = useState(false);
  const [filters, setFilters] = useState({
    minScore: 0,
    maxScore: 100,
    direction: "",
    signal: "",
    minVolumeRatio: 0,
    maxResults: 20,
    search: "",
  });
  const [showFilters, setShowFilters] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["expiry-opportunities"],
    queryFn: async () => {
      const res = await fetch("/api/expiry-liquidity/opportunities");
      const json = await res.json();
      return json.data || [];
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const opportunities = useMemo(() => {
    if (!data) return [];

    let filtered = data.filter((opp: Opportunity) => {
      if (filters.minScore && opp.score < filters.minScore) return false;
      if (filters.maxScore && opp.score > filters.maxScore) return false;
      if (filters.direction && opp.direction !== filters.direction) return false;
      if (filters.signal && opp.signal !== filters.signal) return false;
      if (filters.minVolumeRatio && opp.volumeRatio < filters.minVolumeRatio) return false;
      if (filters.search && !opp.symbol.toLowerCase().includes(filters.search.toLowerCase())) return false;
      return true;
    });

    if (sortCol) {
      filtered.sort((a, b) => {
        const aVal = a[sortCol];
        const bVal = b[sortCol];
        if (aVal === bVal) return 0;
        const cmp = aVal > bVal ? 1 : -1;
        return sortAsc ? cmp : -cmp;
      });
    }

    return filtered.slice(0, filters.maxResults);
  }, [data, sortCol, sortAsc, filters]);

  const handleSort = (col: keyof Opportunity) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  };

  const activeFilterCount = Object.values(filters).filter(v => v !== "" && v !== 0 && v !== 20).length;

  if (isLoading) {
    return (
      <Card className="bg-[#0f1117] border-zinc-800">
        <CardContent className="p-4">
          <div className="animate-pulse space-y-2">
            {[1,2,3,4,5].map(i => <div key={i} className="h-12 bg-zinc-800 rounded" />)}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 p-2 bg-[#0f1117] border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-zinc-300 flex items-center gap-1">
            <Zap className="h-3 w-3 text-yellow-500" />
            LIVE OPPORTUNITIES
          </span>
          <Badge variant="outline" className="text-[9px]">{data?.length || 0} symbols</Badge>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <Input
            placeholder="Search symbol..."
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            className="w-40 text-[10px] bg-zinc-800 border-zinc-700"
          />
          <Select value={filters.direction} onValueChange={v => setFilters(f => ({ ...f, direction: v }))} className="w-28">
            <SelectTrigger className="text-[10px] h-7 bg-zinc-800 border-zinc-700"><SelectValue placeholder="Direction" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="BULLISH">Bullish</SelectItem>
              <SelectItem value="BEARISH">Bearish</SelectItem>
              <SelectItem value="NEUTRAL">Neutral</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.signal} onValueChange={v => setFilters(f => ({ ...f, signal: v }))} className="w-32">
            <SelectTrigger className="text-[10px] h-7 bg-zinc-800 border-zinc-700"><SelectValue placeholder="Signal" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="LONG_CALL">LONG_CALL</SelectItem>
              <SelectItem value="LONG_PUT">LONG_PUT</SelectItem>
              <SelectItem value="CALL_SHORT_COVERING">CALL_SHORT_COVERING</SelectItem>
              <SelectItem value="PUT_SHORT_COVERING">PUT_SHORT_COVERING</SelectItem>
              <SelectItem value="FUTURES_LONG">FUTURES_LONG</SelectItem>
              <SelectItem value="FUTURES_SHORT">FUTURES_SHORT</SelectItem>
              <SelectItem value="WATCH">WATCH</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          className={showFilters ? "bg-emerald-500/20 text-emerald-400" : ""}
        >
          <Filter className="h-3 w-3 mr-1" />
          <span className="text-[10px]">Filters</span>
          {Object.values(filters).filter(v => v !== "" && v !== 0 && v !== 20).length > 0 && (
            <span className="ml-1 text-[9px] bg-emerald-500 text-black rounded-full px-1">
              {Object.values(filters).filter(v => v !== "" && v !== 0 && v !== 20).length}
            </span>
          )}
        </Button>

        <div className="flex-1" />

        <div className="flex gap-1">
          <Button variant={!filters.maxResults || filters.maxResults === 20 ? "default" : "ghost"} size="sm" onClick={() => setFilters(f => ({ ...f, maxResults: 20 }))} className="text-[9px] px-2">Top 20</Button>
          <Button variant={filters.maxResults === 50 ? "default" : "ghost"} size="sm" onClick={() => setFilters(f => ({ ...f, maxResults: 50 }))} className="text-[9px] px-2">Top 50</Button>
          <Button variant={filters.maxResults === 100 ? "default" : "ghost"} size="sm" onClick={() => setFilters(f => ({ ...f, maxResults: 100 }))} className="text-[9px] px-2">All</Button>
        </div>
      </div>

      {/* Filter Panel */}
      {showFilters && (
        <div className="bg-zinc-950 border-b border-zinc-800 p-3 animate-slide-down overflow-x-auto">
          <div className="flex flex-wrap gap-4 min-w-max" style={{ minWidth: "1000px" }}>
            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-[10px] font-bold text-zinc-400">MIN SCORE</label>
              <Input type="number" value={filters.minScore} onChange={e => setFilters(f => ({ ...f, minScore: parseInt(e.target.value) || 0 }))} className="text-[10px] bg-zinc-800 border-zinc-700" />
            </div>
            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-[10px] font-bold text-zinc-400">MAX SCORE</label>
              <Input type="number" value={filters.maxScore} onChange={e => setFilters(f => ({ ...f, maxScore: parseInt(e.target.value) || 100 }))} className="text-[10px] bg-zinc-800 border-zinc-700" />
            </div>
            <div className="flex flex-col gap-1 min-w-[140px]">
              <label className="text-[10px] font-bold text-zinc-400">MIN VOL RATIO</label>
              <Input type="number" step="0.1" value={filters.minVolumeRatio} onChange={e => setFilters(f => ({ ...f, minVolumeRatio: parseFloat(e.target.value) || 0 }))} className="text-[10px] bg-zinc-800 border-zinc-700" />
            </div>
            <div className="flex flex-col gap-1 min-w-[140px]">
              <label className="text-[10px] font-bold text-zinc-400">MAX RESULTS</label>
              <Input type="number" value={filters.maxResults} onChange={e => setFilters(f => ({ ...f, maxResults: parseInt(e.target.value) || 20 }))} className="text-[10px] bg-zinc-800 border-zinc-700" />
            </div>
            <div className="flex items-end">
              <Button variant="ghost" size="sm" onClick={() => setFilters({
                minScore: 0, maxScore: 100, direction: "", signal: "", minVolumeRatio: 0, maxResults: 20, search: ""
              })} className="text-red-400 hover:bg-red-500/10 h-7">
                <X className="h-3 w-3 mr-1" /> Clear All
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto p-3">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-zinc-800">
              {[
                { key: "symbol", label: "SYMBOL" },
                { key: "name", label: "NAME" },
                { key: "direction", label: "DIR" },
                { key: "signal", label: "SIGNAL" },
                { key: "score", label: "SCORE" },
                { key: "entryState", label: "STATE" },
                { key: "entry", label: "ENTRY" },
                { key: "stop", label: "SL" },
                { key: "target1", label: "T1" },
                { key: "target2", label: "T2" },
                { key: "rr", label: "R:R" },
                { key: "confidence", label: "CONF" },
                { key: "casGap", label: "CAS%" },
                { key: "oiFlow", label: "OI FLOW" },
                { key: "volumeRatio", label: "RVOL" },
                { key: "ivState", label: "IV" },
                { key: "futuresConfirmed", label: "FUT" },
              ].map(col => (
                <th
                  key={col.key}
                  className={`text-right text-[#7d8ba0] font-semibold py-1.5 px-1 text-[10.5px] uppercase tracking-wide bg-[#10151d] cursor-pointer hover:text-white`}
                  onClick={() => handleSort(col.key as keyof Opportunity)}
                  style={{ textAlign: col.key === "symbol" || col.key === "name" || col.key === "signal" || col.key === "oiFlow" ? "left" : "right" }}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>{col.label}</span>
                    {sortCol === col.key && (
                      sortAsc ? <ChevronUp className="h-3 w-3 text-blue-400" /> : <ChevronDown className="h-3 w-3 text-blue-400" />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {opportunities.map((opp, idx) => (
              <tr key={opp.symbol} className={`${idx % 2 === 0 ? "bg-[#0a0e14]" : "bg-[#0f1117]"} border-b border-[#1f2733] hover:bg-[#151b25] transition-colors`}>
                <td className="text-right py-1.5 px-1 font-semibold text-[#dfe6ee]">{opp.symbol}</td>
                <td className="text-left py-1.5 px-1 text-[#7d8ba0] text-[11px]">{opp.name}</td>
                <td className="text-center py-1.5 px-1">
                  <DirectionBadge direction={opp.direction} />
                </td>
                <td className="text-center py-1.5 px-1">
                  <SignalBadge signal={opp.signal} />
                </td>
                <td className="text-right py-1.5 px-1">
                  <ScoreBadge score={opp.score} />
                </td>
                <td className="text-center py-1.5 px-1">
                  <Badge
                    variant="outline"
                    className={`text-[9px] ${
                      opp.status === "CONFIRMED" ? "text-emerald-400 border-emerald-500/30" :
                      opp.status === "CONFIRMING" ? "text-blue-400 border-blue-500/30" :
                      opp.status === "TRIGGERED" ? "text-emerald-400 border-emerald-500/30" :
                      opp.status === "ACTIVE" ? "text-emerald-400 border-emerald-500/30" :
                      opp.status === "EXHAUSTED" ? "text-orange-400 border-orange-500/30" :
                      opp.status === "INVALIDATED" ? "text-red-400 border-red-500/30" :
                      "text-zinc-400"
                    }`}
                  >
                    {opp.status === "CONFIRMED" ? "✓" : opp.status === "CONFIRMING" ? "⟳" : opp.status === "WATCH" ? "👁" : opp.status}
                    {opp.status}
                  </Badge>
                </td>
                <td className="text-right py-1.5 px-1 font-bold text-white">{opp.entry.toFixed(2)}</td>
                <td className="text-right py-1.5 px-1 font-bold text-red-400">{opp.stop.toFixed(2)}</td>
                <td className="text-right py-1.5 px-1 font-bold text-emerald-400">{opp.target1.toFixed(2)}</td>
                <td className="text-right py-1.5 px-1 font-bold text-emerald-400">{opp.target2.toFixed(2)}</td>
                <td className="text-right py-1.5 px-1">
                  <span className={`font-bold ${opp.rr >= 2 ? "text-emerald-400" : opp.rr >= 1.5 ? "text-yellow-400" : "text-red-400"}`}>
                    1:{opp.rr.toFixed(1)}
                  </span>
                </td>
                <td className="text-center py-1.5 px-1">
                  <ConfidenceBadge confidence={opp.confidence} />
                </td>
                <td className="text-right py-1.5 px-1">
                  <span className={`font-bold ${opp.casGap >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {opp.casGap >= 0 ? "+" : ""}{opp.casGap.toFixed(2)}%
                  </span>
                </td>
                <td className="text-left py-1.5 px-1 text-[10px]">
                  <Badge variant="outline" className={`text-[8px] ${
                    opp.oiFlow === "LONG_BUILDUP" || opp.oiFlow === "SHORT_COVERING" ? "text-emerald-400 border-emerald-500/30" :
                    opp.oiFlow === "SHORT_BUILDUP" || opp.oiFlow === "LONG_UNWINDING" ? "text-red-400 border-red-500/30" :
                    "text-zinc-400"
                  }`}>
                    {opp.oiFlow}
                  </Badge>
                </td>
                <td className="text-right py-1.5 px-1">
                  <span className={`font-bold ${opp.volumeRatio > 2 ? "text-emerald-400" : opp.volumeRatio > 1.5 ? "text-yellow-400" : "text-zinc-400"}`}>
                    {opp.volumeRatio.toFixed(1)}x
                  </span>
                </td>
                <td className="text-center py-1.5 px-1">
                  <Badge variant="outline" className={`text-[8px] ${
                    opp.ivState === "IV_EXPANSION" ? "text-emerald-400 border-emerald-500/30" :
                    opp.ivState === "IV_CONTRACTION" ? "text-red-400 border-red-500/30" :
                    opp.ivState === "IV_SHOCK" ? "text-orange-400 border-orange-500/30" :
                    "text-zinc-400"
                  }`}>
                    {opp.ivState}
                  </Badge>
                </td>
                <td className="text-center py-1.5 px-1">
                  <Badge variant="outline" className={`text-[8px] ${opp.futuresConfirmed ? "text-emerald-400 border-emerald-500/30" : "text-red-400 border-red-500/30"}`}>
                    {opp.futuresConfirmed ? "✓" : "✗"}
                  </Badge>
                </td>
              </tr>
            ))}
            {opportunities.length === 0 && (
              <tr>
                <td colSpan={18} className="text-center py-8 text-zinc-500 text-sm">
                  No opportunities match current filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function handleSort(col: keyof Opportunity) {
  // This would be implemented in the component
}