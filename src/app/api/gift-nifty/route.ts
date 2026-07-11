import { NextRequest, NextResponse } from 'next/server';
import { fetchYahooIndexData } from '@/lib/yahoo-finance-api';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const spotPrice = parseFloat(searchParams.get('spot') || '0');

    const data = await fetchYahooIndexData('GIFTNIFTY');
    if (data) {
      return NextResponse.json({
        success: true,
        price: data.regularMarketPrice,
        change: data.change,
        changePct: data.changePct,
        previousClose: data.previousClose,
        source: 'live',
      });
    }

    // Fallback: use spot price as estimate (Gift Nifty ≈ Nifty spot during market hours)
    if (spotPrice > 0) {
      return NextResponse.json({
        success: true,
        price: spotPrice,
        change: 0,
        changePct: 0,
        previousClose: spotPrice,
        source: 'estimated',
      });
    }

    return NextResponse.json({ success: false, error: 'No data available' }, { status: 503 });
  } catch (error: any) {
    console.error('[Gift Nifty API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
