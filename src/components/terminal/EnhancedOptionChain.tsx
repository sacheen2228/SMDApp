"use client";

import { useMemo, useState, useCallback } from "react";
import { TrendingUp, TrendingDown, Zap, Target, ChevronUp, ChevronDown } from "lucide-react";

interface ChainLeg {
  oi: number;
  oiChg: number;
  vol: number;
  iv: number;
  delta: number;
  ltp: number;
  gamma: number;
  theta: number;
  vega: number;
}

interface ChainRow {
  strike: number;
  atm: boolean;
  ce: ChainLeg | null;
  pe: ChainLeg | null;
}

interface Props {
  chain: ChainRow[];
  spot: number;
  atmStrike: number;
  maxPain: number;
  openTrade: (strike: number, type: "CE" | "PE", ltp: number) => void;
}

type SortKey = "oi" | "oiChg" | "vol" | "iv" | "delta" | "gamma" | "theta" | "vega" | "ltp";

function fmt(n: number): string {
  if (n === 0 || isNaN(n)) return "—";
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(2) + "L";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toFixed(n % 1 === 0 ? 0 : 2);
}

function fmtPrice(n: number): string {
  if (n === 0 || isNaN(n)) return "—";
  return n.toFixed(2);
}

function ivColor(iv: number, minIV: number, maxIV: number): string {
  if (maxIV === minIV) return "";
  const t = (iv - minIV) / (maxIV - minIV);
  if (t > 0.75) return "text-red-400";
  if (t > 0.5) return "text-orange-400";
  if (t < 0.25) return "text-emerald-400";
  return "text-yellow-400";
}

function oiChgBar(val: number, maxAbs: number): { width: string; color: string } {
  if (maxAbs === 0 || val === 0) return { width: "0%", color: "bg-gray-700" };
  const pct = Math.min(100, (Math.abs(val) / maxAbs) * 100);
  return {
    width: `${pct}%`,
    color: val > 0 ? "bg-emerald-500" : "bg-red-500",
  };
}

function volBar(vol: number, maxVol: number): string {
  if (maxVol === 0) return "0%";
  return `${Math.min(100, (vol / maxVol) * 100)}%`;
}

function MoneyTag({ strike, atmStrike, side }: { strike: number; atmStrike: number; side: "CE" | "PE" }) {
  if (strike === atmStrike) return <span className="text-[8px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">ATM</span>;
  if (side === "CE") {
    return strike < atmStrike
      ? <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400">ITM</span>
      : <span className="text-[8px] px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-500">OTM</span>;
  }
  return strike > atmStrike
    ? <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400">ITM</span>
    : <span className="text-[8px] px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-500">OTM</span>;
}

function SpreadTag({ spread, ltp }: { spread: number; ltp: number }) {
  if (ltp === 0) return <span className="text-[8px] text-gray-600">—</span>;
  const pct = (spread / ltp) * 100;
  if (pct < 1) return <span className="text-[8px] text-emerald-400"> tight</span>;
  if (pct < 3) return <span className="text-[8px] text-yellow-400"> {pct.toFixed(1)}%</span>;
  return <span className="text-[8px] text-red-400"> wide</span>;
}

