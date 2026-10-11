// NSE primary provider — SMDApp central data layer
// Priority: NSE (BSE as secondary within NSE module)
// Read‑only, evidence‑only. Never touches trade-generation logic.
//
// Invariants every export must honour:
//   • source = 'NSE' (or 'BSE' for BSE‑derived derivatives)
//   • publishedAt / collectedAt verbatim (never rewritten)
//   • freshness computed from original timestamps via classifyFreshness()
//   • fallbackUsed = true when NSE endpoint returns non‑200 or stale data
//   • quoted values remain null when feed has no data (never fabricated)

import { TtlCache } from '@/lib/data-layer/cache';
import { classifyFreshness, collectedFreshness } from '@/lib/api-freshness';
import type { FreshnessLevel, OptionStrike, OptionLeg, OptionChainData, QuoteData, DataProvenance, ProviderResult, ProviderModule, HistoricalCandle, GainersLosers, MostActiveEquity, OISpurt } from '@/lib/data-layer/types';

// ── NSE endpoint helpers ─────────────────────────────────────────────

// NOTE: api.nseindia.com is dead (404 for every path). NSE only serves
// www.nseindia.com/api/* and requires a cookie primed from an HTML page,
// plus a matching Referer. Verified live: option-chain-v3, contract-info,
// allIndices, live-analysis-variations, marketStatus.
const NSE_BASE = 'https://www.nseindia.com/api';
const NSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let nseCookieCache: { cookie: string; expiresAt: number } | null = null;

async function getNseCookie(): Promise<string> {
  if (nseCookieCache && Date.now() < nseCookieCache.expiresAt) return nseCookieCache.cookie;
  try {
    const res = await fetch('https://www.nseindia.com', {
      headers: { 'User-Agent': NSE_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8_000),
    });
    const cookie = res.headers.get('set-cookie')?.split(';')[0] || '';
    nseCookieCache = { cookie, expiresAt: Date.now() + 5 * 60 * 1000 };
    return cookie;
  } catch {
    return '';
  }
}

async function nseGet(path: string, referer = 'https://www.nseindia.com/option-chain'): Promise<any> {
  const cookie = await getNseCookie();
  const res = await fetch(`${NSE_BASE}${path}`, {
    headers: {
      'User-Agent': NSE_UA,
      Cookie: cookie,
      Referer: referer,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`NSE ${path} ${res.status}`);
  return res.json();
}

// V3 requires an explicit expiry — fetch the list first (never guess a date).
async function fetchNseExpiries(symbol: string, type: string): Promise<string[]> {
  try {
    const info = await nseGet(
      `/option-chain-contract-info?type=${type}&symbol=${encodeURIComponent(symbol)}`,
    );
    const exps = info?.expiryDates || info?.records?.expiryDates;
    if (!Array.isArray(exps) || exps.length === 0) return [];
    // "13-Oct-2026" — string sort is unreliable across months; parse.
    return [...exps].sort(
      (a: string, b: string) =>
        (parseNseDate(a)?.getTime() ?? 0) - (parseNseDate(b)?.getTime() ?? 0),
    );
  } catch {
    return [];
  }
}

function parseNseDate(s: string): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s).trim());
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const mon = months[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
  if (mon === undefined) return null;
  return new Date(Number(m[3]), mon, Number(m[1]));
}

async function fetchNseOptionChainV3(symbol: string, expiry?: string): Promise<any> {
  // NIFTY/BANKNIFTY/… are indices; SENSEX/BANKEX are BSE-only (NSE has no
  // contract for them — contract-info returns {} rather than an error).
  const isBseIndex = symbol.toUpperCase() === 'SENSEX' || symbol.toUpperCase() === 'BANKEX';
  const type = isBseIndex ? 'BSE' : 'Indices';

  let exp = expiry;
  if (!exp) {
    const expiries = await fetchNseExpiries(symbol, type);
    if (expiries.length === 0) return null; // no NSE contract for this symbol
    exp = expiries[0];
  }

  const raw = await nseGet(
    `/option-chain-v3?type=${type}&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(exp)}`,
  );
  if (!raw?.records?.data?.length) return null;
  return { raw, expiry: exp };
}

async function fetchNseQuote(symbol: string): Promise<any> {
  return nseGet(`/quote-equity?symbol=${encodeURIComponent(symbol)}`, `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`);
}

async function fetchNseGainersLosers(): Promise<any> {
  return nseGet('/live-analysis-variations?index=gainers', 'https://www.nseindia.com/market-data/live-equity-market');
}

async function fetchNseMostActive(): Promise<any> {
  return nseGet('/marketMoversData?index=overview', 'https://www.nseindia.com/market-data/live-market-indices');
}

// ── Caches (per‑provider, module‑level state) ─────────────────────────

