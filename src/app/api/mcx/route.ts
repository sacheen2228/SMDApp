// MCX Commodity Module — API Endpoint
// GET /api/mcx                — MCX market data, session, health
// GET /api/mcx?symbol=CRUDEOIL — single instrument quote
// GET /api/mcx?mode=best       — best scanner trade
// GET /api/mcx?mode=summary    — scanner summary

import { NextResponse } from 'next/server';
import { fetchMCXMarketData, fetchMCXQuote } from '@/lib/mcx/market-data';
import { getMCXSession, getMCXSessionLabel, getMCXSessionColor } from '@/lib/mcx/session';
import { MCX_APPROVED_CONTRACTS } from '@/lib/mcx/types';
import { MCX_CONTRACT_SPECS } from '@/lib/mcx/instrument-master';
import { getBestMCXTrade, getMCXScannerSummary } from '@/lib/mcx/scanner';
import { resolveMCXRouteMode, isApprovedMCXSymbol } from '@/lib/mcx/bridge';

export async function GET(request?: Request) {
  try {
    const { searchParams } = new URL(request?.url || 'http://localhost/api/mcx');
    const mode = resolveMCXRouteMode({
      mode: searchParams.get('mode'),
      symbol: searchParams.get('symbol'),
    });

    const session = getMCXSession();
    const sessionView = {
      state: session.state,
      label: getMCXSessionLabel(session.state),
      color: getMCXSessionColor(session.state),
      isActive: session.isActive,
      description: session.description,
      minutesRemaining: session.minutesRemaining,
      isSignalWindow: session.isSignalWindow,
      signalsAllowed: session.signalsAllowed,
      isTradingDay: session.isTradingDay,
    };

    // ── Single quote ──
    if (mode === 'quote') {
      const symbol = searchParams.get('symbol')!.trim().toUpperCase();
      if (!isApprovedMCXSymbol(symbol)) {
        return NextResponse.json(
          { success: false, error: `Unsupported MCX symbol: ${symbol}` },
          { status: 400 }
        );
      }
      const quote = await fetchMCXQuote(symbol);
      return NextResponse.json({
        success: true,
        session: sessionView,
        symbol,
        quote,
        spec: MCX_CONTRACT_SPECS[symbol],
      });
    }

    // ── Best scanner trade ──
    if (mode === 'best') {
      const bestTrade = await getBestMCXTrade();
      return NextResponse.json({
        success: true,
        session: sessionView,
        bestTrade,
        message: bestTrade ? `Best MCX Trade: ${bestTrade.symbol}` : 'NO VALID MCX TRADE',
      });
    }

    // ── Scanner summary ──
    if (mode === 'summary') {
      const summary = await getMCXScannerSummary();
      return NextResponse.json({ success: true, session: sessionView, ...summary });
    }

    // ── Full market payload ──
    const marketData = await fetchMCXMarketData();

    const byCategory = (category: string) =>
      MCX_APPROVED_CONTRACTS
        .filter(s => MCX_CONTRACT_SPECS[s].category === category)
        .map(s => ({
          ...(marketData.quotes.get(s) || { symbol: s, dataStatus: 'DATA_UNAVAILABLE' }),
          spec: MCX_CONTRACT_SPECS[s],
        }));

    return NextResponse.json({
      success: true,
      session: sessionView,
      data: {
        energy: byCategory('ENERGY'),
        preciousMetals: byCategory('PRECIOUS_METALS'),
      },
      health: marketData.dataHealth,
      lastUpdate: marketData.lastUpdate,
      totalContracts: MCX_APPROVED_CONTRACTS.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to fetch MCX data' },
      { status: 500 }
    );
  }
}
