'use client';

import { useMemo, useState } from 'react';
import type { Trade } from '@/types/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Time & Sales — live trade tape for the NEXUS futures terminal.
// Design reference: native tape panes (rolling retention window, min-size
// filter, buy/sell tint, ms timestamps) — reimplemented from scratch.
// Data: the `trades` snapshot FuturesDashboard already fetches (50/print poll).
// Retention: 2 minutes, matching the reference design's short tape window.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  trades: Trade[];
  market: string;
}

const RETENTION_MS = 120_000;

function fmtSize(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toFixed(5);
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function TimeSalesPanel({ trades, market }: Props) {
  const [minSize, setMinSize] = useState(0);

  // Rolling window: keep prints from the last 2 minutes, newest first,
  // then apply the min-size filter.
  const rows = useMemo(() => {
    const cutoff = Date.now() - RETENTION_MS;
    return trades
      .filter(t => t.time >= cutoff && t.size >= minSize)
      .slice()
      .sort((a, b) => b.time - a.time);
  }, [trades, minSize]);

  // Session deltas over the visible window (context, not a signal)
  const { buyVol, sellVol } = useMemo(() => {
    let buy = 0, sell = 0;
    for (const t of rows) {
      // isBuyerMaker = true → seller was the aggressor (printed red)
      if (t.isBuyerMaker) sell += t.size;
      else buy += t.size;
    }
    return { buyVol: buy, sellVol: sell };
  }, [rows]);

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
      <div className="px-2 py-1 text-[9px] font-bold uppercase flex items-center justify-between" style={{ color: '#5d6070', borderBottom: '1px solid #1e222d' }}>
        <span>Time &amp; Sales</span>
        <span style={{ color: '#787b86' }}>{market}</span>
      </div>

      {/* filter + window stats */}
      <div className="flex items-center justify-between px-1.5 py-1 text-[8px]" style={{ color: '#3d4050', borderBottom: '1px solid #1e222d' }}>
        <label className="flex items-center gap-1">
          MIN
          <input
            type="number"
            min={0}
            step="any"
            value={minSize || ''}
            placeholder="0"
            onChange={e => setMinSize(Math.max(0, parseFloat(e.target.value) || 0))}
            className="w-12 px-1 py-0.5 text-[9px] tabular-nums outline-none rounded"
            style={{ background: '#0a0e17', color: '#d1d4dc', border: '1px solid #1e222d' }}
          />
        </label>
        <span>
          <span style={{ color: '#26a69a' }}>▲ {fmtSize(buyVol)}</span>
          {' · '}
          <span style={{ color: '#ef5350' }}>▼ {fmtSize(sellVol)}</span>
        </span>
        <span>2m window</span>
      </div>

      {/* column headers */}
      <div className="flex items-center justify-between px-1.5 py-0.5 text-[8px] uppercase" style={{ color: '#3d4050', borderBottom: '1px solid #1e222d' }}>
        <span className="w-[34%]">Time</span>
        <span className="w-[33%] text-right">Price</span>
        <span className="w-[33%] text-right">Size</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.map((t, i) => {
          const isSell = t.isBuyerMaker; // seller aggressor → red
          return (
            <div key={`${t.time}-${i}`} className="flex items-center justify-between px-1.5 py-[2px] text-[10px] tabular-nums"
              style={{ color: isSell ? '#ef5350' : '#26a69a' }}>
              <span className="w-[34%]" style={{ color: '#5d6070' }}>{fmtTime(t.time)}</span>
              <span className="w-[33%] text-right">{t.price.toFixed(2)}</span>
              <span className="w-[33%] text-right font-medium">{fmtSize(t.size)}</span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="text-[10px] text-center py-3" style={{ color: '#5d6070' }}>
            {trades.length === 0 ? 'Waiting for prints…' : 'No prints in the last 2 minutes'}
          </div>
        )}
      </div>
    </div>
  );
}
