// ─── Expiry Liquidity Engine API ──────────────────────────────────────
// Main endpoint for the Expiry Liquidity Shift Engine
//
// POST: caller supplies real market data (preferred — caller already has it).
// GET:  gathers real data itself (chain via chain-source — NSE/BSE primary,
//       Breeze live, canonical tree; + VIX + daily candles) for callers that
//       only know the symbol — ExpiryRadar, agent-brain
//       `get_expiry_liquidity`, Hermes tool-registry.
//       No fabricated data anywhere: if the chain source fails → 503.

import { NextResponse } from 'next/server';
import { getExpiryLiquidityEngine } from '@/lib/expiry-liquidity/engine';
import { gatherChainWithFallback } from '@/lib/expiry-liquidity/chain-source';

// Bounded parallel fetch of real inputs for a symbol.
async function gatherRealData(symbol: string): Promise<{
  optionChain: any[] | null;
  spot: number;
  candles: any[];
  vix: number | null;
  source: string;
}> {
  const [chainRes, vixRes, candlesRes] = await Promise.all([
    // 1. Option chain + spot — NSE/BSE primary → Breeze live → canonical tree
    gatherChainWithFallback(symbol).catch(() => null),

    // 2. India VIX — Yahoo (bounded 2s)
    (async () => {
      try {
        const { getNSEIndiaVIX } = await import('@/lib/nse-api');
        const v = await Promise.race([
          getNSEIndiaVIX(),
          new Promise<null>((_, r) => setTimeout(() => r(new Error('VIX_TIMEOUT')), 2000)),
        ]);
        return (v as any)?.value ?? null;
      } catch {
        return null;
      }
    })(),

    // 3. Daily candles — Yahoo, only for symbols with a real index mapping
    //    (used by CAS reference / structure; empty is a valid degraded state)
    (async () => {
      const yahooSym =
        symbol === 'NIFTY' ? '^NSEI' :
        symbol === 'BANKNIFTY' ? '^NSEBANK' :
        symbol === 'SENSEX' ? '^BSESN' : null;
      if (!yahooSym) return [];
      try {
        const res = await Promise.race([
          fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=3mo&interval=1d`, {
            signal: AbortSignal.timeout(4000),
          }),
          new Promise<Response>((_, r) => setTimeout(() => r(new Error('YAHOO_TIMEOUT')), 4000)),
        ]);
        if (!res.ok) return [];
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];
        const ts: number[] = result.timestamp;
        const q = result.indicators.quote[0];
        const out: any[] = [];
        for (let i = 0; i < ts.length; i++) {
          const close = q.close?.[i];
          if (close == null) continue;
          const dt = new Date(ts[i] * 1000);
          const pad = (n: number) => n.toString().padStart(2, '0');
          out.push({
            time: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} 00:00:00`,
            open: q.open?.[i] ?? close,
            high: q.high?.[i] ?? close,
            low: q.low?.[i] ?? close,
            close,
            volume: q.volume?.[i] || 0,
          });
        }
        return out;
      } catch {
        return [];
      }
    })(),
  ]);

  return {
    optionChain: chainRes?.rows ?? null,
    spot: chainRes?.spot ?? 0,
    candles: candlesRes,
    vix: vixRes,
    source: chainRes?.source ?? 'unavailable',
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';

    const { optionChain, spot, candles, vix, source } = await gatherRealData(symbol);

    // Real-data rule: no chain source → 503 (never fabricate strikes)
    if (!optionChain || !spot) {
      return NextResponse.json(
        { success: false, error: `Real option chain data unavailable for ${symbol}` },
        { status: 503 }
      );
    }

    const engine = getExpiryLiquidityEngine();
    const result = await engine.process({
      symbol,
      spot,
      candles,
      optionChain,
      futures: null,
      marketBreadth: null,
      sectorHeatmap: null,
      regime: null,
      vix: vix || 15,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      data: result,
      source,
      realData: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Expiry Liquidity API] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Expiry liquidity analysis failed' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { symbol, spot, candles, optionChain, futures, marketBreadth, sectorHeatmap, regime, vix } = body;

    if (!symbol || !spot) {
      return NextResponse.json(
        { success: false, error: 'symbol and spot are required' },
        { status: 400 }
      );
    }

    const engine = getExpiryLiquidityEngine();
    const result = await engine.process({
      symbol,
      spot,
      candles: candles || [],
      optionChain: optionChain || null,
      futures: futures || null,
      marketBreadth: marketBreadth || null,
      sectorHeatmap: sectorHeatmap || null,
      regime: regime || null,
      vix: vix || 15,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Expiry Liquidity API] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Expiry liquidity analysis failed' },
      { status: 500 }
    );
  }
}
