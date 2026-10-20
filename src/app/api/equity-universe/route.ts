// Equity Universe API - Dynamic NSE/BSE equity scanner with price filter
//
// Honesty notes (2026-10-20 audit):
//   • The candles came from `getHistoricalCandles()` → Breeze → **Yahoo**
//     (banned). The scan now uses the canonical live-capture candle chain
//     (Breeze → MO → NSE index-only) — no Yahoo anywhere.
//   • `scanned: symbols.length` was reported even when NO symbol had any
//     candles, so a dead feed rendered as "0 signals found" instead of
//     "no data". The route now separates requested / analysed.
//   • A failed feed now returns an explicit UNAVAILABLE state with the
//     reason, plus the source + age of the candles that did arrive.

import { analyzeEquityCash } from '@/lib/equity-cash-engine';
import { getDailyBars } from '@/lib/daily-bars';
import { getIntradayCandles } from '@/lib/breeze-historical';
import { NextResponse } from 'next/server';
import { buildCardMeta, getMarketClock, unavailableMeta } from '@/lib/data-freshness';

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

/** Map the dashboard interval to the broker's vocabulary. */
function breezeIntervalFor(interval: string): "1minute" | "5minute" | "15minute" {
  if (interval === "1m") return "1minute";
  if (interval === "15m") return "15minute";
  return "5minute";
}

function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/-/g, '');
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const priceFilter = parseInt(searchParams.get('priceFilter') || '1000');
    const interval = searchParams.get('interval') || '5m';
    const limit = Math.min(parseInt(searchParams.get('limit') || '200'), 500);
    const minSignal = parseInt(searchParams.get('minSignal') || '60');
    const customSymbols = searchParams.get('symbols')?.split(',').filter(Boolean);

    const symbols = customSymbols || EQUITY_UNIVERSE;
    const today = istToday();
    const breezeInterval = breezeIntervalFor(interval);

    // Real daily levels from the exchange's own history (no Yahoo).
    const dailyMap = new Map<string, any[]>();
    await Promise.all(
      symbols.slice(0, 25).map(async (s) => {
        const bars = await getDailyBars(s, 30);
        if (bars.length) dailyMap.set(s, bars);
      }),
    );

    const results: any[] = [];
    const noData: Array<{ symbol: string; reason: string }> = [];
    const candleSources = new Set<string>();
    let analysed = 0;
    let newestCandleMs = 0;

    for (const symbol of symbols) {
      try {
        // Real intraday candles from the broker feed (Breeze). No Yahoo.
        const chain = await getIntradayCandles(symbol, today, breezeInterval);
        const candles = chain.candles || [];
        if (candles.length < 50) {
          noData.push({
            symbol,
            reason: chain.warning || 'No intraday candles returned',
          });
          continue;
        }
        analysed += 1;
        candleSources.add(chain.source || "breeze");
        for (const c of candles) {
          const raw = Number(c.time);
          if (!Number.isFinite(raw)) continue;
          const t = raw > 1e12 ? raw : raw * 1000;
          if (t > newestCandleMs) newestCandleMs = t;
        }

        const spot = Number(candles[candles.length - 1].close);

        // Apply price filter (ONLY for cash equity)
        if (spot > priceFilter) continue;

        const daily = dailyMap.get(symbol) || [];
        // The exchange's daily bars: [n-1] = previous session, [n-6..n-2] = last week.
        const prevSession = daily.length >= 2 ? daily[daily.length - 1] : null;
        const prevDayHigh = prevSession?.h ?? 0;
        const prevDayLow = prevSession?.l ?? 0;
        const lastWeek = daily.slice(-6, -1);
        const prevWeekHigh = lastWeek.length ? Math.max(...lastWeek.map((c) => c.h)) : 0;
        const prevWeekLow = lastWeek.length ? Math.min(...lastWeek.map((c) => c.l)) : 0;

        const analysis = analyzeEquityCash(
          symbol,
          candles as any,
          prevDayHigh,
          prevDayLow,
          prevWeekHigh,
          prevWeekLow,
        );

        const longScore = analysis.bestLong?.signalScore?.total ?? 0;
        const shortScore = analysis.bestShort?.signalScore?.total ?? 0;

        if (longScore >= minSignal || shortScore >= minSignal) {
          const best = longScore >= shortScore ? analysis.bestLong : analysis.bestShort;

          if (best && (best.signalScore?.total ?? 0) >= minSignal) {
            const last = candles[candles.length - 1];
            const prev = candles[candles.length - 2];
            results.push({
              symbol,
              name: symbol,
              price: spot,
              changePct: prev?.close ? ((last.close - prev.close) / prev.close) * 100 : null,
              regime: analysis.data.regime,
              signalStrength: best.signalScore?.total ?? 0,
              signalLabel: best.signalScore?.strength ?? 'NO_TRADE',
              setup: best.setup,
              direction: best.direction,
              entry: best.entry.aggressive,
              sl: best.stopLoss.price,
              tp1: best.targets[0]?.price ?? null,
              tp2: best.targets[1]?.price ?? null,
              tp3: best.targets[2]?.price ?? null,
              rr: best.riskReward,
              historicalExpectancy: best.historicalExpectancy,
              priceFilterPassed: true,
              liquidity: analysis.data.liquidityLevels.length,
              gaps: analysis.data.gaps.length,
              // Provenance of the candles behind this row.
              candleSource: chain.source || "breeze",
              candleInterval: interval,
            });
          }
        }
      } catch (e: any) {
        noData.push({ symbol, reason: e?.message ? String(e.message).slice(0, 120) : 'fetch failed' });
      }
    }

    // Sort by signal strength
    results.sort((a, b) => b.signalStrength - a.signalStrength);

    const clock = await getMarketClock();
    const meta =
      analysed === 0
        ? unavailableMeta('No intraday candles from any source — the scanner cannot run.', 'none')
        : buildCardMeta({
            source: Array.from(candleSources).join("+"),
            providerTimestamp: newestCandleMs ? new Date(newestCandleMs) : null,
            ttlMs: 15 * 60_000,
            live: clock.isOpen,
            reason: clock.isOpen
              ? undefined
              : `Exchange closed — last session ${clock.tradeDateLabel || 'unknown'}`,
          });

    if (analysed === 0) {
      return Response.json({
        success: false,
        status: 'UNAVAILABLE',
        error: meta.reason,
        meta,
        data: {
          scanned: symbols.length,
          analysed: 0,
          filtered: 0,
          noData: noData.length,
          noDataSymbols: noData.slice(0, 25),
          results: [],
        },
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json({
      success: true,
      status: meta.status,
      meta,
      data: {
        scanned: symbols.length,
        analysed,
        filtered: results.length,
        priceFilter,
        minSignal,
        results: results.slice(0, 100),
        noData: noData.length,
        noDataSymbols: noData.slice(0, 25),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[Equity Universe API] Error:', error);
    return Response.json(
      { success: false, status: 'UNAVAILABLE', error: error.message },
      { status: 500 },
    );
  }
}
