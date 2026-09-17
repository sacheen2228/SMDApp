// MCX Commodity Module — Option Chain
// Fetches MCX commodity options from Motilal API
// Only for approved contracts: CRUDEOIL, GOLD, SILVER, NATURALGAS

import { getScrips, getLTP } from '@/lib/motilal/market';
import { getSessionToken } from '@/lib/motilal/auth';
import type { MCXCommodity } from './types';
import type { DataProvenance } from '@/types';
import { MCX_APPROVED_CONTRACTS } from './types';
import { MCX_CONTRACT_SPECS } from './instrument-master';
import { fetchBhaavBriefChain, isBhaavBriefSupported, type BhaavBriefChain } from './bhaavbrief';

// Yahoo Finance tickers for MCX spot fallback
const MCX_YAHOO: Record<string, string> = {
  CRUDEOIL: 'CL=F',
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  NATURALGAS: 'NG=F',
};

export interface MCXOptionStrike {
  strike: number;
  ce: {
    ltp: number;
    bid: number;
    ask: number;
    volume: number;
    oi: number;
    oiChange: number;
    iv: number;
    token: number;
    expiry: string;
  } | null;
  pe: {
    ltp: number;
    bid: number;
    ask: number;
    volume: number;
    oi: number;
    oiChange: number;
    iv: number;
    token: number;
    expiry: string;
  } | null;
}

export interface MCXOptionChain {
  symbol: MCXCommodity;
  expiry: string;
  spotPrice: number;
  strikes: MCXOptionStrike[];
  atmStrike: number;
  totalCEVolume: number;
  totalPEVolume: number;
  totalCEOI: number;
  totalPEOI: number;
  pcr: number;
  maxPain: number;
  ivix: number;
  timestamp: string;
  dataSource: 'MOAPI' | 'BHAAVBRIEF' | 'NONE';
  provenance: DataProvenance;
}

// Cache
const optionChainCache = new Map<string, { chain: MCXOptionChain; ts: number }>();
const OC_CACHE_TTL = 30000; // 30s

// ── Load option chain from BhaavBrief (has OI, IV, Bid/Ask, Max Pain, PCR) ──
async function loadFromBhaavBrief(
  symbol: MCXCommodity
): Promise<MCXOptionChain | null> {
  if (!isBhaavBriefSupported(symbol)) return null;

  const bb = await fetchBhaavBriefChain(symbol);
  if (!bb || !bb.chain || bb.chain.length === 0) return null;

  const strikes: MCXOptionStrike[] = bb.chain.map(s => ({
    strike: s.strike,
    ce: s.CE ? {
      ltp: s.CE.ltp,
      bid: s.CE.bid,
      ask: s.CE.ask,
      volume: s.CE.volume,
      oi: s.CE.oi,
      oiChange: s.CE.oiChange,
      iv: s.CE.iv,
      token: 0,
      expiry: bb.expiry,
    } : null,
    pe: s.PE ? {
      ltp: s.PE.ltp,
      bid: s.PE.bid,
      ask: s.PE.ask,
      volume: s.PE.volume,
      oi: s.PE.oi,
      oiChange: s.PE.oiChange,
      iv: s.PE.iv,
      token: 0,
      expiry: bb.expiry,
    } : null,
  }));

  const totalCEVolume = strikes.reduce((s, st) => s + (st.ce?.volume || 0), 0);
  const totalPEVolume = strikes.reduce((s, st) => s + (st.pe?.volume || 0), 0);
  const totalCEOI = strikes.reduce((s, st) => s + (st.ce?.oi || 0), 0);
  const totalPEOI = strikes.reduce((s, st) => s + (st.pe?.oi || 0), 0);

  return {
    symbol,
    expiry: bb.expiry,
    spotPrice: bb.futurePrice,
    strikes,
    atmStrike: bb.chain.find(s => s.isATM)?.strike || 0,
    totalCEVolume,
    totalPEVolume,
    totalCEOI,
    totalPEOI,
    pcr: bb.pcr,
    maxPain: bb.maxPain,
    ivix: bb.ivix,
    timestamp: bb.lastUpdated || new Date().toISOString(),
    dataSource: 'BHAAVBRIEF',
    provenance: {
      source: 'BhaavBrief',
      retrievedAt: new Date().toISOString(),
      freshness: 'FRESH',
      isLive: true,
      status: 'AVAILABLE',
    },
  };
}

