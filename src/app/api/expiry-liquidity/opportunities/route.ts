// ─── Expiry Liquidity Opportunities API ───────────────────────────────
// Returns ranked trade opportunities from the Expiry Liquidity Engine

import { NextResponse } from 'next/server';
import { getExpiryLiquidityEngine } from '@/lib/expiry-liquidity/engine';
import { fetchNIFTY50Stocks } from '@/lib/nse-stock-data';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const topN = parseInt(searchParams.get('top') || '10');
    const minScore = parseInt(searchParams.get('minScore') || '0');
    const direction = searchParams.get('direction') || '';
    const signalType = searchParams.get('signal') || '';

    // Get market data
    const stocks = await fetchNIFTY50Stocks();

    // For now, use the engine with mock data structure
    // In production, this would fetch real option chain, futures, etc.
    const engine = (await import('@/lib/expiry-liquidity/engine')).getExpiryLiquidityEngine();

    // Create minimal context for engine
    const context = {
      symbol: 'NIFTY',
      spot: 19500, // Would come from live data
      candles: [],
      optionChain: null,
      futures: null,
      marketBreadth: null,
      sectorHeatmap: null,
      regime: null,
      vix: 15,
      timestamp: Date.now(),
    };

    // Process through engine
    const result = await require('@/lib/expiry-liquidity/engine').getExpiryLiquidityEngine().process({
      symbol: 'NIFTY',
      spot: 19500,
      candles: [],
      optionChain: null,
      futures: null,
      marketBreadth: null,
      sectorHeatmap: null,
      regime: null,
      vix: 15,
      timestamp: Date.now(),
    });

    // For opportunities, we'd scan all symbols
    // For now, return the single result as an array
    const opportunities = result.signal && result.signal !== 'NO_TRADE' && result.signal !== 'WATCH'
      ? [{
        symbol: 'NIFTY',
        name: 'NIFTY 50',
        expiry: 'CURRENT',
        direction: result.direction,
        score: result.expiryScore,
        setup: result.optionFlow,
        entry: result.entry,
        stop: result.stop,
        target1: result.target1,
        target2: result.target2,
        rr: result.riskReward,
        confidence: result.expiryScore >= 80 ? 'VERY_HIGH' : result.expiryScore >= 65 ? 'HIGH' : 'MEDIUM',
        casGap: result.casDislocationPct,
        oiFlow: result.optionFlow,
        volumeRatio: result.volumeRatio,
        ivState: result.ivState,
        futuresConfirmed: result.futuresConfirmed,
        reasons: result.explainability?.why || [],
        risks: result.explainability?.risks || [],
        signal: result.signal,
        status: result.status,
        timestamp: result.timestamp,
      }] : [];

    // Filter by query params
    let filtered = opportunities.filter((o: any) => {
      if (minScore && o.score < minScore) return false;
      if (direction && o.direction !== direction) return false;
      if (signalType && o.signal !== signalType) return false;
      return true;
    });

    // Sort by score descending
    filtered.sort((a: any, b: any) => b.score - a.score);

    return NextResponse.json({
      success: true,
      opportunities: filtered.slice(0, Math.min(topN, 20)),
      totalSymbols: 1,
      avgScore: filtered.length > 0 ? Math.round(filtered.reduce((s: number, o: any) => s + o.score, 0) / filtered.length) : 0,
      topOppCount: filtered.filter((o: any) => o.score >= 70).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Expiry Opportunities API] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Opportunities fetch failed' },
      { status: 500 }
    );
  }
}