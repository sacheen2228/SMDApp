// ─── Expiry Liquidity Engine API ──────────────────────────────────────
// Main endpoint for the Expiry Liquidity Shift Engine

import { NextResponse } from 'next/server';
import { getExpiryLiquidityEngine } from '@/lib/expiry-liquidity/engine';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';

    // GET endpoint requires real data via POST — do not fabricate data
    return NextResponse.json({
      success: false,
      error: 'GET endpoint not supported — use POST with real market data (symbol, spot, optionChain, etc.)',
      hint: 'POST /api/expiry-liquidity with { symbol, spot, candles, optionChain, futures, vix }',
    }, { status: 400 });
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