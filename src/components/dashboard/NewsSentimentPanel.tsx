'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { Newspaper, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { analyzeNewsSentiment, type NewsSentiment } from '@/lib/signal-engine';

// ─── Default headlines (change these / wire to an API) ───
const DEFAULT_HEADLINES: string[] = [
  "FII buying continues in cash market for third straight session",
  "NIFTY holds above 24,200 on strong support from banking stocks",
  "Rupee weakens on geopolitical tension in Middle East",
  "India's GDP growth beats estimates, manufacturing expands",
  "Selloff in IT stocks amid global tech slowdown fears",
  "RBI expected to hold rates steady in upcoming policy",
  "Crude oil prices rally on supply disruption fears",
  "Government announces Rs 10,000 crore capex push for infrastructure",
];

interface NewsSentimentPanelProps {
  headlines?: string[];
  onScoreChange?: (score: number) => void;
}

export default function NewsSentimentPanel({ headlines = DEFAULT_HEADLINES, onScoreChange }: NewsSentimentPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [customText, setCustomText] = useState('');

  const sentiment: NewsSentiment = useMemo(() => {
    const items = customText.trim()
      ? [...headlines, customText]
      : headlines;
    return analyzeNewsSentiment(items);
  }, [headlines, customText]);

  // Notify parent
  React.useEffect(() => {
    onScoreChange?.(sentiment.score);
  }, [sentiment.score, onScoreChange]);

  const barColor = sentiment.score > 20 ? 'bg-emerald-500' : sentiment.score < -20 ? 'bg-red-500' : 'bg-amber-500';
  const barLabel = sentiment.score > 20 ? 'Bullish' : sentiment.score < -20 ? 'Bearish' : 'Neutral';

  return (
    <div className="bg-[#10151d] border border-[#1f2733] rounded text-[11px]">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[#151b25]"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Newspaper className="h-3 w-3 text-orange-400" />
          <span className="font-semibold text-[#dfe6ee]">News Sentiment</span>
          <span className="text-[9px] text-[#7d8ba0]">(heuristic — not verified)</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Score bar */}
          <div className="w-24 h-1.5 bg-[#1f2733] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${Math.abs(sentiment.score) * 0.5}%`, marginLeft: sentiment.score < 0 ? 'auto' : 0 }}
            />
          </div>
          <span className={`text-[10px] font-bold w-16 text-right ${barColor.replace('bg-', 'text-')}`}>
            {sentiment.score > 0 ? '+' : ''}{sentiment.score} ({barLabel})
          </span>
          {collapsed ? <ChevronDown className="h-3 w-3 text-[#7d8ba0]" /> : <ChevronUp className="h-3 w-3 text-[#7d8ba0]" />}
        </div>
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-[#1f2733] pt-1.5">
          {/* Manual entry */}
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="Paste a headline to score..."
              className="flex-1 bg-[#0a0e14] border border-[#1f2733] rounded px-2 py-1 text-[10px] text-[#dfe6ee] placeholder:text-[#5a6a80] outline-none"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
            />
          </div>

          {/* Headline list */}
          <div className="max-h-32 overflow-y-auto space-y-0.5">
            {sentiment.headlines.map((h, i) => (
              <div key={i} className="flex items-center gap-1.5 py-0.5">
                <span className={`text-[8px] font-bold px-1 rounded ${
                  h.sentiment === 'bullish' ? 'bg-emerald-500/20 text-emerald-400' :
                  h.sentiment === 'bearish' ? 'bg-red-500/20 text-red-400' :
                  'bg-zinc-500/20 text-zinc-400'
                }`}>
                  {h.sentiment === 'bullish' ? '+1' : h.sentiment === 'bearish' ? '-1' : '0'}
                </span>
                <span className="truncate text-[10px] text-[#7d8ba0]">{h.text}</span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-1 text-[9px] text-[#5a6a80]">
            <AlertTriangle className="h-2.5 w-2.5" />
            Simple keyword matching — not verified analysis. Use as one input only.
          </div>
        </div>
      )}
    </div>
  );
}
