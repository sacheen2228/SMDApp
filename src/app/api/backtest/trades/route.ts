// ─── Real Trade Backtest API ──────────────────────────────────────────
// Backtests every recorded trade against real historical candles.
// GET /api/backtest/trades
//   ?strategyId=ZERO_HERO_AI  (filter by strategy)
//   ?symbol=NIFTY             (filter by symbol)
//   ?maxTrades=100            (limit trades to backtest, default 100)
//   ?dateFrom=2026-08-01      (filter trades from date)
//   ?dateTo=2026-08-31        (filter trades to date)

import { NextResponse } from 'next/server';
import { backtestAllTrades } from '@/lib/trade-backtest-engine';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const strategyId = searchParams.get('strategyId') || undefined;
    const symbol = searchParams.get('symbol') || undefined;
    const maxTrades = parseInt(searchParams.get('maxTrades') || '100');
    const dateFrom = searchParams.get('dateFrom') || undefined;
    const dateTo = searchParams.get('dateTo') || undefined;

    const result = await backtestAllTrades({
      strategyId,
      symbol,
      maxTrades,
      dateFrom,
      dateTo,
    });

    return NextResponse.json({
      success: true,
      summary: result.summary,
      trades: result.trades,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[TradeBacktest API] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Trade backtest failed' },
      { status: 500 }
    );
  }
}
