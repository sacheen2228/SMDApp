"use client";

import type { ConsensusResult, TimeframeResult } from "@/types/sdm";
import { TrendingUp, TrendingDown, Minus, Check, X, BarChart3 } from "lucide-react";

interface TimeframePanelProps {
  consensus: ConsensusResult | null;
}

function BiasIcon({ bias }: { bias: TimeframeResult["bias"] }) {
  if (bias === "BULLISH") return <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />;
  if (bias === "BEARISH") return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
  return <Minus className="w-3.5 h-3.5 text-gray-500" />;
}

const consensusLabel = (s: number) =>
  s >= 0.6 ? "Strong Bullish" : s >= 0.2 ? "Bullish" : s > -0.2 ? "Neutral" : s > -0.6 ? "Bearish" : "Strong Bearish";

const consensusTextClass = (s: number) =>
  s >= 0.2 ? "text-emerald-400" : s > -0.2 ? "text-gray-400" : "text-red-400";

const structureColor = (t: string) =>
  t === "UPTREND" ? "text-emerald-400" : t === "DOWNTREND" ? "text-red-400" : "text-gray-500";

export function TimeframePanel({ consensus }: TimeframePanelProps) {
  if (!consensus) return null;
  const { timeframes, consensus: score, overallBias, bullishCount, bearishCount, neutralCount } = consensus;
  const barWidth = ((score + 1) / 2) * 100;

  return (
    <div className="rounded-lg border border-white/10 bg-gray-900/80 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wide">Multi-Timeframe Analysis</span>
        </div>
        <span className={`text-[9px] font-bold ${consensusTextClass(score)}`}>{overallBias.replace("_", " ")}</span>
      </div>
      {/* Consensus Bar */}
      <div className="space-y-1">
        <div className="relative h-2.5 rounded-full overflow-hidden bg-gray-800">
          <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 bg-gradient-to-r from-red-500 via-gray-500 to-emerald-500" style={{ width: `${barWidth}%` }} />
          <div className="absolute inset-y-0 left-1/2 w-px bg-white/30" />
        </div>
        <div className="flex justify-between text-[8px] text-gray-500">
          <span>-1 Bearish</span>
          <span className={consensusTextClass(score)}>{score.toFixed(2)} — {consensusLabel(score)}</span>
          <span>+1 Bullish</span>
        </div>
      </div>
      {/* Timeframe Rows */}
      <div className="space-y-1">
        {timeframes.map((tf) => (
          <div key={tf.tf} className="flex items-center gap-2 px-1.5 py-1 rounded bg-gray-800/50">
            <span className="text-[9px] font-mono font-bold text-gray-300 w-7">{tf.tf}</span>
            <BiasIcon bias={tf.bias} />
            <span className="text-[8px] text-gray-400 w-16 truncate">
              EMA 9 {tf.ema9 > tf.ema21 ? ">" : "<"} 21
            </span>
            <span className={`text-[8px] font-medium w-16 ${structureColor(tf.structureTrend)}`}>{tf.structureTrend}</span>
            <span className="ml-auto">
              {tf.volumeConfirm ? <Check className="w-3 h-3 text-emerald-400" /> : <X className="w-3 h-3 text-red-500/60" />}
            </span>
          </div>
        ))}
      </div>
      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <div className="flex gap-2 text-[8px]">
          <span className="text-emerald-400">{bullishCount} Bullish</span>
          <span className="text-gray-500">·</span>
          <span className="text-gray-400">{neutralCount} Neutral</span>
          <span className="text-gray-500">·</span>
          <span className="text-red-400">{bearishCount} Bearish</span>
        </div>
        <span className="text-[8px] text-gray-500">{timeframes.length - neutralCount}/{timeframes.length} Trending</span>
      </div>
    </div>
  );
}
