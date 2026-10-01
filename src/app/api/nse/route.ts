import { NextRequest, NextResponse } from 'next/server';
import { getNSEOptionChain, getNSEMarketStatus, getNSEGainers, getNSELosers, getNSEIndiaVIX } from '@/lib/nse-api';
import { fetchYahooDailyCandles } from '@/lib/yahoo-finance-api';

// Index symbols the broken nse-bse-api historical path cannot handle
const INDEX_SYMBOLS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50',
  'SENSEX', 'BANKEX', 'INDIAVIX', 'GIFTNIFTY', 'NIFTY50',
]);

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
      case 'historical': {
        const days = Math.min(Number(searchParams.get('days') || 30), 365);
        const isIndex = INDEX_SYMBOLS.has(symbol.toUpperCase()) || symbol.startsWith('^');
        const limit = Math.min(days, 60);

        // Indices: Yahoo free path only (nse-bse-api historical is broken for them)
        if (isIndex) {
          const raw = await fetchYahooDailyCandles(symbol, limit);
          const candles = raw.map((c) => ({
            date: new Date(c.time).toISOString().slice(0, 10),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })).filter((c) => c.close > 0);
          if (candles.length > 0) {
            return NextResponse.json({ success: true, data: candles, source: 'yahoo' });
          }
          return NextResponse.json({ success: false, error: 'No historical data available' }, { status: 404 });
        }

        // Equities: try NSE first, fall back to Yahoo
        try {
          const { getNSEHistoricalData } = await import('@/lib/nse-api');
          const to = new Date();
          const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
          const raw = await getNSEHistoricalData(symbol, from, to);
          let candles: any[] = [];
          if (Array.isArray(raw)) {
            candles = raw;
          } else if (raw && typeof raw === 'object') {
            const anyRaw = raw as any;
            const rows = anyRaw.banks || anyRaw.data || anyRaw.candles || anyRaw.records || [];
            if (Array.isArray(rows)) candles = rows;
          }
          candles = candles
            .map((r: any) => ({
              date: r.date || r.CH_TIMESTAMP || r.timestamp || r.tradeDate || '',
              open: Number(r.open || r.CH_OPENING_PRICE || r.openPrice || 0),
              high: Number(r.high || r.CH_HIGH_PRICE || r.highPrice || 0),
              low: Number(r.low || r.CH_LOW_PRICE || r.lowPrice || 0),
              close: Number(r.close || r.CH_CLOSING_PRICE || r.closePrice || r.CH_LAST_TRADED_PRICE || 0),
              volume: Number(r.volume || r.CH_TOTAL_TRADED_QTY || r.totalTradedVolume || 0),
            }))
            .filter((c: any) => c.close > 0);
          if (candles.length > 0) {
            return NextResponse.json({ success: true, data: candles, source: 'nse' });
          }
        } catch {}

        const raw = await fetchYahooDailyCandles(symbol, limit);
        const candles = raw.map((c) => ({
          date: new Date(c.time).toISOString().slice(0, 10),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })).filter((c) => c.close > 0);
        if (candles.length > 0) {
          return NextResponse.json({ success: true, data: candles, source: 'yahoo' });
        }
        return NextResponse.json({ success: false, error: 'No historical data available' }, { status: 404 });
      }
      case 'vix': {
        const data = await getNSEIndiaVIX();
        if (data) return NextResponse.json({ success: true, data, source: 'nse' });
        try {
          const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1d&range=5d', {
            signal: AbortSignal.timeout(8000),
          });
          const json = await res.json();
          const meta = json?.chart?.result?.[0]?.meta;
          const v = Number(meta?.regularMarketPrice || 0);
          if (v > 0) return NextResponse.json({ success: true, data: { value: v, change: 0 }, source: 'yahoo' });
        } catch {}
        return NextResponse.json({ success: false, error: 'VIX unavailable' }, { status: 404 });
      }
      default:
        return NextResponse.json({ success: false, error: 'Unknown type' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('[NSE API Route] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
