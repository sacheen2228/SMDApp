// Shared option chain data fetcher.
// Used by atm-straddle, ide, daily-ide, today-trades, greek-flow,
// institutional-greeks — eliminates HTTP self-fetch which breaks on Render.

import { getOptionChain, getOptionChainExpiries } from '@/lib/icici-breeze/option-chain';
import { initSession } from '@/lib/icici-breeze/auth';
import { getNSEOptionChain } from '@/lib/nse-api';
import { calculateGreeks } from '@/lib/greeks';

let sessionInitialized = false;

export interface OptionChainResult {
  success: boolean;
  source: string;
  ageMs?: number; // age of the chain data (0 = just fetched)
  data?: {
    data: any[];
    spotPrice: number;
    summary: {
      spotPrice: number;
      indiaVIX: number | null;
      maxPain: number;
      pcr: number;
      totalCallOI: number;
      totalPutOI: number;
      callOiChange: number;
      putOiChange: number;
      atmStrike: number;
      [key: string]: any;
    };
    expiries: any[];
    selectedExpiry: string;
    candles?: any[];
    [key: string]: any;
  };
  error?: string;
}

function parseBreezeDate(dateStr: string): Date {
  if (!dateStr) return new Date();
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

export async function fetchLiveOptionChain(
  symbol: string,
  expiry?: string,
  signal?: AbortSignal,
): Promise<OptionChainResult> {
  if (!sessionInitialized) {
    sessionInitialized = true;
    await initSession().catch(() => {});
  }

  // 1) MOAPI spot price (primary for spot)
  let moapiSpot: number | null = null;
  try {
    const { getLTPBySymbol, getCurrentAuthToken } = await import('@/lib/motilal/market');
    const token = getCurrentAuthToken();
    if (token) {
      const ltpResult = await getLTPBySymbol(symbol, token);
      if (ltpResult?.ltp && ltpResult.ltp > 0) {
        moapiSpot = ltpResult.ltp;
      }
    }
  } catch {}

  let liveVix: number | null = null;
  try {
    const { fetchIndiaVIX } = await import('@/lib/yahoo-finance-api');
    liveVix = (await fetchIndiaVIX().catch(() => null))?.value ?? null;
  } catch {}

  let chainData: any = null;
  let chainSource = 'none';
  let chainDataAgeMs = 0; // 0 = just fetched; scraped path sets the real age

  // 1) NSE API first choice — live data with priceChg/bid/ask/OI/IV (richest chain)
  try {
    const nseData = await getNSEOptionChain(symbol);
    if (nseData?.records?.data) {
      chainData = {
        data: nseData.records.data.map((row: any) => ({
          strike: row.strikePrice,
          ce: row.CE ? {
            ltp: row.CE.lastPrice || 0,
            priceChg: row.CE.change !== undefined ? row.CE.change : undefined,
            bid: row.CE.bidprice || 0,
            ask: row.CE.askPrice || 0,
            oi: row.CE.openInterest || 0,
            oiChg: row.CE.changeinOpenInterest || 0,
            volume: row.CE.totalTradedVolume || 0,
            iv: row.CE.impliedVolatility || 0,
            delta: row.CE.greeks?.delta || 0,
            gamma: row.CE.greeks?.gamma || 0,
            theta: row.CE.greeks?.theta || 0,
            vega: row.CE.greeks?.vega || 0,
          } : null,
          pe: row.PE ? {
            ltp: row.PE.lastPrice || 0,
            priceChg: row.PE.change !== undefined ? row.PE.change : undefined,
            bid: row.PE.bidprice || 0,
            ask: row.PE.askPrice || 0,
            oi: row.PE.openInterest || 0,
            oiChg: row.PE.changeinOpenInterest || 0,
            volume: row.PE.totalTradedVolume || 0,
            iv: row.PE.impliedVolatility || 0,
            delta: row.PE.greeks?.delta || 0,
            gamma: row.PE.greeks?.gamma || 0,
            theta: row.PE.greeks?.theta || 0,
            vega: row.PE.greeks?.vega || 0,
          } : null,
        })),
        spotPrice: nseData.records?.underlyingValue || 0,
        expiries: (nseData.records?.expiryDates || []).map((d: string) => ({ date: d, label: d, daysToExpiry: 0 })),
        selectedExpiry: nseData.records?.expiryDates?.[0] || '',
        summary: { spotPrice: nseData.records?.underlyingValue || 0 },
      };
      chainSource = 'nse-api';
      chainDataAgeMs = 0;
    }
  } catch {}

  // 2) Breeze fallback (MOAPI doesn't provide option chains)
  if (!chainData) {
    try {
      if (expiry) {
        const chain = await getOptionChain(symbol, expiry);
        if (chain) { chainData = chain; chainSource = 'icici-breeze'; }
      } else {
        const expiries = await getOptionChainExpiries(symbol);
        for (const exp of expiries.slice(0, 3)) {
          try {
            const chain = await getOptionChain(symbol, exp);
            if (chain) { chainData = { ...chain, expiries }; chainSource = 'icici-breeze'; break; }
          } catch {}
        }
      }
    } catch {}
  }

  // 3) Scraped NSE cache — last fallback (hourly scraper, may be stale)
  if (!chainData) {
    try {
      const scrapedRes = await fetch(`http://localhost:3000/api/nse-data?symbol=${symbol}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (scrapedRes.ok) {
        const scraped = await scrapedRes.json();
        if (scraped.latest && scraped.latest.strikes?.length > 0) {
          const snap = scraped.latest;
          chainData = {
            data: snap.strikes,
            spotPrice: snap.spotPrice,
            expiries: snap.expiries?.map((d: string) => ({ date: d, label: d, daysToExpiry: 0 })) || [],
            selectedExpiry: snap.selectedExpiry,
            summary: {
              spotPrice: snap.spotPrice,
              indiaVIX: snap.indiaVIX,
              maxPain: snap.maxPain,
              pcr: snap.pcr,
              totalCallOI: snap.totalCallOI,
              totalPutOI: snap.totalPutOI,
              callOiChange: snap.callOiChange,
              putOiChange: snap.putOiChange,
              atmStrike: snap.atmStrike,
            },
          };
          chainSource = `nse-scraped(${Math.round((scraped.ageMs || 0) / 60000)}m ago)`;
          chainDataAgeMs = scraped.ageMs || 0;
          if (snap.indiaVIX) liveVix = snap.indiaVIX;
        }
      }
    } catch {}
  }

  if (!chainData) {
    return { success: false, source: 'none', error: 'No option chain data available' };
  }

  // Merge spot: prefer MOAPI over chain's own spot
  const chainSpotPrice = chainData.spotPrice || chainData.summary?.spotPrice || 0;
  const spotPrice = moapiSpot && moapiSpot > 0 ? moapiSpot : chainSpotPrice;
  const source = moapiSpot && moapiSpot > 0 ? `moapi+${chainSource}` : chainSource;

  const rawStrikes = chainData.data || [];
  const selectedExpiry = expiry || chainData.selectedExpiry || chainData.expiries?.[0]?.date || '';

  // Calculate Greeks if missing
  const expiryDate = new Date(selectedExpiry);
  const daysToExpiry = Math.max(1, Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  const tte = daysToExpiry / 365;

  for (const strike of rawStrikes) {
    const moneyness = Math.abs(strike.strike - spotPrice) / spotPrice;
    const baseIV = 0.15 + moneyness * 2 + (daysToExpiry < 7 ? 0.05 : 0);
    if (strike.ce) {
      const iv = strike.ce.iv > 0 ? strike.ce.iv / 100 : baseIV;
      if (strike.ce.iv === 0 || !strike.ce.iv) strike.ce.iv = Math.round(baseIV * 10000) / 100; // store estimated IV as percentage
      const greeks = calculateGreeks(spotPrice, strike.strike, tte, iv, true);
      strike.ce.delta = greeks.delta;
      strike.ce.gamma = greeks.gamma;
      strike.ce.theta = greeks.theta;
      strike.ce.vega = greeks.vega;
    }
    if (strike.pe) {
      const iv = strike.pe.iv > 0 ? strike.pe.iv / 100 : baseIV;
      if (strike.pe.iv === 0 || !strike.pe.iv) strike.pe.iv = Math.round(baseIV * 10000) / 100; // store estimated IV as percentage
      const greeks = calculateGreeks(spotPrice, strike.strike, tte, iv, false);
      strike.pe.delta = greeks.delta;
      strike.pe.gamma = greeks.gamma;
      strike.pe.theta = greeks.theta;
      strike.pe.vega = greeks.vega;
    }
  }

  // Build summary
  let totalCallOI = 0, totalPutOI = 0, callOiChg = 0, putOiChg = 0;
  let maxPain = spotPrice, maxTotalOI = 0, atmStrike = 0, bestAtmDist = Infinity;
  for (const s of rawStrikes) {
    totalCallOI += s.ce?.oi || 0;
    totalPutOI += s.pe?.oi || 0;
    callOiChg += s.ce?.oiChg || 0;
    putOiChg += s.pe?.oiChg || 0;
    const total = (s.ce?.oi || 0) + (s.pe?.oi || 0);
    if (total > maxTotalOI) { maxTotalOI = total; maxPain = s.strike; }
    const dist = Math.abs(s.strike - spotPrice);
    if (dist < bestAtmDist) { bestAtmDist = dist; atmStrike = s.strike; }
  }
  const pcr = totalCallOI > 0 && totalPutOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : null;

  return {
    success: true,
    source,
    ageMs: chainDataAgeMs,
    data: {
      data: rawStrikes,
      spotPrice,
      summary: {
        spotPrice,
        indiaVIX: liveVix,
        maxPain,
        pcr,
        totalCallOI,
        totalPutOI,
        callOiChange: callOiChg,
        putOiChange: putOiChg,
        atmStrike,
      },
      expiries: chainData.expiries || [],
      selectedExpiry,
      candles: chainData.candles || [],
    },
  };
}