// ── Load option chain for a commodity ──
export async function loadMCXOptionChain(
  symbol: MCXCommodity,
  expiry?: string
): Promise<MCXOptionChain | null> {
  const cacheKey = `${symbol}_${expiry || 'nearest'}`;
  const cached = optionChainCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OC_CACHE_TTL) return cached.chain;

  // Try BhaavBrief first (has OI, IV, Max Pain, PCR)
  const bbChain = await loadFromBhaavBrief(symbol);
  if (bbChain) {
    optionChainCache.set(cacheKey, { chain: bbChain, ts: Date.now() });
    return bbChain;
  }

  // Fallback: Motilal (LTP + Volume only, no OI)
  const token = getSessionToken();
  if (!token) return null;

  try {
    const scrips = await getScrips('MCX', token);
    if (!scrips || scrips.length === 0) return null;

    const now = new Date();

    // Try exact match first, then startsWith (handles CRUDEOIL vs CRUDEOILM)
    const filterSymbol = (sName: string) => sName === symbol || sName.startsWith(symbol);

    // Filter options for this symbol with valid expiry
    const optionScrips = scrips.filter(s => {
      const sName = (s.symbol || '').toUpperCase();
      const matchesSymbol = filterSymbol(sName);
      const isOption = s.optiontype === 'CE' || s.optiontype === 'PE' || s.optiontype === 'CA' || s.optiontype === 'PA';
      const hasExpiry = s.expirydate && s.expirydate !== '0000-00-00';
      const notExpired = hasExpiry && new Date(s.expirydate) > now;
      return matchesSymbol && isOption && notExpired;
    });

    if (optionScrips.length === 0) return null;

    // Group by expiry, pick nearest
    const expiryMap = new Map<string, typeof optionScrips>();
    for (const s of optionScrips) {
      const exp = s.expirydate;
      if (!expiryMap.has(exp)) expiryMap.set(exp, []);
      expiryMap.get(exp)!.push(s);
    }

    const sortedExpiries = [...expiryMap.keys()].sort();
    const targetExpiry = expiry || sortedExpiries[0];
    const expiryOptions = expiryMap.get(targetExpiry) || [];

    if (expiryOptions.length === 0) return null;

    // Get futures LTP for spot reference
    const futureScrip = scrips.find(s => {
      const sName = (s.symbol || '').toUpperCase();
      return filterSymbol(sName) && !s.optiontype && s.expirydate === targetExpiry;
    });
    
    let spotPrice = 0;
    if (futureScrip) {
      const futLtp = await getLTP('MCX', futureScrip.scripcode, token);
      spotPrice = futLtp?.ltp || 0;
    }

    // Fallback: Yahoo Finance for spot price
    if (spotPrice <= 0 && MCX_YAHOO[symbol]) {
      try {
        const yahooTicker = MCX_YAHOO[symbol];
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=1d`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice) {
            // Convert USD to INR for crude/gold/silver
            const usdInr = 83.5; // approximate
            spotPrice = Math.round(meta.regularMarketPrice * usdInr * 100) / 100;
          }
        }
      } catch {}
    }

    // First pass: build all strikes to find ATM
    const allStrikeMap = new Map<number, MCXOptionStrike>();
    for (const s of expiryOptions) {
      const strike = s.strikeprice;
      if (!strike || strike <= 0) continue;
      if (!allStrikeMap.has(strike)) allStrikeMap.set(strike, { strike, ce: null, pe: null });
      const entry = allStrikeMap.get(strike)!;
      const optType = (s.optiontype || '').toUpperCase();
      const optionData = { ltp: 0, bid: 0, ask: 0, volume: 0, oi: 0, token: s.scripcode, expiry: s.expirydate };
      if (optType === 'CE' || optType === 'CA') entry.ce = optionData;
      else if (optType === 'PE' || optType === 'PA') entry.pe = optionData;
    }

    const allStrikes = [...allStrikeMap.values()].sort((a, b) => a.strike - b.strike);

    // Find ATM strike
    let atmStrike = 0;
    if (spotPrice > 0 && allStrikes.length > 0) {
      atmStrike = allStrikes.reduce((best, s) =>
        Math.abs(s.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? s : best
      ).strike;
    }

    // Limit to ±5 strikes from ATM for LTP fetching
    const ATM_RANGE = 5;
    let strikesToFetch: typeof allStrikes;
    if (atmStrike > 0) {
      const atmIdx = allStrikes.findIndex(s => s.strike === atmStrike);
      const start = Math.max(0, atmIdx - ATM_RANGE);
      const end = Math.min(allStrikes.length, atmIdx + ATM_RANGE + 1);
      strikesToFetch = allStrikes.slice(start, end);
    } else {
      strikesToFetch = allStrikes.slice(0, 25); // fallback: first 25
    }

    // Fetch LTP for strikes near ATM only
    const scripsToFetch = strikesToFetch.flatMap(s => {
      const result: Array<{ scripcode: number; strike: number; side: string }> = [];
      if (s.ce) result.push({ scripcode: s.ce.token, strike: s.strike, side: 'ce' });
      if (s.pe) result.push({ scripcode: s.pe.token, strike: s.strike, side: 'pe' });
      return result;
    });

    interface LTPResult { ltp: number; volume: number; openInterest: number; }
    const ltpData = new Map<number, LTPResult>();
    
    for (let i = 0; i < scripsToFetch.length; i += 5) {
      const batch = scripsToFetch.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async (s) => {
          const ltp = await getLTP('MCX', s.scripcode, token);
          return { scripcode: s.scripcode, ltp: ltp?.ltp || 0, volume: ltp?.volume || 0, openInterest: ltp?.openInterest || 0 };
        })
      );
      for (const r of results) {
        if (r.ltp > 0) ltpData.set(r.scripcode, r);
      }
    }

    // Apply fetched LTPs + Volume + OI to the limited strikes
    const strikes = strikesToFetch.map(s => ({
      ...s,
      ce: s.ce ? { ...s.ce, ltp: ltpData.get(s.ce.token)?.ltp || 0, volume: ltpData.get(s.ce.token)?.volume || 0, oi: ltpData.get(s.ce.token)?.openInterest || 0 } : null,
      pe: s.pe ? { ...s.pe, ltp: ltpData.get(s.pe.token)?.ltp || 0, volume: ltpData.get(s.pe.token)?.volume || 0, oi: ltpData.get(s.pe.token)?.openInterest || 0 } : null,
    }));

    // PCR + OI totals
    const totalCEVolume = strikes.reduce((s, st) => s + (st.ce?.volume || 0), 0);
    const totalPEVolume = strikes.reduce((s, st) => s + (st.pe?.volume || 0), 0);
    const totalCEOI = strikes.reduce((s, st) => s + (st.ce?.oi || 0), 0);
    const totalPEOI = strikes.reduce((s, st) => s + (st.pe?.oi || 0), 0);
    const pcr = totalCEVolume > 0 ? totalPEVolume / totalCEVolume : 0;

    const chain: MCXOptionChain = {
      symbol,
      expiry: targetExpiry,
      spotPrice,
      strikes,
      atmStrike,
      totalCEVolume,
      totalPEVolume,
      totalCEOI,
      totalPEOI,
      pcr,
      maxPain: 0,
      ivix: 0,
      timestamp: new Date().toISOString(),
      dataSource: 'MOAPI',
      provenance: {
        source: 'Motilal Oswal API',
        retrievedAt: new Date().toISOString(),
        freshness: 'LIVE',
        isLive: true,
        status: 'AVAILABLE',
      },
    };

    optionChainCache.set(cacheKey, { chain, ts: Date.now() });
    return chain;
  } catch {
    return null;
  }
}

// ── Load all MCX option chains (for dashboard) ──
export async function loadAllMCXOptionChains(): Promise<Map<MCXCommodity, MCXOptionChain>> {
  const results = new Map<MCXCommodity, MCXOptionChain>();

  // Only fetch for commodities that have options
  const withOptions = (['CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS'] as MCXCommodity[]);

  // Try BhaavBrief first for each commodity (has OI, IV, Max Pain)
  const bbPromises = withOptions.map(sym => loadFromBhaavBrief(sym));
  const bbResults = await Promise.allSettled(bbPromises);
  for (const r of bbResults) {
    if (r.status === 'fulfilled' && r.value) {
      results.set(r.value.symbol, r.value);
    }
  }

  // For commodities not fetched by BhaavBrief, try Motilal fallback
  const token = getSessionToken();
  if (!token) return results;

  const missing = withOptions.filter(s => !results.has(s));
  if (missing.length === 0) return results;

  try {
    const scrips = await getScrips('MCX', token);
    if (!scrips || scrips.length === 0) return results;

    const now = new Date();

    for (const symbol of missing) {
      const filterSymbol = (sName: string) => sName === symbol || sName.startsWith(symbol);

      const optionScrips = scrips.filter(s => {
        const sName = (s.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
        const matchesSymbol = filterSymbol(sName);
        const isOption = s.optiontype === 'CE' || s.optiontype === 'PE' || s.optiontype === 'CA' || s.optiontype === 'PA';
        const notExpired = s.expirydate && s.expirydate !== '0000-00-00' && new Date(s.expirydate) > now;
        return matchesSymbol && isOption && notExpired;
      });

      if (optionScrips.length === 0) continue;

      const expiries = [...new Set(optionScrips.map(s => s.expirydate))].sort();
      const nearest = expiries[0];
      const nearestOptions = optionScrips.filter(s => s.expirydate === nearest);

      const futureScrip = scrips.find(s => {
        const sName = (s.symbol || '').toUpperCase();
        return filterSymbol(sName) && !s.optiontype && s.expirydate === nearest;
      });
      let spotPrice = 0;
      if (futureScrip) {
        const futLtp = await getLTP('MCX', futureScrip.scripcode, token);
        spotPrice = futLtp?.ltp || 0;
      }
      if (spotPrice <= 0 && MCX_YAHOO[symbol]) {
        try {
          const yahooTicker = MCX_YAHOO[symbol];
          const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = await res.json();
            const meta = data?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) {
              const usdInr = 83.5;
              spotPrice = Math.round(meta.regularMarketPrice * usdInr * 100) / 100;
            }
          }
        } catch {}
      }

      const allStrikeMap = new Map<number, MCXOptionStrike>();
      for (const s of nearestOptions) {
        const strike = s.strikeprice;
        if (!strike || strike <= 0) continue;
        if (!allStrikeMap.has(strike)) allStrikeMap.set(strike, { strike, ce: null, pe: null });
        const entry = allStrikeMap.get(strike)!;
        const optType = (s.optiontype || '').toUpperCase();
        const optionData = { ltp: 0, bid: 0, ask: 0, volume: 0, oi: 0, oiChange: 0, iv: 0, token: s.scripcode, expiry: s.expirydate };
        if (optType === 'CE' || optType === 'CA') entry.ce = optionData;
        else if (optType === 'PE' || optType === 'PA') entry.pe = optionData;
      }

      const allStrikes = [...allStrikeMap.values()].sort((a, b) => a.strike - b.strike);
      let atmStrike = 0;
      if (spotPrice > 0 && allStrikes.length > 0) {
        atmStrike = allStrikes.reduce((best, s) =>
          Math.abs(s.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? s : best
        ).strike;
      }

      const ATM_RANGE = 5;
      let strikesToFetch: typeof allStrikes;
      if (atmStrike > 0) {
        const atmIdx = allStrikes.findIndex(s => s.strike === atmStrike);
        const start = Math.max(0, atmIdx - ATM_RANGE);
        const end = Math.min(allStrikes.length, atmIdx + ATM_RANGE + 1);
        strikesToFetch = allStrikes.slice(start, end);
      } else {
        strikesToFetch = allStrikes.slice(0, 25);
      }

      const scripsToFetch = strikesToFetch.flatMap(s => {
        const result: Array<{ scripcode: number }> = [];
        if (s.ce) result.push({ scripcode: s.ce.token });
        if (s.pe) result.push({ scripcode: s.pe.token });
        return result;
      });

      interface LTPResult { ltp: number; volume: number; openInterest: number; }
      const ltpData = new Map<number, LTPResult>();
      for (let i = 0; i < scripsToFetch.length; i += 5) {
        const batch = scripsToFetch.slice(i, i + 5);
        const batchResults = await Promise.all(
          batch.map(async (s) => {
            const ltp = await getLTP('MCX', s.scripcode, token);
            return { scripcode: s.scripcode, ltp: ltp?.ltp || 0, volume: ltp?.volume || 0, openInterest: ltp?.openInterest || 0 };
          })
        );
        for (const r of batchResults) {
          if (r.ltp > 0) ltpData.set(r.scripcode, r);
        }
      }

      const strikes = strikesToFetch.map(s => ({
        ...s,
        ce: s.ce ? { ...s.ce, ltp: ltpData.get(s.ce.token)?.ltp || 0, volume: ltpData.get(s.ce.token)?.volume || 0, oi: ltpData.get(s.ce.token)?.openInterest || 0 } : null,
        pe: s.pe ? { ...s.pe, ltp: ltpData.get(s.pe.token)?.ltp || 0, volume: ltpData.get(s.pe.token)?.volume || 0, oi: ltpData.get(s.pe.token)?.openInterest || 0 } : null,
      }));

      const totalCEVolume = strikes.reduce((s, st) => s + (st.ce?.volume || 0), 0);
      const totalPEVolume = strikes.reduce((s, st) => s + (st.pe?.volume || 0), 0);
      const totalCEOI = strikes.reduce((s, st) => s + (st.ce?.oi || 0), 0);
      const totalPEOI = strikes.reduce((s, st) => s + (st.pe?.oi || 0), 0);

      results.set(symbol, {
        symbol,
        expiry: nearest,
        spotPrice,
        strikes,
        atmStrike,
        totalCEVolume,
        totalPEVolume,
        totalCEOI,
        totalPEOI,
        pcr: totalCEVolume > 0 ? totalPEVolume / totalCEVolume : 0,
        maxPain: 0,
        ivix: 0,
        timestamp: new Date().toISOString(),
        dataSource: 'MOAPI',
      });
    }
  } catch {
    // Failed to load
  }

  return results;
}

// ── Get available expiries for a commodity ──
export function getMCXExpiries(scrips: any[], symbol: MCXCommodity): string[] {
  const now = new Date();
  const expiries = new Set<string>();
  for (const s of scrips) {
    const sName = (s.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (sName.includes(symbol) && s.expirydate && s.expirydate !== '0000-00-00' && new Date(s.expirydate) > now) {
      expiries.add(s.expirydate);
    }
  }
  return [...expiries].sort();
}
