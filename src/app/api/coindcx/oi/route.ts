import { NextResponse } from 'next/server';

// Binance Futures public API proxy for Open Interest data
// CoinDCX spot API doesn't provide OI; Binance futures data is used as a reference

const BINANCE_BASE = 'https://fapi.binance.com';

interface OIResult {
  success: boolean;
  data: {
    symbol: string;
    openInterest: number | null;
    openInterestValue: number | null;
    oiChange5m: number | null;
    oiChange15m: number | null;
    oiChange1h: number | null;
    oiChange4h: number | null;
    oiChange24h: number | null;
    oiHistory: Array<{ time: number; oi: number; value: number }>;
    takerBuyRatio: number | null;
    buyVol: number | null;
    sellVol: number | null;
  };
  source: string;
  error?: string;
}

const CACHE = new Map<string, { data: any; time: number }>();
const CACHE_TTL = 30_000; // 30s

async function fetchWithCache(url: string, key: string) {
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  CACHE.set(key, { data, time: Date.now() });
  return data;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    let symbol = (searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
    // Normalize: remove USDT suffix if needed, Binance needs standard format
    if (!symbol.endsWith('USDT') && !symbol.endsWith('BTC') && !symbol.endsWith('ETH')) {
      symbol = symbol + 'USDT';
    }

    // Real-time OI from Binance
    let oiData: any = null;
    let oiHist: any[] = [];
    let takerData: any = null;

    try {
      oiData = await fetchWithCache(
        `${BINANCE_BASE}/fapi/v1/openInterest?symbol=${symbol}`,
        `oi_${symbol}`
      );
    } catch {
      // Try uppercase variation
      try {
        oiData = await fetchWithCache(
          `${BINANCE_BASE}/fapi/v1/openInterest?symbol=${symbol.replace('USDT', '')}USDT`,
          `oi_${symbol}`
        );
      } catch {}
    }

    // OI history
    try {
      const raw = await fetchWithCache(
        `${BINANCE_BASE}/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=100`,
        `oihist_${symbol}`
      );
      if (Array.isArray(raw)) oiHist = raw;
    } catch {}

    // Taker long/short ratio
    try {
      takerData = await fetchWithCache(
        `${BINANCE_BASE}/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=2`,
        `taker_${symbol}`
      );
    } catch {}

    const currentOi = oiData ? parseFloat(oiData.openInterest) : null;
    const currentValue = currentOi && oiData
      ? currentOi * parseFloat(oiData.openInterest) // will be replaced with sumOpenInterestValue from history
      : null;

    // Compute OI changes from history
    let oiChange5m: number | null = null;
    let oiChange15m: number | null = null;
    let oiChange1h: number | null = null;
    let oiChange4h: number | null = null;
    let oiChange24h: number | null = null;

    if (oiHist.length > 1) {
      const latest = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest);
      // 5m change (one period back)
      if (oiHist.length >= 2) {
        const prev5 = parseFloat(oiHist[oiHist.length - 2].sumOpenInterest);
        oiChange5m = prev5 > 0 ? ((latest - prev5) / prev5) * 100 : null;
      }
      // 15m (3 periods)
      if (oiHist.length >= 3) {
        const prev15 = parseFloat(oiHist[oiHist.length - 3].sumOpenInterest);
        oiChange15m = prev15 > 0 ? ((latest - prev15) / prev15) * 100 : null;
      }
      // 1h (12 periods)
      if (oiHist.length >= 12) {
        const prev1h = parseFloat(oiHist[oiHist.length - 12].sumOpenInterest);
        oiChange1h = prev1h > 0 ? ((latest - prev1h) / prev1h) * 100 : null;
      }
      // 4h (48 periods)
      if (oiHist.length >= 48) {
        const prev4h = parseFloat(oiHist[oiHist.length - 48].sumOpenInterest);
        oiChange4h = prev4h > 0 ? ((latest - prev4h) / prev4h) * 100 : null;
      }
      // 24h (288 periods)
      if (oiHist.length >= 288) {
        const prev24h = parseFloat(oiHist[oiHist.length - 288].sumOpenInterest);
        oiChange24h = prev24h > 0 ? ((latest - prev24h) / prev24h) * 100 : null;
      }
    }

    const result: OIResult = {
      success: currentOi !== null,
      data: {
        symbol,
        openInterest: currentOi,
        openInterestValue: currentValue,
        oiChange5m,
        oiChange15m,
        oiChange1h,
        oiChange4h,
        oiChange24h,
        oiHistory: oiHist.slice(-20).map((h: any) => ({
          time: h.timestamp,
          oi: parseFloat(h.sumOpenInterest),
          value: parseFloat(h.sumOpenInterestValue),
        })),
        takerBuyRatio: Array.isArray(takerData) && takerData.length > 0
          ? parseFloat(takerData[takerData.length - 1].buySellRatio) : null,
        buyVol: Array.isArray(takerData) && takerData.length > 0
          ? parseFloat(takerData[takerData.length - 1].buyVol) : null,
        sellVol: Array.isArray(takerData) && takerData.length > 0
          ? parseFloat(takerData[takerData.length - 1].sellVol) : null,
      },
      source: 'binance_futures',
    };

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message,
      data: {
        symbol: '', openInterest: null, openInterestValue: null,
        oiChange5m: null, oiChange15m: null, oiChange1h: null,
        oiChange4h: null, oiChange24h: null, oiHistory: [],
        takerBuyRatio: null, buyVol: null, sellVol: null,
      },
      source: 'error',
    }, { status: 200 });
  }
}
