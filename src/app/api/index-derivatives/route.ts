// Index Derivatives API - Dynamic contract detection for futures & options

import { getHistoricalCandles } from '@/lib/historical-data';
import { IndexSymbol, INDEX_META, INDEX_UNIVERSE, FuturesContractMeta, OptionsContractMeta } from '@/lib/index-universe';
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

    // Build dynamic contract metadata (in production, fetch from exchange instrument master)
    const futures = buildFuturesContractMeta(symbol, spot);
    const options = buildOptionsContractMeta(symbol, spot);

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
        futures,
        options,
        lastUpdated: Date.now(),
      },
    });
  } catch (error: any) {
    console.error('[Index Derivatives API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

function buildFuturesContractMeta(symbol: IndexSymbol, spot: number): any {
  // In production, fetch from exchange instrument master
  // This is a mock implementation showing the structure
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
    futuresPrice: spot * 1.002, // approximate
    basis: spot * 0.002,
    basisPct: 0.2,
    volume: 100000,
    oi: 50000,
    oiChange: 5000,
    priceChange: spot * 0.01,
    priceChangePct: 1,
    oiState: 'LONG_BUILDUP',
  };
}

function buildOptionsContractMeta(symbol: IndexSymbol, spot: number): any {
  const meta = INDEX_META[symbol];
  const strikeInterval = meta.strikeInterval;
  const atmStrike = Math.round(spot / strikeInterval) * strikeInterval;

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
    // Mock option chain data
    strikesData: strikes.map(strike => ({
      strike,
      expiry: currentExpiry,
      ce: mockOptionMetrics(strike < spot ? 'ITM' : strike > spot ? 'OTM' : 'ATM', spot, strike),
      pe: mockOptionMetrics(strike > spot ? 'ITM' : strike < spot ? 'OTM' : 'ATM', spot, strike),
    })),
    callOiMap: new Map(strikes.map(s => [s, Math.floor(Math.random() * 100000)])),
    putOiMap: new Map(strikes.map(s => [s, Math.floor(Math.random() * 100000)])),
    callOiChangeMap: new Map(),
    putOiChangeMap: new Map(),
    callVolumeMap: new Map(),
    putVolumeMap: new Map(),
    maxPain: atmStrike,
    pcr: 1.0,
    ivRank: 50,
    ivPercentile: 50,
    atmIV: 15,
    ivSkew: 0,
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