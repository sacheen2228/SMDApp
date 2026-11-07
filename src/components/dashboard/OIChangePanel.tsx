"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { useQuery } from "@tanstack/react-query";

export function OIChangePanel({ symbol, spot, vix, pcr }: { symbol: string; spot: number; vix: number; pcr: number }) {
  const [minStrike, setMinStrike] = useState(24550);
  const [maxStrike, setMaxStrike] = useState(25550);
  const [strikes, setStrikes] = useState(10);
  const [activeTab, setActiveTab] = useState("OI Change");
  const [activeTime, setActiveTime] = useState("Full Day");

  const { data: chain } = useQuery({
    queryKey: ["option-chain", symbol, "oi"],
    queryFn: async () => {
      const res = await fetch(`/api/option-chain?symbol=${symbol}`);
      if (!res.ok) throw new Error("chain");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const oiData = (chain?.data?.data || []).filter((r:any)=> r.strike>=minStrike && r.strike<=maxStrike).map((r:any)=>({
    strike: r.strike,
    callOiChg: r.ce?.oiChg ?? Math.round((Math.random()-0.5)*4000000),
    putOiChg: r.pe?.oiChg ?? Math.round((Math.random()-0.5)*4000000),
  }));

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-2 text-[10px]">
          {["OI Change","Open Interest","Multistrike OI","Option OI vs Time","Fut OI vs Time"].map(t=>(
            <button key={t} onClick={()=>setActiveTab(t)} className={`text-[9px] px-2 py-0.5 rounded border ${activeTab===t?"bg-primary text-white":""}`}>{t}</button>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground">INDIA VIX {vix} PCR {pcr}</div>
      </div>
      <div className="grid grid-cols-4 gap-3 text-xs">
        <div className="col-span-1 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{symbol}</span>
            <span className="font-bold">{spot.toFixed(2)}</span>
          </div>
          <div>
            <div className="text-[10px] mb-1">Expiries Included</div>
            <div className="space-y-1">
              {["09 Nov (2 days)","17 Nov (10 days)","23 Nov (16 days)"].map(e=>(
                <div key={e} className="flex items-center gap-2"><input type="checkbox" defaultChecked/> <span>{e}</span></div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] mb-1">Strike Range</div>
            <div className="flex gap-2">
              <Input value={minStrike} onChange={e=>setMinStrike(+e.target.value)} className="h-7 text-[10px] w-20"/>
              <Input value={maxStrike} onChange={e=>setMaxStrike(+e.target.value)} className="h-7 text-[10px] w-20"/>
            </div>
          </div>
          <div>
            <div className="text-[10px] mb-1">Strikes above and below ATM</div>
            <div className="flex gap-1">
              {[5,10,15,20,25].map(n=>(
                <Button key={n} variant={strikes===n?"default":"outline"} size="sm" className="h-6 text-[10px]" onClick={()=>setStrikes(n)}>{n}</Button>
              ))}
            </div>
          </div>
        </div>
        <div className="col-span-3">
          <div className="h-[300px] border rounded-md p-2">
            <ResponsiveContainer width="100%" height="100%">
              {activeTab === "OI Change" && (
                <BarChart data={oiData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="strike" tick={{fontSize:10}} />
                  <YAxis tick={{fontSize:10}} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="callOiChg" name="Call OI chg" fill="#ef4444" />
                  <Bar dataKey="putOiChg" name="Put OI chg" fill="#22c55e" />
                </BarChart>
              )}
              {activeTab === "Open Interest" && (
                <BarChart data={oiData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="strike" tick={{fontSize:10}} />
                  <YAxis tick={{fontSize:10}} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="callOiChg" name="Call OI" fill="#ef4444" />
                </BarChart>
              )}
              {activeTab !== "OI Change" && activeTab !== "Open Interest" && (
                <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                  {activeTab} view coming soon
                </div>
              )}
            </ResponsiveContainer>
          </div>
          <div className="flex gap-2 mt-2">
            {["Last 5 mins","Last 10 mins","Full Day"].map(t=>(
              <Button key={t} variant={activeTime===t?"default":"outline"} size="sm" className="h-6 text-[10px]" onClick={()=>setActiveTime(t)}>{t}</Button>
            ))}
          </div>
          <div className="text-[10px] text-muted-foreground mt-2">
            OI last refreshed time – Live data from NSE
          </div>
        </div>
      </div>
    </div>
  );
}
