import { NextRequest, NextResponse } from 'next/server';
import { fetchLiveOptionChain } from '@/lib/live-option-chain';
import { runDynamicOptionsEngine, type DynamicOptionsInput } from '@/lib/dynamic-options-engine';

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
      vix: data.summary.indiaVIX || 15,
      pcr: data.summary.pcr,
      maxPain: data.summary.maxPain,
      atmStrike: data.summary.atmStrike,
      strikes: (data.data || []).map((row: any) => ({
        strike: row.strike,
        ce: {
          ltp: row.ce?.ltp || 0,
          bid: row.ce?.bid || 0,
          ask: row.ce?.ask || row.ce?.ltp || 0,
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
          bid: row.pe?.bid || 0,
          ask: row.pe?.ask || row.pe?.ltp || 0,
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

    const result = runDynamicOptionsEngine(input);

    return NextResponse.json({
      success: true,
      source: chainResult.source,
      data: result,
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
