"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataFreshnessBadge } from "./DataFreshnessBadge";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";

interface Stock {
  symbol: string;
  name: string;
  changePct: number;
  ltp: number;
}

interface Sector {
  name: string;
  avgChangePct: number;
  stocks: Stock[];
  advanceCount: number;
  declineCount: number;
}

interface HeatmapResponse {
  success: boolean;
  status: string;
  stocks: Stock[];
  sectors: Sector[];
  stockCount: number;
  provenance?: any;
  data?: any;
}

function formatPct(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function getTileColor(changePct: number) {
  if (changePct >= 3) return "bg-emerald-600 text-white";
  if (changePct >= 1.5) return "bg-emerald-500 text-white";
  if (changePct >= 0.3) return "bg-emerald-400/70 text-zinc-900";
  if (changePct > -0.3) return "bg-zinc-700 text-zinc-200";
  if (changePct > -1.5) return "bg-zinc-600 text-zinc-200";
  if (changePct > -3) return "bg-zinc-500 text-zinc-100";
  return "bg-red-600 text-white";
}

export default function IndustryHeatmapPanel() {
  const [selected, setSelected] = useState<Sector | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  const { data, isLoading, error } = useQuery<HeatmapResponse>({
    queryKey: ["industry-heatmap"],
    queryFn: async () => {
      const res = await fetch("/api/market/heatmap?market=NIFTY500");
      if (!res.ok) throw new Error("Heatmap fetch failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <Card className="bg-[#0b0f1a] border-[#1f2330]">
        <CardHeader className="pb-2">
          <div className="text-sm font-semibold">Market Heatmap</div>
        </CardHeader>
        <CardContent>Loading...</CardContent>
      </Card>
    );
  }

  if (error || !data?.success || !data.sectors?.length) {
    return (
      <Card className="bg-[#0b0f1a] border-[#1f2330]">
        <CardHeader className="pb-2">
          <div className="text-sm font-semibold">Market Heatmap</div>
        </CardHeader>
        <CardContent className="text-sm text-red-400">Unable to load industry data</CardContent>
      </Card>
    );
  }

  const sectors = data.sectors
    .map(s => {
      const totalStocks = s.stocks.length;
      const unchangedCount = Math.max(0, totalStocks - s.advanceCount - s.declineCount);
      const topMover = [...s.stocks].sort((a,b)=> Math.abs(b.changePct) - Math.abs(a.changePct))[0];
      return { ...s, totalStocks, unchangedCount, topMover };
    })
    .sort((a,b)=> b.avgChangePct - a.avgChangePct);

  const totalAdvancing = sectors.reduce((sum,s)=> sum + s.advanceCount,0);
  const totalDeclining = sectors.reduce((sum,s)=> sum + s.declineCount,0);
  const totalUnchanged = sectors.reduce((sum,s)=> sum + s.unchangedCount,0);
  const totalStocks = sectors.reduce((sum,s)=> sum + s.totalStocks,0);
  const avgChange = totalStocks ? sectors.reduce((sum,s)=> sum + s.avgChangePct * s.totalStocks,0)/totalStocks : 0;

  const maxStocks = Math.max(...sectors.map(s=>s.totalStocks),1);
  const getSpan = (count: number) => {
    const norm = Math.sqrt(count / maxStocks);
    if (norm > 0.8) return 4;
    if (norm > 0.55) return 3;
    if (norm > 0.3) return 2;
    return 1;
  };

  const freshness = data.provenance?.freshness || "UNKNOWN";
  const lastChecked = data.provenance?.retrievedAt ? `${Math.floor((Date.now() - new Date(data.provenance.retrievedAt).getTime())/60000)}m ago` : "—";

  return (
    <Card className="bg-[#0b0f1a] border-[#1f2330]">
      <CardHeader className="pb-2 pt-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-white">Market Heatmap</div>
            <div className="text-xs text-zinc-400 mt-0.5">Every industry's average move today. Click one to see its stocks.</div>
            <div className="text-[10px] text-zinc-500 mt-1 flex items-center gap-2">
              <span>data as of {new Date().toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short'})}</span>
              <span className="bg-zinc-800 px-1 rounded">checked {lastChecked}</span>
              <span className="bg-zinc-800 px-1 rounded">{data.provenance?.sourceLabel || 'NSE/BSE • Moneycontrol'}</span>
              <span>Daily bars from NSE/BSE via Moneycontrol, refreshed each collector cycle — intraday moves lag the live price by up to a cycle.</span>
            </div>
          </div>
          <DataFreshnessBadge status={freshness} />
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <Collapsible open={howOpen} onOpenChange={setHowOpen}>
          <CollapsibleTrigger className="w-full flex items-center justify-between bg-[#121826] rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-[#151c2e]">
            How to read this page <ChevronDown className={`w-4 h-4 transition ${howOpen?'rotate-180':''}`} />
          </CollapsibleTrigger>
          <CollapsibleContent className="text-xs text-zinc-400 px-3 py-2 bg-[#0f1320] rounded-b-md">
            Tile size reflects number of stocks in the industry. Color reflects average % change. Click a tile to drill down to its constituents.
          </CollapsibleContent>
        </Collapsible>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            {label:'Advancing', value: totalAdvancing, color:'text-emerald-400'},
            {label:'Declining', value: totalDeclining, color:'text-red-400'},
            {label:'Unchanged', value: totalUnchanged, color:'text-zinc-200'},
            {label:'Avg change', value: formatPct(avgChange), color: avgChange>=0?'text-emerald-400':'text-red-400'},
          ].map((s,i)=>(
            <div key={i} className="bg-[#121826] rounded-lg p-3 border border-[#1f2330]">
              <div className="text-[11px] text-zinc-400">{s.label}</div>
              <div className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-[#1f2330] bg-[#0b0f1a]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#1f2330]">
            <div className="text-sm text-zinc-300">{sectors.length} industries</div>
            <div className="flex items-center gap-2 text-[10px] text-zinc-500">
              <span>Down</span>
              {[
                {v:-3,color:'bg-red-700'},
                {v:-1.5,color:'bg-red-500'},
                {v:-0.3,color:'bg-rose-300'},
                {v:0,color:'bg-zinc-600'},
                {v:0.3,color:'bg-emerald-300'},
                {v:1.5,color:'bg-emerald-500'},
                {v:3,color:'bg-emerald-600'},
              ].map((l,i)=>(
                <div key={i} className="flex items-center gap-1">
                  <div className={`w-5 h-3 rounded-sm ${l.color}`} />
                  <span>{l.v===0?'0':`${l.v>0?'+':''}${l.v}%`}</span>
                </div>
              ))}
              <span>Up</span>
            </div>
          </div>

          <div className="p-2">
            <div className="grid grid-cols-12 gap-2 auto-rows-min">
              {sectors.map(s=>{
                const span = getSpan(s.totalStocks);
                const color = getTileColor(s.avgChangePct);
                return (
                  <button
                    key={s.name}
                    onClick={()=>setSelected(s)}
                    className={`col-span-${span} rounded-md p-2 text-left border border-black/20 ${color} hover:brightness-110 transition`}
                    style={{minHeight:'64px'}}
                  >
                    <div className="text-[11px] font-semibold leading-tight">{s.name}</div>
                    <div className="text-lg font-bold leading-tight mt-0.5">{formatPct(s.avgChangePct)}</div>
                    <div className="text-[10px] opacity-90">{s.totalStocks} stocks · {s.topMover?.symbol} {formatPct(s.topMover?.changePct ?? 0)}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {selected && (
          <Card className="bg-[#0b0f1a] border-[#1f2330]">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">{selected.name} — {selected.totalStocks} stocks</div>
                <button onClick={()=>setSelected(null)} className="text-zinc-500 hover:text-zinc-200 text-xs">✕</button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1 max-h-60 overflow-auto">
                {selected.stocks.map(st=>(
                  <div key={st.symbol} className={`flex justify-between px-2 py-1 rounded text-[10px] ${getTileColor(st.changePct)}`}>
                    <span>{st.symbol}</span>
                    <span>{formatPct(st.changePct)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </CardContent>
    </Card>
  );
}
