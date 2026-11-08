'use client';

import { useMemo } from 'react';
import type { Trade } from '@/types/engine';
import { aggregateFootprint, type FootprintBin } from '@/lib/futures/footprint';

// ─────────────────────────────────────────────────────────────────────────────
// Footprint panel — directional volume per price bin for the live session.
// Design reference: native footprint panes (sell | price | buy rows, delta
// footer, POC marker). Aggregation is the tested pure module
// `@/lib/futures/footprint`; this file only renders it.
//
// Data honesty: CoinDCX trade_history returns only recent prints, so the
// parent folds each poll into a session accumulator (mergePrints) and this
// panel renders exactly what was received — labelled LIVE SESSION.
// Historical bars are never invented.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  /** session-accumulated prints (FuturesDashboard folds polls via mergePrints) */
  trades: Trade[];
  market: string;
}

const MAX_BINS = 40;

function niceStep(raw: number): number {
  // 1 / 2 / 5 × 10^k ladder
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const mult = raw / base;
  const nice = mult <= 1 ? 1 : mult <= 2 ? 2 : mult <= 5 ? 5 : 10;
  return nice * base;
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toFixed(5);
}

export function FootprintPanel({ trades, market }: Props) {
  const { bins, poc, totalVolume, step } = useMemo(() => {
    if (trades.length === 0) return { bins: [] as FootprintBin[], poc: null as number | null, totalVolume: 0, step: 0 };
    let lo = Infinity, hi = -Infinity;
    for (const t of trades) {
      if (t.price < lo) lo = t.price;
      if (t.price > hi) hi = t.price;
    }
    const range = Math.max(hi - lo, hi * 0.0001, 1e-9);
    const rawStep = range / 20; // target up to ~20 bins across the session range
    const s = Math.max(niceStep(rawStep), 1e-8);
    const r = aggregateFootprint(trades, s);
    // cap bin count by widening the step once if the ladder explodes
    if (r.bins.length > MAX_BINS) {
      const widened = s * Math.ceil(r.bins.length / MAX_BINS);
      return { ...aggregateFootprint(trades, widened), step: widened };
    }
    return { ...r, step: s };
  }, [trades]);

  const maxSide = useMemo(
    () => bins.reduce((m, b) => Math.max(m, b.buyQty, b.sellQty), 0.0001),
    [bins],
  );

  const netDelta = bins.reduce((s, b) => s + b.delta, 0);
  const stepLabel = step >= 1 ? step.toFixed(step < 10 ? 2 : 0) : step.toPrecision(2);

  return (
    <div className="flex flex-col overflow-hidden" style={{ background: '#0d1321', border: '1px solid #1e222d', borderTop: 'none', height: 148 }}>
      <div className="px-2 py-1 text-[9px] font-bold uppercase flex items-center justify-between" style={{ color: '#5d6070', borderBottom: '1px solid #1e222d' }}>
        <span>Footprint · Live Session</span>
        <span style={{ color: '#787b86' }}>
          {market} · step {stepLabel} · {bins.length} bins · {fmt(totalVolume)} vol
        </span>
      </div>

      <div className="flex items-center justify-between px-2 py-0.5 text-[8px] uppercase" style={{ color: '#3d4050', borderBottom: '1px solid #1e222d' }}>
        <span className="w-[38%] text-right" style={{ color: '#ef5350' }}>Sell</span>
        <span className="w-[24%] text-center">Price</span>
        <span className="w-[38%] text-left" style={{ color: '#26a69a' }}>Buy</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {bins.length === 0 && (
          <div className="text-[10px] text-center py-4" style={{ color: '#5d6070' }}>
            Accumulating prints… (footprint builds from live trades only)
          </div>
        )}
        {/* high → low, so the ladder reads like the DOM above it */}
        {bins.slice().reverse().map(b => {
          const isPoc = poc === b.price;
          const sellW = (b.sellQty / maxSide) * 50;
          const buyW = (b.buyQty / maxSide) * 50;
          return (
            <div key={b.price} className="relative flex items-center justify-between px-2 py-[2px] text-[10px] tabular-nums"
              style={{ background: isPoc ? 'rgba(255,235,59,0.06)' : 'transparent', borderBottom: '1px solid #131722' }}>
              {/* sell bar grows left from center */}
              <div className="absolute top-0 bottom-0 right-1/2" style={{ background: 'rgba(239,83,80,0.18)', width: `${sellW}%` }} />
              <div className="absolute top-0 bottom-0 left-1/2" style={{ background: 'rgba(38,166,154,0.18)', width: `${buyW}%` }} />
              <span className="relative z-10 w-[38%] text-right" style={{ color: '#ef5350' }}>{b.sellQty > 0 ? fmt(b.sellQty) : ''}</span>
              <span className="relative z-10 w-[24%] text-center" style={{ color: isPoc ? '#ffeb3b' : '#d1d4dc', fontWeight: isPoc ? 700 : 400 }}>
                {b.price.toFixed(Math.abs(b.price) >= 100 ? 1 : 4)}{isPoc ? ' ◆' : ''}
              </span>
              <span className="relative z-10 w-[38%] text-left" style={{ color: '#26a69a' }}>{b.buyQty > 0 ? fmt(b.buyQty) : ''}</span>
            </div>
          );
        })}
      </div>

      {bins.length > 0 && (
        <div className="flex items-center justify-between px-2 py-1 text-[9px] font-bold" style={{ color: '#d1d4dc', borderTop: '1px solid #1e222d', background: '#0a0e17' }}>
          <span style={{ color: '#5d6070' }}>POC {poc != null ? poc.toFixed(Math.abs(poc) >= 100 ? 1 : 4) : '—'}</span>
          <span style={{ color: netDelta >= 0 ? '#26a69a' : '#ef5350' }}>
            Δ {netDelta >= 0 ? '+' : ''}{fmt(netDelta)}
          </span>
          <span style={{ color: '#5d6070' }}>prints since load</span>
        </div>
      )}
    </div>
  );
}
