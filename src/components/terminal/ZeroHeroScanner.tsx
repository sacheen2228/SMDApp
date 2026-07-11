"use client";

import { useState, useEffect, useCallback } from "react";
import { Flame, Star, RefreshCw, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ZeroHeroCandidate {
  rank: number;
  strike: number;
  type: "CE" | "PE";
  premium: number;
  probability: number;
  rr: number;
  confidence: number;
  stars: number;
  delta: number;
  iv: number;
  oiChange: number;
  volume: number;
}

function computeStars(confidence: number): number {
  if (confidence >= 80) return 5;
  if (confidence >= 65) return 4;
  if (confidence >= 50) return 3;
  if (confidence >= 35) return 2;
  return 1;
}

function StarRating({ count }: { count: number }) {
  return (
    <span className="inline-flex gap-px">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`size-2.5 ${
            i < count ? "text-amber-400 fill-amber-400" : "text-zinc-700"
          }`}
        />
      ))}
    </span>
  );
}

export function ZeroHeroScanner() {
  const [candidates, setCandidates] = useState<ZeroHeroCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/option-chain?symbol=NIFTY");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      if (!json.success) throw new Error("No data");

      const strikes = json.data?.data || [];
      const spot = json.data?.summary?.spotPrice || json.data?.spotPrice || 0;
      if (!spot || strikes.length === 0) throw new Error("Incomplete data");

      const threshold = spot * 0.02; // 2% of spot
      const nearStrikes = strikes.filter(
        (s: any) => Math.abs(s.strike - spot) <= threshold
      );

      const candidatesList: ZeroHeroCandidate[] = [];
      let rank = 1;

      for (const s of nearStrikes) {
        // Call candidate
        if (s.ce && s.ce.ltp > 0) {
          const absOIChg = Math.abs(s.ce.oiChg || 0);
          const absDelta = Math.abs(s.ce.delta || 0);
          const ivScore = Math.min(100, (s.ce.iv || 15) * 3);
          const oiScore = Math.min(100, (absOIChg / 50000) * 100);
          const deltaScore = absDelta * 100;
          const volScore = Math.min(100, ((s.ce.volume || 0) / 100000) * 100);
          const gammaScore = Math.min(100, ((s.ce.gamma || 0) * 1000) * 100);

          const confidence = Math.round(
            oiScore * 0.25 +
            deltaScore * 0.2 +
            ivScore * 0.2 +
            volScore * 0.15 +
            gammaScore * 0.1 +
            (absOIChg > 20000 ? 10 : 0)
          );

          const sl = s.ce.ltp * 0.65;
          const tp = s.ce.ltp * 1.5;
          const rr = sl > 0 ? (tp - s.ce.ltp) / (s.ce.ltp - sl) : 0;
          const probability = Math.min(95, Math.round(confidence * 0.85 + absDelta * 10));

          candidatesList.push({
            rank: 0,
            strike: s.strike,
            type: "CE",
            premium: s.ce.ltp,
            probability,
            rr: Math.round(rr * 10) / 10,
            confidence,
            stars: computeStars(confidence),
            delta: s.ce.delta || 0,
            iv: s.ce.iv || 0,
            oiChange: s.ce.oiChg || 0,
            volume: s.ce.volume || 0,
          });
        }

        // Put candidate
        if (s.pe && s.pe.ltp > 0) {
          const absOIChg = Math.abs(s.pe.oiChg || 0);
          const absDelta = Math.abs(s.pe.delta || 0);
          const ivScore = Math.min(100, (s.pe.iv || 15) * 3);
          const oiScore = Math.min(100, (absOIChg / 50000) * 100);
          const deltaScore = absDelta * 100;
          const volScore = Math.min(100, ((s.pe.volume || 0) / 100000) * 100);
          const gammaScore = Math.min(100, ((s.pe.gamma || 0) * 1000) * 100);

          const confidence = Math.round(
            oiScore * 0.25 +
            deltaScore * 0.2 +
            ivScore * 0.2 +
            volScore * 0.15 +
            gammaScore * 0.1 +
            (absOIChg > 20000 ? 10 : 0)
          );

          const sl = s.pe.ltp * 0.65;
          const tp = s.pe.ltp * 1.5;
          const rr = sl > 0 ? (tp - s.pe.ltp) / (s.pe.ltp - sl) : 0;
          const probability = Math.min(95, Math.round(confidence * 0.85 + absDelta * 10));

          candidatesList.push({
            rank: 0,
            strike: s.strike,
            type: "PE",
            premium: s.pe.ltp,
            probability,
            rr: Math.round(rr * 10) / 10,
            confidence,
            stars: computeStars(confidence),
            delta: s.pe.delta || 0,
            iv: s.pe.iv || 0,
            oiChange: s.pe.oiChg || 0,
            volume: s.pe.volume || 0,
          });
        }
      }

      // Sort by confidence desc, assign ranks, take top 10
      candidatesList.sort((a, b) => b.confidence - a.confidence);
      const top10 = candidatesList.slice(0, 10).map((c, i) => ({ ...c, rank: i + 1 }));

      setCandidates(top10);
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
            <Flame className="size-3.5 text-orange-400" />
            Zero Hero Scanner
          </CardTitle>
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
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="p-3 space-y-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-8 bg-white/5 animate-pulse rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            Data unavailable
          </div>
        ) : candidates.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-xs">
            No zero-hero candidates found
          </div>
        ) : (
          <ScrollArea className="h-full">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5">#</TableHead>
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5">Strike</TableHead>
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5">Type</TableHead>
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5 text-right">LTP</TableHead>
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5 text-right">Prob%</TableHead>
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5 text-right">R:R</TableHead>
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5 text-right">Conf</TableHead>
                  <TableHead className="text-[9px] text-zinc-500 h-6 px-1.5">Stars</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={`${c.strike}-${c.type}-${c.rank}`} className="border-white/5">
                    <TableCell className="px-1.5 py-1 text-[10px] font-mono tabular-nums text-zinc-400">
                      {c.rank}
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-[10px] font-mono tabular-nums text-zinc-200 font-semibold">
                      {c.strike.toLocaleString("en-IN")}
                    </TableCell>
                    <TableCell className="px-1.5 py-1">
                      <Badge
                        variant="outline"
                        className={`text-[8px] px-1 py-0 h-3 font-mono ${
                          c.type === "CE"
                            ? "text-emerald-400 border-emerald-500/30"
                            : "text-red-400 border-red-500/30"
                        }`}
                      >
                        {c.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-[10px] font-mono tabular-nums text-zinc-300 text-right">
                      ₹{c.premium.toFixed(2)}
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-[10px] font-mono tabular-nums text-right">
                      <span className={c.probability >= 60 ? "text-emerald-400" : c.probability >= 40 ? "text-amber-400" : "text-zinc-400"}>
                        {c.probability}%
                      </span>
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-[10px] font-mono tabular-nums text-right">
                      <span className={c.rr >= 2 ? "text-emerald-400" : c.rr >= 1 ? "text-amber-400" : "text-red-400"}>
                        {c.rr.toFixed(1)}
                      </span>
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-[10px] font-mono tabular-nums text-right">
                      <span className={c.confidence >= 60 ? "text-emerald-400" : c.confidence >= 40 ? "text-amber-400" : "text-zinc-400"}>
                        {c.confidence}
                      </span>
                    </TableCell>
                    <TableCell className="px-1.5 py-1">
                      <StarRating count={c.stars} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
