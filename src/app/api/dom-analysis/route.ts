// API Route - NSE Equity Derivatives DOM Analysis
// Fetches option chain for F&O equities and analyzes OI buildup, DOM depth

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { runDOMAnalysis, getSingleStockDOM, type DOMSummary } from '@/lib/dom-analysis';

const prisma = new PrismaClient();

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
      const startTime = Date.now();
      const data = await runDOMAnalysis();
      const duration = Date.now() - startTime;
      
      if (save) {
        const targetDate = date ? new Date(date) : new Date();
        await Promise.all(data.map(d => saveDOMAnalysis(d, targetDate)));
      }
      
      return NextResponse.json({
        success: true,
        count: data.length,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
        data,
      });
    }
    
    // Default: top OI buildup across all F&O equities
    const data = await runDOMAnalysis();
    
    const topBuildup = data
      .flatMap(d => d.unusualBuildup.map(u => ({ ...u, symbol: d.symbol, spot: d.spot })))
      .sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg))
      .slice(0, 30);
    
    return NextResponse.json({
      success: true,
      count: data.length,
      timestamp: new Date().toISOString(),
      topBuildup,
      summary: data.map(d => ({
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