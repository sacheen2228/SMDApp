// ─── Expiry Liquidity Engine API ──────────────────────────────────────
// Main endpoint for the Expiry Liquidity Shift Engine

import { NextResponse } from 'next/server';
import { getExpiryLiquidityEngine } from '@/lib/expiry-liquidity/engine';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const includeDetails = searchParams.get('details') === 'true';

    const engine = getExpiryLiquidityEngine();

    // In production, this would fetch real live data
    // For now, return the engine output structure
    const result = await getExpiryLiquidityEngine().process({
      symbol,
      spot: 0,
      candles: [],
      optionChain: null,
      futures: null,
      marketBreadth: null,
      sectorHeatmap: null,
      regime: null,
      vix: 15,
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