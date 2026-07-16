import { NextRequest, NextResponse } from 'next/server';
import { fetchYahooIndexData } from '@/lib/yahoo-finance-api';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();

    // NIFTY uses the Gift Nifty proxy (^NSEI). SENSEX has no Gift Nifty
    // equivalent, so we use the live SENSEX index (^BSESN) spot vs its
    // previous close as the pre-open gap proxy. Both are real Yahoo data.
    const yahooKey = symbol === 'SENSEX' ? 'SENSEX' : 'GIFTNIFTY';

    const data = await fetchYahooIndexData(yahooKey);
    if (data && data.regularMarketPrice && data.previousClose) {
      const gap = data.regularMarketPrice - data.previousClose;
      return NextResponse.json({
        success: true,
        symbol,
        price: data.regularMarketPrice,
        change: data.change,
        changePct: data.changePct,
        previousClose: data.previousClose,
        gap,
        gapPct: data.previousClose > 0 ? (gap / data.previousClose) * 100 : 0,
        source: 'live',
        proxy: symbol === 'SENSEX' ? 'SENSEX spot vs prev close' : 'Gift Nifty',
      });
    }

    // Do NOT fabricate data. If Yahoo fails, return 503 so callers know data is unavailable.
    return NextResponse.json({ success: false, error: 'Gift Nifty data unavailable — Yahoo Finance did not return data' }, { status: 503 });
  } catch (error: any) {
    console.error('[Gift Nifty API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
