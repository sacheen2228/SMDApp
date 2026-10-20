import { NextRequest, NextResponse } from 'next/server';
import { getNSEIndices } from '@/lib/nse-api';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const spotPrice = parseFloat(searchParams.get('spot') || '0');

    // GIFT NIFTY (SGX) is no longer quoted by any free source — the documented
    // proxy is the NSE NIFTY 50 spot, read from the exchange.
    const nseIdx = await getNSEIndices();
    const nifty = nseIdx?.find((i: any) => String(i.key).toUpperCase() === 'NIFTY');
    const data = nifty?.ltp ? { regularMarketPrice: nifty.ltp, previousClose: nifty.prevClose, change: nifty.change, changePct: nifty.changePct, name: nifty.name } : null;
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
        source: 'live',
      });
    }

    // Do NOT fabricate data. If Yahoo fails, return 503 so callers know data is unavailable.
    return NextResponse.json({ success: false, error: 'Gift Nifty data unavailable — Yahoo Finance did not return data' }, { status: 503 });
  } catch (error: any) {
    console.error('[Gift Nifty API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
