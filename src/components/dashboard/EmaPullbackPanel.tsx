'use client';

// EMA PULLBACK ENGINE v2 — dashboard panel.
// Non-repainting: 15m bias + chop filter (last FULLY CLOSED 15m bar only),
// 5m trigger evaluated on closed bars, min 1:2 RR, optional SMC + variance-
// ratio regime gate.
//
// Educational framework — NOT financial advice. Thresholds are starting
// values, NOT backtested.

import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Gauge, RefreshCw, Shield,
  Target, TrendingDown, TrendingUp, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Signal {
  time: string;
  side: 'CE' | 'PE';
  pattern: string;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  risk_pts: number;
  rr: number;
  score: number;
  chop_score: string;
  rvol: number | null;
  clv: number;
  atr: number;
  vr: number | null;
  regime_flip_price: number;
  valid_bars: number;
  smc: { fvg_retest: boolean; sweep_reclaim: boolean; bos: boolean; hl_intact: boolean };
  order_flow_delta_ok: boolean;
  note: string;
}

interface Gate {
  status: 'VALID' | 'SKIP';
  skip_reasons: string[];
  signal: Signal | null;
}

interface Payload {
  success: boolean;
  error?: string;
  symbol: string;
  signals: Signal[];
  lastBar: Record<string, Gate>;
  bars: number;
  first: string | null;
  last: string | null;
  provenance?: {
    symbol: string;
    candles: string;
    vix: number | null;
    callWall: number | null;
    putWall: number | null;
    delta: string;
    chainSource: string | null;
  };
}

