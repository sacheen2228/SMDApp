'use client';

import { useMemo } from 'react';
import type { OrderBookLevel } from '@/types/engine';

// ─────────────────────────────────────────────────────────────────────────────
// DOM Ladder — price-centered depth view for the NEXUS futures terminal.
// Design reference: native ladder panes (grouped depth, cumulative bars,
// spread row, wall marker) — reimplemented from scratch for React.
// Data: the `levels` snapshot FuturesDashboard already fetches (12/side).
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  levels: OrderBookLevel[];
  market: string;
  bidVol: number;
  askVol: number;
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

// Cumulative depth (ladder convention: cumulative from best price outward).
// Pure prefix sums — books are ≤12 levels, so O(n²) is negligible and keeps
// the render path mutation-free.
function withCum(rows: OrderBookLevel[]) {
  return rows.map((l, i) => ({
    ...l,
    cum: rows.slice(0, i + 1).reduce((s, x) => s + x.size, 0),
  }));
}

export function DomLadder({ levels, market, bidVol, askVol }: Props) {
  const { asks, bids, maxSz, avgSz, bestAsk, bestBid, spread } = useMemo(() => {
    const a = levels.filter(l => !l.isBid).sort((x, y) => y.price - x.price); // high → low
    const b = levels.filter(l => l.isBid).sort((x, y) => y.price - x.price);   // high → low
    const maxSz = Math.max(...levels.map(l => l.size), 0.001);
    const avgSz = levels.length > 0 ? levels.reduce((s, l) => s + l.size, 0) / levels.length : 0;
    const bestAsk = a.length > 0 ? a[a.length - 1].price : 0;
    const bestBid = b.length > 0 ? b[0].price : 0;
    const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
    return { asks: a, bids: b, maxSz, avgSz, bestAsk, bestBid, spread };
  }, [levels]);

  const wallThreshold = avgSz * 3;

  const askRows = useMemo(() => withCum(asks), [asks]);
  const bidRows = useMemo(() => withCum(bids), [bids]);

  const maxCum = Math.max(
    askRows.length > 0 ? askRows[askRows.length - 1].cum : 0,
    bidRows.length > 0 ? bidRows[bidRows.length - 1].cum : 0,
    0.001,
  );

  const Row = ({ r, side }: { r: OrderBookLevel & { cum: number }; side: 'ask' | 'bid' }) => {
    const isWall = r.size > wallThreshold;
    const barColor = side === 'ask' ? 'rgba(239,83,80,0.14)' : 'rgba(38,166,154,0.14)';
    const textColor = side === 'ask' ? '#ef5350' : '#26a69a';
    return (
      <div className="relative flex items-center justify-between px-1.5 py-[3px] text-[10px] tabular-nums" style={{ color: textColor }}>
        <div className="absolute left-0 top-0 bottom-0" style={{ background: barColor, width: `${(r.cum / maxCum) * 100}%` }} />
        <span className="relative z-10 w-[30%] font-medium">{r.price.toFixed(2)}</span>
        <span className="relative z-10 w-[22%] text-right">{fmt(r.size)}</span>
        <span className="relative z-10 w-[26%] text-right" style={{ color: '#787b86' }}>{fmt(r.cum)}</span>
        <span className="relative z-10 w-[22%] text-right" style={{ color: isWall ? '#ffeb3b' : '#3d4050' }}>
          {isWall ? '🏦' : ''}
        </span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}>
      <div className="px-2 py-1 text-[9px] font-bold uppercase flex items-center justify-between" style={{ color: '#5d6070', borderBottom: '1px solid #1e222d' }}>
        <span>Ladder</span>
        <span style={{ color: '#787b86' }}>{market}</span>
      </div>

      {/* column headers */}
      <div className="flex items-center justify-between px-1.5 py-0.5 text-[8px] uppercase" style={{ color: '#3d4050', borderBottom: '1px solid #1e222d' }}>
        <span className="w-[30%]">Price</span>
        <span className="w-[22%] text-right">Size</span>
        <span className="w-[26%] text-right">Cum</span>
        <span className="w-[22%] text-right">Wall</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {askRows.map(r => <Row key={`a-${r.price}`} r={r} side="ask" />)}

        {/* spread row — the ladder's center line */}
        <div className="flex items-center justify-between px-1.5 py-[3px] text-[9px] font-bold"
          style={{ color: '#d1d4dc', background: '#0a0e17', borderTop: '1px solid #1e222d', borderBottom: '1px solid #1e222d' }}>
          <span>SPREAD {spread > 0 ? spread.toFixed(2) : '—'}</span>
          <span style={{ color: '#5d6070' }}>B {fmt(bidVol)} / A {fmt(askVol)}</span>
        </div>

        {bidRows.map(r => <Row key={`b-${r.price}`} r={r} side="bid" />)}

        {levels.length === 0 && (
          <div className="text-[10px] text-center py-3" style={{ color: '#5d6070' }}>Waiting for depth…</div>
        )}
      </div>
    </div>
  );
}
