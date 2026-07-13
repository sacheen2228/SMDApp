// API Route - BSE DOM Analysis for SENSEX/BANKEX
// Uses BSE India API for option chain data

import { NextRequest, NextResponse } from 'next/server';
import { getBSEOptionChain, getBSEExpiryDates, isBSEIndex } from '@/lib/bse-api';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface BSEDOMStrike {
  strike: number;
  ce: {
    oi: number;
    oiChg: number;
    volume: number;
    ltp: number;
    iv: number;
    bid: number;
    ask: number;
    chg: number;
  } | null;
  pe: {
    oi: number;
    oiChg: number;
    volume: number;
    ltp: number;
    iv: number;
    bid: number;
    ask: number;
    chg: number;
  } | null;
}

interface BSEDOMSummary {
  symbol: string;
  spot: number;
  atmStrike: number;
  timestamp: string;
  maxPain: number;
  pcr: number;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVol: number;
  totalPutVol: number;
  strikes: BSEDOMStrike[];
  resistance: number[];
  support: number[];
  unusualBuildup: {
    strike: number;
    type: 'CE' | 'PE';
    oiChg: number;
    volume: number;
    ltp: number;
    interpretation: string;
  }[];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol')?.toUpperCase();
    const save = searchParams.get('save') === 'true';
    
    if (!symbol || !isBSEIndex(symbol)) {
      return NextResponse.json({ success: false, error: 'Invalid BSE symbol. Use SENSEX or BANKEX' }, { status: 400 });
    }

    const expiries = await getBSEExpiryDates(symbol);
    if (!expiries.length) {
      return NextResponse.json({ success: false, error: 'No expiries found' }, { status: 404 });
    }

    const nearestExpiry = expiries[0];
    const data = await getBSEOptionChain(symbol, nearestExpiry);
    
    if (!data?.data?.length) {
      return NextResponse.json({ success: false, error: 'No option chain data' }, { status: 404 });
    }

    const strikes = data.data;
    const spot = data.spotPrice;
    
    // Find ATM strike
    const allStrikes = [...new Set(strikes.map(s => s.strike))].sort((a, b) => a - b);
    let atmStrike = allStrikes[0];
    let minDiff = Infinity;
    for (const s of allStrikes) {
      const diff = Math.abs(s - spot);
      if (diff < minDiff) { minDiff = diff; atmStrike = s; }
    }

    // Process strikes
    const processedStrikes = strikes.map(s => ({
      strike: s.strike,
      ce: s.ce ? {
        oi: s.ce.oi || 0,
        oiChg: s.ce.oiChg || 0,
        volume: s.ce.volume || 0,
        ltp: s.ce.ltp || 0,
        iv: s.ce.iv || 0,
        bid: s.ce.bid || 0,
        ask: s.ce.ask || 0,
        chg: s.ce.chg || 0,
      } : null,
      pe: s.pe ? {
        oi: s.pe.oi || 0,
        oiChg: s.pe.oiChg || 0,
        volume: s.pe.volume || 0,
        ltp: s.pe.ltp || 0,
        iv: s.pe.iv || 0,
        bid: s.pe.bid || 0,
        ask: s.pe.ask || 0,
        chg: s.pe.chg || 0,
      } : null,
    }));

    // Calculate metrics
    const totalCallOI = processedStrikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
    const totalPutOI = processedStrikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
    
    const totalCallVol = processedStrikes.reduce((sum, s) => sum + (s.ce?.volume || 0), 0);
    const totalPutVol = processedStrikes.reduce((sum, s) => sum + (s.pe?.volume || 0), 0);

    // Max Pain
    let maxPain = atmStrike;
    let maxTotalOI = 0;
    for (const s of processedStrikes) {
      const total = (s.ce?.oi || 0) + (s.pe?.oi || 0);
      if (total > maxTotalOI) { maxTotalOI = total; maxPain = s.strike; }
    }

    // Resistance/Support
    const resistance = processedStrikes
      .filter(s => s.ce?.oi > 0)
      .sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0))
      .slice(0, 5)
      .map(s => s.strike);

    const support = processedStrikes
      .filter(s => s.pe?.oi > 0)
      .sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0))
      .slice(0, 5)
      .map(s => s.strike);

    // Unusual Buildup
    const threshold = 5000;
    const unusualBuildup: BSEDOMSummary['unusualBuildup'] = [];
    
    for (const s of processedStrikes) {
      if (s.ce && s.ce.oiChg > threshold) {
        unusualBuildup.push({
          strike: s.strike,
          type: 'CE',
          oiChg: s.ce.oiChg,
          volume: s.ce.volume,
          ltp: s.ce.ltp,
          interpretation: s.strike > spot ? 'Call Writing (Resistance)' : 'Call Unwinding',
        });
      }
      if (s.pe && s.pe.oiChg > threshold) {
        unusualBuildup.push({
          strike: s.strike,
          type: 'PE',
          oiChg: s.pe.oiChg,
          volume: s.pe.volume,
          ltp: s.pe.ltp,
          interpretation: s.strike < spot ? 'Put Writing (Support)' : 'Put Unwinding',
        });
      }
      if (s.ce && s.ce.oiChg < -threshold) {
        unusualBuildup.push({
          strike: s.strike,
          type: 'CE',
          oiChg: s.ce.oiChg,
          volume: s.ce.volume,
          ltp: s.ce.ltp,
          interpretation: 'Call Unwinding',
        });
      }
      if (s.pe && s.pe.oiChg < -threshold) {
        unusualBuildup.push({
          strike: s.strike,
          type: 'PE',
          oiChg: s.pe.oiChg,
          volume: s.pe.volume,
          ltp: s.pe.ltp,
          interpretation: 'Put Unwinding',
        });
      }
    }

    const result: BSEDOMSummary = {
      symbol,
      spot,
      atmStrike,
      timestamp: new Date().toISOString(),
      maxPain,
      pcr,
      totalCallOI,
      totalPutOI,
      totalCallVol,
      totalPutVol,
      strikes: processedStrikes,
      resistance,
      support,
      unusualBuildup: unusualBuildup.sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 10),
    };

    // Save to DB
    if (save) {
      try {
        const today = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(today.getTime() + istOffset + today.getTimezoneOffset() * 60 * 1000);
        istDate.setHours(0, 0, 0, 0);
        
        await prisma.domAnalysis.upsert({
          where: { symbol_date: { symbol, date: istDate } },
          update: {
            spot, atmStrike, pcr, maxPain, expiry: nearestExpiry,
            timestamp: new Date(),
            strikes: processedStrikes,
            unusualBuildup: result.unusualBuildup,
            resistance, support,
          },
          create: {
            symbol, date: istDate, spot, atmStrike, pcr, maxPain, expiry: nearestExpiry,
            timestamp: new Date(), strikes: processedStrikes,
            unusualBuildup: result.unusualBuildup, resistance, support,
          },
        });
      } catch (e) {
        console.error('[BSE DOM Save] Error:', e);
      }
    }

    return NextResponse.json({ success: true, data: result });
    
  } catch (error: any) {
    console.error('[BSE DOM Analysis] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch BSE DOM analysis' },
      { status: 500 }
    );
  }
}