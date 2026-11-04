// Motilal Oswal Option Chain Provider
// Provides NIFTY, BANKNIFTY, FINNIFTY, SENSEX option chains from Motilal API
//
// Two rungs, same shape (see ./motilal/service.ts for the service contract):
//   1. LOCAL MOAPI service (preferred) — instrument master in ~1.5s (the
//      direct `getScrips` call takes ~20s for 83k NSEFO rows and blows the
//      option-chain route's 6s race) + one bulk `/ltps` for every strike.
//   2. Direct Motilal REST — fallback when the service is off/unconfigured.

import { getScrips, getLTP } from '@/lib/motilal/market';
import { getSessionToken, isSessionValid } from '@/lib/motilal/auth';
import {
  fetchServiceInstruments,
  fetchServiceLTP,
  fetchServiceLTPs,
  isServiceConfigured,
  type ServiceInstrument,
} from '@/lib/motilal/service';

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

// ── Common scrip shape both rungs normalise into ──
interface OptionScrip {
  scripcode: number;
  symbol: string;
  optiontype: string; // CE | PE | "" (futures/cash)
  instrumenttype: string;
  expirydate: string; // YYYY-MM-DD
  strikeprice: number;
  tradingsymbol?: string; // present on the service rung
}

function fromServiceInstrument(i: ServiceInstrument): OptionScrip {
  return {
    scripcode: 0,
    symbol: i.symbol,
    optiontype: i.optionType || '',
    instrumenttype: i.instrumentType || '',
    expirydate: i.expiry,
    strikeprice: i.strike,
    tradingsymbol: i.tradingsymbol,
  };
}

function fromDirectScrip(s: any): OptionScrip {
  return {
    scripcode: Number(s.scripcode) || 0,
    symbol: String(s.symbol || ''),
    optiontype: String(s.optiontype || ''),
    instrumenttype: String(s.instrumenttype || ''),
    expirydate: String(s.expirydate || ''),
    strikeprice: Number(s.strikeprice) || 0,
  };
}

/**
 * MO's REST `getltpdata` returns prices in PAISE (verified live: 89890 →
 * ₹898.90). The service rung already serves rupees; this helper normalises
 * a batch of raw direct-REST values. If any value looks like paise for a
 * realistic F&O price (> ₹20 in raw units), the whole batch is paise —
 * a single contract is never scaled differently from its siblings.
 */
function scaleMoRestPrices(raws: number[]): (raw: number) => number {
  const positive = raws.filter((n) => Number.isFinite(n) && n > 0);
  if (!positive.length) return (raw) => raw;
  const max = Math.max(...positive);
  // Raw > 2000 cannot be a rupee premium for the strikes we fetch (max
  // realistic index premium is a few thousand RUPEES = tens of thousands
  // of paise); treat the batch as paise and convert once.
  const factor = max > 2000 ? 100 : 1;
  return (raw) => (Number.isFinite(raw) && raw > 0 ? raw / factor : raw);
}

