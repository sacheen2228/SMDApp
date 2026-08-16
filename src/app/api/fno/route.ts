// F&O API - Analyzes Indian Index/Stock Futures & Options using Auction + OI + Option Chain

import { analyzeFno } from '@/lib/fno-engine';
import { getHistoricalCandles } from '@/lib/historical-data';
import { fetchOptionChainSnapshot, fetchFuturesData } from '@/lib/breeze-fno-data';
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

    // Get futures data (real Breeze data - null when unavailable)
    const spotPrice = spotCandles[spotCandles.length - 1]?.close || 0;
    const futures = await fetchFuturesData(symbol, spotPrice);

    // Get option chain (real Breeze data - null when unavailable)
    const optionChain = await fetchOptionChainSnapshot(symbol, spotPrice);

    const analysis = analyzeFno(
      symbol,
      spotPrice,
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