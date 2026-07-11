// API Route - Option Chain with SDM Analysis
// Fetch option chain data and run SDM analysis

import { NextRequest, NextResponse } from 'next/server';
import { getOptionChain, getOptionChainExpiries } from '@/lib/icici-breeze/option-chain';
import { initSession } from '@/lib/icici-breeze/auth';
import { runFullAnalysis } from '@/lib/sdm-engine';
import { validateAndSanitize } from '@/lib/data-validation';
import { calculateGreeks } from '@/lib/greeks';
import { getNSEOptionChain } from '@/lib/nse-api';
import { sendTradeAlert } from '@/lib/telegram';
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
          try {
            const chain = await getOptionChain(symbol, exp);
            if (chain) {
              chainData = { ...chain, expiries };
              source = 'icici-breeze';
              break;
            }
          } catch (expErr) {
            const errMsg = typeof expErr === 'string' ? expErr : (expErr as any)?.message || String(expErr);
            console.warn(`[API] Breeze option chain failed for ${symbol} ${exp}:`, errMsg.substring(0, 120));
          }
        }
      }
    } catch (breezeError) {
      console.warn('[API] ICICI Breeze failed, trying NSE API:', breezeError);
    }
    
    // Fallback to NSE API
    if (!chainData) {
      try {
        const nseData = await getNSEOptionChain(symbol);
        if (nseData?.records?.data) {
          chainData = {
            data: nseData.records.data.map((row: any) => ({
              strike: row.strikePrice,
              ce: row.CE ? {
                ltp: row.CE.lastPrice || 0,
                oi: row.CE.openInterest || 0,
                oiChg: row.CE.changeinOpenInterest || 0,
                volume: row.CE.totalTradedVolume || 0,
                iv: row.CE.impliedVolatility || 0,
                delta: row.CE.greeks?.delta || 0,
                gamma: row.CE.greeks?.gamma || 0,
                theta: row.CE.greeks?.theta || 0,
                vega: row.CE.greeks?.vega || 0,
                bid: row.CE.bid || 0,
                ask: row.CE.ask || 0,
              } : null,
              pe: row.PE ? {
                ltp: row.PE.lastPrice || 0,
                oi: row.PE.openInterest || 0,
                oiChg: row.PE.changeinOpenInterest || 0,
                volume: row.PE.totalTradedVolume || 0,
                iv: row.PE.impliedVolatility || 0,
                delta: row.PE.greeks?.delta || 0,
                gamma: row.PE.greeks?.gamma || 0,
                theta: row.PE.greeks?.theta || 0,
                vega: row.PE.greeks?.vega || 0,
                bid: row.PE.bid || 0,
                ask: row.PE.ask || 0,
              } : null,
            })),
            spotPrice: nseData.records?.underlyingValue || 0,
            expiries: (nseData.records?.expiryDates || []).map((d: string) => ({ date: d, label: d, daysToExpiry: 0 })),
            selectedExpiry: nseData.records?.expiryDates?.[0] || '',
            summary: { spotPrice: nseData.records?.underlyingValue || 0 },
          };
          source = 'nse-api';
          console.log('[API] NSE API data fetched successfully');
        }
      } catch (nseError) {
        console.warn('[API] NSE API also failed:', nseError);
      }
    }
    
    // If no real data available, try Yahoo Finance for spot price
    if (!chainData) {
      try {
        const { fetchYahooIndexData } = await import('@/lib/yahoo-finance-api');
        const yahooData = await fetchYahooIndexData(symbol);
        if (yahooData?.regularMarketPrice) {
          chainData = {
            data: [],
            spotPrice: yahooData.regularMarketPrice,
            summary: {
              spotPrice: yahooData.regularMarketPrice,
              indiaVIX: 15,
              maxPain: 0,
            },
            expiries: [],
            selectedExpiry: '',
          };
          console.log(`[API] Using Yahoo Finance spot price for ${symbol}: ${yahooData.regularMarketPrice}`);
        }
      } catch {}
    }

    if (!chainData || !chainData.data?.length) {
      const spotPrice = chainData?.spotPrice || chainData?.summary?.spotPrice || 0;
      if (spotPrice > 0) {
        // Return spot price with empty chain — frontend can show spot + "no data" message
        chainData = chainData || {};
        chainData.data = [];
        chainData.spotPrice = spotPrice;
        chainData.summary = chainData.summary || { spotPrice, indiaVIX: 15 };
        chainData.summary.spotPrice = spotPrice;
      } else {
        // Known symbols with no data source — return 200 with not_available flag for better UX
        const noDataSymbols = ['BANKEX']; // Add other symbols here if needed
        if (noDataSymbols.includes(symbol)) {
          return NextResponse.json({
            success: true,
            source: 'unavailable',
            lastUpdate: new Date().toISOString(),
            data: {
              data: [],
              spotPrice: 0,
              summary: { spotPrice: 0, indiaVIX: 15, maxPain: 0 },
              expiries: [],
              selectedExpiry: '',
              dataSource: 'unavailable',
              notAvailable: true,
            },
            analysis: { recommendation: { action: 'WAIT', reason: 'No data source available' } },
          });
        }
        return NextResponse.json({
          success: false,
          error: "No option chain data available for this symbol. Breeze, NSE, and Yahoo Finance all failed.",
        }, { status: 503 });
      }
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
    
    // Validate and sanitize the data (skip for Yahoo-only spot price with empty chain)
    if (optionChainStrikes.length > 0) {
      const validation = validateAndSanitize(optionChainStrikes, spotPrice, source);
      if (!validation.valid) {
        console.warn('[API] Data validation failed:', validation.errors);
        return NextResponse.json({
          success: false,
          error: "Option chain data validation failed. Real data may be incomplete.",
        }, { status: 503 });
      }
      if (validation.warnings.length > 0) {
        console.warn('[API] Data warnings:', validation.warnings);
      }
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

    // Send Telegram alert if SDM analysis has a strong trade signal (real data only)
    if (analysis?.recommendation && source !== "simulation") {
      const rec = analysis.recommendation;
      const isTradeAction = rec.action && !["HOLD", "NEUTRAL", "WAIT"].includes(rec.action);
      const hasConfidence = (rec.confidence || rec.sdmScore || 0) >= 60;
      if (isTradeAction && hasConfidence) {
        sendTradeAlert({
          symbol,
          action: rec.action,
          strike: rec.strike || analysis.atmStrike || spotPrice,
          type: rec.optionType || rec.direction || "OPTION",
          confidence: rec.confidence || rec.sdmScore || 0,
          entry: rec.entryPrice,
          stopLoss: rec.stopLoss,
          target1: rec.tp1,
          target2: rec.tp2,
          source: `📊 SDM Analysis (${source})`,
        }).catch(() => {});
      }
    }

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

    // Generate intraday candles for chart — try real Breeze data first
    const today = new Date().toISOString().split('T')[0];
    let candles5m: any[] = [];
    try {
      const { getIntradayCandles } = await import('@/lib/breeze-historical');
      candles5m = await getIntradayCandles(symbol, '5minute', selectedExpiry || '');
    } catch {
      // Fallback: empty candles — frontend should handle gracefully
      candles5m = [];
    }
    
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
