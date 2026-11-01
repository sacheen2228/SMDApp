// EMA Pullback Engine v2 — API route.
//
// GET /api/ema-pullback?symbol=NIFTY&bars=300
//
// Runs the non-repainting EMA-pullback engine over REAL 5m candles and
// returns (a) the gate checklist for the last closed bar (CE + PE) and
// (b) every signal the scan produced. Fails closed — no candles, no engine.

import { NextRequest, NextResponse } from 'next/server';
import { runEmaPullbackEngine } from '@/lib/ema-pullback-engine';
import { isPlausibleOptionSymbol } from '@/lib/stockUniverse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();

    if (!isPlausibleOptionSymbol(symbol)) {
      return NextResponse.json(
        { success: false, error: `Invalid symbol: ${symbol}` },
        { status: 400 }
      );
    }

    const bars = Math.min(Math.max(parseInt(searchParams.get('bars') || '300', 10) || 300, 80), 500);

    const result = await runEmaPullbackEngine({ symbol, bars });

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Engine unavailable',
          symbol,
          provenance: result.provenance,
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      success: true,
      symbol,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[EmaPullback] Error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'EMA pullback engine failed' },
      { status: 500 }
    );
  }
}
