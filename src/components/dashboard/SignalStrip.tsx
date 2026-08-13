'use client';

import React, { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';
import {
  evaluateStrikeSignal,
  suggestTrade,
  type StrikeSignal,
  type SuggestedTrade,
} from '@/lib/signal-engine';

interface SignalStripProps {
  chainData: any[];
  spot: number;
  atmStrike: number;
  maxPain: number;
  pcr: number;
  newsScore: number;
  onStrikeClick?: (strike: number, type: 'CE' | 'PE') => void;
}

export default function SignalStrip({ chainData, spot, atmStrike, maxPain, pcr, newsScore, onStrikeClick }: SignalStripProps) {
  const [expanded, setExpanded] = useState(true);

  // Compute signals for all strikes
  const allSignals: StrikeSignal[] = useMemo(() => {
    if (!chainData?.length) return [];
    const prevPrices = new Map<number, { ce: number; pe: number }>();
    return chainData.map((row: any) => {
      const prevCe = prevPrices.get(row.strike)?.ce ?? row.ce?.ltp ?? 0;
      const prevPe = prevPrices.get(row.strike)?.pe ?? row.pe?.ltp ?? 0;
      prevPrices.set(row.strike, {
        ce: row.ce?.ltp ?? 0,
        pe: row.pe?.ltp ?? 0,
      });
      return evaluateStrikeSignal(
        row.strike, spot, atmStrike, maxPain, pcr,
        row.ce?.ltp ?? 0, row.ce?.oi ?? 0, row.ce?.oiChg ?? 0,
        row.ce?.iv ?? 0, row.ce?.delta ?? 0, prevCe,
        row.pe?.ltp ?? 0, row.pe?.oi ?? 0, row.pe?.oiChg ?? 0,
        row.pe?.iv ?? 0, row.pe?.delta ?? 0, prevPe,
        newsScore,
      );
    });
  }, [chainData, spot, atmStrike, maxPain, pcr, newsScore]);

  // Top 3 non-neutral signals
  const topSignals: StrikeSignal[] = useMemo(() => {
    return allSignals
      .filter(s => s.direction !== 'NEUTRAL' && s.confidence >= 40)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }, [allSignals]);

  // Suggested trade from best signal
  const trade: SuggestedTrade | null = useMemo(() => {
    return suggestTrade(allSignals, chainData, spot, maxPain);
  }, [allSignals, chainData, spot, maxPain]);

  if (!topSignals.length && !trade) return null;

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded text-[11px]">
      <button
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[#151b25]"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {trade?.direction === 'BUY_CE' ? (
            <TrendingUp className="h-3 w-3 text-emerald-400" />
          ) : trade?.direction === 'BUY_PE' ? (
            <TrendingDown className="h-3 w-3 text-red-400" />
          ) : (
            <Minus className="h-3 w-3 text-zinc-400" />
          )}
          <span className="font-semibold text-[#dfe6ee]">Active Signals</span>
          <span className="text-[9px] text-[#7d8ba0]">Model Signal — not investment advice</span>
        </div>
        <div className="flex items-center gap-2">
          {trade && (
            <span className="text-[10px] font-bold tabular-nums text-[#7d8ba0]">
              Best: <span className={trade.type === 'CE' ? 'text-emerald-400' : 'text-red-400'}>{trade.strike} {trade.type}</span>
              {' · '}Conf {trade.confidence}% · R:R {trade.rr}
            </span>
          )}
          {expanded ? <ChevronUp className="h-3 w-3 text-[#7d8ba0]" /> : <ChevronDown className="h-3 w-3 text-[#7d8ba0]" />}
        </div>
      </button>

      {expanded && trade && (
        <div className="px-3 pb-2 border-t border-[#1f2733] pt-2">
          {/* Top 3 signals */}
          <div className="flex gap-2 overflow-x-auto pb-1.5">
            {topSignals.map((s) => (
              <button
                key={s.strike}
                onClick={() => {
                  const type = s.direction === 'BUY_CE' ? 'CE' : 'PE';
                  onStrikeClick?.(s.strike, type);
                }}
                className={`shrink-0 px-2 py-1 rounded border text-[10px] cursor-pointer transition-colors ${
                  s.direction === 'BUY_CE'
                    ? 'border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20'
                    : 'border-red-500/30 bg-red-500/10 hover:bg-red-500/20'
                }`}
              >
                <div className="font-bold text-[11px]">{s.strike} {s.direction === 'BUY_CE' ? 'CE' : 'PE'}</div>
                <div className="text-[#7d8ba0] mt-0.5">Conf {s.confidence}%</div>
              </button>
            ))}
          </div>

          {/* Best trade card */}
          <div className="bg-[#0a0e14] border border-[#1f2733] rounded p-2">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`font-bold text-sm ${trade.type === 'CE' ? 'text-emerald-400' : 'text-red-400'}`}>
                {trade.strike} {trade.type}
              </span>
              <span className="text-[9px] text-[#7d8ba0]">Conf {trade.confidence}%</span>
              <span className={`text-[10px] font-bold ${trade.rr >= 1.5 ? 'text-emerald-400' : trade.rr >= 1 ? 'text-amber-400' : 'text-red-400'}`}>
                R:R {trade.rr}
              </span>
            </div>
            <div className="text-[#7d8ba0] text-[10px] mb-1">{trade.reason}</div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="text-[9px] text-[#5a6a80]">Entry</div>
                <div className="font-bold text-[11px] text-[#dfe6ee]">₹{trade.entry}</div>
              </div>
              <div>
                <div className="text-[9px] text-[#5a6a80]">SL</div>
                <div className="font-bold text-[11px] text-red-400">₹{trade.sl}</div>
              </div>
              <div>
                <div className="text-[9px] text-[#5a6a80]">T1</div>
                <div className="font-bold text-[11px] text-emerald-400">₹{trade.tp1}</div>
              </div>
              <div>
                <div className="text-[9px] text-[#5a6a80]">T2</div>
                <div className="font-bold text-[11px] text-emerald-400">₹{trade.tp2}</div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 mt-1 text-[9px] text-[#5a6a80]">
            <ShieldAlert className="h-2.5 w-2.5" />
            Decision-support only. Verify with your own analysis before trading.
          </div>
        </div>
      )}
    </div>
  );
}