// ── Load option chain from Motilal ──
export async function getMotilalOptionChain(
  symbol: string,
  expiry?: string
): Promise<MotilalOptionChainResult | null> {
  if (!isSessionValid()) {
    // Try auto-login with .env credentials
    try {
      const { autoLogin } = await import('@/lib/motilal/auth');
      const loggedIn = await autoLogin();
      if (!loggedIn) return null;
    } catch {
      return null;
    }
  }

  const cacheKey = `${symbol}_${expiry || 'nearest'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.chain;

  const token = getSessionToken();
  if (!token) return null;

  const moslSymbol = SYMBOL_MAP[symbol.toUpperCase()] || symbol.toUpperCase();
  const exchange = EXCHANGE_MAP[symbol.toUpperCase()] || 'NSEFO';

  try {
    // ── Rung 1: local MOAPI service (fast instrument master + bulk LTP) ──
    // Symbol-filtered fetch: only NIFTY's ~few-k rows, not the 126k master.
    const serviceInstruments = isServiceConfigured()
      ? await fetchServiceInstruments(false, moslSymbol)
      : null;

    let scrips: OptionScrip[];
    let viaService = false;
    if (serviceInstruments && serviceInstruments.length) {
      scrips = serviceInstruments
        .filter((i) => i.exchange === exchange || !i.exchange)
        .map(fromServiceInstrument);
      viaService = true;
    } else {
      // ── Rung 2: direct Motilal REST (getScrips is ~20s on NSEFO) ──
      const direct = await getScrips(exchange, token);
      if (!direct || direct.length === 0) return null;
      scrips = direct.map(fromDirectScrip);
    }

    const now = new Date();

    // Filter options for this symbol
    const optionScrips = scrips.filter((s) => {
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
    const expiryOptions = optionScrips.filter((s) => s.expirydate === targetExpiry);

    if (expiryOptions.length === 0) return null;

    // Get futures price for spot reference
    const futureScrip = scrips.find((s) => {
      const sName = (s.symbol || '').toUpperCase();
      return sName === moslSymbol && s.instrumenttype === 'FUTIDX' && s.expirydate === targetExpiry;
    });

    let spotPrice = 0;
    const spotScrip = futureScrip ||
      // Nearest futures when the target expiry has no FUTIDX row.
      scrips
        .filter((s) => (s.symbol || '').toUpperCase() === moslSymbol && s.instrumenttype === 'FUTIDX' && s.expirydate >= targetExpiry)
        .sort((a, b) => a.expirydate.localeCompare(b.expirydate))[0];

    // Raw direct-REST option values (paise) — scaled once after the batch.
    const directOptionRaws = new Map<number, number>(); // scripcode → raw

    // ── Spot LTP ──
    if (viaService && spotScrip?.tradingsymbol) {
      const spots = await fetchServiceLTPs([spotScrip.tradingsymbol]);
      spotPrice = spots[spotScrip.tradingsymbol.toUpperCase()] || 0;
    } else if (spotScrip?.scripcode) {
      const futLtp = await getLTP(exchange, spotScrip.scripcode, token);
      if (futLtp?.ltp) {
        // Scale spot IMMEDIATELY — moneyness sorting below compares against
        // strike prices in rupees; leaving spot in paise would sort garbage.
        spotPrice = scaleMoRestPrices([futLtp.ltp])(futLtp.ltp);
      }
    }

    // Also try to get cash market LTP if futures not available
    if (spotPrice === 0) {
      const cashScrip = scrips.find((s) => {
        const sName = (s.symbol || '').toUpperCase();
        return sName === moslSymbol && !s.optiontype && !s.instrumenttype;
      });
      if (cashScrip) {
        if (viaService && cashScrip.tradingsymbol) {
          const spots = await fetchServiceLTPs([cashScrip.tradingsymbol]);
          spotPrice = spots[cashScrip.tradingsymbol.toUpperCase()] || 0;
        } else if (cashScrip.scripcode) {
          const cashLtp = await getLTP(exchange, cashScrip.scripcode, token);
          if (cashLtp?.ltp) {
            spotPrice = scaleMoRestPrices([cashLtp.ltp])(cashLtp.ltp);
          }
        }
      }
    }

    // MO only has LTP for contracts that actually traded — far strikes come
    // back NO RECORDS. Once spot is known, order by moneyness and cap the
    // fetch so the call stays inside the route's race budget.
    const MAX_OPTION_SCRIPS = 30; // ~15 strikes × CE+PE
    const sortRef = spotPrice > 0 ? spotPrice : 0;
    const fetchSet = (sortRef > 0
      ? [...expiryOptions].sort(
          (a, b) =>
            Math.abs(a.strikeprice - sortRef) - Math.abs(b.strikeprice - sortRef)
        )
      : expiryOptions
    ).slice(0, MAX_OPTION_SCRIPS);

    // Fetch LTP for options — only the nearest strikes (fetchSet)
    const scripsToFetch = fetchSet;
    const ltpMap = new Map<number, number>(); // scripcode → ltp (direct rung)
    const ltpBySymbol = new Map<string, number>(); // tradingsymbol → ltp (service rung)

    if (viaService) {
      const tradingsymbols = scripsToFetch
        .map((s) => s.tradingsymbol)
        .filter((t): t is string => Boolean(t));
      if (tradingsymbols.length) {
        // Parallel individual /ltp calls (the service caches each result in
        // ~15s TTL; ThreadingHTTPServer handles concurrent GETs). A single
        // bulk /ltps of 40+ contracts is effectively serial on MO's REST
        // (~250ms each) and blows the budget — batches of 10 overlap instead.
        const CONCURRENCY = 10;
        for (let i = 0; i < tradingsymbols.length; i += CONCURRENCY) {
          const batch = tradingsymbols.slice(i, i + CONCURRENCY);
          const results = await Promise.all(
            batch.map(async (ts) => {
              const json = await fetchServiceLTP(ts);
              return { ts, ltp: json?.ltp || 0 };
            })
          );
          for (const r of results) {
            if (r.ltp > 0) ltpBySymbol.set(r.ts.toUpperCase(), r.ltp);
          }
        }
      }
      // Early bail: if the bulk call returned nothing, the service LTP path
      // is broken — don't pretend we have a chain.
      if (tradingsymbols.length > 0 && ltpBySymbol.size === 0) {
        console.warn('[Motilal] service LTP returned no prices — skipping MOAPI');
        return null;
      }
    } else {
      let consecutiveFailures = 0;
      for (let i = 0; i < scripsToFetch.length; i += 5) {
        const batch = scripsToFetch.slice(i, i + 5);
        const results = await Promise.all(
          batch.map(async (s) => {
            const ltp = await getLTP(exchange, s.scripcode, token);
            return { scripcode: s.scripcode, ltp: ltp?.ltp || 0 };
          })
        );
        for (const r of results) {
          if (r.ltp > 0) {
            directOptionRaws.set(r.scripcode, r.ltp);
            consecutiveFailures = 0;
          } else {
            consecutiveFailures++;
          }
        }
        // If first batch (5 calls) all fail, MOAPI F&O LTP is broken — bail
        if (i === 0 && consecutiveFailures >= 5) {
          console.warn('[Motilal] NSEFO LTP endpoint not responding — skipping MOAPI');
          return null;
        }
      }
      // One batch factor for every option raw (paise → rupees). Spot was
      // already scaled at fetch time and is intentionally NOT in this batch.
      const scale = scaleMoRestPrices([...directOptionRaws.values()]);
      for (const [code, raw] of directOptionRaws) ltpMap.set(code, scale(raw));
    }

    const ltpFor = (s: OptionScrip): number => {
      if (viaService && s.tradingsymbol) {
        return ltpBySymbol.get(s.tradingsymbol.toUpperCase()) || 0;
      }
      return ltpMap.get(s.scripcode) || 0;
    };

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
        ltp: ltpFor(s),
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
        _dataSource: viaService ? 'moapi-service-ltp' : 'moapi-ltp-only',
        _hasOI: false,
        _hasVolume: false,
        _hasGreeks: false,
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