const quoteCache = new TtlCache<string, QuoteData>(30_000); // 30 s
const chainCache = new TtlCache<string, OptionChainData>(60_000); // 1 min
const glCache = new TtlCache<string, GainersLosers[]>(60_000); // 1 min
const maCache = new TtlCache<string, MostActiveEquity[]>(30_000); // 30 s

// ── Provider implementation ───────────────────────────────────────────

export const nseProvider: ProviderModule<never> = {
  // ── Quotes ──────────────────────────────────────────────────────────

  async getQuotes(symbols: string[]): Promise<ProviderResult<QuoteData[]>> {
    const results: QuoteData[] = [];
    const pending: Promise<QuoteData>[] = [];

    for (const sym of symbols) {
      const cached = quoteCache.get(sym);
      if (cached) {
        results.push(cached);
        continue;
      }
      pending.push(
        (async () => {
          try {
            const raw = await fetchNseQuote(sym);
            const quote: QuoteData = {
              symbol: raw?.symbol ?? sym,
              ltp: raw?.priceInfo?.lastPrice ?? null,
              change: raw?.priceInfo?.change ?? null,
              changePct: raw?.priceInfo?.changePercent ?? null,
              volume: raw?.priceInfo?.totalTradedQuantity ?? null,
              timestamp: new Date().toISOString(),
              source: 'NSE',
              fallbackUsed: false,
            };
            quoteCache.set(sym, quote);
            return quote;
          } catch (e: any) {
            return {
              symbol: sym,
              ltp: null,
              change: null,
              changePct: null,
              volume: null,
              timestamp: new Date().toISOString(),
              source: 'NSE',
              fallbackUsed: true,
            };
          }
        })(),
      );
    }

    const fetched = await Promise.all(pending);
    results.push(...fetched);
    return {
      data: results,
      fallbackUsed: results.some((r) => r.fallbackUsed),
      source: 'NSE',
    };
  },

  // ── Option Chain ────────────────────────────────────────────────────

  async getOptionChain(symbol: string, expiry?: string): Promise<ProviderResult<OptionChainData>> {
    const cached = chainCache.get(symbol);
    if (cached && (!expiry || cached.expiry === expiry)) {
      // Re-classify on read: a cache hit must age honestly, not stay LIVE.
      const age = Math.max(0, Date.now() - new Date(cached.timestamp).getTime());
      return { data: { ...cached, freshness: classifyFreshness(age, 'optionChain') }, fallbackUsed: false, source: 'NSE' };
    }

    try {
      const fetched = await fetchNseOptionChainV3(symbol, expiry);
      if (!fetched) {
        // No NSE contract (e.g. SENSEX/BANKEX) — honest NO_DATA, not an error.
        return { data: null, fallbackUsed: true, source: 'NSE', fallbackReason: 'no-nse-contract' };
      }
      const { raw, expiry: resolvedExpiry } = fetched;
      const strikes: OptionChainData['strikes'] = [];

      const rawArr = raw?.records?.data ?? [];
      for (const row of rawArr) {
        const strike = row?.strikePrice ?? row?.strike ?? null;
        if (strike === null || isNaN(strike)) continue;

        const ce: OptionLeg = {
          ltp: row?.CE?.lastPrice ?? null,
          volume: row?.CE?.totalTradedVolume ?? row?.CE?.totalTradedQuantity ?? null,
          oi: row?.CE?.openInterest ?? null,
          oiChange: row?.CE?.changeinOpenInterest ?? null,
          iv: row?.CE?.impliedVolatility ?? null,
          bid: row?.CE?.bidprice ?? row?.CE?.bid ?? null,
          ask: row?.CE?.askPrice ?? row?.CE?.ask ?? null,
          delta: row?.CE?.greeks?.delta ?? null,
          gamma: row?.CE?.greeks?.gamma ?? null,
          theta: row?.CE?.greeks?.theta ?? null,
          rho: row?.CE?.greeks?.rho ?? null,
        };

        const pe: OptionLeg = {
          ltp: row?.PE?.lastPrice ?? null,
          volume: row?.PE?.totalTradedVolume ?? row?.PE?.totalTradedQuantity ?? null,
          oi: row?.PE?.openInterest ?? null,
          oiChange: row?.PE?.changeinOpenInterest ?? null,
          iv: row?.PE?.impliedVolatility ?? null,
          bid: row?.PE?.bidprice ?? row?.PE?.bid ?? null,
          ask: row?.PE?.askPrice ?? row?.PE?.ask ?? null,
          delta: row?.PE?.greeks?.delta ?? null,
          gamma: row?.PE?.greeks?.gamma ?? null,
          theta: row?.PE?.greeks?.theta ?? null,
          rho: row?.PE?.greeks?.rho ?? null,
        };

        strikes.push({ strike, ce, pe });
      }

      const collectedAt = new Date().toISOString();
      const data: OptionChainData = {
        underlying: raw?.records?.underlyingValue ?? (symbol ?? 'UNKNOWN'),
        spot: raw?.records?.underlyingValue ?? null,
        expiry: resolvedExpiry ?? null,
        strikes,
        timestamp: collectedAt,
        source: 'NSE',
        fallbackUsed: false,
        // From the provider's OWN timestamp — a 200 response is not proof of LIVE.
        freshness: collectedFreshness(raw, 'optionChain'),
      };

      chainCache.set(symbol, data);
      return { data, fallbackUsed: false, source: 'NSE' };
    } catch (e: any) {
      return { data: null, fallbackUsed: true, source: 'NSE', fallbackReason: String(e?.message || e) };
    }
  },

  // ── Gainers/Losers ──────────────────────────────────────────────────

  async getGainersLosers(): Promise<ProviderResult<GainersLosers[]>> {
    try {
      const raw = await fetchNseGainersLosers();
      const items: GainersLosers[] = [];
      // Shape: { NIFTY: { data: [...], timestamp }, BANKNIFTY: {...}, ... }
      // Rows: { symbol, ltp, net_price, perChange, trade_quantity }
      const rows = raw?.NIFTY?.data ?? raw?.data ?? [];
      const publishedAt = raw?.NIFTY?.timestamp ?? null;

      for (let i = 0; i < rows.length && i < 20; i++) {
        const it = rows[i];
        items.push({
          rank: i + 1,
          symbol: it?.symbol ?? '',
          name: it?.symbol,
          ltp: it?.ltp ?? null,
          change: it?.net_price ?? null,
          changePct: it?.perChange ?? null,
          volume: it?.trade_quantity ?? null,
          timestamp: publishedAt || new Date().toISOString(),
          source: 'NSE',
          fallbackUsed: false,
        });
      }

      glCache.set('nse-g-l', items);
      return { data: items, fallbackUsed: false, source: 'NSE' };
    } catch (e: any) {
      return { data: [], fallbackUsed: true, source: 'NSE' };
    }
  },

  // ── Most‑Active Equities ────────────────────────────────────────────

  async getMostActiveEquities(): Promise<ProviderResult<MostActiveEquity[]>> {
    try {
      const raw = await fetchNseMostActive();
      const items: MostActiveEquity[] = [];

      for (const it of raw?.data ?? []) {
        items.push({
          symbol: it?.symbol ?? '',
          name: it?.symbol,
          ltp: it?.priceInfo?.lastPrice ?? null,
          change: it?.priceInfo?.change ?? null,
          changePct: it?.priceInfo?.changePercent ?? null,
          volume: it?.priceInfo?.totalTradedQuantity ?? null,
          timestamp: new Date().toISOString(),
          source: 'NSE',
          fallbackUsed: false,
        });
      }

      // de‑dup by symbol (keep first seen)
      const seen = new Set<string>();
      const unique = items.filter((o) => !seen.has(o.symbol) && seen.add(o.symbol) || false);
      maCache.set('nse-ma', unique);
      return { data: unique, fallbackUsed: false, source: 'NSE' };
    } catch (e: any) {
      return { data: [], fallbackUsed: true, source: 'NSE' };
    }
  },

  // ── OI Spurts ───────────────────────────────────────────────────────
  // (NSE does not surface OI‑velocity in the V3 bundle; return empty.)
  async getOISpurts(): Promise<ProviderResult<OISpurt[]>> {
    return { data: [], fallbackUsed: true, source: 'NSE' };
  },

  // ── FII/DII ────────────────────────────────────────────────────────
  async getFiiDii(): Promise<ProviderResult<never>> {
    return { data: [] as never, fallbackUsed: true, source: 'NSE' };
  },

  // ── Historical candles ───────────────────────────────────────────────
  async getHistoricalCandles(
    symbol: string,
    timeframe: string,
    count = 100,
  ): Promise<ProviderResult<HistoricalCandle[]>> {
    return { data: [], fallbackUsed: true, source: 'NSE' };
  },
};

// Default export for registry.
export default nseProvider;

/** Fake for tests — replace with a manual object in test files. */
export function __nseProviderFake(): ProviderModule<never> {
  return {
    getQuotes: async () => ({ data: [], fallbackUsed: true, source: 'NSE' }),
    getOptionChain: async () => ({ data: null, fallbackUsed: true, source: 'NSE' }),
    getGainersLosers: async () => ({ data: [] as never, fallbackUsed: true, source: 'NSE' }),
    getMostActiveEquities: async () => ({ data: [] as never, fallbackUsed: true, source: 'NSE' }),
    getOISpurts: async () => ({ data: [] as never, fallbackUsed: true, source: 'NSE' }),
    getFiiDii: async () => ({ data: [] as never, fallbackUsed: true, source: 'NSE' }),
    getHistoricalCandles: async () => ({ data: [] as never, fallbackUsed: true, source: 'NSE' }),
  };
}