export default function EnhancedOptionChain({ chain, spot, atmStrike, maxPain, openTrade }: Props) {
  const [sortCol, setSortCol] = useState<SortKey | null>(null);
  const [sortAsc, setSortAsc] = useState(false);
  const [showGreeks, setShowGreeks] = useState(true);
  const [showSpread, setShowSpread] = useState(false);

  const handleSort = useCallback((col: SortKey) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(false);
    }
  }, [sortCol, sortAsc]);

  const sortedChain = useMemo(() => {
    if (!sortCol) return chain;
    return [...chain].sort((a, b) => {
      const aVal = sortCol === "ltp"
        ? (a.ce?.ltp || 0) + (a.pe?.ltp || 0)
        : sortCol === "oi"
        ? (a.ce?.oi || 0) + (a.pe?.oi || 0)
        : sortCol === "oiChg"
        ? Math.abs(a.ce?.oiChg || 0) + Math.abs(a.pe?.oiChg || 0)
        : sortCol === "vol"
        ? (a.ce?.vol || 0) + (a.pe?.vol || 0)
        : (a.ce?.[sortCol] || 0) + (a.pe?.[sortCol] || 0);
      const bVal = sortCol === "ltp"
        ? (b.ce?.ltp || 0) + (b.pe?.ltp || 0)
        : sortCol === "oi"
        ? (b.ce?.oi || 0) + (b.pe?.oi || 0)
        : sortCol === "oiChg"
        ? Math.abs(b.ce?.oiChg || 0) + Math.abs(b.pe?.oiChg || 0)
        : sortCol === "vol"
        ? (b.ce?.vol || 0) + (b.pe?.vol || 0)
        : (b.ce?.[sortCol] || 0) + (b.pe?.[sortCol] || 0);
      return sortAsc ? aVal - bVal : bVal - aVal;
    });
  }, [chain, sortCol, sortAsc]);

  const stats = useMemo(() => {
    let maxOIAbs = 1, maxOIChgAbs = 1, maxVol = 1, minIV = Infinity, maxIV = -Infinity;
    for (const r of chain) {
      for (const leg of [r.ce, r.pe]) {
        if (!leg) continue;
        maxOIAbs = Math.max(maxOIAbs, leg.oi);
        maxOIChgAbs = Math.max(maxOIChgAbs, Math.abs(leg.oiChg));
        maxVol = Math.max(maxVol, leg.vol);
        if (leg.iv > 0) {
          minIV = Math.min(minIV, leg.iv);
          maxIV = Math.max(maxIV, leg.iv);
        }
      }
    }
    return { maxOIAbs, maxOIChgAbs, maxVol, minIV, maxIV };
  }, [chain]);

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortCol !== col) return <span className="text-gray-600 ml-0.5">⇅</span>;
    return sortAsc ? <ChevronUp size={10} className="text-blue-400 ml-0.5" /> : <ChevronDown size={10} className="text-blue-400 ml-0.5" />;
  };

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded-[10px] overflow-hidden">
      <div className="px-3 py-2 border-b border-[#1f2733] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-bold text-white">Live Option Chain</span>
          <span className="text-[11px] font-mono text-[#7d8ba0]">{fmt(spot)}</span>
          {maxPain > 0 && (
            <span className="text-[10px] text-purple-400">
              Max Pain <span className="font-mono font-bold">{maxPain.toLocaleString("en-IN")}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGreeks(!showGreeks)}
            className={`text-[9px] px-2 py-0.5 rounded font-bold ${
              showGreeks ? "bg-blue-600/20 text-blue-400 border border-blue-500/30" : "bg-gray-800 text-gray-500 border border-gray-700"
            }`}
          >
            Greeks
          </button>
          <button
            onClick={() => setShowSpread(!showSpread)}
            className={`text-[9px] px-2 py-0.5 rounded font-bold ${
              showSpread ? "bg-blue-600/20 text-blue-400 border border-blue-500/30" : "bg-gray-800 text-gray-500 border border-gray-700"
            }`}
          >
            Spread
          </button>
        </div>
      </div>

      <div className="overflow-auto" style={{ maxHeight: "76vh" }}>
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[#0d1219]">
              <th onClick={() => handleSort("oi")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                OI <SortIcon col="oi" />
              </th>
              <th onClick={() => handleSort("oiChg")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                OI Chg <SortIcon col="oiChg" />
              </th>
              <th onClick={() => handleSort("vol")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                Vol <SortIcon col="vol" />
              </th>
              <th onClick={() => handleSort("iv")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                IV <SortIcon col="iv" />
              </th>
              <th onClick={() => handleSort("delta")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                Δ <SortIcon col="delta" />
              </th>
              {showGreeks && (
                <>
                  <th onClick={() => handleSort("gamma")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                    Γ <SortIcon col="gamma" />
                  </th>
                  <th onClick={() => handleSort("theta")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                    Θ <SortIcon col="theta" />
                  </th>
                  <th onClick={() => handleSort("vega")} className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                    ν <SortIcon col="vega" />
                  </th>
                </>
              )}
              <th className="text-right py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase">M</th>
              <th onClick={() => handleSort("ltp")} className="text-right py-1.5 px-1 text-[9px] text-[#1fbf75] uppercase cursor-pointer hover:text-white">
                LTP <SortIcon col="ltp" />
              </th>
              <th className="text-center py-1.5 px-1 text-[9px] text-[#e8a33d] font-bold bg-[#0d1219] sticky left-1/2 -translate-x-1/2 min-w-[60px]">
                STRIKE
              </th>
              <th onClick={() => handleSort("ltp")} className="text-left py-1.5 px-1 text-[9px] text-[#f2495c] uppercase cursor-pointer hover:text-white">
                LTP <SortIcon col="ltp" />
              </th>
              <th className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase">M</th>
              <th onClick={() => handleSort("delta")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                Δ <SortIcon col="delta" />
              </th>
              {showGreeks && (
                <>
                  <th onClick={() => handleSort("gamma")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                    Γ <SortIcon col="gamma" />
                  </th>
                  <th onClick={() => handleSort("theta")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                    Θ <SortIcon col="theta" />
                  </th>
                  <th onClick={() => handleSort("vega")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                    ν <SortIcon col="vega" />
                  </th>
                </>
              )}
              <th onClick={() => handleSort("iv")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                IV <SortIcon col="iv" />
              </th>
              <th onClick={() => handleSort("vol")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                Vol <SortIcon col="vol" />
              </th>
              <th onClick={() => handleSort("oiChg")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                OI Chg <SortIcon col="oiChg" />
              </th>
              <th onClick={() => handleSort("oi")} className="text-left py-1.5 px-1 text-[9px] text-[#7d8ba0] uppercase cursor-pointer hover:text-white">
                OI <SortIcon col="oi" />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedChain.map((r) => {
              const isATM = r.strike === atmStrike;
              const isMaxPain = r.strike === maxPain;
              const isNearATM = Math.abs(r.strike - atmStrike) <= 100;

              const ceOIBar = r.ce ? oiChgBar(r.ce.oiChg, stats.maxOIChgAbs) : null;
              const peOIBar = r.pe ? oiChgBar(r.pe.oiChg, stats.maxOIChgAbs) : null;

              const rowBg = isATM
                ? "bg-[rgba(232,163,61,.1)]"
                : isMaxPain
                ? "bg-[rgba(168,85,247,.06)]"
                : isNearATM
                ? "bg-[#0e1420]"
                : "";

              return (
                <tr
                  key={r.strike}
                  className={`border-b border-[#1a2030] ${rowBg} hover:bg-[#161e2e] transition-colors`}
                >
                  {/* CE OI */}
                  <td className="text-right py-1.5 px-1 text-gray-300">
                    <div className="flex items-center justify-end gap-1">
                      <span>{r.ce ? fmt(r.ce.oi) : "—"}</span>
                    </div>
                  </td>

                  {/* CE OI Change with bar */}
                  <td className="text-right py-1.5 px-1">
                    {r.ce ? (
                      <div className="flex items-center justify-end gap-1">
                        <span className={`text-[10px] ${r.ce.oiChg > 0 ? "text-emerald-400" : r.ce.oiChg < 0 ? "text-red-400" : "text-gray-500"}`}>
                          {r.ce.oiChg > 0 ? "+" : ""}{fmt(r.ce.oiChg)}
                        </span>
                        {ceOIBar && (
                          <div className="w-8 h-1 bg-gray-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${ceOIBar.color}`} style={{ width: ceOIBar.width }} />
                          </div>
                        )}
                      </div>
                    ) : "—"}
                  </td>

                  {/* CE Volume with bar */}
                  <td className="text-right py-1.5 px-1 text-gray-300">
                    <div className="flex items-center justify-end gap-1">
                      <span>{r.ce ? fmt(r.ce.vol) : "—"}</span>
                      {r.ce && r.ce.vol > 0 && (
                        <div className="w-6 h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-cyan-500/60 rounded-full" style={{ width: volBar(r.ce.vol, stats.maxVol) }} />
                        </div>
                      )}
                    </div>
                  </td>

                  {/* CE IV with skew color */}
                  <td className={`text-right py-1.5 px-1 ${r.ce?.iv ? ivColor(r.ce.iv, stats.minIV, stats.maxIV) : "text-gray-500"}`}>
                    {r.ce?.iv ? r.ce.iv.toFixed(1) : "—"}
                  </td>

                  {/* CE Delta */}
                  <td className="text-right py-1.5 px-1 text-gray-300">
                    {r.ce?.delta != null ? r.ce.delta.toFixed(2) : "—"}
                  </td>

                  {/* CE Gamma, Theta, Vega (if showGreeks) */}
                  {showGreeks && (
                    <>
                      <td className="text-right py-1.5 px-1 text-gray-400">
                        {r.ce?.gamma != null ? r.ce.gamma.toFixed(3) : "—"}
                      </td>
                      <td className="text-right py-1.5 px-1 text-gray-400">
                        {r.ce?.theta != null ? r.ce.theta.toFixed(1) : "—"}
                      </td>
                      <td className="text-right py-1.5 px-1 text-gray-400">
                        {r.ce?.vega != null ? r.ce.vega.toFixed(1) : "—"}
                      </td>
                    </>
                  )}

                  {/* CE Moneyness */}
                  <td className="text-right py-1.5 px-1">
                    <MoneyTag strike={r.strike} atmStrike={atmStrike} side="CE" />
                  </td>

                  {/* CE LTP (clickable) */}
                  <td
                    className={`text-right py-1.5 px-1 font-semibold cursor-pointer hover:brightness-125 ${
                      r.ce ? "text-[#1fbf75]" : "text-gray-600"
                    }`}
                    onClick={() => r.ce && openTrade(r.strike, "CE", r.ce.ltp)}
                  >
                    {r.ce ? `₹${fmtPrice(r.ce.ltp)}` : "—"}
                  </td>

                  {/* STRIKE (center, sticky) */}
                  <td className={`text-center py-1.5 px-2 font-bold sticky bg-[#10151d] z-5 border-x border-[#1a2030] ${
                    isATM ? "text-[#e8a33d] text-[13px]" : isMaxPain ? "text-purple-400 text-[12px]" : "text-[#dfe6ee]"
                  }`}>
                    <div className="flex flex-col items-center">
                      <span>{r.strike.toLocaleString("en-IN")}</span>
                      {isMaxPain && !isATM && <span className="text-[7px] text-purple-400">MP</span>}
                    </div>
                  </td>

                  {/* PE LTP (clickable) */}
                  <td
                    className={`text-left py-1.5 px-1 font-semibold cursor-pointer hover:brightness-125 ${
                      r.pe ? "text-[#f2495c]" : "text-gray-600"
                    }`}
                    onClick={() => r.pe && openTrade(r.strike, "PE", r.pe.ltp)}
                  >
                    {r.pe ? `₹${fmtPrice(r.pe.ltp)}` : "—"}
                  </td>

                  {/* PE Moneyness */}
                  <td className="text-left py-1.5 px-1">
                    <MoneyTag strike={r.strike} atmStrike={atmStrike} side="PE" />
                  </td>

                  {/* PE Delta */}
                  <td className="text-left py-1.5 px-1 text-gray-300">
                    {r.pe?.delta != null ? r.pe.delta.toFixed(2) : "—"}
                  </td>

                  {/* PE Gamma, Theta, Vega */}
                  {showGreeks && (
                    <>
                      <td className="text-left py-1.5 px-1 text-gray-400">
                        {r.pe?.gamma != null ? r.pe.gamma.toFixed(3) : "—"}
                      </td>
                      <td className="text-left py-1.5 px-1 text-gray-400">
                        {r.pe?.theta != null ? r.pe.theta.toFixed(1) : "—"}
                      </td>
                      <td className="text-left py-1.5 px-1 text-gray-400">
                        {r.pe?.vega != null ? r.pe.vega.toFixed(1) : "—"}
                      </td>
                    </>
                  )}

                  {/* PE IV */}
                  <td className={`text-left py-1.5 px-1 ${r.pe?.iv ? ivColor(r.pe.iv, stats.minIV, stats.maxIV) : "text-gray-500"}`}>
                    {r.pe?.iv ? r.pe.iv.toFixed(1) : "—"}
                  </td>

                  {/* PE Volume */}
                  <td className="text-left py-1.5 px-1 text-gray-300">
                    <div className="flex items-center gap-1">
                      {r.pe && r.pe.vol > 0 && (
                        <div className="w-6 h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-cyan-500/60 rounded-full" style={{ width: volBar(r.pe.vol, stats.maxVol) }} />
                        </div>
                      )}
                      <span>{r.pe ? fmt(r.pe.vol) : "—"}</span>
                    </div>
                  </td>

                  {/* PE OI Change */}
                  <td className="text-left py-1.5 px-1">
                    {r.pe ? (
                      <div className="flex items-center gap-1">
                        {peOIBar && (
                          <div className="w-8 h-1 bg-gray-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${peOIBar.color}`} style={{ width: peOIBar.width }} />
                          </div>
                        )}
                        <span className={`text-[10px] ${r.pe.oiChg > 0 ? "text-emerald-400" : r.pe.oiChg < 0 ? "text-red-400" : "text-gray-500"}`}>
                          {r.pe.oiChg > 0 ? "+" : ""}{fmt(r.pe.oiChg)}
                        </span>
                      </div>
                    ) : "—"}
                  </td>

                  {/* PE OI */}
                  <td className="text-left py-1.5 px-1 text-gray-300">
                    {r.pe ? fmt(r.pe.oi) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-1.5 border-t border-[#1f2733] flex items-center justify-between text-[9px] text-[#7d8ba0]">
        <div className="flex items-center gap-3">
          <span>Click LTP to trade</span>
          <span className="text-amber-400">■ ATM</span>
          <span className="text-purple-400">■ Max Pain</span>
          <span className="text-emerald-400">■ +OI Buildup</span>
          <span className="text-red-400">■ -OI Unwinding</span>
        </div>
        <span>{chain.length} strikes</span>
      </div>
    </div>
  );
}
