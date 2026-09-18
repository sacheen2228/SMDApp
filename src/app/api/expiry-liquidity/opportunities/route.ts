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

    // Fetch real market data
    const stocks = await fetchNIFTY50Stocks();

    // Fetch real option chain for NIFTY
    let spot = 0;
    let vix = 15;
    let optionChain = null;
    try {
      const { getNSEOptionChain } = await import('@/lib/nse-api');
      const nseData = await getNSEOptionChain('NIFTY');
      if (nseData?.records?.data) {
        spot = nseData.records.underlyingValue || 0;
        optionChain = nseData.records.data;
      }
    } catch {}

    // Fetch live VIX
    try {
      const vixRes = await fetch('https://www.nseindia.com/api/allIndices', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).then(d => {
        const vixIdx = d?.data?.find((i: any) => i.index === 'INDIA VIX');
        return vixIdx?.last ? parseFloat(vixIdx.last) : null;
      });
      if (vixRes && vixRes > 0) vix = vixRes;
    } catch {}

    if (!spot || spot <= 0) {
      return NextResponse.json({
        success: false,
        error: 'Could not fetch real market data — no opportunities to return',
      }, { status: 503 });
    }

    const engine = (await import('@/lib/expiry-liquidity/engine')).getExpiryLiquidityEngine();

    const result = await engine.process({
      symbol: 'NIFTY',
      spot,
      candles: [],
      optionChain,
      futures: null,
      marketBreadth: null,
      sectorHeatmap: null,
      regime: null,
      vix,
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