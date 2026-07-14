import { NextRequest, NextResponse } from 'next/server';
import { fetchYahooIndexData } from '@/lib/yahoo-finance-api';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const spotPrice = parseFloat(searchParams.get('spot') || '0');

    const data = await fetchYahooIndexData('GIFTNIFTY');
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
