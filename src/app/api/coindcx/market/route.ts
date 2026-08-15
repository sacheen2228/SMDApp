import { NextResponse } from 'next/server';
import {
  getAllTickers,
  getTicker,
  getNativeTickers,
  getNativeMarkets,
  getNativeMarketNames,
  getOrderBook,
  getCandles,
  getTrades,
  getMarketsDetails,
} from '@/lib/coindcx/market';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'tickers';
    const market = searchParams.get('market');
    const pair = searchParams.get('pair');
    const interval = searchParams.get('interval') || '15m';
    const limit = parseInt(searchParams.get('limit') || '100');

    switch (action) {
      case 'tickers':
        const tickers = await getAllTickers();
        return NextResponse.json({ success: true, data: tickers });

      case 'ticker':
        if (!market) return NextResponse.json({ error: 'market required' }, { status: 400 });
        const ticker = await getTicker(market);
        return NextResponse.json({ success: true, data: ticker });

      case 'native_tickers':
        const native = await getNativeTickers();
        return NextResponse.json({ success: true, data: native });

      case 'markets':
        const names = await getNativeMarketNames();
        return NextResponse.json({ success: true, data: names });

      case 'markets_details':
        const details = await getMarketsDetails();
        return NextResponse.json({ success: true, data: details });

      case 'native_markets':
        const nativeMarkets = await getNativeMarkets();
        return NextResponse.json({ success: true, data: nativeMarkets });

      case 'orderbook':
        if (!pair) return NextResponse.json({ error: 'pair required (e.g. B-BTC_USDT)' }, { status: 400 });
        const ob = await getOrderBook(pair);
        return NextResponse.json({ success: true, data: ob });

      case 'candles':
        if (!pair) return NextResponse.json({ error: 'pair required' }, { status: 400 });
        // CoinDCX only supports [1m, 15m, 1h, 1d]. Aggregate the standard
        // TradingView timeframes that aren't native:
        //   3m  <- 1m  (3x)
        //   5m  <- 1m  (5x)
        //   30m <- 15m (2x)
        //   2h  <- 1h  (2x)
        //   4h  <- 1h  (4x)
        //   6h  <- 1h  (6x)
        //   1w  <- 1d  (7x)
        //   1M  <- 1d  (30x)
        const aggMap: Record<string, { src: string; n: number }> = {
          '3m': { src: '1m', n: 3 },
          '5m': { src: '1m', n: 5 },
          '30m': { src: '15m', n: 2 },
          '2h': { src: '1h', n: 2 },
          '4h': { src: '1h', n: 4 },
          '6h': { src: '1h', n: 6 },
          '1w': { src: '1d', n: 7 },
          '1M': { src: '1d', n: 30 },
        };
        const spec = aggMap[interval];
        if (spec) {
          const srcBars = await getCandles(pair, spec.src, limit * spec.n + 40);
          const aggregated = aggregateCandles(srcBars, spec.src, spec.n);
          return NextResponse.json({ success: true, data: aggregated });
        }
        const candles = await getCandles(pair, interval, limit);
        return NextResponse.json({ success: true, data: candles });

      case 'trades':
        if (!pair) return NextResponse.json({ error: 'pair required' }, { status: 400 });
        const trades = await getTrades(pair, limit);
        return NextResponse.json({ success: true, data: trades });

      case 'dashboard':
        const allTickers = await getNativeTickers();
        const topMarkets = allTickers.slice(0, 100);
        return NextResponse.json({ success: true, data: topMarkets });

      default:
        return NextResponse.json({ error: 'invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('[CoinDCX Market API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Combine source candles into larger bars by bucketing on epoch minutes.
// srcMin = duration (minutes) of each source bar; n = bars per target bucket.
function aggregateCandles(bars: any[], srcMin: string, n: number) {
  const srcMs = { '1m': 60000, '15m': 900000, '1h': 3600000, '1d': 86400000 } as Record<string, number>;
  const bucketMs = (srcMs[srcMin] || 60000) * n;
  const buckets = new Map<number, any>();
  for (const b of bars) {
    const ms = b.time; // CoinDCX returns epoch ms
    const bucketStart = Math.floor(ms / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, {
        time: bucketStart,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close;
      existing.volume += b.volume || 0;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time).slice(-(Math.floor(bars.length / n)));
}
