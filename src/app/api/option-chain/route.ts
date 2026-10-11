// API Route - Option Chain with SDM Analysis
// Fetch option chain data and run SDM analysis

import { NextRequest, NextResponse } from 'next/server';
import { getOptionChain, getOptionChainExpiries } from '@/lib/icici-breeze/option-chain';
import { initSession } from '@/lib/icici-breeze/auth';
import { runFullAnalysis } from '@/lib/sdm-engine';
import { validateAndSanitize } from '@/lib/data-validation';
import { calculateGreeks } from '@/lib/greeks';
import { normalizeOptionChain } from '@/lib/data-layer';
import { getNSEOptionChain } from '@/lib/nse-api';
import { isBSEIndex } from '@/lib/bse-api';
import { sendTradeAlert } from '@/lib/telegram';
import { buildFreshnessMeta, withSessionAwareFreshness, providerTimestamp } from '@/lib/api-freshness';
import { getTradingSession } from '@/lib/expiry-liquidity/market-session-config';
import { providerHealth } from '@/lib/provider-health';
import { getCurrentSession } from '@/lib/market-session';
import { isPlausibleOptionSymbol } from '@/lib/stockUniverse';
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
  // Overall endpoint timeout: 24 seconds max
  // Provider budget: MO 6s + Breeze 7s + NSE 7s (cold-cookie) = 21s worst
  // case + ~2s post-processing, leaving margin under the endpoint cap.
  // Frontend aborts at 25s (page.tsx) — must stay ABOVE this.
  const controller = new AbortController();
  const ENDPOINT_TIMEOUT_MS = 24000;
  const timeoutId = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);

  const mainLogic = async () => {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const expiry = searchParams.get('expiry') || undefined;

    // Fast-reject synthetic/test IDs (epoch-digit runs) — never contact
    // NSE/Breeze with garbage (a single bad symbol used to walk all 7
    // Breeze expiries + NSE; 60+ wasted provider calls per test run).
    if (!isPlausibleOptionSymbol(symbol)) {
      return NextResponse.json(
        { success: false, error: `Invalid symbol: ${symbol.slice(0, 40)}` },
        { status: 400 }
      );
    }

    // Initialize session once (don't block on it)
    if (!sessionInitialized) {
      sessionInitialized = true;
      initSession().catch(() => {});
    }

    // Fetch live India VIX + previous close with timeout
    let liveVix: number | null = null;
    let livePrevClose: number | null = null;
    try {
      const { fetchIndiaVIX } = await import('@/lib/yahoo-finance-api');
      const vixRes = await Promise.race([
        fetchIndiaVIX(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('VIX_TIMEOUT')), 2000))
      ]);
      liveVix = vixRes?.value ?? null;
    } catch {}

    // Previous close with timeout
    try {
      const nseRes = await fetch('https://www.nseindia.com/api/marketStatus', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (nseRes.ok) {
        const nseData = await nseRes.json();
        const niftyIdx = nseData?.marketState?.find((i: any) => i.index === 'NIFTY 50');
        if (niftyIdx) {
          const variation = parseFloat(niftyIdx.variation) || 0;
          const last = parseFloat(niftyIdx.last) || 0;
          if (last > 0 && variation !== 0) livePrevClose = last - variation;
        }
      }
    } catch {}

    // Yahoo fallback for prev close (with timeout)
    if (!livePrevClose) {
      try {
        const { fetchPrevClose } = await import('@/lib/yahoo-finance-api');
        livePrevClose = await Promise.race([
          fetchPrevClose(symbol),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('PREVCLOSE_TIMEOUT')), 2000))
        ]);
      } catch {}
    }

    let chainData: any = null;
    let source = 'NO_DATA';
    let dataTimestamp: Date = new Date();
    // The provider's own publication timestamp, when it ships one. Null means
    // "we collected this, but cannot verify how current it is" — never LIVE.
    let providerTs: Date | null = null;
    
    // FINAL PROVIDER TREE (see SOP.md §1) — exchange-aware:
    //   1. NSE primary  — NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY + NSE equities
    //   2. BSE primary  — SENSEX/BANKEX (NSE has no contract for these)
    //   3. MOAPI fallback
    //   4. Breeze opt-in last resort
    //   Yahoo must NEVER enter this path.
    // If all valid sources fail: OPTION_CHAIN=UNAVAILABLE → NO_TRADE
    
    // Off-hours fast path: MO/Breeze can only serve live sessions (MO times
    // out, Breeze needs auth) — NSE + Yahoo carry the last session's data.
    const offHours = !getCurrentSession('index').isMarketOpen;
    const bseIndex = isBSEIndex(symbol);

    // ── 1. NSE PRIMARY — NSE indices and equities ──────────────────
    let rawNse: any = null;
    const nseStart = Date.now();
    if (!chainData && !bseIndex) {
      // NSE path for NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY + equities
      try {
        const nseData = await Promise.race([
          getNSEOptionChain(symbol),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('NSE_TIMEOUT')), 7000))
        ]);
        rawNse = nseData;
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
            spotPrice: (nseData as any).records?.underlyingValue || 0,
            expiries: ((nseData as any).records?.expiryDates || []).map((d: string) => ({ date: d, label: d, daysToExpiry: 0 })),
            selectedExpiry: (nseData as any).records?.expiryDates?.[0] || '',
            summary: { spotPrice: (nseData as any).records?.underlyingValue || 0 },
          };
          source = 'nse-api';
          // Use the exchange's own timestamp when it ships one — collecting
          // "now" is collection time, not a quote time, and would fabricate LIVE.
          providerTs = providerTimestamp(nseData);
          dataTimestamp = providerTs ?? new Date();
          providerHealth.recordSuccess("nse", Date.now() - nseStart);
          console.log('[API] NSE API data fetched successfully');
        }
      } catch (nseError) {
        console.warn('[API] NSE API failed:', nseError);
        providerHealth.recordFailure("nse", "NETWORK", String(nseError).substring(0, 200));
      }
    }

    // ── 2. BSE PRIMARY — SENSEX/BANKEX only ────────────────────────
    // NSE has no contract for these, so BSE is not a "fallback" here.
    if (!chainData && bseIndex) {
      try {
        const { getBSEOptionChain, getBSEExpiryDates } = await import('@/lib/bse-api');
        const bseExpiries = await getBSEExpiryDates(symbol).catch(() => [] as string[]);
        const selectedExpiry = expiry || bseExpiries[0] || '';

        if (selectedExpiry) {
          const bseStart = Date.now();
          const bseChain = await Promise.race([
            getBSEOptionChain(symbol, selectedExpiry),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('BSE_TIMEOUT')), 5000))
          ]).catch(() => null);
          if (bseChain?.data?.length) {
            chainData = {
              data: bseChain.data.map((row) => ({
                strike: row.strike,
                ce: row.ce ? {
                  ltp: row.ce.ltp || 0,
                  oi: row.ce.oi || 0,
                  oiChg: row.ce.oiChg || 0,
                  volume: row.ce.volume || 0,
                  iv: row.ce.iv || 0,
                  chg: row.ce.chg || 0,
                  bid: row.ce.bid || 0,
                  ask: row.ce.ask || 0,
                } : null,
                pe: row.pe ? {
                  ltp: row.pe.ltp || 0,
                  oi: row.pe.oi || 0,
                  oiChg: row.pe.oiChg || 0,
                  volume: row.pe.volume || 0,
                  iv: row.pe.iv || 0,
                  chg: row.pe.chg || 0,
                  bid: row.pe.bid || 0,
                  ask: row.pe.ask || 0,
                } : null,
              })),
              spotPrice: bseChain.spotPrice,
              expiries: bseExpiries.map((e: string) => ({ date: e, label: e, daysToExpiry: 0 })),
              selectedExpiry,
              summary: { spotPrice: bseChain.spotPrice },
            };
            source = 'bse-api';
            // BSE DeriOptionChain_IV ships no publication timestamp — leave
            // providerTs null so freshness cannot claim LIVE.
            providerTs = providerTimestamp(bseChain);
            dataTimestamp = providerTs ?? new Date();
            providerHealth.recordSuccess("nse", Date.now() - bseStart); // reuse nse slot for BSE
            console.log('[API] BSE option chain fetched for', symbol);
          }
        }
      } catch (bseError) {
        console.warn('[API] BSE API failed for', symbol, ':', String(bseError).substring(0, 200));
      }
    }

    // ── 3. MOAPI FALLBACK — only when the exchange's own API failed ──
    const moapiStart = Date.now();
    if (!chainData && !offHours && !providerHealth.shouldSkip("moapi")) {
    try {
      const { getMotilalOptionChain } = await import('@/lib/motilal-option-chain');
      const motilalChain = await Promise.race([
        getMotilalOptionChain(symbol, expiry),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('MOAPI_TIMEOUT')), 6000))
      ]);
      if (motilalChain?.data?.length) {
        chainData = {
          data: motilalChain.data.map((row) => ({
            strike: row.strike,
            ce: row.ce ? {
              ltp: row.ce.ltp || 0,
              oi: row.ce.oi || 0,
              oiChg: 0,
              volume: row.ce.volume || 0,
              iv: row.ce.iv || 0,
              delta: row.ce.delta || 0,
              gamma: row.ce.gamma || 0,
              theta: row.ce.theta || 0,
              vega: row.ce.vega || 0,
              bid: row.ce.bid || 0,
              ask: row.ce.ask || 0,
            } : null,
            pe: row.pe ? {
              ltp: row.pe.ltp || 0,
              oi: row.pe.oi || 0,
              oiChg: 0,
              volume: row.pe.volume || 0,
              iv: row.pe.iv || 0,
              delta: row.pe.delta || 0,
              gamma: row.pe.gamma || 0,
              theta: row.pe.theta || 0,
              vega: row.pe.vega || 0,
              bid: row.pe.bid || 0,
              ask: row.pe.ask || 0,
            } : null,
          })),
          spotPrice: motilalChain.spotPrice,
          expiries: motilalChain.expiries.map((e) => ({ date: e, label: e, daysToExpiry: 0 })),
          selectedExpiry: motilalChain.selectedExpiry,
          summary: motilalChain.summary,
        };
        source = 'motilal-api';
        providerHealth.recordSuccess("moapi", Date.now() - moapiStart);
        console.log(`[API] MOAPI option chain fetched for ${symbol}`);
      }
    } catch (moapiError) {
      console.warn('[API] MOAPI failed:', moapiError);
      providerHealth.recordFailure("moapi", "SERVER", String(moapiError).substring(0, 200));
    }
    } else if (!chainData) {
      console.log('[API] Skipping MOAPI —', offHours ? 'market closed' : 'circuit open');
    }

    // ── 4. BREEZE OPT-IN LAST RESORT — bounded 7s + fast failover ──
    // AUTH_REQUIRED, TIMEOUT, ERROR → immediately give up (NO_DATA).
    // No offHours gate: a valid session serves frozen off-hours data fine,
    // and dead auth is already encoded in the circuit (shouldSkip).
    const breezeStart = Date.now();
    if (!chainData && !providerHealth.shouldSkip("breeze")) {
      try {
        const fetchBreezeChain = async () => {
          if (expiry) {
            return await getOptionChain(symbol, expiry);
          } else {
            // Front month only — a spot snapshot is always the nearest
            // contract, and walking every back month burns the whole budget.
            const expiries = await getOptionChainExpiries(symbol);
            for (const exp of expiries.slice(0, 2)) {
              const chain = await getOptionChain(symbol, exp);
              if (chain) return { ...chain, expiries };
            }
            return null;
          }
        };

        // Bounded timeout: 7 seconds max for Breeze
        const BREEZE_TIMEOUT_MS = 7000;
        const chain = await Promise.race([
          fetchBreezeChain(),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('BREEZE_TIMEOUT')), BREEZE_TIMEOUT_MS)
          ),
        ]);

        if (chain) {
          chainData = chain;
          source = 'icici-breeze';
          providerHealth.recordSuccess("breeze", Date.now() - breezeStart);
          console.log(`[API] Breeze option chain fetched for ${symbol}`);
        }
      } catch (breezeError: any) {
        const errMsg = String(breezeError?.message || breezeError);
        // Fast failover for specific error types
        if (errMsg.includes('AUTH') || errMsg.includes('401') || errMsg.includes('403') ||
            errMsg.includes('Unauthorized') || errMsg.includes('BREEZE_TIMEOUT')) {
          providerHealth.recordFailure("breeze", errMsg.includes('TIMEOUT') ? "TIMEOUT" : "AUTH", errMsg.substring(0, 120));
          console.warn(`[API] Breeze ${errMsg.includes('TIMEOUT') ? 'timeout' : 'auth error'} — no data from last resort`);
        } else {
          providerHealth.recordFailure("breeze", "NETWORK", errMsg.substring(0, 120));
          console.warn('[API] Breeze error:', errMsg.substring(0, 120));
        }
      }
    } else if (!chainData) {
      console.log('[API] Skipping Breeze — circuit open or an earlier provider succeeded');
    }

    // Normalize option chain via central data layer (only when no chain was
    // already found by the provider tree — normalize is a structure adapter,
    // not a data source)
    if (!chainData && rawNse) {
      const normResult = normalizeOptionChain(rawNse, expiry, symbol);
      if (normResult.data) {
        chainData = {
          data: normResult.data.strikes.map((s: any) => ({
            strike: s.strike,
            ce: s.ce ? { ltp: s.ce.ltp || 0, oi: s.ce.oi || 0, oiChg: s.ce.oiChange || 0, volume: s.ce.volume || 0, iv: s.ce.iv || 0, delta: s.ce.delta || 0, gamma: s.ce.gamma || 0, theta: s.ce.theta || 0, vega: 0, bid: s.ce.bid || 0, ask: s.ce.ask || 0 } : null,
            pe: s.pe ? { ltp: s.pe.ltp || 0, oi: s.pe.oi || 0, oiChg: s.pe.oiChange || 0, volume: s.pe.volume || 0, iv: s.pe.iv || 0, delta: s.pe.delta || 0, gamma: s.pe.gamma || 0, theta: s.pe.theta || 0, vega: 0, bid: s.pe.bid || 0, ask: s.pe.ask || 0 } : null,
          })),
          spotPrice: normResult.data.spot || 0,
          expiry: normResult.data.expiry,
          selectedExpiry: normResult.data.expiry || '',
          summary: { spotPrice: normResult.data.spot },
        };
        source = normResult.source;
        providerTs = providerTimestamp(normResult.data);
        dataTimestamp = providerTs ?? new Date();
      }
    }
    if (!chainData) {
      chainData = {};
      source = 'NO_DATA';
    }

    // Yahoo is NOT option-chain fallback per FINAL PROVIDER TREE.
    // If Breeze/Motilal/NSE/BSE all fail, return empty chain with spot price from VIX/prevClose context.

    if (!chainData || (!chainData.data?.length && !chainData.calls?.length && !chainData.puts?.length)) {
      const spotPrice = chainData?.spotPrice || chainData?.summary?.spotPrice || 0;
      if (spotPrice > 0) {
        // Return spot price with empty chain — frontend can show spot + "no data" message
        chainData = chainData || {};
        chainData.data = [];
        chainData.spotPrice = spotPrice;
        chainData.summary = chainData.summary || { spotPrice, indiaVIX: liveVix, prevClose: livePrevClose, vixLive: liveVix != null, prevCloseLive: livePrevClose != null };
        chainData.summary.spotPrice = spotPrice;
      } else {
        return NextResponse.json({
          success: false,
          error: `No option chain data available for ${symbol}. NSE, BSE, MOAPI and Breeze all failed or returned no contract.`,
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
      // PCR: null when OI unavailable — NEVER default to 1 (creates fake neutral)
      const pcr = totalCallOI > 0 && totalPutOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : null;
      // Max Pain: strike where total payout to option holders is MINIMUM
      // (NOT maximum total OI — that was wrong)
      let maxPain: number | null = null;
      if (optionChainStrikes.length > 0 && (totalCallOI > 0 || totalPutOI > 0)) {
        const strikes = optionChainStrikes.map(s => s.strike).sort((a, b) => a - b);
        const minStrike = strikes[0];
        const maxStrike = strikes[strikes.length - 1];
        let bestStrike = minStrike;
        let minPayout = Infinity;
        for (let price = minStrike; price <= maxStrike; price++) {
          let totalPayout = 0;
          for (const s of optionChainStrikes) {
            if (price > s.strike) totalPayout += (price - s.strike) * (s.ce?.oi || 0);
            if (price < s.strike) totalPayout += (s.strike - price) * (s.pe?.oi || 0);
          }
          if (totalPayout < minPayout) { minPayout = totalPayout; bestStrike = price; }
        }
        maxPain = bestStrike;
      }

      chainData.summary = {
        spotPrice,
        spotChange: livePrevClose ? Math.round((spotPrice - livePrevClose) * 100) / 100 : 0,
        spotChangePct: livePrevClose ? Math.round(((spotPrice - livePrevClose) / livePrevClose) * 10000) / 100 : 0,
        indiaVIX: liveVix,
        prevClose: livePrevClose,
        vixLive: liveVix != null,
        prevCloseLive: livePrevClose != null,
        pcr,
        maxPain,
        totalCallOI,
        totalPutOI,
        atmStrike: chainData.atmStrike || 0,
        selectedExpiry,
      };
    }
    
    // Generate candles — try Breeze 5-min intraday first (bounded), fallback to
    // Yahoo daily candles so the SMC engine always has structure data.
    // (Moved ABOVE the SDM alert gate so the PE falling-market technical
    // confirmation can use them — isFallingMarket needs candles + spot.)
    // Skip Breeze when its circuit is open (AUTH dead) — otherwise the
    // 3×4s attempts eat the remaining endpoint budget after a successful chain.
    let candles5m: any[] = [];
    if (providerHealth.shouldSkip("breeze")) {
      console.log('[API] Skipping Breeze candles — circuit open, using Yahoo fallback');
    }
    try {
      const { getIntradayCandles } = await import('@/lib/breeze-historical');
      const seen = new Set<string>();
      const seenDay = new Set<string>();
      const d = new Date();
      // Limit to 3 days max, with 4s timeout per call
      for (let attempt = 0; attempt < 3 && candles5m.length < 40 && !providerHealth.shouldSkip("breeze"); attempt++) {
        const dateStr = d.toISOString().split('T')[0];
        if (!seenDay.has(dateStr)) {
          seenDay.add(dateStr);
          try {
            const cr = await Promise.race([
              getIntradayCandles(symbol, dateStr, '5minute'),
              new Promise<{candles: any[]}>((_, reject) => setTimeout(() => reject(new Error('CANDLE_TIMEOUT')), 4000))
            ]);
            for (const c of cr.candles || []) {
              const key = c.time || `${c.open}-${c.close}-${c.volume}`;
              if (!seen.has(key)) { seen.add(key); candles5m.push(c); }
            }
          } catch (candleErr) {
            console.warn(`[API] Candle fetch for ${dateStr} failed:`, String(candleErr).substring(0, 80));
          }
        }
        d.setDate(d.getDate() - 1);
      }
      candles5m.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    } catch {
      candles5m = [];
    }

    // Fallback: Yahoo daily candles when Breeze unavailable (bounded)
    if (candles5m.length < 10) {
      try {
        const yahooSym = symbol === 'SENSEX' ? '^BSESN' : '^NSEI';
        const res = await Promise.race([
          fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=6mo&interval=1d`, {
            signal: AbortSignal.timeout(5000),
          }),
          new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('YAHOO_CANDLE_TIMEOUT')), 5000))
        ]);
        if (res.ok) {
          const json = await res.json();
          const result = json?.chart?.result?.[0];
          if (result?.timestamp && result?.indicators?.quote?.[0]) {
            const ts = result.timestamp;
            const q = result.indicators.quote[0];
            for (let i = 0; i < ts.length; i++) {
              const close = q.close?.[i];
              if (close == null) continue;
              const dt = new Date(ts[i] * 1000);
              const pad = (n: number) => n.toString().padStart(2, '0');
              candles5m.push({
                time: `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} 00:00:00`,
                open: q.open?.[i] ?? close,
                high: q.high?.[i] ?? close,
                low: q.low?.[i] ?? close,
                close,
                volume: q.volume?.[i] || 0,
              });
            }
          }
        }
      } catch {}
    }

    // Run full SDM analysis
    const analysis = runFullAnalysis(optionChainStrikes, spotPrice, selectedExpiry);

    // Send Telegram alert if SDM analysis has a strong trade signal (real data only)
    // Throttled: only sends once per trade signature per day
    if (analysis?.recommendation && source !== "simulation") {
      const rec = analysis.recommendation;
      const isTradeAction = rec.action && !["HOLD", "NEUTRAL", "WAIT"].includes(rec.action);
      const isPut = !!(rec.action?.includes("PUT") || rec.optionType === "PE");
      // PE historically 0 wins on this book — demand a higher confidence floor.
      const confFloor = isPut ? 70 : 60;
      const conf = Number(rec.confidence || rec.sdmScore || 0);
      const hasConfidence = conf >= confFloor;
      // Quality gates — Final Validator rules (MIN_PREMIUM=5, no zero levels).
      // option-chain-api historically wrote ₹0.05 PE stubs that always lost.
      const entryPx = Number(rec.entryPrice || 0);
      const slPx = Number(rec.stopLoss || 0);
      const tp1Px = Number(rec.tp1 || 0);
      const entryOk = entryPx >= 5;
      // BUY options: SL must sit below entry for both CE and PE.
      const levelsOk = slPx > 0 && tp1Px > 0 && entryPx > slPx && tp1Px > entryPx;
      // Session gate — POST_CLOSE auto-entries historically won 0/17 (-4299).
      // market-session.ts allowedActions is the single source of truth.
      const { isTradeAllowed } = await import("@/lib/market-session");
      const sessGate = isTradeAllowed(isPut || rec.optionType === "PE" ? "PUT" : "CALL");
      // PE technical confirmation — price must be DEMONSTRABLY falling
      // (spot < VWAP + DOWN structure + sustained momentum, ≥2 of 3 layers).
      // OI flow alone is positioning, not price action. TDD: falling-market.test.ts
      const { isFallingMarket } = await import("@/lib/technical-analysis");
      const peFallingOk = !isPut || isFallingMarket(candles5m, spotPrice).falling;
      if (isTradeAction && hasConfidence && entryOk && levelsOk && sessGate.allowed && peFallingOk) {
        const { getActiveTrades, addTrade } = await import('@/lib/activeTradeTracker');
        const tradeSig = `${symbol}|${rec.strike || analysis.atmStrike || spotPrice}|${rec.optionType || ''}|${rec.action}`;
        const alreadyActive = getActiveTrades().some(t =>
          t.symbol === symbol && t.strike === (rec.strike || analysis.atmStrike || spotPrice)
        );
        if (!alreadyActive) {
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
            instrument: rec.optionType === 'PE' ? 'PUT' : 'CALL',
          }).then(() => {
            addTrade({
              id: `api-${Date.now()}`,
              symbol,
              side: 'BUY' as const, // option-chain route is options-only
              instrument: `${symbol} ${rec.strike || ''} ${rec.optionType || ''}`.trim(),
              strike: rec.strike || analysis.atmStrike || spotPrice || 0,
              optionType: rec.optionType || '',
              entry: entryPx,
              sl: slPx,
              tp1: tp1Px,
              tp2: rec.tp2 || 0,
              status: 'ACTIVE',
              sentAt: new Date().toISOString(),
              source: `option-chain-api`,
              expiry: selectedExpiry || undefined,
            }, true); // skipAlert=true — sendTradeAlert already sent above
          }).catch(() => {});
        }
      } else if (isTradeAction && hasConfidence) {
        console.log(`[option-chain] Signal skipped: entryOk=${entryOk} levelsOk=${levelsOk} session=${sessGate.allowed ? "ok" : sessGate.reason} conf=${rec.confidence || rec.sdmScore}`);
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


    // Attach live India VIX + previous close to the response summary (and the
    // SDM analysis) for every source path. We never fabricate these — when the
    // live feed was unavailable they stay null and the UI shows "—". Also copy
    // the real computed PCR / OI / ATM / maxPain so any component reading
    // data.summary directly (instead of analysis) sees complete live values.
    chainData.summary = chainData.summary || {};
    chainData.summary.indiaVIX = liveVix;
    chainData.summary.prevClose = livePrevClose;
    chainData.summary.vixLive = liveVix != null;
    chainData.summary.prevCloseLive = livePrevClose != null;
    chainData.summary.pcr = analysis?.pcr ?? chainData.summary.pcr ?? null;
    chainData.summary.maxPain = analysis?.maxPain ?? chainData.summary.maxPain ?? null;
    chainData.summary.totalCallOI = analysis?.totalCallOI ?? chainData.summary.totalCallOI ?? 0;
    chainData.summary.totalPutOI = analysis?.totalPutOI ?? chainData.summary.totalPutOI ?? 0;
    chainData.summary.atmStrike = analysis?.atmStrike ?? chainData.summary.atmStrike ?? 0;
    chainData.summary.spotPrice = spotPrice;

    // Compute aggregated OI changes from per-strike data (needed by GapAnalysis)
    if (optionChainStrikes.length > 0) {
      chainData.summary.callOiChange = optionChainStrikes.reduce((sum, s) => sum + (s.ce?.oiChg || 0), 0);
      chainData.summary.putOiChange = optionChainStrikes.reduce((sum, s) => sum + (s.pe?.oiChg || 0), 0);
    }
    // Get NIFTY futures price from Yahoo (NIFTY 50 futures)
    try {
      const { fetchYahooIndexData } = await import('@/lib/yahoo-finance-api');
      const futuresData = await fetchYahooIndexData('NIFTY');
      if (futuresData?.regularMarketPrice) {
        chainData.summary.futuresPrice = futuresData.regularMarketPrice;
      }
    } catch {}

    if (analysis?.greeks && typeof analysis.greeks === 'object') {
      analysis.greeks.vix = liveVix != null ? liveVix : analysis.greeks.vix;
    }

    // Fix spot change (sdm-engine hardcodes 0, we have real prevClose)
    if (analysis?.spot && livePrevClose) {
      const spotChg = spotPrice - livePrevClose;
      analysis.spot.change = Math.round(spotChg * 100) / 100;
      analysis.spot.changePct = livePrevClose > 0 ? Math.round((spotChg / livePrevClose) * 10000) / 100 : 0;
    }
    
    // NSE and BSE are the DESIGNATED PRIMARY providers for their own
    // exchanges (NSE for NIFTY/BANKNIFiny/MIDCPNIFTY + equities, BSE for
    // SENSEX/BANKEX). Serving from them is NOT a fallback. Breeze/MO only
    // enter when explicitly opted in. Report a fallback only when something
    // other than the designated primary had to stand in.
    const isDesignatedPrimary =
      source === 'nse-api' || source === 'bse-api' ||
      source === 'icici-breeze' || source === 'motilal-api';
    // Prefer the exchange's own publication timestamp. BSE ships none, so an
    // absent timestamp means we can only prove we just collected the payload,
    // not that it is current — cap that at FRESH, never LIVE.
    // LIVE is only truthful while the exchange is open and printing. A fetch
    // on a weekend / holiday / pre-open / after-hours returns the last known
    // state — never let it claim LIVE.
    const freshness = withSessionAwareFreshness(
      buildFreshnessMeta({
        provider: source,
        dataTimestamp: providerTs ?? new Date(),
        dataType: "optionChain",
        fallbackUsed: !isDesignatedPrimary && source !== 'NO_DATA',
        fallbackReason: source === 'NO_DATA' ? "All providers unavailable" : undefined,
      }),
      getTradingSession(),
    );
    if (!providerTs && freshness.freshness === 'LIVE') {
      freshness.freshness = 'FRESH';
      freshness.delayed = false;
    }

    // Build canonical OptionChain from normalized strikes (backward-compatible addition)
    let canonical: any = null;
    try {
      const { buildOptionChain, assessChainQuality } = await import('@/lib/option-chain-normalizer');
      const normalizedStrikes = optionChainStrikes.map((s: any) => ({
        strike: s.strike,
        ce: s.ce ? {
          ltp: s.ce.ltp || 0,
          bid: s.ce.bid ?? null,
          ask: s.ce.ask ?? null,
          spread: (s.ce.bid != null && s.ce.ask != null) ? (s.ce.ask - s.ce.bid) : null,
          quoteQuality: ((s.ce.bid != null && s.ce.ask != null)) ? 'COMPLETE' as const : 'PARTIAL' as const,
          oi: s.ce.oi || 0,
          oiChange: s.ce.oiChg || 0,
          volume: s.ce.volume || 0,
          iv: s.ce.iv || 0,
          delta: s.ce.delta || 0,
          gamma: s.ce.gamma || 0,
          theta: s.ce.theta || 0,
          vega: s.ce.vega || 0,
          hasData: (s.ce.ltp || 0) > 0 || (s.ce.oi || 0) > 0,
        } : null,
        pe: s.pe ? {
          ltp: s.pe.ltp || 0,
          bid: s.pe.bid ?? null,
          ask: s.pe.ask ?? null,
          spread: (s.pe.bid != null && s.pe.ask != null) ? (s.pe.ask - s.pe.bid) : null,
          quoteQuality: ((s.pe.bid != null && s.pe.ask != null)) ? 'COMPLETE' as const : 'PARTIAL' as const,
          oi: s.pe.oi || 0,
          oiChange: s.pe.oiChg || 0,
          volume: s.pe.volume || 0,
          iv: s.pe.iv || 0,
          delta: s.pe.delta || 0,
          gamma: s.pe.gamma || 0,
          theta: s.pe.theta || 0,
          vega: s.pe.vega || 0,
          hasData: (s.pe.ltp || 0) > 0 || (s.pe.oi || 0) > 0,
        } : null,
      }));
      canonical = buildOptionChain(normalizedStrikes, spotPrice, symbol, source, chainData?.selectedExpiry);
      if (canonical) {
        const quality = assessChainQuality(canonical);
        (canonical as any)._quality = quality;
      }
    } catch (e) {
      console.warn('[API] Canonical chain build failed:', e);
    }

    return NextResponse.json({
      success: true,
      source,
      lastUpdate: dataTimestamp.toISOString(),
      freshness,
      provenance: {
        source,
        retrievedAt: dataTimestamp.toISOString(),
        freshness: freshness.freshness, // LIVE | FRESH | DELAYED | STALE | UNAVAILABLE
        isLive: freshness.freshness === 'LIVE',
        ageSeconds: Math.round(freshness.ageMs / 1000),
        status: optionChainStrikes.length > 0 ? 'AVAILABLE' : 'PARTIAL',
      },
      data: { ...chainData, data: optionChainStrikes, strikes: optionChainStrikes, optionChainStrikes, expiries, dataSource: source, candles: candles5m },
      canonical,
      analysis,
    });
  };
  // Run mainLogic with overall endpoint timeout
  try {
    return await Promise.race([
      mainLogic(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('ENDPOINT_TIMEOUT')));
      }),
    ]);
  } catch (error: any) {
    clearTimeout(timeoutId);
    // Handle abort as graceful timeout
    if (error.name === 'AbortError' || error.message?.includes('Abort') || error.message?.includes('ENDPOINT_TIMEOUT')) {
      console.warn('[API] Option chain endpoint timeout (24s)');
      return NextResponse.json(
        { success: false, error: 'Option chain endpoint timeout' },
        { status: 504 }
      );
    }
    console.error('[API] Option chain error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch option chain' },
      { status: 500 }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
