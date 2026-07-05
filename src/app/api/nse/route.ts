import { NextRequest, NextResponse } from 'next/server';
import { getNSEOptionChain, getNSEMarketStatus, getNSEGainers, getNSELosers } from '@/lib/nse-api';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'option-chain';
    const symbol = searchParams.get('symbol') || 'NIFTY';

    switch (type) {
      case 'option-chain': {
        const data = await getNSEOptionChain(symbol);
        return NextResponse.json({ success: !!data, data, source: 'nse' });
      }
      case 'market-status': {
        const data = await getNSEMarketStatus();
        return NextResponse.json({ success: !!data, data, source: 'nse' });
      }
      case 'gainers': {
        const data = await getNSEGainers();
        return NextResponse.json({ success: data.length > 0, data, source: 'nse' });
      }
      case 'losers': {
        const data = await getNSELosers();
        return NextResponse.json({ success: data.length > 0, data, source: 'nse' });
      }
      default:
        return NextResponse.json({ success: false, error: 'Unknown type' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('[NSE API Route] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