function num(v: number | null | undefined, d = 2): string {
  if (v == null || isNaN(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function GateCard({ side, gate }: { side: 'CE' | 'PE'; gate?: Gate }) {
  const isCe = side === 'CE';
  const valid = gate?.status === 'VALID';
  const Icon = isCe ? TrendingUp : TrendingDown;
  return (
    <div
      className={`rounded-lg border p-2 space-y-1 ${
        valid
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-border bg-muted/20'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`flex items-center gap-1 text-[11px] font-bold ${isCe ? 'text-emerald-500' : 'text-red-500'}`}>
          <Icon className="h-3.5 w-3.5" /> {side} BUY
        </span>
        <Badge
          variant="outline"
          className={`text-[9px] ${
            valid ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'
          }`}
        >
          {valid ? 'VALID' : 'SKIP'}
        </Badge>
      </div>
      {valid && gate?.signal ? (
        <div className="text-[10px] space-y-0.5">
          <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span className="font-mono font-bold">{num(gate.signal.entry)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Stop</span><span className="font-mono text-red-500">{num(gate.signal.stop)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">T2</span><span className="font-mono text-emerald-500">{num(gate.signal.t2)}</span></div>
        </div>
      ) : (
        <div className="text-[9px] space-y-0.5 text-muted-foreground">
          {(gate?.skip_reasons || []).length === 0 ? (
            <div>Gate checklist unavailable.</div>
          ) : (
            gate!.skip_reasons.map((r, i) => (
              <div key={i} className="flex items-start gap-1">
                <span className="text-amber-500">•</span>
                <span>{r.replace(/_/g, ' ')}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SignalRow({ s }: { s: Signal }) {
  const isCe = s.side === 'CE';
  return (
    <div className={`rounded border p-2 text-[10px] space-y-1 ${isCe ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
      <div className="flex items-center justify-between">
        <span className={`flex items-center gap-1 font-bold ${isCe ? 'text-emerald-500' : 'text-red-500'}`}>
          {isCe ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {s.side} · {s.pattern.replace(/_/g, ' ')}
        </span>
        <span className="font-mono text-muted-foreground">{s.time}</span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        <div><div className="text-muted-foreground">Entry</div><div className="font-mono font-bold">{num(s.entry)}</div></div>
        <div><div className="text-muted-foreground">Stop</div><div className="font-mono text-red-500">{num(s.stop)}</div></div>
        <div><div className="text-muted-foreground">T1</div><div className="font-mono text-emerald-500">{num(s.t1)}</div></div>
        <div><div className="text-muted-foreground">T2</div><div className="font-mono text-emerald-500">{num(s.t2)}</div></div>
      </div>
      <div className="flex flex-wrap gap-1 text-[9px] text-muted-foreground">
        <span className="px-1 py-0.5 rounded bg-muted">score {s.score}</span>
        <span className="px-1 py-0.5 rounded bg-muted">chop {s.chop_score}</span>
        <span className="px-1 py-0.5 rounded bg-muted">rvol {s.rvol ?? '—'}</span>
        <span className="px-1 py-0.5 rounded bg-muted">clv {s.clv}</span>
        <span className="px-1 py-0.5 rounded bg-muted">RR 1:{s.rr}</span>
        <span className="px-1 py-0.5 rounded bg-muted">atr {s.atr}</span>
        {s.vr != null && <span className="px-1 py-0.5 rounded bg-muted">vr {s.vr}</span>}
      </div>
      <div className="flex flex-wrap gap-1 text-[9px]">
        {s.smc?.fvg_retest && <span className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-400">FVG retest</span>}
        {s.smc?.sweep_reclaim && <span className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-400">sweep+reclaim</span>}
        {s.smc?.bos && <span className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-400">BOS</span>}
        {s.smc?.hl_intact && <span className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-400">HL intact</span>}
      </div>
      <div className="text-[9px] text-muted-foreground/80">{s.note}</div>
    </div>
  );
}

export function EmaPullbackPanel({ symbol = 'NIFTY' }: { symbol?: string }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery<Payload>({
    queryKey: ['ema-pullback', symbol],
    queryFn: async () => {
      const res = await fetch(`/api/ema-pullback?symbol=${encodeURIComponent(symbol)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Engine failed (HTTP ${res.status})`);
      return json;
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const signals = data?.signals || [];
  const prov = data?.provenance;

  return (
    <Card className="border-border/60">
      <CardHeader className="p-2 pb-1">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-cyan-500" />
            EMA PULLBACK ENGINE v2
            <span className="text-[9px] font-normal text-muted-foreground">
              non-repainting · min 1:2 RR · chop-filtered + SMC
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[9px] bg-cyan-500/10 text-cyan-400">
              {symbol}
            </Badge>
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-2 pt-0 space-y-2">
        {isLoading ? (
          <div className="text-center text-xs text-muted-foreground py-4">
            <Activity className="h-4 w-4 mx-auto mb-1 animate-pulse" />
            Running the engine over real 5m candles…
          </div>
        ) : error ? (
          <div className="text-center text-xs text-red-400 py-3 space-y-1">
            <AlertTriangle className="h-4 w-4 mx-auto" />
            <div>{error.message}</div>
          </div>
        ) : (
          <>
            {/* Gate checklist for the last closed bar */}
            <div className="grid grid-cols-2 gap-2">
              <GateCard side="CE" gate={data?.lastBar?.CE} />
              <GateCard side="PE" gate={data?.lastBar?.PE} />
            </div>

            {/* Provenance */}
            {prov && (
              <div className="flex flex-wrap gap-1 text-[9px] text-muted-foreground">
                <span className="px-1 py-0.5 rounded bg-muted flex items-center gap-1">
                  <Clock className="h-2.5 w-2.5" /> {data?.bars} bars · {data?.first?.slice(0, 16)} → {data?.last?.slice(0, 16)}
                </span>
                <span className="px-1 py-0.5 rounded bg-muted">candles: {prov.candles}</span>
                <span className="px-1 py-0.5 rounded bg-muted">VIX: {prov.vix ?? '—'}</span>
                <span className="px-1 py-0.5 rounded bg-muted">call wall: {prov.callWall ?? '—'}</span>
                <span className="px-1 py-0.5 rounded bg-muted">put wall: {prov.putWall ?? '—'}</span>
                <span className="px-1 py-0.5 rounded bg-muted">chain: {prov.chainSource ?? '—'}</span>
              </div>
            )}

            {/* Signals */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-bold uppercase text-muted-foreground">
                  Signals ({signals.length})
                </span>
                <span className="text-[9px] text-muted-foreground">newest first</span>
              </div>
              {signals.length === 0 ? (
                <div className="text-[10px] text-muted-foreground py-2 text-center">
                  No setup cleared every gate in this window.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
                  {[...signals].reverse().map((s, i) => (
                    <SignalRow key={`${s.time}-${s.side}-${i}`} s={s} />
                  ))}
                </div>
              )}
            </div>

            <div className="text-[9px] text-muted-foreground/80 border-t pt-1.5 flex items-start gap-1">
              <Shield className="h-3 w-3 mt-0.5 shrink-0" />
              <span>
                Educational framework — NOT financial advice. Thresholds are starting values,
                NOT backtested. Optimise on your own data with walk-forward testing.
                Buy-stop at entry; cancel if not filled in 2 bars. Book 50% at T1, stop → breakeven, trail the rest.
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
