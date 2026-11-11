import { NextRequest, NextResponse } from 'next/server';
import { fetchLiveOptionChain } from '@/lib/live-option-chain';
import { runDynamicOptionsEngine, type DynamicOptionsInput, validateOptionChainData } from '@/lib/dynamic-options-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get('symbol') || 'NIFTY';

    const chainResult = await fetchLiveOptionChain(symbol);

    if (!chainResult.success || !chainResult.data) {
      return NextResponse.json({
        success: false,
        error: chainResult.error || 'Failed to fetch option chain data',
      }, { status: 503 });
    }

    const { data } = chainResult;

    const input: DynamicOptionsInput = {
      symbol,
      spot: data.summary.spotPrice,
      // Never invent VIX=15. Missing VIX fails validation instead of faking a
      // tradeable volatility regime; the engine still uses it as a real
      // Greeks fallback only when the chain omits per-strike IV.
      vix: data.summary.indiaVIX ?? 0,
      pcr: data.summary.pcr,
      maxPain: data.summary.maxPain,
      atmStrike: data.summary.atmStrike,
      expiryDate:
        (data as any).expiryIso ||
        (data as any).selectedExpiry ||
        (data as any).expiry ||
        data.summary.expiryDate ||
        undefined,
      strikes: (data.data || []).map((row: any) => ({
        strike: row.strike,
        ce: {
          ltp: row.ce?.ltp || 0,
          // 0 = quote unavailable. Never pair a fake 0 bid with LTP as ask —
          // that manufactured a 100% spread and false "spread >50%" blocks.
          bid: row.ce?.bid ?? 0,
          ask: row.ce?.ask ?? 0,
          oi: row.ce?.oi || row.ce?.openInterest || 0,
          oiChg: row.ce?.oiChg || 0,
          volume: row.ce?.volume || 0,
          iv: row.ce?.iv || 0,
          delta: row.ce?.delta || 0,
          gamma: row.ce?.gamma || 0,
          theta: row.ce?.theta || 0,
          vega: row.ce?.vega || 0,
        },
        pe: {
          ltp: row.pe?.ltp || 0,
          bid: row.pe?.bid ?? 0,
          ask: row.pe?.ask ?? 0,
          oi: row.pe?.oi || row.pe?.openInterest || 0,
          oiChg: row.pe?.oiChg || 0,
          volume: row.pe?.volume || 0,
          iv: row.pe?.iv || 0,
          delta: row.pe?.delta || 0,
          gamma: row.pe?.gamma || 0,
          theta: row.pe?.theta || 0,
          vega: row.pe?.vega || 0,
        },
      })),
      totalCallOI: data.summary.totalCallOI,
      totalPutOI: data.summary.totalPutOI,
      callOiChg: data.summary.callOiChange,
      putOiChg: data.summary.putOiChange,
      lotSize: symbol === 'SENSEX' ? 15 : 50,
    };

    // V2: Validate option chain data before scoring
    const validation = validateOptionChainData(input);
    if (!validation.valid) {
      return NextResponse.json({
        success: false,
        error: 'Invalid option chain data',
        details: validation.errors,
      }, { status: 503 });
    }

    const result = runDynamicOptionsEngine(input);

    return NextResponse.json({
      success: true,
      source: chainResult.source,
      data: result,
      validation: { warnings: validation.warnings },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Options Edge API] Error:', error.message);
    return NextResponse.json({
      success: false,
      error: error.message,
    }, { status: 500 });
  }
}
