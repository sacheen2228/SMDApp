// Equity Universe API - Dynamic NSE/BSE equity scanner with price filter

import { getHistoricalCandles } from '@/lib/historical-data';
import { analyzeEquityCash } from '@/lib/equity-cash-engine';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// In production, this would come from NSE/BSE equity master dump
const EQUITY_UNIVERSE = [
  // Large Cap
  'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY',
  'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'BAJFINANCE',
  'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI',
  'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'NESTLEIND', 'POWERGRID',
  'NTPC', 'ONGC', 'COALINDIA', 'TATAMOTORS', 'TECHM',
  'WIPRO', 'HCLTECH', 'ADANIENT', 'ADANIPORTS', 'JSWSTEEL',
  // Mid Cap
  'VOLTAS', 'CROMPTON', 'HAVELLS', 'DIXON', 'POLYCAB',
  'TRENT', 'DMART', 'ZOMATO', 'PAYTM', 'NYKAA',
  // Liquid Small Cap
  'TATACHEM', 'GODREJCP', 'COLPAL', 'EMAMILTD', 'JUBLFOOD',
];

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const priceFilter = parseInt(searchParams.get('priceFilter') || '1000');
    const interval = searchParams.get('interval') || '5m';
    const limit = Math.min(parseInt(searchParams.get('limit') || '200'), 500);
    const minSignal = parseInt(searchParams.get('minSignal') || '60');
    const customSymbols = searchParams.get('symbols')?.split(',').filter(Boolean);

    const symbols = customSymbols || EQUITY_UNIVERSE;

    // Get prev day/week levels from daily data
    const dailyPromises = symbols.slice(0, 20).map(s =>
      getHistoricalCandles(s, '1d', 10).then(c => ({ symbol: s, daily: c }))
    );
    const dailyResults = await Promise.all(dailyPromises);
    const dailyMap = new Map(dailyResults.map(r => [r.symbol, r.daily]));

    const results: any[] = [];

    for (const symbol of symbols) {
      try {
        const candles = await getHistoricalCandles(symbol, interval, limit);
        if (!candles || candles.length < 50) continue;

        const spot = candles[candles.length - 1].close;

        // Apply price filter (ONLY for cash equity)
        if (spot > priceFilter) continue;

        const daily = dailyMap.get(symbol) || [];
        const prevDayHigh = daily[daily.length - 2]?.high || 0;
        const prevDayLow = daily[daily.length - 2]?.low || 0;
        const prevWeekHigh = Math.max(...daily.slice(-5).map(c => c.high));
        const prevWeekLow = Math.min(...daily.slice(-5).map(c => c.low));

        const analysis = analyzeEquityCash(symbol, candles, prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);

        const longScore = analysis.bestLong?.signalScore?.total ?? 0;
        const shortScore = analysis.bestShort?.signalScore?.total ?? 0;

        if (longScore >= minSignal || shortScore >= minSignal) {
          const best = longScore >= shortScore ? analysis.bestLong : analysis.bestShort;

          if (best && (best.signalScore?.total ?? 0) >= minSignal) {
            results.push({
              symbol,
              name: symbol,
              price: spot,
              changePct: ((candles[candles.length - 1].close - candles[candles.length - 2]?.close) / (candles[candles.length - 2]?.close || 1)) * 100,
              regime: analysis.data.regime,
              signalStrength: best.signalScore?.total ?? 0,
              signalLabel: best.signalScore?.strength ?? 'NO_TRADE',
              setup: best.setup,
              direction: best.direction,
              entry: best.entry.aggressive,
              sl: best.stopLoss.price,
              tp1: best.targets[0]?.price,
              tp2: best.targets[1]?.price,
              tp3: best.targets[2]?.price,
              rr: best.riskReward,
              historicalExpectancy: best.historicalExpectancy,
              priceFilterPassed: true,
              liquidity: analysis.data.liquidityLevels.length,
              gaps: analysis.data.gaps.length,
            });
          }
        }
      } catch (e) {
        // Skip failed symbols
      }
    }

    // Sort by signal strength
    results.sort((a, b) => b.signalStrength - a.signalStrength);

    return Response.json({
      success: true,
      data: {
        scanned: symbols.length,
        filtered: results.length,
        priceFilter,
        minSignal,
        results: results.slice(0, 100),
      },
    });
  } catch (error: any) {
    console.error('[Equity Universe API] Error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}