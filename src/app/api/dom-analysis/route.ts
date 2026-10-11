// API Route - NSE Equity Derivatives DOM Analysis
// Fetches option chain for F&O equities and analyzes OI buildup, DOM depth

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { runDOMAnalysis, getSingleStockDOM, type DOMSummary } from '@/lib/dom-analysis';
import { isTradingDay } from '@/lib/expiry-liquidity/market-session-config';

const prisma = new PrismaClient();

// The universe scan is expensive (~150 symbols). Remember a successful run
// briefly so repeated dashboard polls don't re-hammer NSE.
const UNIVERSE_CACHE_TTL_MS = 5 * 60_000;
// Hard cap for a full scan. 20s NSE timeout × 5 concurrent = 4s per batch worst
// case; 30 batches × (4s + 2s sleep) ≈ 180s is the theoretical max, so 45s is a
// deliberate early stop — and now it actually aborts instead of abandoning.
const UNIVERSE_SCAN_CAP_MS = 45_000;
let universeCache: { at: number; data: DOMSummary[] } | null = null;

/** Run the universe scan with a hard cap. The timeout ABORTS the scan — it
 *  does not merely abandon it — so we never leave ~150 NSE calls running in
 *  the background after the response has been sent. */
async function runUniverseScan(capMs: number): Promise<DOMSummary[]> {
  if (universeCache && Date.now() - universeCache.at < UNIVERSE_CACHE_TTL_MS) {
    return universeCache.data;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), capMs);
  try {
    const data = await runDOMAnalysis(controller.signal);
    universeCache = { at: Date.now(), data };
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Universe scan gated on the exchange calendar, with an explicit reason when
 *  we deliberately returned nothing. An empty `data` with no `reason` should
 *  never reach the client — it is ambiguous between "no OI found" and "did not
 *  look". */
async function getUniverse(capMs = UNIVERSE_SCAN_CAP_MS): Promise<{
  data: DOMSummary[];
  durationMs: number;
  reason?: string;
}> {
  const t0 = Date.now();
  if (!isTradingDay()) {
    return {
      data: [],
      durationMs: Date.now() - t0,
      reason: 'Non-trading day — NSE publishes no new equity OI on weekends or exchange holidays',
    };
  }
  const data = await runUniverseScan(capMs);
  return {
    data,
    durationMs: Date.now() - t0,
    ...(data.length === 0 ? { reason: 'No F&O equity chains returned data' } : {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const all = searchParams.get('all') === 'true';
    const save = searchParams.get('save') === 'true';
    const date = searchParams.get('date'); // YYYY-MM-DD
    
    if (symbol) {
      // Single stock DOM analysis
      const data = await getSingleStockDOM(symbol.toUpperCase());
      if (!data) {
        return NextResponse.json({ success: false, error: 'No data available' }, { status: 404 });
      }
      
      if (save) {
        await saveDOMAnalysis(data, date ? new Date(date) : new Date());
      }
      
      return NextResponse.json({ success: true, data });
    }
    
    if (all) {
      // Full F&O equity universe DOM analysis
      const universe = await getUniverse();
      const duration = universe.durationMs;
      
      if (save && universe.data.length) {
        const targetDate = date ? new Date(date) : new Date();
        await Promise.all(universe.data.map(d => saveDOMAnalysis(d, targetDate)));
      }
      
      return NextResponse.json({
        success: true,
        count: universe.data.length,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
        ...(universe.reason ? { reason: universe.reason } : {}),
        data: universe.data,
      });
    }
    
    // Default: top OI buildup across all F&O equities
    const universe = await getUniverse();
    
    const topBuildup = universe.data
      .flatMap(d => d.unusualBuildup.map(u => ({ ...u, symbol: d.symbol, spot: d.spot })))
      .sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg))
      .slice(0, 30);
    
    return NextResponse.json({
      success: true,
      count: universe.data.length,
      timestamp: new Date().toISOString(),
      ...(universe.reason ? { reason: universe.reason } : {}),
      topBuildup,
      summary: universe.data.map(d => ({
        symbol: d.symbol,
        spot: d.spot,
        pcr: d.pcr,
        maxPain: d.maxPain,
        totalCallOI: d.totalCallOI,
        totalPutOI: d.totalPutOI,
        resistance: d.resistance,
        support: d.support,
        unusualCount: d.unusualBuildup.length,
      })),
    });
    
  } catch (error: any) {
    console.error('[API] DOM Analysis error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch DOM analysis' },
      { status: 500 }
    );
  }
}

async function saveDOMAnalysis(data: DOMSummary, date: Date) {
  try {
    await prisma.domAnalysis.upsert({
      where: {
        symbol_date: {
          symbol: data.symbol,
          date,
        },
      },
      update: {
        spot: data.spot,
        atmStrike: data.atmStrike,
        pcr: data.pcr,
        maxPain: data.maxPain,
        timestamp: new Date(data.timestamp),
        strikes: data.strikes,
        unusualBuildup: data.unusualBuildup,
        resistance: data.resistance,
        support: data.support,
      },
      create: {
        symbol: data.symbol,
        date,
        spot: data.spot,
        atmStrike: data.atmStrike,
        pcr: data.pcr,
        maxPain: data.maxPain,
        expiry: data.strikes[0]?.ce?.expiryDate || '',
        timestamp: new Date(data.timestamp),
        strikes: data.strikes,
        unusualBuildup: data.unusualBuildup,
        resistance: data.resistance,
        support: data.support,
      },
    });
  } catch (e: any) {
    console.error(`[DOM Save] Error for ${data.symbol}:`, e.message);
  }
}