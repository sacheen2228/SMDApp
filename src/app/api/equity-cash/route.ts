// Equity Cash API - Analyzes Indian equity cash markets using Auction Theory + Volume Profile

import { analyzeEquityCash } from '@/lib/equity-cash-engine';
import { getHistoricalCandles } from '@/lib/historical-data';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface EquityRequest {
  symbol: string;
  interval?: string;
  limit?: number;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || 'RELIANCE').toUpperCase();
    const interval = searchParams.get('interval') || '5m';
    const limit = Math.min(parseInt(searchParams.get('limit') || '300'), 500);

    // Get historical candles (intraday)
    const candles = await getHistoricalCandles(symbol, interval, limit);

    if (!candles || candles.length < 50) {
      return NextResponse.json({
        success: false,
        error: 'Insufficient data for analysis',
        symbol,
        candlesReceived: candles?.length || 0,
      }, { status: 400 });
    }

    // Get key levels (prev day/week high/low) - would come from daily data
    // For now using recent candles to estimate
    const dailyCandles = await getHistoricalCandles(symbol, '1d', 20);
    const prevDayHigh = dailyCandles[dailyCandles.length - 2]?.high || 0;
    const prevDayLow = dailyCandles[dailyCandles.length - 2]?.low || 0;
    const prevWeekHigh = Math.max(...dailyCandles.slice(-5).map(c => c.high));
    const prevWeekLow = Math.min(...dailyCandles.slice(-5).map(c => c.low));

    const analysis = analyzeEquityCash(symbol, candles, prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow);

    // Build final output
    const output = {
      symbol: analysis.data.symbol,
      regime: analysis.data.regime,
      auctionState: analysis.data.auctionState,
      valueLocation: (() => {
        const p = analysis.data.sessionProfile;
        const price = candles[candles.length - 1]?.close || 0;
        if (price > p.vah) return 'ABOVE_VAH';
        if (price < p.val) return 'BELOW_VAL';
        return 'INSIDE_VALUE';
      })(),
      poc: analysis.data.sessionProfile.poc,
      vah: analysis.data.sessionProfile.vah,
      val: analysis.data.sessionProfile.val,
      liquidityEvent: analysis.data.liquidityLevels.find(l => l.swept)?.type || null,
      structure: analysis.data.structure[analysis.data.structure.length - 1]?.swing.type || null,
      volumeState: `RV: ${analysis.data.relativeVol.ratio.toFixed(2)}x (P${analysis.data.relativeVol.percentile.toFixed(0)})`,
      vwapState: classifyVWAPState(
        candles[candles.length - 1]?.close || 0,
        analysis.data.sessionProfile.sessionVwap,
        candles[candles.length - 2]?.close || 0,
        candles[0]?.open || 0,
        analysis.data.vwapAnchors
      ).state,
      setup: analysis.bestLong?.setup || analysis.bestShort?.setup || null,
      longScore: analysis.bestLong?.signalScore.total || 0,
      shortScore: analysis.bestShort?.signalScore.total || 0,
      entry: analysis.bestLong?.entry.aggressive || analysis.bestShort?.entry.aggressive || 0,
      sl: analysis.bestLong?.stopLoss.price || analysis.bestShort?.stopLoss.price || 0,
      tp1: analysis.bestLong?.targets[0]?.price || analysis.bestShort?.targets[0]?.price || 0,
      tp2: analysis.bestLong?.targets[1]?.price || analysis.bestShort?.targets[1]?.price || 0,
      tp3: analysis.bestLong?.targets[2]?.price || analysis.bestShort?.targets[2]?.price || 0,
      rr: analysis.bestLong?.riskReward || analysis.bestShort?.riskReward || 0,
      signalStrength: analysis.bestLong?.signalScore.strength || analysis.bestShort?.signalScore.strength || 'NO_TRADE',
      historicalExpectancy: analysis.bestLong?.historicalExpectancy || analysis.bestShort?.historicalExpectancy || 0,
      final: analysis.finalDecision,
      details: {
        longSetups: analysis.longSetups,
        shortSetups: analysis.shortSetups,
        regimeCharacteristics: getRegimeCharacteristics(analysis.data.regime),
        liquidityLevels: analysis.data.liquidityLevels.slice(0, 10),
        gaps: analysis.data.gaps.slice(0, 5),
        vwapAnchors: analysis.data.vwapAnchors,
      },
    };

    return NextResponse.json({ success: true, data: output });
  } catch (error: any) {
    console.error('[Equity Cash API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

function classifyVWAPState(currentPrice: number, vwap: number, prevClose: number, sessionOpen: number, anchors: any[]): { state: string } {
  if (currentPrice > vwap && prevClose < vwap) return { state: 'VWAP_RECLAIM' };
  if (currentPrice < vwap && prevClose > vwap) return { state: 'VWAP_REJECTION' };
  return { state: currentPrice > vwap ? 'ABOVE_VWAP' : 'BELOW_VWAP' };
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