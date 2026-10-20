'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Newspaper, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { analyzeNewsSentiment, type NewsSentiment } from '@/lib/signal-engine';
import { DataFreshnessBadge, UnavailableCard } from './DataFreshnessBadge';

// ─── No fallback headlines ───────────────────────────────────────────
// The panel used to fall back to eight hardcoded market headlines and then
// score them, so the dashboard showed a "News Sentiment" number that came
// from text invented in this file. When the real feed is empty the card
// says so and shows no score.
interface NewsSentimentPanelProps {
  headlines?: string[];
  onScoreChange?: (score: number) => void;
}

export default function NewsSentimentPanel({ headlines, onScoreChange }: NewsSentimentPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [customText, setCustomText] = useState('');
  const [liveHeadlines, setLiveHeadlines] = useState<string[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  // Real headlines from /api/news (RSS feeds) — refresh every 2min.
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/news')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const payload = j?.data || j || {};
          const articles = Array.isArray(payload.articles) ? payload.articles : [];
          const titles = articles
            .map((a: any) => String(a?.title || a?.headline || '').trim())
            .filter(Boolean);
          if (!alive) return;
          setMeta(j?.meta || null);
          if (titles.length) {
            setLiveHeadlines(titles);
            setUnavailable(null);
          } else {
            setLiveHeadlines([]);
            setUnavailable(j?.error || 'No headlines returned by the news feeds');
          }
        })
        .catch(() => {
          if (!alive) return;
          setLiveHeadlines([]);
          setUnavailable('News feed unreachable');
        });
    };
    load();
    const iv = setInterval(load, 120000); // auto-update every 2min
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // Explicitly-provided headlines (a parent that has real ones) win.
  const effectiveHeadlines = headlines?.length ? headlines : liveHeadlines;

  const sentiment: NewsSentiment = useMemo(() => {
    const items = customText.trim()
      ? [...effectiveHeadlines, customText]
      : effectiveHeadlines;
    return analyzeNewsSentiment(items);
  }, [effectiveHeadlines, customText]);

  // Notify parent (only when there is a real score — never a score derived
  // from invented headlines).
  React.useEffect(() => {
    if (effectiveHeadlines.length || customText.trim()) onScoreChange?.(sentiment.score);
  }, [sentiment.score, onScoreChange, effectiveHeadlines.length, customText]);

  const barColor = sentiment.score > 20 ? 'bg-emerald-500' : sentiment.score < -20 ? 'bg-red-500' : 'bg-amber-500';
  const barLabel = sentiment.score > 20 ? 'Bullish' : sentiment.score < -20 ? 'Bearish' : 'Neutral';
  const hasScore = effectiveHeadlines.length > 0 || customText.trim().length > 0;

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
          <DataFreshnessBadge meta={meta} className="ml-1" showReason />
        </div>
        <div className="flex items-center gap-2">
          {/* Score bar */}
          <div className="w-24 h-1.5 bg-[#1f2733] rounded-full overflow-hidden">
            {hasScore ? (
              <div
                className={`h-full rounded-full transition-all ${barColor}`}
                style={{ width: `${Math.abs(sentiment.score) * 0.5}%`, marginLeft: sentiment.score < 0 ? 'auto' : 0 }}
              />
            ) : (
              <div className="h-full w-0" />
            )}
          </div>
          <span className={`text-[10px] font-bold w-16 text-right ${hasScore ? barColor.replace('bg-', 'text-') : 'text-zinc-500'}`}>
            {hasScore ? `${sentiment.score > 0 ? '+' : ''}${sentiment.score} (${barLabel})` : 'NO DATA'}
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

          {unavailable && !hasScore ? (
            <UnavailableCard
              title="News sentiment"
              reason={unavailable}
              meta={meta}
              className="mt-1"
            />
          ) : (
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
          )}

          <div className="flex items-center gap-1 text-[9px] text-[#5a6a80]">
            <AlertTriangle className="h-2.5 w-2.5" />
            Simple keyword matching — not verified analysis. Use as one input only.
          </div>
        </div>
      )}
    </div>
  );
}
