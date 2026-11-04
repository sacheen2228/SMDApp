import { NextRequest, NextResponse } from 'next/server';
import { getNSEIndices } from '@/lib/nse-api';

// GIFT NIFTY (SGX) is no longer quoted by any free source — the documented
// proxy is the NSE NIFTY 50 spot (AGENTS.md: Gift NIFTY → `^NSEI`).
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface YahooQuote {
  regularMarketPrice: number;
  previousClose: number;
  change: number;
  changePct: number;
  name: string;
}

/**
 * NIFTY 50 spot from Yahoo (`^NSEI`). Secondary source: NSE can be
 * IP-blocked (Akamai 403), in which case the primary returns nothing.
 */
async function fetchYahooNifty(): Promise<YahooQuote | null> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1d&interval=1d';
    const res = await fetch(url, {
      headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const prevClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(prevClose) || prevClose <= 0) return null;
    const change = price - prevClose;
    return {
      regularMarketPrice: price,
      previousClose: prevClose,
      change,
      changePct: (change / prevClose) * 100,
      name: 'NIFTY 50',
    };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const spotPrice = parseFloat(searchParams.get('spot') || '0');

    // Primary: exchange (NSE) spot.
    let data: YahooQuote | null = null;
    let source = 'live';
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
      // fall through to Yahoo
    }

    // Secondary: Yahoo `^NSEI` (the documented proxy).
    if (!data) {
      data = await fetchYahooNifty();
      source = 'yahoo';
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
        source,
      });
    }

    // Do NOT fabricate data. If both sources fail, return 503 so callers know
    // data is unavailable.
    return NextResponse.json(
      { success: false, error: 'Gift Nifty data unavailable — NSE and Yahoo both failed' },
      { status: 503 },
    );
  } catch (error: any) {
    console.error('[Gift Nifty API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
