import { NextResponse } from 'next/server';

const CACHE = new Map<string, { data: any; time: number }>();
const CACHE_TTL = 15_000;

async function fetchAllFundingRates() {
  const cached = CACHE.get('all_rates');
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
  const res = await fetch(
    'https://public.coindcx.com/market_data/v3/current_prices/futures/rt',
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  CACHE.set('all_rates', { data, time: Date.now() });
  return data;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || '';

    const data = await fetchAllFundingRates();
    const prices: Record<string, any> = data.prices || {};

    // If a symbol is specified, return only that pair's data
    if (symbol) {
      // Try to find the pair, converting symbol formats
      const pairKey = Object.keys(prices).find(
        k => k.replace('B-', '').replace('_', '').toUpperCase() === symbol.toUpperCase()
          || k.toUpperCase() === `B-${symbol.toUpperCase()}`
          || k.toUpperCase().replace('B-', '').replace('_USDT', '') === symbol.toUpperCase().replace('USDT', ''),
      );

      if (pairKey) {
        const p = prices[pairKey];
        return NextResponse.json({
          success: true,
          data: {
            symbol: pairKey,
            currentRate: p.fr ?? null,
            predictedRate: p.efr ?? null,
            lastPrice: p.ls ?? null,
            markPrice: p.mp ?? null,
            volume: p.v ?? null,
            high24h: p.h ?? null,
            low24h: p.l ?? null,
            priceChange: p.pc ?? null,
          },
          source: 'coindcx_futures',
        });
      }

      return NextResponse.json({
        success: false,
        error: `No funding data found for ${symbol}`,
        data: null,
        source: 'coindcx_futures',
      });
    }

    // Return all funding rates (aggregated)
    const all = Object.entries(prices).map(([k, v]: [string, any]) => ({
      symbol: k,
      currentRate: v.fr ?? null,
      predictedRate: v.efr ?? null,
      lastPrice: v.ls ?? null,
    }));

    return NextResponse.json({
      success: true,
      count: all.length,
      data: all,
      source: 'coindcx_futures',
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message,
      data: null,
      source: 'error',
    }, { status: 200 });
  }
}
