// MCX Commodity Module — Option Chain
// Fetches MCX commodity options from Motilal API
// Only for approved contracts: CRUDEOIL, GOLD, SILVER, NATURALGAS

import { getScrips } from '@/lib/motilal/market';
import { getSessionToken } from '@/lib/motilal/auth';
import type { MCXCommodity } from './types';
import { MCX_APPROVED_CONTRACTS } from './types';
import { MCX_CONTRACT_SPECS } from './instrument-master';

export interface MCXOptionStrike {
  strike: number;
  ce: {
    ltp: number;
    bid: number;
    ask: number;
    volume: number;
    oi: number;
    token: number;
    expiry: string;
  } | null;
  pe: {
    ltp: number;
    bid: number;
    ask: number;
    volume: number;
    oi: number;
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
  pcr: number;
  timestamp: string;
  dataSource: 'MOAPI' | 'NONE';
}

// Cache
const optionChainCache = new Map<string, { chain: MCXOptionChain; ts: number }>();
const OC_CACHE_TTL = 30000; // 30s

// ── Load option chain for a commodity ──
export async function loadMCXOptionChain(
  symbol: MCXCommodity,
  expiry?: string
): Promise<MCXOptionChain | null> {
  const token = getSessionToken();
  if (!token) return null;

  const cacheKey = `${symbol}_${expiry || 'nearest'}`;
  const cached = optionChainCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OC_CACHE_TTL) return cached.chain;

  try {
    const scrips = await getScrips('MCX', token);
    if (!scrips || scrips.length === 0) return null;

    const spec = MCX_CONTRACT_SPECS[symbol];
    const now = new Date();

    // Filter options for this symbol with valid expiry
    const optionScrips = scrips.filter(s => {
      const sName = (s.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
      const matchesSymbol = sName.includes(symbol);
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

    // Get futures price for spot reference
    const futureScrip = scrips.find(s => {
      const sName = (s.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
      return sName.includes(symbol) && !s.optiontype && s.expirydate === targetExpiry;
    });
    const spotPrice = futureScrip ? (futureScrip.strikeprice || 0) : 0;

    // Group by strike
    const strikeMap = new Map<number, MCXOptionStrike>();
    for (const s of expiryOptions) {
      const strike = s.strikeprice;
      if (!strike || strike <= 0) continue;

      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, { strike, ce: null, pe: null });
      }
      const entry = strikeMap.get(strike)!;

      const optionData = {
        ltp: 0,
        bid: 0,
        ask: 0,
        volume: 0,
        oi: 0,
        token: s.scripcode,
        expiry: s.expirydate,
      };

      const optType = (s.optiontype || '').toUpperCase();
      if (optType === 'CE' || optType === 'CA') {
        entry.ce = optionData;
      } else if (optType === 'PE' || optType === 'PA') {
        entry.pe = optionData;
      }
    }

    const strikes = [...strikeMap.values()].sort((a, b) => a.strike - b.strike);

    // Find ATM strike
    let atmStrike = 0;
    if (spotPrice > 0 && strikes.length > 0) {
      atmStrike = strikes.reduce((best, s) =>
        Math.abs(s.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? s : best
      ).strike;
    }

    // PCR
    const totalCEVolume = strikes.reduce((s, st) => s + (st.ce?.volume || 0), 0);
    const totalPEVolume = strikes.reduce((s, st) => s + (st.pe?.volume || 0), 0);
    const pcr = totalCEVolume > 0 ? totalPEVolume / totalCEVolume : 0;

    const chain: MCXOptionChain = {
      symbol,
      expiry: targetExpiry,
      spotPrice,
      strikes,
      atmStrike,
      totalCEVolume,
      totalPEVolume,
      pcr,
      timestamp: new Date().toISOString(),
      dataSource: 'MOAPI',
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

  // Only fetch for commodities that have options (CRUDEOIL, GOLD, SILVER, NATURALGAS)
  const withOptions = MCX_APPROVED_CONTRACTS.filter(s =>
    ['CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS'].includes(s)
  );

  const token = getSessionToken();
  if (!token) return results;

  try {
    const scrips = await getScrips('MCX', token);
    if (!scrips || scrips.length === 0) return results;

    const now = new Date();

    for (const symbol of withOptions) {
      const optionScrips = scrips.filter(s => {
        const sName = (s.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
        const matchesSymbol = sName.includes(symbol);
        const isOption = s.optiontype === 'CE' || s.optiontype === 'PE' || s.optiontype === 'CA' || s.optiontype === 'PA';
        const notExpired = s.expirydate && s.expirydate !== '0000-00-00' && new Date(s.expirydate) > now;
        return matchesSymbol && isOption && notExpired;
      });

      if (optionScrips.length === 0) continue;

      // Pick nearest expiry
      const expiries = [...new Set(optionScrips.map(s => s.expirydate))].sort();
      const nearest = expiries[0];
      const nearestOptions = optionScrips.filter(s => s.expirydate === nearest);

      // Get futures price
      const futureScrip = scrips.find(s => {
        const sName = (s.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
        return sName.includes(symbol) && !s.optiontype && s.expirydate === nearest;
      });
      const spotPrice = futureScrip ? (futureScrip.strikeprice || 0) : 0;

      // Group by strike
      const strikeMap = new Map<number, MCXOptionStrike>();
      for (const s of nearestOptions) {
        const strike = s.strikeprice;
        if (!strike || strike <= 0) continue;
        if (!strikeMap.has(strike)) strikeMap.set(strike, { strike, ce: null, pe: null });
        const entry = strikeMap.get(strike)!;
        const optType = (s.optiontype || '').toUpperCase();
        const optionData = { ltp: 0, bid: 0, ask: 0, volume: 0, oi: 0, token: s.scripcode, expiry: s.expirydate };
        if (optType === 'CE' || optType === 'CA') entry.ce = optionData;
        else if (optType === 'PE' || optType === 'PA') entry.pe = optionData;
      }

      const strikes = [...strikeMap.values()].sort((a, b) => a.strike - b.strike);
      let atmStrike = 0;
      if (spotPrice > 0 && strikes.length > 0) {
        atmStrike = strikes.reduce((best, s) =>
          Math.abs(s.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? s : best
        ).strike;
      }

      const totalCEVolume = strikes.reduce((s, st) => s + (st.ce?.volume || 0), 0);
      const totalPEVolume = strikes.reduce((s, st) => s + (st.pe?.volume || 0), 0);

      results.set(symbol, {
        symbol,
        expiry: nearest,
        spotPrice,
        strikes,
        atmStrike,
        totalCEVolume,
        totalPEVolume,
        pcr: totalCEVolume > 0 ? totalPEVolume / totalCEVolume : 0,
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
