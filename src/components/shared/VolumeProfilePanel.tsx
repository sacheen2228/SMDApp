'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { calculateVolumeProfile } from '@/lib/auction-engine';
import type { Candle } from '@/lib/auction-types';

// ─────────────────────────────────────────────────────────────────────────────
// Volume Profile panel — POC / VAH / VAL + volume-at-price bars for the India
// chart. Reuses the production engine `calculateVolumeProfile` (auction-engine)
// — no new engine, per the Architecture Guardian duplicate check.
//
// Data honesty: with candle inputs the engine spreads each bar's volume across
// its high→low range and splits buy/sell 60/40 by candle direction (the same
// documented approximation native charting platforms use without tick data).
// Labelled ESTIMATED — never presented as tick-accurate.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
  symbol?: string;
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0.05;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const mult = raw / base;
  const nice = mult <= 1 ? 1 : mult <= 2 ? 2 : mult <= 5 ? 5 : 10;
  return nice * base;
}

function fmtVol(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(1);
}

function priceDp(price: number): number {
  return Math.abs(price) >= 1000 ? 1 : Math.abs(price) >= 100 ? 2 : 4;
}

export function VolumeProfilePanel({ candles, symbol = 'NIFTY' }: Props) {
  const profile = useMemo(() => {
    const withVol = candles
      .filter(c => Number.isFinite(c.high) && Number.isFinite(c.low))
      .map(c => ({ ...c, volume: c.volume ?? 0 }));
    if (withVol.length === 0) return null;

    let lo = Infinity, hi = -Infinity;
    for (const c of withVol) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    const range = Math.max(hi - lo, 1e-9);
    // ~35 bins across the visible range keeps the axis readable
    const tick = niceStep(range / 35);
    return calculateVolumeProfile(withVol as Candle[], tick);
  }, [candles]);

  const rows = useMemo(() => {
    if (!profile) return [];
    // display top-to-bottom (high price first), capped for readability
    return profile.levels
      .slice()
      .sort((a, b) => b.price - a.price)
      .slice(0, 60)
      .map(l => ({
        price: l.price,
        label: l.price.toFixed(priceDp(l.price)),
        volume: l.volume,
        buy: l.buyVolume ?? 0,
        sell: l.sellVolume ?? 0,
        pct: l.percentage,
      }));
  }, [profile]);

  const maxVol = rows.reduce((m, r) => Math.max(m, r.volume), 0.0001);
  const dp = rows.length > 0 ? priceDp(rows[0].price) : 2;

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-lg border border-border bg-card">
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">Volume Profile</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
            {symbol} · estimated
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          Volume spread across each candle's range (no tick data) · 60/40 direction split
        </div>
      </div>

      {!profile || rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4 text-xs text-muted-foreground">
          {candles.length === 0 ? 'Waiting for candles…' : 'No volume data in these candles'}
        </div>
      ) : (
        <>
          {/* POC / VAH / VAL */}
          <div className="grid grid-cols-3 gap-1 px-2 py-1.5 border-b border-border text-center">
            <div>
              <div className="text-[9px] text-muted-foreground uppercase">POC</div>
              <div className="text-[11px] font-bold tabular-nums text-amber-500">{profile.poc.toFixed(dp)}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase">VAH</div>
              <div className="text-[11px] font-bold tabular-nums text-emerald-600">{profile.vah.toFixed(dp)}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase">VAL</div>
              <div className="text-[11px] font-bold tabular-nums text-red-500">{profile.val.toFixed(dp)}</div>
            </div>
          </div>

          {/* horizontal volume-at-price bars */}
          <div className="flex-1 min-h-0 px-1 py-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ top: 2, right: 8, bottom: 2, left: 2 }}>
                <XAxis type="number" hide domain={[0, maxVol]} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={58}
                  tick={{ fontSize: 9, fill: '#888' }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                />
                <Tooltip
                  formatter={(v: number, name: string) => [fmtVol(v), name]}
                  labelFormatter={l => `Price ${l}`}
                  contentStyle={{ fontSize: 11, background: '#0d1321', border: '1px solid #1e222d', borderRadius: 4 }}
                />
                <Bar dataKey="volume" barSize={9}>
                  {rows.map(r => (
                    <Cell
                      key={r.price}
                      fill={
                        Math.abs(r.price - profile.poc) < 1e-9
                          ? '#f5a623'
                          : r.price > profile.vah || r.price < profile.val
                            ? '#26a69a55'
                            : '#26a69a99'
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="px-2 py-1 text-[9px] text-muted-foreground border-t border-border flex justify-between">
            <span>{rows.length} levels</span>
            <span>total {fmtVol(profile.totalVolume)}</span>
            <span>VA {fmtVol(profile.valueAreaVolume)}</span>
          </div>
        </>
      )}
    </div>
  );
}
