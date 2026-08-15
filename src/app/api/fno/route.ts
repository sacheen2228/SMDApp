// F&O API - Analyzes Indian Index/Stock Futures & Options using Auction + OI + Option Chain

import { analyzeFno } from '@/lib/fno-engine';
import { getHistoricalCandles } from '@/lib/historical-data';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();
    const interval = searchParams.get('interval') || '5m';
    const limit = Math.min(parseInt(searchParams.get('limit') || '300'), 500);

    // Get spot candles
    const spotCandles = await getHistoricalCandles(symbol, interval, limit);

    if (!spotCandles || spotCandles.length < 50) {
      return NextResponse.json({
        success: false,
        error: 'Insufficient spot data',
        symbol,
      }, { status: 400 });
    }

    // Get key levels from daily data
    const dailyCandles = await getHistoricalCandles(symbol, '1d', 20);
    const prevDayHigh = dailyCandles[dailyCandles.length - 2]?.high || 0;
    const prevDayLow = dailyCandles[dailyCandles.length - 2]?.low || 0;
    const prevWeekHigh = Math.max(...dailyCandles.slice(-5).map(c => c.high));
    const prevWeekLow = Math.min(...dailyCandles.slice(-5).map(c => c.low));

    // Get futures data (mock for now - would come from Breeze)
    const futures = getMockFuturesData(symbol, spotCandles[spotCandles.length - 1]?.close || 0);

    // Get option chain (mock for now - would come from Breeze)
    const optionChain = getMockOptionChain(symbol, spotCandles[spotCandles.length - 1]?.close || 0);

    const analysis = analyzeFno(
      symbol,
      spotCandles[spotCandles.length - 1]?.close || 0,
      spotCandles,
      futures,
      optionChain,
      prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow
    );

    const output = {
      underlying: analysis.data.symbol,
      regime: analysis.data.regime,
      auction: analysis.data.auctionState,
      valueLocation: (() => {
        const p = analysis.data.sessionProfile;
        if (analysis.data.spot > p.vah) return 'ABOVE_VAH';
        if (analysis.data.spot < p.val) return 'BELOW_VAL';
        return 'INSIDE_VALUE';
      })(),
      liquidity: analysis.data.liquidityLevels.find(l => l.swept)?.type || null,
      futuresState: analysis.data.futures?.oiState || 'N/A',
      optionChainState: analysis.data.optionChain ? 'LOADED' : 'UNAVAILABLE',
      ivState: analysis.data.ivState,
      greeks: analysis.data.optionChain ? {
        delta: 'N/A', gamma: 'N/A', theta: 'N/A', vega: 'N/A',
      } : 'N/A',
      setup: analysis.bestLong?.setup || analysis.bestShort?.setup || null,
      direction: analysis.finalDecision,
      preferredStrategy: analysis.preferredStrategy,
      entry: analysis.bestLong?.entry.aggressive || analysis.bestShort?.entry.aggressive || 0,
      sl: analysis.bestLong?.stopLoss.price || analysis.bestShort?.stopLoss.price || 0,
      tp1: analysis.bestLong?.targets[0]?.price || analysis.bestShort?.targets[0]?.price || 0,
      tp2: analysis.bestLong?.targets[1]?.price || analysis.bestShort?.targets[1]?.price || 0,
      tp3: analysis.bestLong?.targets[2]?.price || analysis.bestShort?.targets[2]?.price || 0,
      maxLoss: analysis.bestLong?.maxLoss || analysis.bestShort?.maxLoss || 0,
      rr: analysis.bestLong?.riskReward || analysis.bestShort?.riskReward || 0,
      signalStrength: analysis.bestLong?.signalScore.strength || analysis.bestShort?.signalScore.strength || 'NO_TRADE',
      historicalExpectancy: analysis.bestLong?.historicalExpectancy || analysis.bestShort?.historicalExpectancy || 0,
      final: analysis.finalDecision,
      details: {
        longSetups: analysis.longSetups,
        shortSetups: analysis.shortSetups,
        regimeCharacteristics: getRegimeCharacteristics(analysis.data.regime),
        futures: analysis.data.futures,
        optionChain: analysis.data.optionChain ? {
          atmStrike: analysis.data.optionChain.atmStrike,
          pcr: analysis.data.optionChain.pcr,
          ivRank: analysis.data.optionChain.ivRank,
          ivPercentile: analysis.data.optionChain.ivPercentile,
          atmIV: analysis.data.optionChain.atmIV,
        } : null,
        liquidityLevels: analysis.data.liquidityLevels.slice(0, 10),
      },
    };

    return NextResponse.json({ success: true, data: output });
  } catch (error: any) {
    console.error('[F&O API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

function getMockFuturesData(symbol: string, spot: number) {
  // Mock futures data - replace with real Breeze data
  return {
    symbol,
    spot,
    futures: spot * 1.002,
    basis: spot * 0.002,
    basisPct: 0.2,
    volume: 100000,
    oi: 50000,
    oiChange: 5000,
    oiChangePct: 10,
    priceChange: spot * 0.01,
    priceChangePct: 1,
    oiState: 'LONG_BUILDUP' as const,
  };
}

function getMockOptionChain(symbol: string, spot: number) {
  // Mock option chain - replace with real Breeze data
  const atmStrike = Math.round(spot / 50) * 50;
  const strikes: number[] = [];
  for (let i = -10; i <= 10; i++) {
    strikes.push(atmStrike + i * 50);
  }

  const chainStrikes = strikes.map(strike => ({
    strike,
    expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    ce: mockOptionMetrics(strike < spot ? 'ITM' : strike > spot ? 'OTM' : 'ATM'),
    pe: mockOptionMetrics(strike > spot ? 'ITM' : strike < spot ? 'OTM' : 'ATM'),
  }));

  let callOITotal = 0, putOITotal = 0;
  const callOiMap = new Map<number, number>();
  const putOiMap = new Map<number, number>();

  for (const s of chainStrikes) {
    callOiMap.set(s.strike, s.ce.oi);
    putOiMap.set(s.strike, s.pe.oi);
    callOITotal += s.ce.oi;
    putOITotal += s.pe.oi;
  }

  return {
    symbol,
    spot,
    atmStrike,
    expiry: chainStrikes[0]?.expiry || '',
    strikes: chainStrikes,
    callOiMap,
    putOiMap,
    callOiChangeMap: new Map(),
    putOiChangeMap: new Map(),
    callVolumeMap: new Map(),
    putVolumeMap: new Map(),
    maxPain: atmStrike,
    pcr: putOITotal / Math.max(1, callOITotal),
    ivRank: 50,
    ivPercentile: 50,
    atmIV: 15,
    ivSkew: 0,
  };
}

function mockOptionMetrics(moneyness: string) {
  const base = moneyness === 'ITM' ? 100 : moneyness === 'ATM' ? 50 : 10;
  return {
    ltp: base + Math.random() * 20,
    volume: Math.floor(Math.random() * 50000),
    oi: Math.floor(Math.random() * 100000),
    oiChange: Math.floor(Math.random() * 10000) - 5000,
    iv: 15 + Math.random() * 10,
    bid: base - 2,
    ask: base + 2,
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

function getRegimeCharacteristics(regime: string): any {
  const chars: Record<string, any> = {
    TRENDING_UP: { bias: 'BULLISH', tradeable: true },
    TRENDING_DOWN: { bias: 'BEARISH', tradeable: true },
    BALANCED: { bias: 'NEUTRAL', tradeable: true },
    RANGING: { bias: 'NEUTRAL', tradeable: true },
    BREAKOUT: { bias: 'BULLISH', tradeable: true },
    FAILED_BREAKOUT: { bias: 'BEARISH', tradeable: true },
    REVERSAL: { bias: 'NEUTRAL', tradeable: true },
    ACCUMULATION: { bias: 'BULLISH', tradeable: true },
    DISTRIBUTION: { bias: 'BEARISH', tradeable: true },
    HIGH_VOLATILITY: { bias: 'NEUTRAL', tradeable: false },
    LOW_VOLATILITY: { bias: 'NEUTRAL', tradeable: true },
    TRANSITION: { bias: 'NEUTRAL', tradeable: false },
  };
  return chars[regime] || chars.TRANSITION;
}