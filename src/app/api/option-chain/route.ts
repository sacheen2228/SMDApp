// API Route - Option Chain with SDM Analysis
// Fetch option chain data and run SDM analysis

import { NextRequest, NextResponse } from 'next/server';
import { getOptionChain, getOptionChainExpiries } from '@/lib/icici-breeze/option-chain';
import { initSession } from '@/lib/icici-breeze/auth';
import { generateOptionChain } from '@/lib/option-chain-data';
import { runFullAnalysis } from '@/lib/sdm-engine';
import { validateAndSanitize } from '@/lib/data-validation';
import { generateDayCandles } from '@/lib/historical-data';
import { calculateGreeks } from '@/lib/greeks';
import type { OptionChainStrike } from '@/lib/sdm-engine';

// Init Breeze session on first request
let sessionInitialized = false;

function parseBreezeDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  // Format: "28-Jul-2026"
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = months[parts[1]] ?? 0;
    const year = parseInt(parts[2], 10);
    return new Date(year, month, day);
  }
  return new Date(dateStr);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const expiry = searchParams.get('expiry') || undefined;

    // Initialize session once
    if (!sessionInitialized) {
      sessionInitialized = true;
      await initSession().catch(() => {});
    }
    
    let chainData: any = null;
    let source = 'simulation';
    
    // Try ICICI Breeze API first
    try {
      if (expiry) {
        const chain = await getOptionChain(symbol, expiry);
        if (chain) {
          chainData = chain;
          source = 'icici-breeze';
        }
      } else {
        const expiries = await getOptionChainExpiries(symbol);
        // Try each expiry and pick the nearest one with valid data
        for (const exp of expiries) {
          const chain = await getOptionChain(symbol, exp);
          if (chain) {
            chainData = { ...chain, expiries };
            source = 'icici-breeze';
            // Don't break — keep trying to find the nearest valid expiry
            // (some generated dates may not have data, so continue to find nearest)
            break;
          }
        }
      }
    } catch (breezeError) {
      console.warn('[API] ICICI Breeze failed, using simulation:', breezeError);
    }
    
    // Fallback to simulation
    if (!chainData) {
      chainData = generateOptionChain(symbol, expiry);
      source = 'simulation';
    }
    
    // Build SDM analysis strikes from either format
    let optionChainStrikes: OptionChainStrike[] = [];
    
    if (chainData.data) {
      // Simulation format: data is array of {strike, ce, pe}
      optionChainStrikes = chainData.data.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? {
          ltp: row.ce.ltp || 0,
          oi: row.ce.oi || 0,
          oiChg: row.ce.oiChg || 0,
          volume: row.ce.volume || 0,
          iv: row.ce.iv || 0,
          delta: row.ce.delta || 0,
          gamma: row.ce.gamma || 0,
          theta: row.ce.theta || 0,
          vega: row.ce.vega || 0,
          bid: 0,
          ask: 0,
        } : null,
        pe: row.pe ? {
          ltp: row.pe.ltp || 0,
          oi: row.pe.oi || 0,
          oiChg: row.pe.oiChg || 0,
          volume: row.pe.volume || 0,
          iv: row.pe.iv || 0,
          delta: row.pe.delta || 0,
          gamma: row.pe.gamma || 0,
          theta: row.pe.theta || 0,
          vega: row.pe.vega || 0,
          bid: 0,
          ask: 0,
        } : null,
      }));
    } else if (chainData.calls && chainData.puts) {
      // Breeze format: calls and puts arrays
      const callMap = new Map<number, any>();
      const putMap = new Map<number, any>();
      for (const c of chainData.calls) callMap.set(c.strikePrice, c);
      for (const p of chainData.puts) putMap.set(p.strikePrice, p);
      
      const allStrikes = [...new Set([...callMap.keys(), ...putMap.keys()])].sort((a, b) => a - b);
      optionChainStrikes = allStrikes.map(strike => ({
        strike,
        ce: callMap.has(strike) ? {
          ltp: callMap.get(strike).ltp || 0,
          oi: callMap.get(strike).openInterest || 0,
          oiChg: callMap.get(strike).oiChange || 0,
          volume: callMap.get(strike).volume || 0,
          iv: callMap.get(strike).iv || 0,
          delta: callMap.get(strike).delta || 0,
          gamma: callMap.get(strike).gamma || 0,
          theta: callMap.get(strike).theta || 0,
          vega: callMap.get(strike).vega || 0,
          bid: callMap.get(strike).bid || 0,
          ask: callMap.get(strike).ask || 0,
        } : null,
        pe: putMap.has(strike) ? {
          ltp: putMap.get(strike).ltp || 0,
          oi: putMap.get(strike).openInterest || 0,
          oiChg: putMap.get(strike).oiChange || 0,
          volume: putMap.get(strike).volume || 0,
          iv: putMap.get(strike).iv || 0,
          delta: putMap.get(strike).delta || 0,
          gamma: putMap.get(strike).gamma || 0,
          theta: putMap.get(strike).theta || 0,
          vega: putMap.get(strike).vega || 0,
          bid: putMap.get(strike).bid || 0,
          ask: putMap.get(strike).ask || 0,
        } : null,
      }));
    }
    
    const spotPrice = chainData.spotPrice || chainData.summary?.spotPrice || 0;
    
    // Validate and sanitize the data
    const validation = validateAndSanitize(optionChainStrikes, spotPrice, source);
    if (!validation.valid) {
      console.warn('[API] Data validation failed:', validation.errors);
      // Fall back to simulation
      chainData = generateOptionChain(symbol, expiry);
      source = 'simulation';
      optionChainStrikes = chainData.data.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, gamma: row.ce.gamma || 0, theta: row.ce.theta || 0, vega: row.ce.vega || 0, bid: 0, ask: 0 } : null,
        pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, gamma: row.pe.gamma || 0, theta: row.pe.theta || 0, vega: row.pe.vega || 0, bid: 0, ask: 0 } : null,
      }));
    } else if (validation.warnings.length > 0) {
      console.warn('[API] Data warnings:', validation.warnings);
    }

    // Calculate Greeks if missing (Breeze doesn't return them)
    const selectedExpiry = expiry || chainData.selectedExpiry || chainData.expiries?.[0]?.date || chainData.expiries?.[0] || '';
    const now = new Date();
    const expiryDate = new Date(selectedExpiry);
    const daysToExpiry = Math.max(1, Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    const tte = daysToExpiry / 365; // time to expiry in years

    for (const strike of optionChainStrikes) {
      // Estimate IV from moneyness if not provided
      const moneyness = Math.abs(strike.strike - spotPrice) / spotPrice;
      const baseIV = 0.15 + moneyness * 2 + (daysToExpiry < 7 ? 0.05 : 0); // ATM ~15%, increases with distance

      if (strike.ce) {
        const iv = strike.ce.iv > 0 ? strike.ce.iv / 100 : baseIV;
        const greeks = calculateGreeks(spotPrice, strike.strike, tte, iv, true);
        strike.ce.delta = greeks.delta;
        strike.ce.gamma = greeks.gamma;
        strike.ce.theta = greeks.theta;
        strike.ce.vega = greeks.vega;
        if (strike.ce.iv === 0) strike.ce.iv = Math.round(iv * 10000) / 100; // store as percentage
      }
      if (strike.pe) {
        const iv = strike.pe.iv > 0 ? strike.pe.iv / 100 : baseIV;
        const greeks = calculateGreeks(spotPrice, strike.strike, tte, iv, false);
        strike.pe.delta = greeks.delta;
        strike.pe.gamma = greeks.gamma;
        strike.pe.theta = greeks.theta;
        strike.pe.vega = greeks.vega;
        if (strike.pe.iv === 0) strike.pe.iv = Math.round(iv * 10000) / 100;
      }
    }

    // Build summary for frontend compatibility
    if (!chainData.summary) {
      // Compute from strikes data
      const totalCallOI = optionChainStrikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
      const totalPutOI = optionChainStrikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
      const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
      // Max pain: strike with highest total OI
      let maxPain = spotPrice;
      let maxTotalOI = 0;
      for (const s of optionChainStrikes) {
        const total = (s.ce?.oi || 0) + (s.pe?.oi || 0);
        if (total > maxTotalOI) { maxTotalOI = total; maxPain = s.strike; }
      }

      chainData.summary = {
        spotPrice,
        spotChange: 0,
        spotChangePct: 0,
        indiaVIX: 15,
        pcr,
        maxPain,
        totalCallOI,
        totalPutOI,
        atmStrike: chainData.atmStrike || 0,
        selectedExpiry,
      };
    }
    
    // Run full SDM analysis
    const analysis = runFullAnalysis(optionChainStrikes, spotPrice, selectedExpiry);

    // Transform expiry strings into objects the frontend expects
    const rawExpiries = chainData.expiries || [];
    const expiries = rawExpiries.map((e: any) => {
      const dateStr = typeof e === 'string' ? e : e?.date || '';
      const dateObj = parseBreezeDate(dateStr);
      const now = new Date();
      const diffMs = dateObj.getTime() - now.getTime();
      const daysToExpiry = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      return { date: dateStr, label: dateStr, daysToExpiry };
    });

    // Generate intraday candles for chart
    const today = new Date().toISOString().split('T')[0];
    const candles5m = generateDayCandles(symbol, today);
    
    return NextResponse.json({
      success: true,
      source,
      lastUpdate: new Date().toISOString(),
      data: { ...chainData, data: optionChainStrikes, expiries, dataSource: source, candles: candles5m },
      analysis,
    });
    
  } catch (error: any) {
    console.error('[API] Option chain error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch option chain' },
      { status: 500 }
    );
  }
}
