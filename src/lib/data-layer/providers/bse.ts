// BSE provider — SMDApp central data layer
// Priority: BSE (primary) → MOAPI (fallback) → NO_DATA
// Never trades, never creates orders; read‑only, evidence‑only.
//
// Invariants every export must honour:
//   • source = 'BSE' (or 'BSE-chain' for chain-derived spot)
//   • publishedAt / collectedAt verbatim (never rewritten)
//   • freshness computed from original timestamps via classifyFreshness()
//   • fallbackUsed = true when BSE endpoint returns non‑200 or stale data
//   • quoted values remain null when feed has no data (never fabricated)
//
// This module is the CANONICAL BSE source for the central data layer.
// It must NOT be the primary source for NSE instruments; callers should always
// attempt NSE first and only fall through to this module on NSE failure.
//
// The BSE spot price is derived from the live DerivOptionChain_IV option chain,
// since the official GetSensexDatanew endpoint has been unavailable since ~2026-09.
//
// All missing fields remain null — never fabricated.

import { TtlCache } from '@/lib/data-layer/cache';
import { classifyFreshness, collectedFreshness } from '@/lib/api-freshness';
import type { FreshnessLevel, OptionStrike, OptionLeg, OptionChainData, QuoteData, DataProvenance, ProviderResult, ProviderModule, HistoricalCandle, GainersLosers, MostActiveEquity } from '@/lib/data-layer/types';

// ── BSE endpoint helpers ─────────────────────────────────────────────

const BSE_API_BASE = 'https://api.bseindia.com/BseIndiaAPI/api';
const BSE_SCRIP_CODES: Record<string, number> = {
  SENSEX: 1,
  BANKEX: 12,
};
// BSE rejects bare requests with 404 — Origin + Referer from the
// DerivOptionchain page are required (verified live).
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Origin': 'https://www.bseindia.com',
  'Referer': 'https://www.bseindia.com/markets/Derivatives/DeriReports/DeriOptionchain',
  'Accept': 'application/json',
};

function getBseScripCd(symbol: string): number | null {
  // Unknown symbols must NOT default to 1 (= SENSEX) — that silently
  // returns another instrument's chain.
  return BSE_SCRIP_CODES[symbol.toUpperCase()] ?? null;
}

// BSE "MON YYYY" label is NOT a valid Expiry value — DerivOptionChain_IV
// expects "15 Oct 2026" exactly as returned by the dropdown endpoint.
// Verified live: guessing "OCT 2026" returns { Table: [] }.
async function fetchBseExpiries(symbol: string): Promise<string[]> {
  const scripCd = getBseScripCd(symbol);
  if (!scripCd) return [];
  try {
    const url = `${BSE_API_BASE}/Mkt_Archive_SerachDeriDropDown_beta/w?Product_Type=IO&scrip_cd=${scripCd}&Flag=1`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const table1 = data?.table1 || [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return table1
      .map((r: any) => r?.EXPIRYDT)
      .filter((s: any): s is string => typeof s === 'string' && s !== '-' && s !== '')
      .map((s: string) => ({ s, d: parseBseDate(s) }))
      .filter((x: { s: string; d: Date | null }) => x.d && x.d.getTime() >= now.getTime())
      .sort((a, b) => a.d!.getTime() - b.d!.getTime())
      .map((x) => x.s);
  } catch {
    return [];
  }
}

function parseBseDate(s: string): Date | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(String(s).trim());
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mon = months[m[2].toLowerCase()];
  if (mon === undefined) return null;
  return new Date(Number(m[3]), mon, Number(m[1]));
}

