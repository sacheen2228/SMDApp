// EMA Pullback Engine v2 — server-side runner.
//
// The engine itself is the Python implementation in
//   skills/ema-pullback-engine/scripts/ema_pullback_engine.py
// (non-repainting: 15m bias + chop filter, 5m trigger, SMC, variance-ratio
// regime gate, min 1:2 RR).
//
// This module feeds it REAL market data and never fabricates anything:
//   * 5m candles      → Breeze (via the canonical candle chain)
//   * India VIX       → the live option chain summary
//   * call/put walls  → the strongest CE / PE OI strike of the live chain
//   * delta           → omitted (we have no buy-vs-sell volume split)
// Every optional column is attached ONLY when it is known, because the
// engine treats a present-but-stale column as a hard gate.
//
// SERVER ONLY — it spawns a python process and imports the candle chain.

import { spawn } from 'child_process';
import path from 'path';
import { getHistoricalCandles } from '@/lib/historical-data';
import { fetchLiveOptionChain } from '@/lib/live-option-chain';

const RUNNER = path.join(
  process.cwd(),
  'skills/ema-pullback-engine/scripts/ema_pullback_runner.py'
);

export interface EmaPullbackSignal {
  time: string;
  side: 'CE' | 'PE';
  status: string;
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
  regime_flip_price: number;
  valid_bars: number;
  smc: { fvg_retest: boolean; sweep_reclaim: boolean; bos: boolean; hl_intact: boolean };
  order_flow_delta_ok: boolean;
  vr: number | null;
  note: string;
}

export interface EmaPullbackGate {
  status: 'VALID' | 'SKIP';
  skip_reasons: string[];
  signal: EmaPullbackSignal | null;
}

export interface EmaPullbackResult {
  ok: boolean;
  error?: string;
  signals: EmaPullbackSignal[];
  lastBar: Record<string, EmaPullbackGate>;
  bars: number;
  first: string | null;
  last: string | null;
  config: Record<string, unknown>;
  provenance: {
    symbol: string;
    candles: string;
    vix: number | null;
    callWall: number | null;
    putWall: number | null;
    delta: 'unavailable';
    chainSource: string | null;
  };
}

/** Epoch-ms → naive IST wall clock ("YYYY-MM-DD HH:MM:SS"). */
function istWallClock(ms: number): string {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** The strongest CE / PE OI strike — the same rule the SDM engine uses. */
function strongestOiWalls(strikes: any[]): { callWall: number | null; putWall: number | null } {
  let maxCeOi = 0;
  let maxPeOi = 0;
  let callWall: number | null = null;
  let putWall: number | null = null;
  for (const s of strikes || []) {
    const ceOi = Number(s?.ce?.oi || 0);
    const peOi = Number(s?.pe?.oi || 0);
    if (ceOi > maxCeOi) {
      maxCeOi = ceOi;
      callWall = Number(s.strike);
    }
    if (peOi > maxPeOi) {
      maxPeOi = peOi;
      putWall = Number(s.strike);
    }
  }
  return { callWall, putWall };
}

function runPython(payload: any, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [RUNNER], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ema pullback engine timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to start python3: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!out.trim()) {
        reject(new Error(`engine produced no output (exit ${code}): ${err.trim().slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`engine output was not JSON: ${out.slice(0, 200)}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export interface RunEmaPullbackOptions {
  symbol?: string;
  bars?: number;
  config?: Record<string, unknown>;
  timeoutMs?: number;
}

// A run costs a Breeze 5m pull (300 bars) + the option chain + a python
// process. The dashboard polls every 2 minutes, so cache for a minute —
// the engine only reads CLOSED bars, so a stale answer is still correct.
const resultCache = new Map<string, { at: number; result: EmaPullbackResult }>();
const RESULT_CACHE_TTL_MS = 60_000;

export async function runEmaPullbackEngine(
  opts: RunEmaPullbackOptions = {}
): Promise<EmaPullbackResult> {
  const symbol = (opts.symbol || 'NIFTY').toUpperCase();
  const bars = Math.min(Math.max(opts.bars || 300, 80), 500);
  const timeoutMs = opts.timeoutMs || 25_000;

  const cacheKey = `${symbol}:${bars}:${JSON.stringify(opts.config || {})}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESULT_CACHE_TTL_MS) {
    return cached.result;
  }

  const empty: EmaPullbackResult = {
    ok: false,
    error: 'No data',
    signals: [],
    lastBar: {},
    bars: 0,
    first: null,
    last: null,
    config: {},
    provenance: {
      symbol,
      candles: 'unavailable',
      vix: null,
      callWall: null,
      putWall: null,
      delta: 'unavailable',
      chainSource: null,
    },
  };

  let candles: Awaited<ReturnType<typeof getHistoricalCandles>> = [];
  try {
    candles = await getHistoricalCandles(symbol, '5m', bars);
  } catch (e: any) {
    return { ...empty, error: `Candle fetch failed: ${e?.message || e}` };
  }

  if (!candles || candles.length < 70) {
    return {
      ...empty,
      error: `Only ${candles?.length || 0} closed 5m bars available — the engine needs at least 70.`,
    };
  }

  // Optional columns — VIX and the OI walls come from the live chain. They
  // are omitted (not zeroed) when the chain is unavailable.
  let vix: number | null = null;
  let callWall: number | null = null;
  let putWall: number | null = null;
  let chainSource: string | null = null;
  try {
    const chain = await fetchLiveOptionChain(symbol);
    if (chain.success && chain.data) {
      chainSource = chain.source;
      const v = (chain.data.summary as any)?.indiaVIX;
      vix = typeof v === 'number' && v > 0 ? v : null;
      const walls = strongestOiWalls(chain.data.data || []);
      callWall = walls.callWall;
      putWall = walls.putWall;
    }
  } catch {
    /* chain unavailable — the engine simply runs without the optional gates */
  }

  const payload: any = {
    candles: candles.map((c) => ({
      datetime: istWallClock(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
  };
  if (vix != null) payload.vix = vix;
  if (callWall != null) payload.call_wall = callWall;
  if (putWall != null) payload.put_wall = putWall;
  if (opts.config) payload.config = opts.config;

  let raw: any;
  try {
    raw = await runPython(payload, timeoutMs);
  } catch (e: any) {
    return { ...empty, error: e?.message || String(e) };
  }

  if (!raw?.ok) {
    return { ...empty, error: raw?.error || 'Engine reported a failure' };
  }

  const result: EmaPullbackResult = {
    ok: true,
    signals: raw.signals || [],
    lastBar: raw.last_bar || {},
    bars: raw.bars || candles.length,
    first: raw.first || null,
    last: raw.last || null,
    config: raw.config || {},
    provenance: {
      symbol,
      candles: 'Breeze 5m (real)',
      vix,
      callWall,
      putWall,
      delta: 'unavailable',
      chainSource,
    },
  };
  resultCache.set(cacheKey, { at: Date.now(), result });
  return result;
}
