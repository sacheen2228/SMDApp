import { NextRequest, NextResponse } from 'next/server';
import { getNSEIndices } from '@/lib/nse-api';

// GIFT NIFTY (SGX) is no longer quoted by any free source. The ONLY honest
// source this route can use is the NSE NIFTY 50 spot, which is a PROXY for the
// overnight GIFT NIFTY gap — NOT the SGX contract itself. Every response is
// therefore labelled `isProxy: true` so no caller can present it as the real
// GIFT NIFTY. There is no Yahoo fallback (Yahoo is not a data source here).

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    // `spot` is accepted for backwards-compatible callers but the exchange
    // spot below is always authoritative.
    const _spot = parseFloat(searchParams.get('spot') || '0');

    // Single source: exchange (NSE) NIFTY 50 spot.
    let data: {
      regularMarketPrice: number;
      previousClose: number;
      change: number;
      changePct: number;
      name: string;
    } | null = null;
    try {
      const nseIdx = await getNSEIndices();
      const nifty = nseIdx?.find((i: any) => String(i.key).toUpperCase() === 'NIFTY');
      if (nifty?.ltp && nifty?.prevClose) {
        data = {
          regularMarketPrice: nifty.ltp,
          previousClose: nifty.prevClose,
          change: nifty.change,
          changePct: nifty.changePct,
          name: nifty.name,
        };
      }
    } catch {
      // no data — fall through to the honest 503 below
    }

    if (data && data.regularMarketPrice && data.previousClose) {
      const gap = data.regularMarketPrice - data.previousClose;
      return NextResponse.json({
        success: true,
        price: data.regularMarketPrice,
        change: data.change,
        changePct: data.changePct,
        previousClose: data.previousClose,
        gap,
        gapPct: data.previousClose > 0 ? (gap / data.previousClose) * 100 : 0,
        source: 'nse',
        // Honest provenance: the GIFT NIFTY (SGX) contract is not available;
        // this is the NSE NIFTY 50 spot used as an overnight-gap proxy.
        isProxy: true,
        proxyFor: 'GIFTNIFTY',
        proxySource: 'NSE NIFTY 50 spot',
        label: 'NIFTY 50 spot (GIFT NIFTY proxy)',
        timestamp: new Date().toISOString(),
        freshness: 'LIVE',
      });
    }

    // Do NOT fabricate data. If NSE is unavailable, return 503 so callers know
    // the (proxy) data is unavailable.
    return NextResponse.json(
      { success: false, error: 'Gift Nifty proxy unavailable — NSE NIFTY 50 spot did not load' },
      { status: 503 },
    );
  } catch (error: any) {
    console.error('[Gift Nifty API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
