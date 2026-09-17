"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  RefreshCw,
  TrendingUp,
  BarChart3,
  ArrowUpDown,
  Flame,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface MostActiveContract {
  instrument: string;
  underlying: string;
  expiryDate: string;
  optionType: string;
  strikePrice: number;
  lastPrice: number;
  pChange: number;
  numberOfContractsTraded: number;
  totalTurnover: number;
  openInterest: number;
  underlyingValue: number;
}

interface MostActiveData {
  contracts: { data: MostActiveContract[]; timestamp: string };
  futures: { data: MostActiveContract[]; timestamp: string };
  options: { data: MostActiveContract[]; timestamp: string };
  callsIndex: { data: MostActiveContract[]; timestamp: string };
  putsIndex: { data: MostActiveContract[]; timestamp: string };
  callsStocks: { data: MostActiveContract[]; timestamp: string };
  putsStocks: { data: MostActiveContract[]; timestamp: string };
  oi: { data: MostActiveContract[]; timestamp: string };
  fetchedAt: number;
  marketStatus: string;
}

function fmtVol(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString("en-IN");
}

function fmtTurnover(v: number): string {
  if (v >= 100) return `${(v / 100).toFixed(0)}Cr`;
  if (v >= 1) return `${v.toFixed(0)}L`;
  return `${(v * 100).toFixed(0)}K`;
}

function SentimentBadge({ calls, puts }: { calls: MostActiveContract[]; puts: MostActiveContract[] }) {
  const callVol = calls.reduce((s, c) => s + c.numberOfContractsTraded, 0);
  const putVol = puts.reduce((s, c) => s + c.numberOfContractsTraded, 0);
  const ratio = callVol > 0 ? putVol / callVol : 1;

  let label = "Neutral";
  let color = "text-zinc-400";
  let bgColor = "bg-zinc-500/20";
  if (ratio > 1.5) { label = "BEARISH"; color = "text-red-400"; bgColor = "bg-red-500/20"; }
  else if (ratio > 1.1) { label = "Mild Bearish"; color = "text-orange-400"; bgColor = "bg-orange-500/20"; }
  else if (ratio < 0.67) { label = "BULLISH"; color = "text-emerald-400"; bgColor = "bg-emerald-500/20"; }
  else if (ratio < 0.9) { label = "Mild Bullish"; color = "text-green-400"; bgColor = "bg-green-500/20"; }

  return (
    <Badge variant="outline" className={`${color} ${bgColor} border-current text-[10px] font-bold`}>
      {label} P/C: {ratio.toFixed(2)}
    </Badge>
  );
}