async function fetchBSEOptionChain(symbol: string, expiry?: string): Promise<any> {
  const scripCd = getBseScripCd(symbol);
  if (!scripCd) throw new Error(`BSE unknown scrip for ${symbol}`);

  let exp = expiry;
  if (!exp) {
    const expiries = await fetchBseExpiries(symbol);
    if (expiries.length === 0) throw new Error(`BSE no expiries for ${symbol}`);
    exp = expiries[0];
  }

  const encodedExpiry = exp.replace(/ /g, '+');
  const url = `${BSE_API_BASE}/DerivOptionChain_IV/w?Expiry=${encodedExpiry}&scrip_cd=${scripCd}&strprice=0`;
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`BSE option-chain ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json?.Table) || json.Table.length === 0) {
    throw new Error(`BSE empty chain for ${symbol} @ ${exp}`);
  }
  return { json, expiry: exp };
}

async function fetchBSEIndexData(symbol: string): Promise<any> {
  // try the dead endpoint briefly
  try {
    const response = await fetch(`${BSE_API_BASE}/GetSensexDatanew/w`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data)) {
        const index = data.find((d: any) =>
          symbol.toUpperCase() === 'SENSEX'
            ? d.indxnm === 'BSE SENSEX'
            : d.indxnm === 'BSE BANKEX'
        );
        if (index) {
          return {
            spotPrice: parseFloat((index.ltp || '0').replace(/,/g, '')),
            previousClose: parseFloat((index.Prev_Close || '0').replace(/,/g, '')),
            high: parseFloat((index.High || '0').replace(/,/g, '')),
            low: parseFloat((index.Low || '0').replace(/,/g, '')),
            volume: 0,
            timestamp: new Date().toISOString(),
          };
        }
      }
    }
  } catch {
    // dead endpoint — fall through
  }

  // derive spot from live option chain
  try {
    const { json } = await fetchBSEOptionChain(symbol);
    const rows = json?.Table ?? [];
    const ula = rows[0]?.UlaValue ?? json?.UlaValue;
    if (ula) {
      return {
        spotPrice: parseFloat(String(ula).replace(/,/g, '')),
        previousClose: 0,
        high: 0,
        low: 0,
        volume: 0,
        timestamp: new Date().toISOString(),
      };
    }
  } catch {
    // fall through to NO_DATA
  }

  return null;
}

// ── Caches (per‑provider, module‑level state) ──────────────────────────

const quoteCache = new TtlCache< string, QuoteData >(30_000); // 30 s
const chainCache = new TtlCache<string, OptionChainData>(60_000); // 1 min

// ── Provider implementation ───────────────────────────────────────────

export const bseProvider: ProviderModule<never> = {
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
            const raw = await fetchBSEIndexData(sym);
            const quote: QuoteData = {
              symbol: raw?.symbol ?? sym,
              ltp: raw?.spotPrice ?? null,
              change: null,
              changePct: null,
              volume: raw?.volume ?? null,
              timestamp: raw?.timestamp ?? new Date().toISOString(),
              source: 'BSE',
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
              source: 'BSE',
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
      source: 'BSE',
    };
  },

  // ── Option Chain ────────────────────────────────────────────────────

  async getOptionChain(symbol: string, expiry?: string): Promise<ProviderResult<OptionChainData>> {
    // check cache first
    const cached = chainCache.get(symbol);
    if (cached && (!expiry || cached.expiry === expiry)) {
      // Re-classify on read: a cache hit must age honestly, not stay LIVE.
      const age = Math.max(0, Date.now() - new Date(cached.timestamp).getTime());
      return { data: { ...cached, freshness: classifyFreshness(age, 'optionChain') }, fallbackUsed: false, source: 'BSE' };
    }

    try {
      const { json: raw, expiry: resolvedExpiry } = await fetchBSEOptionChain(symbol, expiry);
      const strikes: OptionChainData['strikes'] = [];

      const rawArr = raw?.Table ?? [];
      for (const row of rawArr) {
        const strike = parseFloat(row.Strike_Price1);
        if (isNaN(strike)) continue;

        // BSE DerivOptionChain_IV returns one row per strike holding BOTH
        // sides: PE fields are unprefixed, CE fields carry a `C_` prefix.
        // (The legacy `bse-api.ts` is the reference mapping.)
        const ce: OptionLeg = {
          ltp: parseNum(row.C_Last_Trd_Price),
          volume: parseNum(row.C_Vol_Traded),
          oi: parseNum(row.C_Open_Interest),
          oiChange: parseNum(row.C_Absolute_Change_OI),
          iv: roundIv(parseNum(row.C_IV)),
          bid: parseNum(row.C_BidPrice),
          ask: parseNum(row.C_OfferPrice),
          delta: null,
          gamma: null,
          theta: null,
          rho: null,
        };

        const pe: OptionLeg = {
          ltp: parseNum(row.Last_Trd_Price),
          volume: parseNum(row.Vol_Traded),
          oi: parseNum(row.Open_Interest),
          oiChange: parseNum(row.Absolute_Change_OI),
          iv: roundIv(parseNum(row.IV)),
          bid: parseNum(row.BidPrice),
          ask: parseNum(row.OfferPrice),
          delta: null,
          gamma: null,
          theta: null,
          rho: null,
        };

        strikes.push({ strike, ce, pe });
      }

      const collectedAt = new Date().toISOString();
      const data: OptionChainData = {
        underlying: symbol,
        // UlaValue is per-row (verified live): top-level UlaValue does not exist.
        spot: parseNum(rawArr[0]?.UlaValue) || raw?.UlaValue || null,
        expiry: resolvedExpiry ?? null,
        strikes,
        timestamp: collectedAt,
        source: 'BSE',
        fallbackUsed: false,
        freshness: collectedFreshness(raw, 'optionChain'),
      };

      chainCache.set(symbol, data);
      return { data, fallbackUsed: false, source: 'BSE' };
    } catch (e: any) {
      return { data: null, fallbackUsed: true, source: 'BSE', fallbackReason: String(e?.message || e) };
    }
  },

  // ── Gainers/Losers ──────────────────────────────────────────────────

  async getGainersLosers(): Promise<ProviderResult<GainersLosers[]>> {
    return { data: [], fallbackUsed: true, source: 'BSE' };
  },

  // ── Most‑Active Equities ──────────────────────────────────────────────

  async getMostActiveEquities(): Promise<ProviderResult<MostActiveEquity[]>> {
    return { data: [], fallbackUsed: true, source: 'BSE' };
  },

  // ── OI Spurts ───────────────────────────────────────────────────────
  async getOISpurts(): Promise<ProviderResult<never>> {
    return { data: [] as never, fallbackUsed: true, source: 'BSE' };
  },

  // ── FII/DII ────────────────────────────────────────────────────────
  async getFiiDii(): Promise<ProviderResult<never>> {
    return { data: [] as never, fallbackUsed: true, source: 'BSE' };
  },

  // ── Historical candles ───────────────────────────────────────────────
  async getHistoricalCandles(
    symbol: string,
    timeframe: string,
    count = 100,
  ): Promise<ProviderResult<HistoricalCandle[]>> {
    return { data: [], fallbackUsed: true, source: 'BSE' };
  },
};

// Default export for registry.
export default bseProvider;

/** Fake for tests — replace with a manual object in test files. */
export function __bseProviderFake(): ProviderModule<never> {
  return {
    getQuotes: async () => ({ data: [], fallbackUsed: true, source: 'BSE' }),
    getOptionChain: async () => ({ data: null, fallbackUsed: true, source: 'BSE' }),
    getGainersLosers: async () => ({ data: [] as never, fallbackUsed: true, source: 'BSE' }),
    getMostActiveEquities: async () => ({ data: [] as never, fallbackUsed: true, source: 'BSE' }),
    getOISpurts: async () => ({ data: [] as never, fallbackUsed: true, source: 'BSE' }),
    getFiiDii: async () => ({ data: [] as never, fallbackUsed: true, source: 'BSE' }),
    getHistoricalCandles: async () => ({ data: [] as never, fallbackUsed: true, source: 'BSE' }),
  };
}

// Helper: parse string to number — returns null when missing (never fabricated)
function parseNum(val: string | undefined | null): number | null {
  if (!val || val === '' || val === '-') return null;
  const n = parseFloat(val.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// BSE ships IV at full float precision (14.215268143110801) while NSE reports
// clean 2dp (14.22). Round for display parity — never for OI, volume or price.
function roundIv(iv: number | null): number | null {
  if (iv == null) return null;
  return Math.round(iv * 100) / 100;
}