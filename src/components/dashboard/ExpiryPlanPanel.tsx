"use client";

import { useMemo, useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Target, TrendingUp, TrendingDown, AlertTriangle, Clock,
  Shield, BarChart3, Zap, ArrowUp, ArrowDown, Info,
  Activity, Brain,
} from "lucide-react";

interface ExpiryPlanPanelProps {
  symbol: string;
  spotPrice: number;
  summary?: any;
  chainData?: any[];
  expiries?: any[];
  selectedExpiry?: string;
}

function fmt(n: number | undefined | null, d = 2): string {
  if (n === undefined || n === null || isNaN(n)) return "—";
  return n.toFixed(d);
}

function fmtInt(n: number | undefined | null): string {
  if (!n || isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-IN");
}

function fmtCr(n: number | undefined | null): string {
  if (!n || isNaN(n)) return "₹0";
  const v = n / 10000000;
  const sign = v >= 0 ? "+" : "";
  return `${sign}₹${v.toFixed(2)}Cr`;
}

function fmtOI(n: number): string {
  if (!n) return "0";
  if (n >= 100000) return (n / 100000).toFixed(1) + "L";
  if (n >= 1000) return (n / 1000).toFixed(0) + "K";
  return n.toString();
}

export default function ExpiryPlanPanel({
  symbol, spotPrice, summary, chainData, expiries, selectedExpiry,
}: ExpiryPlanPanelProps) {
  const [fii, setFii] = useState<any>(null);
  const [accel, setAccel] = useState<any>(null);
  const [instData, setInstData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/fii-dii").then(r => r.json()).catch(() => null),
      fetch("/api/greek-flow").then(r => r.json()).catch(() => null),
      fetch("/api/institutional-positioning").then(r => r.json()).catch(() => null),
    ]).then(([fiiData, accelData, inst]) => {
      setFii(fiiData);
      setAccel(accelData?.result || accelData);
      setInstData(inst?.success ? inst : null);
      setLoading(false);
    });
  }, [symbol]);

  // Derive OI walls from chainData
  const oiWalls = useMemo(() => {
    if (!chainData?.length) return { calls: [], puts: [] };
    const calls = chainData
      .map((r: any) => ({ strike: r.strike, oi: r.ce?.oi || 0, oiChg: r.ce?.oiChg || 0, ltp: r.ce?.ltp || 0, vol: r.ce?.volume || 0 }))
      .filter((r: any) => r.oi > 40000)
      .sort((a: any, b: any) => b.oi - a.oi)
      .slice(0, 6);
    const puts = chainData
      .map((r: any) => ({ strike: r.strike, oi: r.pe?.oi || 0, oiChg: r.pe?.oiChg || 0, ltp: r.pe?.ltp || 0, vol: r.pe?.volume || 0 }))
      .filter((r: any) => r.oi > 40000)
      .sort((a: any, b: any) => b.oi - a.oi)
      .slice(0, 6);
    return { calls, puts };
  }, [chainData]);

  const spot = spotPrice || summary?.spotPrice || 0;
  const atm = summary?.atmStrike || 0;
  const vix = summary?.indiaVIX;
  const pcr = summary?.pcr || 1;
  const maxPain = summary?.maxPain || 0;
  const ceOI = summary?.totalCallOI || 0;
  const peOI = summary?.totalPutOI || 0;
  const ceOIChg = summary?.callOiChange || 0;
  const peOIChg = summary?.putOiChange || 0;

  // Theoretical range
  const sigmaPct = vix ? (vix / Math.sqrt(252)) / 100 : 0.008;
  const oneSigma = spot * sigmaPct;
  const regime = accel?.regime || "—";
  const expMove = accel?.expectedMove || 0;

  // Find nearest expiry
  const now = new Date();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const expiryDate = selectedExpiry
    ? new Date(selectedExpiry)
    : expiries?.length
    ? new Date(expiries[0].date)
    : new Date(now.getTime() + (7 - now.getDay()) * 86400000);
  const daysToExpiry = Math.max(0, Math.ceil((expiryDate.getTime() - now.getTime()) / 86400000));

  // FII/DII
  const fiiNet = fii?.fiiNet || 0;
  const diiNet = fii?.diiNet || 0;
  const fiiBuy = fii?.fiiBuy || 0;
  const fiiSell = fii?.fiiSell || 0;
  const history = fii?.history || [];
  const fii7d = history.slice(0, 7).reduce((s: number, h: any) => s + (h.fiiNet || 0), 0);
  const dii7d = history.slice(0, 7).reduce((s: number, h: any) => s + (h.diiNet || 0), 0);
  const fii30d = history.reduce((s: number, h: any) => s + (h.fiiNet || 0), 0);
  const dii30d = history.reduce((s: number, h: any) => s + (h.diiNet || 0), 0);

  // Institutional positioning (NSE Participant-wise OI)
  const instScores = instData?.strengthScores || [];
  const fiiScore = instScores.find((s: any) => s.participant === 'FII');
  const proScore = instScores.find((s: any) => s.participant === 'Pro');
  const clientScore = instScores.find((s: any) => s.participant === 'Client');
  const instBias = instData?.bias?.dominantDirection || 'neutral';
  const instTrap = instData?.retailTrap?.detected || false;
  const instTrapType = instData?.retailTrap?.type || null;
  const instAlign = instData?.alignment?.overall ?? null;
  const instFilter = instData?.institutionalFilter?.verdict || 'proceed';
  const instPrediction = instData?.prediction?.tomorrowBias || 'neutral';
  const instPredictionConf = instData?.prediction?.confidence || 0;
  const instConfidence = instData?.confidence?.overall || 0;

  // Accel top picks
  const topCalls = accel?.topCalls?.slice(0, 4) || [];
  const topPuts = accel?.topPuts?.slice(0, 4) || [];

  const isExpiryToday = daysToExpiry <= 0;
  const isWeeklyExpiry = daysToExpiry <= 1;

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3 bg-[#0a0e14]">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-amber-400" />
          <span className="font-bold text-sm text-[#dfe6ee]">{symbol} Expiry Plan</span>
          {isExpiryToday && (
            <Badge className="text-[9px] bg-red-600 text-white">EXPIRY TODAY</Badge>
          )}
          {isWeeklyExpiry && !isExpiryToday && (
            <Badge className="text-[9px] bg-amber-600 text-white">TOMORROW</Badge>
          )}
        </div>
        <Badge variant="outline" className="text-[9px] font-mono">
          {dayNames[expiryDate.getDay()]} {expiryDate.getDate()} {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][expiryDate.getMonth()]} · {daysToExpiry}d away
        </Badge>
        {instData && (
          <Badge variant="outline" className={`text-[8px] ${instPrediction === 'bullish' ? 'text-emerald-400 border-emerald-500/30' : instPrediction === 'bearish' ? 'text-red-400 border-red-500/30' : 'text-zinc-400 border-zinc-600/30'}`}>
            {instPrediction.toUpperCase()} · {instPredictionConf}%
          </Badge>
        )}
      </div>

      {/* ─── Key Metrics ─── */}
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
        {[
          { label: "Spot", value: fmtInt(spot), color: "text-[#dfe6ee]" },
          { label: "ATM", value: fmtInt(atm), color: "text-amber-400" },
          { label: "VIX", value: fmt(vix), color: vix && vix > 20 ? "text-red-400" : "text-emerald-400" },
          { label: "PCR", value: fmt(pcr), color: pcr > 1.2 ? "text-emerald-400" : pcr < 0.7 ? "text-red-400" : "text-[#dfe6ee]" },
          { label: "MaxPain", value: fmtInt(maxPain), color: "text-orange-400" },
          { label: "Expected", value: `₹${fmtInt(expMove)}`, color: "text-cyan-400" },
          { label: "Regime", value: regime, color: "text-violet-400" },
          { label: "Futures", value: fmtInt(summary?.futuresPrice), color: "text-zinc-400" },
        ].map(m => (
          <Card key={m.label} className="bg-[#10151d] border-[#1f2733]">
            <CardContent className="p-2">
              <div className="text-[9px] text-[#7d8ba0] uppercase tracking-wide">{m.label}</div>
              <div className={`text-[13px] font-bold tabular-nums ${m.color}`}>{m.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ─── OI Walls & Range ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Resistance (Call Walls) */}
        <Card className="bg-[#10151d] border-[#1f2733] col-span-1">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <ArrowUp className="h-3 w-3 text-red-400" />
              <span className="text-[10px] font-bold text-red-400 uppercase tracking-wide">Resistance · Call Walls</span>
            </div>
            <div className="space-y-1">
              {oiWalls.calls.map((w: any) => (
                <div key={w.strike} className="flex items-center justify-between text-[11px] font-mono py-0.5 px-1.5 rounded bg-red-500/5 border border-red-500/10">
                  <span className="font-bold text-[#dfe6ee]">{fmtInt(w.strike)}</span>
                  <div className="flex items-center gap-2 text-[9px]">
                    <span className="text-[#7d8ba0]">OI {fmtOI(w.oi)}</span>
                    <span className={w.oiChg > 0 ? "text-red-400" : "text-emerald-400"}>
                      {w.oiChg > 0 ? "+" : ""}{fmtOI(w.oiChg)}
                    </span>
                    <span className="text-amber-400">₹{fmt(w.ltp)}</span>
                  </div>
                </div>
              ))}
              {!oiWalls.calls.length && <div className="text-[10px] text-[#7d8ba0] italic">No significant call walls</div>}
            </div>
            <div className="mt-2 text-[9px] text-[#7d8ba0]">
              Call writers added {fmtOI(ceOIChg)} OI — {ceOIChg > 0 ? "defending levels" : "covering"}
            </div>
          </CardContent>
        </Card>

        {/* Support (Put Walls) */}
        <Card className="bg-[#10151d] border-[#1f2733] col-span-1">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <ArrowDown className="h-3 w-3 text-emerald-400" />
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wide">Support · Put Walls</span>
            </div>
            <div className="space-y-1">
              {oiWalls.puts.map((w: any) => (
                <div key={w.strike} className="flex items-center justify-between text-[11px] font-mono py-0.5 px-1.5 rounded bg-emerald-500/5 border border-emerald-500/10">
                  <span className="font-bold text-[#dfe6ee]">{fmtInt(w.strike)}</span>
                  <div className="flex items-center gap-2 text-[9px]">
                    <span className="text-[#7d8ba0]">OI {fmtOI(w.oi)}</span>
                    <span className={w.oiChg > 0 ? "text-emerald-400" : "text-red-400"}>
                      {w.oiChg > 0 ? "+" : ""}{fmtOI(w.oiChg)}
                    </span>
                    <span className="text-amber-400">₹{fmt(w.ltp)}</span>
                  </div>
                </div>
              ))}
              {!oiWalls.puts.length && <div className="text-[10px] text-[#7d8ba0] italic">No significant put walls</div>}
            </div>
            <div className="mt-2 text-[9px] text-[#7d8ba0]">
              Put writers changed {fmtOI(peOIChg)} OI — {peOIChg > 0 ? "building support" : "covering"}
            </div>
          </CardContent>
        </Card>

        {/* Expected Range */}
        <Card className="bg-[#10151d] border-[#1f2733] col-span-1">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Activity className="h-3 w-3 text-cyan-400" />
              <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wide">Expected Range {daysToExpiry}d</span>
            </div>
            <div className="space-y-2">
              <div className="bg-cyan-500/5 border border-cyan-500/10 rounded p-2">
                <div className="text-[9px] text-[#7d8ba0]">1σ Range (68%)</div>
                <div className="text-[13px] font-bold text-cyan-300 font-mono">
                  {fmtInt(spot - oneSigma)} — {fmtInt(spot + oneSigma)}
                </div>
                <div className="text-[9px] text-[#7d8ba0]">±{fmtInt(oneSigma)}pt</div>
              </div>
              <div className="bg-violet-500/5 border border-violet-500/10 rounded p-2">
                <div className="text-[9px] text-[#7d8ba0]">2σ Range (95%)</div>
                <div className="text-[13px] font-bold text-violet-300 font-mono">
                  {fmtInt(spot - 2 * oneSigma)} — {fmtInt(spot + 2 * oneSigma)}
                </div>
                <div className="text-[9px] text-[#7d8ba0]">±{fmtInt(2 * oneSigma)}pt</div>
              </div>
            </div>
            {maxPain > 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px]">
                <Info className="h-2.5 w-2.5 text-orange-400" />
                <span className="text-[#7d8ba0]">MaxPain</span>
                <span className="font-bold text-orange-400">{fmtInt(maxPain)}</span>
                <span className="text-[#7d8ba0]">({spot > maxPain ? `${fmtInt(spot - maxPain)}pt above` : `${fmtInt(maxPain - spot)}pt below`})</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── OI Battle ─── */}
      <Card className="bg-[#10151d] border-[#1f2733]">
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield className="h-3 w-3 text-amber-400" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-[#dfe6ee]">CE/PE OI Battle</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <div className="text-[9px] text-[#7d8ba0]">CE OI</div>
              <div className="text-[13px] font-bold text-red-400 font-mono">{fmtOI(ceOI)}</div>
              <div className="text-[9px] font-mono">
                <span className={ceOIChg > 0 ? "text-red-400" : "text-emerald-400"}>
                  {ceOIChg > 0 ? "+" : ""}{fmtOI(ceOIChg)}
                </span>
                <span className="text-[#7d8ba0] ml-1">chg</span>
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">PE OI</div>
              <div className="text-[13px] font-bold text-emerald-400 font-mono">{fmtOI(peOI)}</div>
              <div className="text-[9px] font-mono">
                <span className={peOIChg > 0 ? "text-emerald-400" : "text-red-400"}>
                  {peOIChg > 0 ? "+" : ""}{fmtOI(peOIChg)}
                </span>
                <span className="text-[#7d8ba0] ml-1">chg</span>
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">PCR OI</div>
              <div className={`text-[13px] font-bold font-mono ${pcr > 1.2 ? "text-emerald-400" : pcr < 0.7 ? "text-red-400" : "text-[#dfe6ee]"}`}>{fmt(pcr)}</div>
              <div className="text-[9px] text-[#7d8ba0]">
                {pcr > 1.2 ? "BULLISH (put support strong)" : pcr < 0.7 ? "BEARISH (call pressure)" : "NEUTRAL"}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">Bias</div>
              <div className={`text-[13px] font-bold ${ceOIChg > peOIChg ? "text-red-400" : "text-emerald-400"}`}>
                {ceOIChg > peOIChg ? "BEARISH" : "BULLISH"}
              </div>
              <div className="text-[9px] text-[#7d8ba0]">
                {ceOIChg > peOIChg ? "Call writers dominating" : "Put writers dominating"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Institutional Flow (Cash FII/DII + NSE Participant OI) ─── */}
      <Card className="bg-[#10151d] border-[#1f2733]">
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Brain className="h-3 w-3 text-purple-400" />
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wide">Institutional Flow</span>
            {instFilter !== 'proceed' && (
              <Badge className={`text-[8px] ${instFilter === 'reject' ? 'bg-red-600' : 'bg-amber-600'}`}>
                {instFilter.toUpperCase()}
              </Badge>
            )}
          </div>

          {/* Row 1: Cash market FII/DII */}
          <div className="text-[9px] text-[#7d8ba0] mb-1 uppercase tracking-wide">Cash Market</div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
            <div>
              <div className="text-[9px] text-[#7d8ba0]">FII Today</div>
              <div className={`text-[12px] font-bold font-mono ${fiiNet < 0 ? "text-red-400" : "text-emerald-400"}`}>
                {fmtCr(fiiNet)}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">DII Today</div>
              <div className={`text-[12px] font-bold font-mono ${diiNet > 0 ? "text-emerald-400" : "text-red-400"}`}>
                {fmtCr(diiNet)}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">FII 7d</div>
              <div className={`text-[12px] font-bold font-mono ${fii7d < 0 ? "text-red-400" : "text-emerald-400"}`}>{fmtCr(fii7d)}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">FII 30d</div>
              <div className={`text-[12px] font-bold font-mono ${fii30d < 0 ? "text-red-400" : "text-emerald-400"}`}>{fmtCr(fii30d)}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">Net Bias</div>
              <div className={`text-[12px] font-bold font-mono ${fii30d < -500 ? "text-red-400" : fii30d > 500 ? "text-emerald-400" : "text-zinc-400"}`}>
                {fii30d < -500 ? "BEARISH" : fii30d > 500 ? "BULLISH" : "NEUTRAL"}
              </div>
              <div className="text-[8px] text-[#7d8ba0]">FII {fii30d < 0 ? "selling" : "buying"}</div>
            </div>
          </div>

          {/* Row 2: NSE Participant-wise OI */}
          <div className="text-[9px] text-[#7d8ba0] mb-1 uppercase tracking-wide border-t border-[#1f2733] pt-2">NSE Participant OI</div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div>
              <div className="text-[9px] text-[#7d8ba0]">FII</div>
              <div className={`text-[12px] font-bold font-mono ${fiiScore?.direction === 'bullish' ? 'text-emerald-400' : fiiScore?.direction === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
                {fiiScore?.direction || 'neutral'} ({fiiScore?.score || 50})
              </div>
              <div className="text-[8px] text-[#7d8ba0]">{fiiScore?.conviction || 'low'} conviction</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">Pro</div>
              <div className={`text-[12px] font-bold font-mono ${proScore?.direction === 'bullish' ? 'text-emerald-400' : proScore?.direction === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
                {proScore?.direction || 'neutral'} ({proScore?.score || 50})
              </div>
              <div className="text-[8px] text-[#7d8ba0]">{proScore?.conviction || 'low'} conviction</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">Client</div>
              <div className={`text-[12px] font-bold font-mono ${clientScore?.direction === 'bullish' ? 'text-emerald-400' : clientScore?.direction === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
                {clientScore?.direction || 'neutral'} ({clientScore?.score || 50})
              </div>
              <div className="text-[8px] text-[#7d8ba0]">{clientScore?.conviction || 'low'} conviction</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">Smart Money</div>
              <div className={`text-[12px] font-bold font-mono ${instBias === 'bullish' ? 'text-emerald-400' : instBias === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
                {instBias.toUpperCase()}
              </div>
              <div className="text-[8px] text-[#7d8ba0]">
                {instTrap ? <span className="text-red-400">⚠ {instTrapType}_trap</span> : 'no trap'}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[#7d8ba0]">Verdict</div>
              <div className={`text-[12px] font-bold font-mono ${instFilter === 'proceed' ? 'text-emerald-400' : instFilter === 'caution' ? 'text-amber-400' : 'text-red-400'}`}>
                {instFilter?.toUpperCase() || '—'}
              </div>
              <div className="text-[8px] text-[#7d8ba0]">
                {instAlign != null ? `align ${instAlign}%` : ''}
                {instConfidence > 0 && ` · AI ${instConfidence}%`}
              </div>
            </div>
          </div>

          {/* Retail trap warning banner */}
          {instTrap && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
              <AlertTriangle className="h-3 w-3 text-red-400 shrink-0" />
              <span className="text-red-300 font-bold">Retail {instTrapType === 'bull_trap' ? 'Bull' : 'Bear'} Trap Detected</span>
              <span className="text-[#7d8ba0]">— {instTrapType === 'bull_trap' ? 'retail long, FII short' : 'retail short, FII long'} — trade with caution</span>
            </div>
          )}

          {/* Prediction bar */}
          <div className="mt-2 text-[9px] text-[#7d8ba0] flex items-center gap-1.5">
            <Activity className="h-2.5 w-2.5" />
            Prediction: <span className={`font-bold ${instPrediction === 'bullish' ? 'text-emerald-400' : instPrediction === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>
              {instPrediction.toUpperCase()}
            </span> ({instPredictionConf}% conf)
          </div>
        </CardContent>
      </Card>

      {/* ─── Accel Engine Picks ─── */}
      {topCalls.length > 0 && topPuts.length > 0 && (
        <Card className="bg-[#10151d] border-[#1f2733]">
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Zap className="h-3 w-3 text-amber-400" />
              <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wide">Acceleration Engine Picks</span>
              <Badge variant="outline" className="text-[8px] ml-auto">{regime} · {expMove}pt exp</Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-[9px] text-red-400 mb-1">Top Calls</div>
                {topCalls.map((c: any) => (
                  <div key={c.strike} className="flex items-center justify-between text-[10px] font-mono py-0.5 px-1.5 rounded bg-red-500/5 border border-red-500/10 mb-0.5">
                    <span className="font-bold text-[#dfe6ee]">{fmtInt(c.strike)}</span>
                    <span className="text-[#7d8ba0]">₹{fmt(c.ltp)}</span>
                    <span className="text-amber-400">→ ₹{fmt(c.tp1)}</span>
                    <span className={c.signal === "BUY" ? "text-emerald-400" : c.signal === "WATCH" ? "text-amber-400" : "text-[#7d8ba0]"}>
                      {c.signal || "—"}
                    </span>
                  </div>
                ))}
              </div>
              <div>
                <div className="text-[9px] text-emerald-400 mb-1">Top Puts</div>
                {topPuts.map((p: any) => (
                  <div key={p.strike} className="flex items-center justify-between text-[10px] font-mono py-0.5 px-1.5 rounded bg-emerald-500/5 border border-emerald-500/10 mb-0.5">
                    <span className="font-bold text-[#dfe6ee]">{fmtInt(p.strike)}</span>
                    <span className="text-[#7d8ba0]">₹{fmt(p.ltp)}</span>
                    <span className="text-amber-400">→ ₹{fmt(p.tp1)}</span>
                    <span className={p.signal === "BUY" ? "text-emerald-400" : p.signal === "WATCH" ? "text-amber-400" : "text-[#7d8ba0]"}>
                      {p.signal || "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Expiry Plan Strategy ─── */}
      <Card className="bg-[#10151d] border-amber-500/20">
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Target className="h-3 w-3 text-amber-400" />
            <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wide">Expiry Strategy · {dayNames[expiryDate.getDay()]} {expiryDate.getDate()}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px]">
            <div className="bg-amber-500/5 border border-amber-500/10 rounded p-2">
              <div className="font-bold text-[#dfe6ee] mb-1">📍 Key Levels</div>
              {maxPain > 0 && <div className="text-[#7d8ba0]">MaxPain <span className="text-orange-400 font-bold">{fmtInt(maxPain)}</span> — {spot > maxPain ? `${fmtInt(spot - maxPain)}pt BELOW spot, writers want to pull down` : `${fmtInt(maxPain - spot)}pt ABOVE spot, writers want to push up`}</div>}
              {oiWalls.calls[0] && <div className="text-[#7d8ba0]">Resistance <span className="text-red-400 font-bold">{fmtInt(oiWalls.calls[0].strike)}</span> — biggest call wall, {fmtInt(oiWalls.calls[0].strike - spot)}pt from spot</div>}
              {oiWalls.puts[0] && <div className="text-[#7d8ba0]">Support <span className="text-emerald-400 font-bold">{fmtInt(oiWalls.puts[0].strike)}</span> — biggest put wall, {fmtInt(spot - oiWalls.puts[0].strike)}pt from spot</div>}
            </div>
            <div className="bg-amber-500/5 border border-amber-500/10 rounded p-2">
              <div className="font-bold text-[#dfe6ee] mb-1">🎯 Plan</div>
              {isExpiryToday && <div className="text-red-400 font-bold">⚠️ EXPIRY DAY — Close by 2:30 PM</div>}
              <div className="text-[#7d8ba0]">🕐 Morning (9:30-10:00): Wait for OI build, don't chase first move</div>
              <div className="text-[#7d8ba0]">📊 Expected range: {fmtInt(spot - oneSigma)}–{fmtInt(spot + oneSigma)} (1σ), bias {spot > maxPain ? "bearish below MaxPain" : "bullish above MaxPain"}</div>
              <div className="text-[#7d8ba0]">👁 Watch {oiWalls.calls[0] ? fmtInt(oiWalls.calls[0].strike) : ""} break (if call wall breaks → short squeeze) / {oiWalls.puts[0] ? fmtInt(oiWalls.puts[0].strike) : ""} break (if put wall breaks → sell-off)</div>
              <div className="text-[#7d8ba0]">💰 FII {fii30d < 0 ? `selling ₹${fmtInt(Math.abs(fii30d))}Cr (bearish)` : `buying ₹${fmtInt(fii30d)}Cr (bullish)`} — trade opposite of FII intraday</div>
              {instData && (
                <div className="text-[#7d8ba0]">🏛 NSE Participants: FII {fiiScore?.direction}({fiiScore?.score}) · Pro {proScore?.direction}({proScore?.score}) · Client {clientScore?.direction}({clientScore?.score}) — {instBias} bias{instAlign != null ? `, alignment ${instAlign}%` : ''} · AI confidence {instConfidence}%</div>
              )}
              {instFilter === 'reject' && <div className="text-red-400 font-bold">🛑 INSTITUTIONAL FILTER REJECTED — avoid directional trades</div>}
              {instFilter === 'caution' && <div className="text-amber-400">⚠️ Institutional filter CAUTION — prefer defined-risk strategies</div>}
            </div>
            <div className="bg-amber-500/5 border border-amber-500/10 rounded p-2">
              <div className="font-bold text-[#dfe6ee] mb-1">⚠️ Risk Management</div>
              <div className="text-[#7d8ba0]">🔴 Do NOT hold overnight into expiry — theta kills</div>
              <div className="text-[#7d8ba0]">🚫 No trades after 2:30 PM (final hour chaos)</div>
              <div className="text-[#7d8ba0]">📉 Straddle/strangle sellers have the edge — premium decays fast</div>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/10 rounded p-2">
              <div className="font-bold text-[#dfe6ee] mb-1">📈 Triggers</div>
              {spot > maxPain && <div className="text-[#7d8ba0]">🔻 Short below {fmtInt(maxPain)} (MaxPain breakdown = 200pt+ move)</div>}
              {spot > maxPain && <div className="text-[#7d8ba0]">🟢 Hold above {fmtInt(atm)} (ATM hold = bullish momentum)</div>}
              <div className="text-[#7d8ba0]">⚡ Acceleration engine in <span className="text-violet-400 font-bold">{regime}</span> regime — {regime === "Reversal" ? "expect mean reversion" : regime === "Breakout" ? "expect trend continuation" : regime === "Range" ? "expect range bound" : "manage risk"}</div>
              {instData && (
                <div className="text-[#7d8ba0]">🏛 Institutional prediction <span className={`font-bold ${instPrediction === 'bullish' ? 'text-emerald-400' : instPrediction === 'bearish' ? 'text-red-400' : 'text-zinc-400'}`}>{instPrediction.toUpperCase()}</span> ({instPredictionConf}% conf) — {instPrediction === 'range' ? 'range-bound expected, trade spreads' : instPrediction === 'bullish' ? 'align with institutional bias' : 'align with institutional bias'}</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Loading overlay */}
      {loading && (
        <div className="flex items-center justify-center py-4">
          <div className="text-[10px] text-[#7d8ba0] animate-pulse">Loading data...</div>
        </div>
      )}
    </div>
  );
}
