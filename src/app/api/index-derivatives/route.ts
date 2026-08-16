// Index Derivatives API - Dynamic contract detection for futures & options

import { getHistoricalCandles } from '@/lib/historical-data';
import { IndexSymbol, INDEX_META, INDEX_UNIVERSE, FuturesContractMeta, OptionsContractMeta } from '@/lib/index-universe';
import { fetchOptionChainSnapshot, fetchFuturesData } from '@/lib/breeze-fno-data';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase() as IndexSymbol;
    const interval = searchParams.get('interval') || '5m';
    const limit = Math.min(parseInt(searchParams.get('limit') || '300'), 500);

    if (!INDEX_UNIVERSE.includes(symbol)) {
      return NextResponse.json({ success: false, error: 'Invalid index symbol' }, { status: 400 });
    }

    const meta = INDEX_META[symbol];
    const candles = await getHistoricalCandles(symbol, interval, limit);

    if (!candles || candles.length < 2) {
      return NextResponse.json({ success: false, error: 'Insufficient data' }, { status: 400 });
    }

    const spot = candles[candles.length - 1].close;

    // Build dynamic contract metadata (futures + option chain from real Breeze data)
    const [futures, optionChain] = await Promise.all([
      fetchFuturesData(symbol, spot),
      fetchOptionChainSnapshot(symbol, spot),
    ]);

    const futuresContract = buildFuturesContractMeta(symbol, spot, futures);
    const options = buildOptionsContractMeta(symbol, spot, optionChain);

    return NextResponse.json({
      success: true,
      data: {
        symbol,
        name: meta.name,
        exchange: meta.exchange,
        spotPrice: spot,
        spotChange: calculateChange(candles),
        lotSize: meta.lotSize,
        tickSize: meta.tickSize,
        strikeInterval: meta.strikeInterval,
        futures: futuresContract,
        options,
        dataSource: {
          futures: futures ? 'live-breeze' : 'unavailable',
          optionChain: optionChain ? 'live-breeze' : 'unavailable',
        },
        lastUpdated: Date.now(),
      },
    });
  } catch (error: any) {
    console.error('[Index Derivatives API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

function buildFuturesContractMeta(symbol: IndexSymbol, spot: number, futures: any): any {
  const now = new Date();
  const currentExpiry = getCurrentMonthlyExpiry();
  const nextExpiry = getNextMonthlyExpiry();

  return {
    symbol,
    exchange: 'NSE',
    instrumentType: 'FUTIDX',
    currentExpiry,
    nextExpiry,
    availableExpiries: [currentExpiry, nextExpiry, getNextNextMonthlyExpiry()],
    lotSize: INDEX_META[symbol].lotSize,
    tickSize: INDEX_META[symbol].tickSize,
    currentContract: `${symbol}${formatExpiryForContract(currentExpiry)}`,
    nextContract: `${symbol}${formatExpiryForContract(nextExpiry)}`,
    spotPrice: spot,
    futuresPrice: futures?.futures ?? null,
    basis: futures?.basis ?? null,
    basisPct: futures?.basisPct ?? null,
    volume: futures?.volume ?? null,
    oi: futures?.oi ?? null,
    oiChange: futures?.oiChange ?? null,
    priceChange: futures?.priceChange ?? null,
    priceChangePct: futures?.priceChangePct ?? null,
    oiState: futures?.oiState || 'NEUTRAL',
  };
}

function buildOptionsContractMeta(symbol: IndexSymbol, spot: number, chain: any): any {
  const meta = INDEX_META[symbol];
  const strikeInterval = meta.strikeInterval;
  const atmStrike = chain?.atmStrike || Math.round(spot / strikeInterval) * strikeInterval;

  // Build strikes around ATM
  const strikes: number[] = [];
  const range = 20; // 10 ITM, 10 OTM
  for (let i = -range; i <= range; i++) {
    strikes.push(atmStrike + i * strikeInterval);
  }

  const itmCe = strikes.filter(s => s < spot);
  const itmPe = strikes.filter(s => s > spot);
  const otmCe = strikes.filter(s => s > spot);
  const otmPe = strikes.filter(s => s < spot);

  const now = new Date();
  const currentExpiry = getCurrentMonthlyExpiry();
  const nextExpiry = getNextMonthlyExpiry();

  const chainStrikes = chain?.strikes || [];
  const strikesData = strikes.map(strike => {
    const live = chainStrikes.find((s: any) => s.strike === strike);
    const ce = live?.ce || mockOptionMetrics(strike < spot ? 'ITM' : strike > spot ? 'OTM' : 'ATM', spot, strike);
    const pe = live?.pe || mockOptionMetrics(strike > spot ? 'ITM' : strike < spot ? 'OTM' : 'ATM', spot, strike);
    return {
      strike,
      expiry: chain?.expiry || currentExpiry,
      ce,
      pe,
      dataSource: live ? 'live-breeze' : 'unavailable',
    };
  });

  return {
    symbol,
    exchange: meta.exchange,
    instrumentType: 'OPTIDX',
    currentExpiry,
    nextExpiry,
    availableExpiries: [currentExpiry, nextExpiry, getNextNextMonthlyExpiry()],
    lotSize: meta.lotSize,
    tickSize: meta.tickSize,
    strikeInterval,
    atmStrike,
    strikes,
    itmStrikes: { ce: itmCe, pe: itmPe },
    otmStrikes: { ce: otmCe, pe: otmPe },
    strikesData,
    callOiMap: chain?.callOiMap || new Map(strikes.map(s => [s, 0])),
    putOiMap: chain?.putOiMap || new Map(strikes.map(s => [s, 0])),
    callOiChangeMap: chain?.callOiChangeMap || new Map(),
    putOiChangeMap: chain?.putOiChangeMap || new Map(),
    callVolumeMap: chain?.callVolumeMap || new Map(),
    putVolumeMap: chain?.putVolumeMap || new Map(),
    maxPain: chain?.maxPain || atmStrike,
    pcr: chain?.pcr ?? null,
    ivRank: chain?.ivRank ?? null,
    ivPercentile: chain?.ivPercentile ?? null,
    atmIV: chain?.atmIV ?? null,
    ivSkew: chain?.ivSkew ?? null,
    dataSource: chain ? 'live-breeze' : 'unavailable',
  };
}

function mockOptionMetrics(moneyness: string, spot: number, strike: number) {
  const intrinsic = moneyness === 'ITM' ? Math.abs(spot - strike) : 0;
  const timeValue = moneyness === 'ATM' ? 50 : moneyness === 'ITM' ? 20 : 5;
  return {
    ltp: intrinsic + timeValue + Math.random() * 10,
    volume: Math.floor(Math.random() * 50000),
    oi: Math.floor(Math.random() * 100000),
    oiChange: Math.floor(Math.random() * 10000) - 5000,
    iv: 15 + Math.random() * 10,
    bid: intrinsic + timeValue - 2,
    ask: intrinsic + timeValue + 2,
    bidQty: Math.floor(Math.random() * 1000),
    askQty: Math.floor(Math.random() * 1000),
    delta: moneyness === 'ITM' ? 0.7 : moneyness === 'ATM' ? 0.5 : 0.3,
    gamma: 0.01,
    theta: -5,
    vega: 10,
    spread: 4,
    spreadPct: 4,
  };
}

function calculateChange(candles: any[]): { value: number; pct: number } {
  if (candles.length < 2) return { value: 0, pct: 0 };
  const last = candles[candles.length - 1].close;
  const prev = candles[candles.length - 2].close;
  const value = last - prev;
  const pct = (value / prev) * 100;
  return { value: Math.round(value * 100) / 100, pct: Math.round(pct * 100) / 100 };
}

function getCurrentMonthlyExpiry(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  // Last Thursday of current month
  const lastDay = new Date(year, month + 1, 0);
  const day = lastDay.getDate();
  const thursday = day - ((lastDay.getDay() + 3) % 7); // Last Thursday
  const expiry = new Date(year, month, thursday);
  return expiry.toISOString().split('T')[0];
}

function getNextMonthlyExpiry(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // Last Thursday of next month
  const lastDay = new Date(year, month + 1, 0);
  const day = lastDay.getDate();
  const thursday = day - ((lastDay.getDay() + 3) % 7);
  const expiry = new Date(year, month, thursday);
  return expiry.toISOString().split('T')[0];
}

function getNextNextMonthlyExpiry(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 2;
  const lastDay = new Date(year, month + 1, 0);
  const day = lastDay.getDate();
  const thursday = day - ((lastDay.getDay() + 3) % 7);
  const expiry = new Date(year, month, thursday);
  return expiry.toISOString().split('T')[0];
}

function formatExpiryForContract(expiryStr: string): string {
  // Format: 24AUG -> YYMMM
  const date = new Date(expiryStr);
  const year = date.getFullYear().toString().slice(-2);
  const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${year}${month}`;
}