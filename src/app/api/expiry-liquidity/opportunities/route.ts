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

    // Fetch real option chain for NIFTY → OptionChainSnapshot shape
    let spot = 0;
    let vix = 15;
    let optionChain: any = null;
    try {
      const { getNSEOptionChain } = await import('@/lib/nse-api');
      const nseData = await getNSEOptionChain('NIFTY');
      if (nseData?.records?.data) {
        spot = nseData.records.underlyingValue || 0;
        const rawStrikes: any[] = nseData.records.data;
        const strikes = rawStrikes
          .map((s: any) => {
            const strike = Number(s?.strikePrice ?? s?.strike ?? 0);
            const toLeg = (leg: any) => {
              if (!leg) return null;
              const n = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
              return {
                ltp: n(leg.lastPrice ?? leg.ltp),
                prevLtp: n(leg.lastPrice ?? leg.ltp),
                bid: n(leg.bidprice ?? leg.buyPrice1),
                ask: n(leg.askprice ?? leg.sellPrice1),
                bidQty: n(leg.buyQuantity1),
                askQty: n(leg.sellQuantity1),
                volume: n(leg.totalTradedVolume ?? leg.volume),
                prevVolume: n(leg.totalTradedVolume ?? leg.volume),
                oi: n(leg.openInterest ?? leg.oi),
                prevOi: n(leg.openInterest ?? leg.oi),
                oiChange: n(leg.changeinOpenInterest ?? leg.oiChange),
                oiChangePct: n(leg.pchangeinOpenInterest),
                iv: n(leg.impliedVolatility ?? leg.iv),
                prevIv: n(leg.impliedVolatility ?? leg.iv),
                ivChange: 0,
                delta: n(leg.delta),
                gamma: n(leg.gamma),
                theta: n(leg.theta),
                vega: n(leg.vega),
                spread: 0,
                spreadPct: 0,
                premiumVelocity: 0,
                premiumAcceleration: 0,
                ivVelocity: 0,
                ivAcceleration: 0,
                volumeVelocity: 0,
                oiVelocity: 0,
              };
            };
            return {
              strike,
              expiry: String(s?.expiryDate ?? ''),
              ce: toLeg(s?.CE),
              pe: toLeg(s?.PE),
            };
          })
          .filter((s) => s.strike > 0 && (s.ce || s.pe));
        const atmStrike =
          strikes.reduce((best, s) =>
            Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best,
          strikes[0] ?? { strike: 0 })?.strike || 0;
        optionChain = {
          symbol: 'NIFTY',
          spot,
          atmStrike,
          expiry: String(nseData.records.expiryDates?.[0] ?? ''),
          strikes,
          callOiMap: new Map<number, number>(),
          putOiMap: new Map<number, number>(),
          callOiChangeMap: new Map<number, number>(),
          putOiChangeMap: new Map<number, number>(),
          callVolumeMap: new Map<number, number>(),
          putVolumeMap: new Map<number, number>(),
          maxPain: 0,
          pcr: 0,
          ivRank: 0,
          ivPercentile: 0,
          atmIV: 0,
          ivSkew: 0,
        };
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

    let result: any;
    try {
      result = await engine.process({
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
    } catch (engineErr: any) {
      // Never 500 on a bad chain shape — degrade to empty opportunities
      console.error('[Expiry Opportunities] engine.process failed:', engineErr?.message || engineErr);
      return NextResponse.json({
        success: true,
        opportunities: [],
        totalSymbols: 0,
        avgScore: 0,
        topOppCount: 0,
        warning: 'option chain unavailable',
        timestamp: new Date().toISOString(),
      });
    }

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