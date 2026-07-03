// SDM Scores Panel Component
// Displays 10 horizontal score bars with gradient coloring and directional indicators

import { useState } from "react";
import type { SDMScores } from "@/types/sdm";
import { ChevronDown, ChevronUp } from "lucide-react";

interface SDMScoresPanelProps {
  scores: SDMScores;
  confidence: number;
  direction?: string;
}

export function SDMScoresPanel({ scores, confidence, direction }: SDMScoresPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const scoreEntries: { label: string; value: number; highlight?: boolean; weight?: string }[] = [
    { label: "Seller SL", value: scores.sellerStopLoss, highlight: true, weight: "25%" },
    { label: "Expiry G/T", value: scores.expiryGammaTheta, weight: "15%" },
    { label: "PCR", value: scores.pcr, weight: "10-12%" },
    { label: "OI Conc", value: scores.oiConcentration, weight: "12-18%" },
    { label: "OI Chg", value: scores.oiChange, weight: "10-15%" },
    { label: "Delta", value: scores.delta, weight: "8-10%" },
    { label: "IV", value: scores.iv, weight: "4-5%" },
    { label: "Volume", value: scores.volume, weight: "5%" },
    { label: "Max Pain", value: scores.maxPain, weight: "5-8%" },
    { label: "Liquidity", value: scores.liquidity, weight: "3-5%" },
  ];

  const getBarColor = (score: number) => {
    if (score >= 70) return "bg-emerald-500";
    if (score >= 50) return "bg-yellow-500";
    return "bg-red-500";
  };

  const getScoreLabel = (score: number) => {
    if (score >= 80) return "STRONG";
    if (score >= 60) return "MODERATE";
    if (score >= 40) return "WEAK";
    return "WEAKEST";
  };

  const getDirectionIcon = () => {
    switch (direction) {
      case "CALL":
        return <span className="text-emerald-400">▶</span>;
      case "PUT":
        return <span className="text-red-400">▼</span>;
      case "SELL_CALL":
        return <span className="text-blue-400">◀</span>;
      case "SELL_PUT":
        return <span className="text-purple-400">▲</span>;
      default:
        return <span className="text-gray-400">⏸</span>;
    }
  };

  // Count strong/weak signals
  const strongCount = scoreEntries.filter(s => s.value >= 60).length;
  const weakCount = scoreEntries.filter(s => s.value < 40).length;

  return (
    <div className="space-y-2">
      {/* Confidence Bar */}
      <div className="relative h-4 rounded-full overflow-hidden bg-gray-800">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${confidence}%`,
            background:
              "linear-gradient(to right, #ef4444, #eab308, #22c55e)",
          }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white drop-shadow-lg">
          {confidence.toFixed(1)}% — {getScoreLabel(confidence)}
        </span>
      </div>

      {/* Toggle */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-300 transition-colors w-full"
      >
        {getDirectionIcon()}
        <span>SDM Scores</span>
        <span className="text-[9px] text-gray-500 ml-auto">
          {strongCount} strong · {weakCount} weak
        </span>
        {isExpanded ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
      </button>

      {/* Score Bars */}
      {isExpanded && (
        <div className="space-y-1">
          {scoreEntries.map((entry) => (
            <div key={entry.label} className="flex items-center gap-2">
              <span
                className={`text-[9px] w-16 text-right ${
                  entry.highlight ? "text-amber-400 font-bold" : "text-gray-400"
                }`}
              >
                {entry.label}
              </span>
              <div
                className={`flex-1 rounded ${
                  entry.highlight ? "h-3.5 border border-amber-400/30" : "h-2"
                } bg-gray-800 overflow-hidden relative`}
              >
                <div
                  className={`h-full rounded transition-all duration-500 ${
                    entry.highlight ? "" : getBarColor(entry.value)
                  }`}
                  style={{
                    width: `${entry.value}%`,
                    ...(entry.highlight
                      ? { background: "#f59e0b" }
                      : {}),
                  }}
                />
                {/* Threshold markers */}
                <div className="absolute inset-0 flex">
                  <div className="w-[40%] border-r border-gray-600/30" />
                  <div className="w-[20%] border-r border-gray-600/30" />
                </div>
              </div>
              <span className={`text-[9px] w-6 text-right font-mono ${
                entry.value >= 60 ? "text-emerald-400" : entry.value >= 40 ? "text-yellow-400" : "text-red-400"
              }`}>
                {entry.value}
              </span>
              <span className="text-[8px] text-gray-600 w-8 text-right">
                {entry.weight}
              </span>
            </div>
          ))}
          {/* Legend */}
          <div className="flex justify-between text-[8px] text-gray-500 mt-1 pt-1 border-t border-white/5">
            <span>0-39: Weak</span>
            <span>40-59: Moderate</span>
            <span>60-79: Strong</span>
            <span>80-100: Very Strong</span>
          </div>
        </div>
      )}
    </div>
  );
}
