// MCX Commodity Module — Scanner API
// GET /api/mcx/scanner — MCX commodity scanner results

import { NextResponse } from 'next/server';
import { runMCXScanner, getBestMCXTrade, getMCXScannerSummary } from '@/lib/mcx/scanner';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode') || 'full'; // 'full' | 'best' | 'summary'

    if (mode === 'best') {
      const best = await getBestMCXTrade();
      return NextResponse.json({
        success: true,
        bestTrade: best,
        message: best ? `Best MCX Trade: ${best.symbol}` : 'NO VALID MCX TRADE',
      });
    }

    if (mode === 'summary') {
      const summary = await getMCXScannerSummary();
      return NextResponse.json({
        success: true,
        ...summary,
      });
    }

    // Full scanner results
    const results = await runMCXScanner();
    const tradeable = results.filter(r => r.grade !== 'NO_TRADE');

    return NextResponse.json({
      success: true,
      totalContracts: results.length,
      tradeableContracts: tradeable.length,
      bestTrade: tradeable.length > 0 ? tradeable[0] : null,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'MCX scanner failed' },
      { status: 500 }
    );
  }
}
