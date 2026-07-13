// Daily DOM Analysis Cron - Runs after 7:30 PM IST
// Fetches F&O equity option chains with OI changes for next-day analysis
// Stores results in DB for quick retrieval

import { NextRequest, NextResponse } from 'next/server';
import { NSEClient } from 'nse-bse-api/nse';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const client = new NSEClient('./downloads', { timeout: 20000 });

const SECRET = process.env.DAILY_SCAN_SECRET || 'sdm-cron-9f3a2b';

interface DOMResult {
  symbol: string;
  spot: number;
  atmStrike: number;
  pcr: number;
  maxPain: number;
  expiry: string;
  timestamp: string;
  strikes: {
    strike: number;
    ceOI: number;
    ceOIChg: number;
    ceVol: number;
    ceLTP: number;
    peOI: number;
    peOIChg: number;
    peVol: number;
    peLTP: number;
    interpretation: string;
  }[];
  unusualBuildup: {
    strike: number;
    type: 'CE' | 'PE';
    oiChg: number;
    volume: number;
    ltp: number;
    interpretation: string;
  }[];
  resistance: number[];
  support: number[];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${SECRET}` && searchParams.get('secret') !== SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const symbol = searchParams.get('symbol');
    const save = searchParams.get('save') === 'true';
    const all = searchParams.get('all') === 'true';

    // Single symbol mode
    if (symbol) {
      console.log(`[DOM Cron] Analyzing single symbol: ${symbol}`);
      const result = await analyzeSymbol(symbol.toUpperCase(), 'Equity');
      if (!result) {
        return NextResponse.json({ success: false, error: 'No data' }, { status: 404 });
      }
      if (save) {
        await storeResults([result]);
      }
      return NextResponse.json({ success: true, data: result });
    }

    // All symbols mode (run after 7:30 PM)
    if (all) {
      console.log('[DOM Cron] Starting daily DOM analysis for all F&O stocks...');
      // ... existing all mode code
      const lots = await client.fnoLots();
      const indices = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'];
      const stocks = Object.keys(lots).filter(k => !indices.includes(k));
      
      console.log(`[DOM Cron] Analyzing ${stocks.length} F&O stocks + ${indices.length} indices`);

      const allResults: DOMResult[] = [];
      const errors: string[] = [];

      for (const sym of indices) {
        try {
          const result = await analyzeSymbol(sym, 'Indices');
          if (result) allResults.push(result);
        } catch (e: any) {
          errors.push(`${sym}: ${e.message}`);
        }
      }

      const batchSize = 5;
      for (let i = 0; i < stocks.length; i += batchSize) {
        const batch = stocks.slice(i, i + batchSize);
        await Promise.all(batch.map(async (sym) => {
          try {
            const result = await analyzeSymbol(sym, 'Equity');
            if (result) allResults.push(result);
          } catch (e: any) {
            errors.push(`${sym}: ${e.message}`);
          }
        }));
        
        if (i + batchSize < stocks.length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      const stored = await storeResults(allResults);
      
      console.log(`[DOM Cron] Completed: ${stored} stored, ${errors.length} errors`);

      return NextResponse.json({
        success: true,
        analyzed: allResults.length,
        stored,
        errors: errors.slice(0, 10),
        timestamp: new Date().toISOString(),
      });
    }

    // Default: return summary
    return NextResponse.json({ success: true, message: 'Use ?symbol=SYMBOL or ?all=true' });
    
  } catch (error: any) {
    console.error('[DOM Cron] Fatal error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

async function analyzeSymbol(symbol: string, type: 'Indices' | 'Equity'): Promise<DOMResult | null> {
  const data = await client.optionChainV3({ symbol, type });
  
  if (!data.records?.data?.length) {
    return null;
  }

  const records = data.records.data;
  const spot = data.records.underlyingValue;
  const expiry = data.records.expiryDates?.[0] || '';
  const timestamp = data.records.timestamp || new Date().toISOString();

  // Find ATM strike
  const strikes = [...new Set(records.map((r: any) => r.strikePrice))].sort((a, b) => a - b);
  let atmStrike = strikes[0];
  let minDiff = Infinity;
  for (const s of strikes) {
    const diff = Math.abs(s - spot);
    if (diff < minDiff) { minDiff = diff; atmStrike = s; }
  }

  // Process strikes
  const processedStrikes = [];
  const unusualBuildup = [];

  // NSE optionChainV3 returns data for nearest expiry only
  // No need to filter by expiry - just use all records with CE or PE
  for (const record of records) {
    if (!record.CE && !record.PE) continue;
    
    const strike = record.strikePrice;
    const ce = record.CE;
    const pe = record.PE;
    const ceOIChg = ce?.changeinOpenInterest || 0;
    const peOIChg = pe?.changeinOpenInterest || 0;
    const ceOI = ce?.openInterest || 0;
    const peOI = pe?.openInterest || 0;

    // Interpretation
    let interpretation = 'Neutral';
    if (ceOIChg > 0 && peOIChg <= 0) interpretation = 'Call Writing (Resistance)';
    else if (peOIChg > 0 && ceOIChg <= 0) interpretation = 'Put Writing (Support)';
    else if (ceOIChg < 0 && peOIChg >= 0) interpretation = 'Call Unwinding';
    else if (peOIChg < 0 && ceOIChg >= 0) interpretation = 'Put Unwinding';
    else if (ceOIChg > 0 && peOIChg > 0) interpretation = 'Both Writing';

    processedStrikes.push({
      strike,
      ceOI,
      ceOIChg,
      ceVol: ce?.totalTradedVolume || 0,
      ceLTP: ce?.lastPrice || 0,
      peOI,
      peOIChg,
      peVol: pe?.totalTradedVolume || 0,
      peLTP: pe?.lastPrice || 0,
      interpretation,
    });

    // Detect unusual buildup (> 50K OI change or > 2x avg)
    if (Math.abs(ceOIChg) > 50000) {
      unusualBuildup.push({
        strike,
        type: 'CE' as const,
        oiChg: ceOIChg,
        volume: ce?.totalTradedVolume || 0,
        ltp: ce?.lastPrice || 0,
        interpretation: ceOIChg > 0 ? 'Call Writing' : 'Call Unwinding',
      });
    }
    if (Math.abs(peOIChg) > 50000) {
      unusualBuildup.push({
        strike,
        type: 'PE' as const,
        oiChg: peOIChg,
        volume: pe?.totalTradedVolume || 0,
        ltp: pe?.lastPrice || 0,
        interpretation: peOIChg > 0 ? 'Put Writing' : 'Put Unwinding',
      });
    }
  }

  // PCR
  const totalCallOI = processedStrikes.reduce((s, r) => s + r.ceOI, 0);
  const totalPutOI = processedStrikes.reduce((s, r) => s + r.peOI, 0);
  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

  // Max Pain
  let maxPain = atmStrike;
  let maxTotalOI = 0;
  for (const s of processedStrikes) {
    const total = s.ceOI + s.peOI;
    if (total > maxTotalOI) { maxTotalOI = total; maxPain = s.strike; }
  }

  // Resistance/Support from OI walls
  const resistance = processedStrikes
    .filter(s => s.ceOI > 0)
    .sort((a, b) => b.ceOI - a.ceOI)
    .slice(0, 5)
    .map(s => s.strike);
  
  const support = processedStrikes
    .filter(s => s.peOI > 0)
    .sort((a, b) => b.peOI - a.peOI)
    .slice(0, 5)
    .map(s => s.strike);

  return {
    symbol,
    spot,
    atmStrike,
    pcr: Math.round(pcr * 100) / 100,
    maxPain,
    expiry,
    timestamp,
    strikes: processedStrikes,
    unusualBuildup: unusualBuildup.sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)),
    resistance,
    support,
  };
}

async function storeResults(results: DOMResult[]) {
  let stored = 0;
  // Use IST date (market date) for storage - NSE timestamp is in IST
  const today = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(today.getTime() + istOffset + today.getTimezoneOffset() * 60 * 1000);
  const istMidnight = new Date(istDate);
  istMidnight.setHours(0, 0, 0, 0);
  
  console.log(`[DOM Cron] Storing ${results.length} results for date ${istMidnight.toISOString()}`);
  
  for (const r of results) {
    try {
      await prisma.domAnalysis.upsert({
        where: { symbol_date: { symbol: r.symbol, date: istMidnight } },
        update: {
          spot: r.spot,
          atmStrike: r.atmStrike,
          pcr: r.pcr,
          maxPain: r.maxPain,
          expiry: r.expiry,
          timestamp: new Date(r.timestamp),
          strikes: r.strikes,
          unusualBuildup: r.unusualBuildup,
          resistance: r.resistance,
          support: r.support,
        },
        create: {
          symbol: r.symbol,
          date: istMidnight,
          spot: r.spot,
          atmStrike: r.atmStrike,
          pcr: r.pcr,
          maxPain: r.maxPain,
          expiry: r.expiry,
          timestamp: new Date(r.timestamp),
          strikes: r.strikes,
          unusualBuildup: r.unusualBuildup,
          resistance: r.resistance,
          support: r.support,
        },
      });
      stored++;
    } catch (e: any) {
      console.error(`[DOM Cron] Store error for ${r.symbol}:`, e.message);
    }
  }
  console.log(`[DOM Cron] Stored ${stored}/${results.length} results`);
  return stored;
}