function ContractRow({ c, rank }: { c: MostActiveContract; rank: number }) {
  const isPositive = c.pChange >= 0;
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
      <td className="py-1.5 px-2 text-[10px] text-zinc-500 font-mono">{rank}</td>
      <td className="py-1.5 px-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-bold text-zinc-100">{c.underlying}</span>
          {c.instrument.includes("IDX") && (
            <Badge variant="outline" className="text-[8px] px-1 py-0 border-blue-500/40 text-blue-400">IDX</Badge>
          )}
        </div>
        <div className="text-[9px] text-zinc-500">
          {c.expiryDate} {c.optionType && `${c.strikePrice} ${c.optionType}`}
        </div>
      </td>
      <td className="py-1.5 px-2 text-right text-[11px] font-mono text-zinc-200">
        ₹{c.lastPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
      </td>
      <td className={`py-1.5 px-2 text-right text-[11px] font-mono font-bold ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
        {isPositive ? "+" : ""}{c.pChange.toFixed(2)}%
      </td>
      <td className="py-1.5 px-2 text-right text-[11px] font-mono text-cyan-400">
        {fmtVol(c.numberOfContractsTraded)}
      </td>
      <td className="py-1.5 px-2 text-right text-[11px] font-mono text-amber-400">
        {fmtTurnover(c.totalTurnover)}
      </td>
      <td className="py-1.5 px-2 text-right text-[11px] font-mono text-purple-400">
        {fmtVol(c.openInterest)}
      </td>
    </tr>
  );
}

function ContractTable({ data, title }: { data: MostActiveContract[]; title: string }) {
  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-500 text-[11px]">
        No data available — market may be closed
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-zinc-700">
            <th className="py-1.5 px-2 text-left text-zinc-500 font-medium">#</th>
            <th className="py-1.5 px-2 text-left text-zinc-500 font-medium">Contract</th>
            <th className="py-1.5 px-2 text-right text-zinc-500 font-medium">LTP</th>
            <th className="py-1.5 px-2 text-right text-zinc-500 font-medium">%Chg</th>
            <th className="py-1.5 px-2 text-right text-zinc-500 font-medium">Vol</th>
            <th className="py-1.5 px-2 text-right text-zinc-500 font-medium">Turnover</th>
            <th className="py-1.5 px-2 text-right text-zinc-500 font-medium">OI</th>
          </tr>
        </thead>
        <tbody>
          {data.map((c, i) => (
            <ContractRow key={`${c.underlying}-${c.strikePrice}-${c.optionType}-${i}`} c={c} rank={i + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MostActiveContracts() {
  const [data, setData] = useState<MostActiveData | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [activeTab, setActiveTab] = useState("contracts");

  const fetchData = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const url = "/api/market/most-active";
      const method = force ? "POST" : "GET";
      const res = await fetch(url, { method });
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        setLastFetch(Date.now());
      }
    } catch (err) {
      console.error("Failed to fetch most active contracts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh every 5 min
  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const ageMin = lastFetch ? Math.round((Date.now() - lastFetch) / 60000) : null;

  return (
    <Card className="bg-zinc-900/50 border-zinc-800">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-orange-400" />
            <CardTitle className="text-[13px] font-semibold text-zinc-100">
              Most Active F&O Contracts
            </CardTitle>
            {data && (
              <SentimentBadge
                calls={data.callsIndex?.data || []}
                puts={data.putsIndex?.data || []}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            {ageMin !== null && (
              <span className="text-[9px] text-zinc-500">
                {ageMin === 0 ? "Just now" : `${ageMin}m ago`}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchData(true)}
              disabled={loading}
              className="h-6 px-2 text-[10px]"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="h-7 bg-zinc-800/50 mb-2">
            <TabsTrigger value="contracts" className="text-[10px] px-2 h-5">
              <Activity className="h-3 w-3 mr-1" /> All
            </TabsTrigger>
            <TabsTrigger value="futures" className="text-[10px] px-2 h-5">
              <TrendingUp className="h-3 w-3 mr-1" /> Futures
            </TabsTrigger>
            <TabsTrigger value="options" className="text-[10px] px-2 h-5">
              <BarChart3 className="h-3 w-3 mr-1" /> Options
            </TabsTrigger>
            <TabsTrigger value="calls" className="text-[10px] px-2 h-5">
              <ArrowUpDown className="h-3 w-3 mr-1" /> Calls
            </TabsTrigger>
            <TabsTrigger value="puts" className="text-[10px] px-2 h-5">
              <ArrowUpDown className="h-3 w-3 mr-1" /> Puts
            </TabsTrigger>
            <TabsTrigger value="oi" className="text-[10px] px-2 h-5">
              OI
            </TabsTrigger>
          </TabsList>

          <TabsContent value="contracts" className="mt-0">
            <ContractTable data={data?.contracts?.data || []} title="Most Active Contracts" />
          </TabsContent>
          <TabsContent value="futures" className="mt-0">
            <ContractTable data={data?.futures?.data || []} title="Most Active Futures" />
          </TabsContent>
          <TabsContent value="options" className="mt-0">
            <ContractTable data={data?.options?.data || []} title="Most Active Options" />
          </TabsContent>
          <TabsContent value="calls" className="mt-0">
            <ContractTable data={data?.callsIndex?.data || []} title="Index Calls" />
            {data?.callsStocks?.data && data.callsStocks.data.length > 0 && (
              <>
                <div className="text-[10px] text-zinc-500 mt-2 mb-1 font-medium">Stock Calls</div>
                <ContractTable data={data.callsStocks.data} title="Stock Calls" />
              </>
            )}
          </TabsContent>
          <TabsContent value="puts" className="mt-0">
            <ContractTable data={data?.putsIndex?.data || []} title="Index Puts" />
            {data?.putsStocks?.data && data.putsStocks.data.length > 0 && (
              <>
                <div className="text-[10px] text-zinc-500 mt-2 mb-1 font-medium">Stock Puts</div>
                <ContractTable data={data.putsStocks.data} title="Stock Puts" />
              </>
            )}
          </TabsContent>
          <TabsContent value="oi" className="mt-0">
            <ContractTable data={data?.oi?.data || []} title="Most Active by OI" />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
