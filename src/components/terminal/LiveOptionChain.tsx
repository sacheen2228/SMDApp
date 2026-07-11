"use client";

import { useState, useEffect, useCallback } from "react";
import { Table2, RefreshCw, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ChainStrike {
  strike: number;
  ce: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    delta: number;
    ltp: number;
  } | null;
  pe: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    delta: number;
    ltp: number;
  } | null;
}

function formatIST(date: Date): string {
  return date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

export function LiveOptionChain() {
  const [strikes, setStrikes] = useState<ChainStrike[]>([]);
  const [atmStrike, setAtmStrike] = useState(0);
  const [spot, setSpot] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("--:--:--");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/option-chain?symbol=NIFTY");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error("No data");

      const allStrikes = json.data?.data || [];
      const spotPrice = json.data?.summary?.spotPrice || json.data?.spotPrice || 0;

      // Find ATM
      let closest = allStrikes[0];
      let minDiff = Infinity;
      for (const s of allStrikes) {
        const diff = Math.abs(s.strike - spotPrice);
        if (diff < minDiff) {
          minDiff = diff;
          closest = s;
        }
      }
      const atm = closest?.strike || 0;

      // Sort all, take 21 centered on ATM
      const sorted = [...allStrikes].sort((a: any, b: any) => a.strike - b.strike);
      const atmIdx = sorted.findIndex((s: any) => s.strike === atm);
      const start = Math.max(0, atmIdx - 10);
      const end = Math.min(sorted.length, start + 21);
      const nearby = sorted.slice(start, end);

      setStrikes(nearby);
      setAtmStrike(atm);
      setSpot(spotPrice);
      setLastUpdate(formatIST(new Date()));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <Card className="bg-[#0d1117] border-white/5 h-full flex flex-col overflow-hidden">
      <CardHeader className="py-2 px-3 border-b border-white/5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <Table2 className="size-3.5 text-blue-400" />
            Live Option Chain
            {spot > 0 && (
              <span className="text-[10px] font-mono tabular-nums text-zinc-500 ml-1">
                NIFTY {spot.toLocaleString("en-IN")}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-zinc-600 font-mono flex items-center gap-1">
              <Clock className="size-2.5" />
              {lastUpdate}
            </span>
            <button
              onClick={() => {
                setLoading(true);
                fetchData();
              }}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 space-y-1">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-6 bg-white/5 animate-pulse rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">Data unavailable</div>
        ) : strikes.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">No chain data</div>
        ) : (
          <ScrollArea className="h-full">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  {/* CE columns */}
                  <TableHead className="text-[8px] text-emerald-400/60 h-5 px-1 text-right">OI</TableHead>
                  <TableHead className="text-[8px] text-emerald-400/60 h-5 px-1 text-right">OI Chg</TableHead>
                  <TableHead className="text-[8px] text-emerald-400/60 h-5 px-1 text-right">Vol</TableHead>
                  <TableHead className="text-[8px] text-emerald-400/60 h-5 px-1 text-right">IV</TableHead>
                  <TableHead className="text-[8px] text-emerald-400/60 h-5 px-1 text-right">Delta</TableHead>
                  <TableHead className="text-[8px] text-emerald-400/60 h-5 px-1 text-right">LTP</TableHead>
                  {/* Strike */}
                  <TableHead className="text-[8px] text-amber-400 h-5 px-1 text-center w-12">STK</TableHead>
                  {/* PE columns */}
                  <TableHead className="text-[8px] text-red-400/60 h-5 px-1 text-left">LTP</TableHead>
                  <TableHead className="text-[8px] text-red-400/60 h-5 px-1 text-left">Delta</TableHead>
                  <TableHead className="text-[8px] text-red-400/60 h-5 px-1 text-left">IV</TableHead>
                  <TableHead className="text-[8px] text-red-400/60 h-5 px-1 text-left">Vol</TableHead>
                  <TableHead className="text-[8px] text-red-400/60 h-5 px-1 text-left">OI Chg</TableHead>
                  <TableHead className="text-[8px] text-red-400/60 h-5 px-1 text-left">OI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {strikes.map((s) => {
                  const isATM = s.strike === atmStrike;
                  const isCEITM = s.strike <= atmStrike; // CE ITM when strike <= ATM
                  const isPEITM = s.strike >= atmStrike; // PE ITM when strike >= ATM

                  return (
                    <TableRow
                      key={s.strike}
                      className={`border-white/5 text-[9px] font-mono tabular-nums ${
                        isATM
                          ? "bg-amber-500/10 border-y border-amber-500/20"
                          : ""
                      }`}
                    >
                      {/* CE OI */}
                      <TableCell className={`px-1 py-0.5 text-right ${isCEITM ? "text-emerald-300/70" : "text-zinc-500"}`}>
                        {s.ce ? (s.ce.oi >= 1000 ? (s.ce.oi / 1000).toFixed(0) + "K" : s.ce.oi) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-right ${!s.ce ? "text-zinc-700" : s.ce.oiChg > 0 ? "text-emerald-400" : s.ce.oiChg < 0 ? "text-red-400" : "text-zinc-600"}`}>
                        {s.ce ? (s.ce.oiChg > 0 ? "+" : "") + (s.ce.oiChg >= 1000 ? (s.ce.oiChg / 1000).toFixed(0) + "K" : s.ce.oiChg) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-right ${isCEITM ? "text-emerald-300/60" : "text-zinc-500"}`}>
                        {s.ce ? (s.ce.volume >= 1000 ? (s.ce.volume / 1000).toFixed(0) + "K" : s.ce.volume) : "-"}
                      </TableCell>
                      <TableCell className="px-1 py-0.5 text-right text-blue-400/70">
                        {s.ce?.iv ? s.ce.iv.toFixed(1) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-right ${isCEITM ? "text-emerald-400" : "text-zinc-500"}`}>
                        {s.ce?.delta ? s.ce.delta.toFixed(2) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-right font-semibold ${isCEITM ? "text-emerald-300" : "text-zinc-300"}`}>
                        {s.ce ? "₹" + s.ce.ltp.toFixed(2) : "-"}
                      </TableCell>

                      {/* Strike (center) */}
                      <TableCell
                        className={`px-1 py-0.5 text-center font-bold ${
                          isATM ? "text-amber-400" : "text-zinc-300"
                        }`}
                      >
                        {s.strike >= 1000 ? Math.round(s.strike) : s.strike}
                      </TableCell>

                      {/* PE columns */}
                      <TableCell className={`px-1 py-0.5 text-left font-semibold ${isPEITM ? "text-red-300" : "text-zinc-300"}`}>
                        {s.pe ? "₹" + s.pe.ltp.toFixed(2) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-left ${isPEITM ? "text-red-400" : "text-zinc-500"}`}>
                        {s.pe?.delta ? s.pe.delta.toFixed(2) : "-"}
                      </TableCell>
                      <TableCell className="px-1 py-0.5 text-left text-blue-400/70">
                        {s.pe?.iv ? s.pe.iv.toFixed(1) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-left ${isPEITM ? "text-red-300/60" : "text-zinc-500"}`}>
                        {s.pe ? (s.pe.volume >= 1000 ? (s.pe.volume / 1000).toFixed(0) + "K" : s.pe.volume) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-left ${!s.pe ? "text-zinc-700" : s.pe.oiChg > 0 ? "text-emerald-400" : s.pe.oiChg < 0 ? "text-red-400" : "text-zinc-600"}`}>
                        {s.pe ? (s.pe.oiChg > 0 ? "+" : "") + (s.pe.oiChg >= 1000 ? (s.pe.oiChg / 1000).toFixed(0) + "K" : s.pe.oiChg) : "-"}
                      </TableCell>
                      <TableCell className={`px-1 py-0.5 text-left ${isPEITM ? "text-red-300/70" : "text-zinc-500"}`}>
                        {s.pe ? (s.pe.oi >= 1000 ? (s.pe.oi / 1000).toFixed(0) + "K" : s.pe.oi) : "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
