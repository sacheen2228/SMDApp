// Motilal Oswal Option Chain Provider
// Provides NIFTY, BANKNIFTY, FINNIFTY, SENSEX option chains from Motilal API

import { getScrips, getLTP } from '@/lib/motilal/market';
import { getSessionToken, isSessionValid } from '@/lib/motilal/auth';

export interface MotilalOptionStrike {
  strike: number;
  ce: {
    ltp: number;
    oi: number;
    volume: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    bid: number;
    ask: number;
    token: number;
  } | null;
  pe: {
    ltp: number;
    oi: number;
    volume: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    bid: number;
    ask: number;
    token: number;
  } | null;
}

export interface MotilalOptionChainResult {
  data: MotilalOptionStrike[];
  spotPrice: number;
  expiries: string[];
  selectedExpiry: string;
  summary: {
    spotPrice: number;
    indiaVIX?: number;
    maxPain?: number;
    prevClose?: number;
  };
}

// Map symbol to Motilal scripshortname
const SYMBOL_MAP: Record<string, string> = {
  NIFTY: 'NIFTY',
  NIFTY50: 'NIFTY',
  BANKNIFTY: 'BANKNIFTY',
  FINNIFTY: 'FINNIFTY',
  MIDCPNIFTY: 'MIDCPNIFTY',
  SENSEX: 'SENSEX',
  BANKEX: 'BANKEX',
};

// Map symbol to exchange
const EXCHANGE_MAP: Record<string, string> = {
  NIFTY: 'NSEFO',
  NIFTY50: 'NSEFO',
  BANKNIFTY: 'NSEFO',
  FINNIFTY: 'NSEFO',
  MIDCPNIFTY: 'NSEFO',
  SENSEX: 'BSEFO',
  BANKEX: 'BSEFO',
};

// Cache
const cache = new Map<string, { data: MotilalOptionChainResult; ts: number }>();
const CACHE_TTL = 30000; // 30s

// ── Load option chain from Motilal ──
export async function getMotilalOptionChain(
  symbol: string,
  expiry?: string
): Promise<MotilalOptionChainResult | null> {
  if (!isSessionValid()) return null;

  const cacheKey = `${symbol}_${expiry || 'nearest'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.chain;

  const token = getSessionToken();
  if (!token) return null;

  const moslSymbol = SYMBOL_MAP[symbol.toUpperCase()] || symbol.toUpperCase();
  const exchange = EXCHANGE_MAP[symbol.toUpperCase()] || 'NSEFO';

  try {
    const scrips = await getScrips(exchange, token);
    if (!scrips || scrips.length === 0) return null;

    const now = new Date();

    // Filter options for this symbol
    const optionScrips = scrips.filter(s => {
      const sName = (s.symbol || '').toUpperCase();
      const matchesSymbol = sName === moslSymbol;
      const isOption = s.optiontype === 'CE' || s.optiontype === 'PE';
      const hasExpiry = s.expirydate && s.expirydate !== '0000-00-00';
      // Use date-only comparison (ignore time) so today's expiry is included
      const expiryDate = hasExpiry ? new Date(s.expirydate + 'T23:59:59') : null;
      const notExpired = expiryDate && expiryDate >= now;
      return matchesSymbol && isOption && notExpired;
    });

    if (optionScrips.length === 0) return null;

    // Get unique expiries
    const expirySet = new Set<string>();
    for (const s of optionScrips) {
      if (s.expirydate) expirySet.add(s.expirydate);
    }
    const sortedExpiries = [...expirySet].sort();
    const targetExpiry = expiry || sortedExpiries[0];
    const expiryOptions = optionScrips.filter(s => s.expirydate === targetExpiry);

    if (expiryOptions.length === 0) return null;

    // Get futures price for spot reference
    const futureScrip = scrips.find(s => {
      const sName = (s.symbol || '').toUpperCase();
      return sName === moslSymbol && s.instrumenttype === 'FUTIDX' && s.expirydate === targetExpiry;
    });

    let spotPrice = 0;
    if (futureScrip) {
      const futLtp = await getLTP(exchange, futureScrip.scripcode, token);
      spotPrice = futLtp?.ltp || 0;
    }

    // Also try to get cash market LTP if futures not available
    if (spotPrice === 0) {
      const cashScrip = scrips.find(s => {
        const sName = (s.symbol || '').toUpperCase();
        return sName === moslSymbol && !s.optiontype && !s.instrumenttype;
      });
      if (cashScrip) {
        const cashLtp = await getLTP(exchange, cashScrip.scripcode, token);
        spotPrice = cashLtp?.ltp || 0;
      }
    }

    // Fetch LTP for options (batch, max 80)
    const scripsToFetch = expiryOptions.slice(0, 80);
    const ltpMap = new Map<number, number>();

    for (let i = 0; i < scripsToFetch.length; i += 5) {
      const batch = scripsToFetch.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async (s) => {
          const ltp = await getLTP(exchange, s.scripcode, token);
          return { scripcode: s.scripcode, ltp: ltp?.ltp || 0 };
        })
      );
      for (const r of results) {
        if (r.ltp > 0) ltpMap.set(r.scripcode, r.ltp);
      }
    }

    // Group by strike
    const strikeMap = new Map<number, MotilalOptionStrike>();
    for (const s of expiryOptions) {
      const strike = s.strikeprice;
      if (!strike || strike <= 0) continue;

      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, { strike, ce: null, pe: null });
      }
      const entry = strikeMap.get(strike)!;

      const optionData = {
        ltp: ltpMap.get(s.scripcode) || 0,
        oi: 0,
        volume: 0,
        iv: 0,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        bid: 0,
        ask: 0,
        token: s.scripcode,
      };

      if (s.optiontype === 'CE') {
        entry.ce = optionData;
      } else if (s.optiontype === 'PE') {
        entry.pe = optionData;
      }
    }

    const strikes = [...strikeMap.values()].sort((a, b) => a.strike - b.strike);

    const result: MotilalOptionChainResult = {
      data: strikes,
      spotPrice,
      expiries: sortedExpiries,
      selectedExpiry: targetExpiry,
      summary: { spotPrice },
    };

    cache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (error) {
    console.warn('[Motilal] Option chain error:', error);
    return null;
  }
}

// ── Get expiries for a symbol ──
export async function getMotilalExpiries(symbol: string): Promise<string[]> {
  if (!isSessionValid()) return [];

  const token = getSessionToken();
  if (!token) return [];

  const moslSymbol = SYMBOL_MAP[symbol.toUpperCase()] || symbol.toUpperCase();
  const exchange = EXCHANGE_MAP[symbol.toUpperCase()] || 'NSEFO';

  try {
    const scrips = await getScrips(exchange, token);
    if (!scrips) return [];

    const now = new Date();
    const expirySet = new Set<string>();

    for (const s of scrips) {
      const sName = (s.symbol || '').toUpperCase();
      if (sName === moslSymbol && s.optiontype && s.expirydate && new Date(s.expirydate) > now) {
        expirySet.add(s.expirydate);
      }
    }

    return [...expirySet].sort();
  } catch {
    return [];
  }
}
