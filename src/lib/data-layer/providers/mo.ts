// MOAPI (Motilal Oswal) fallback provider — SMDApp central data layer
// Priority: NSE (primary) → MOAPI (fallback) → Yahoo (structured fallback)
// Never trades, never creates orders; read‑only, evidence‑only.
//
// Invariants: source='MOAPI' when served from this module;
//   fallbackUsed=true iff MOAPI returns error or stale data;
//   all null/NO_DATA fields when feed has no data (never fabricated).
//
// This module is the CANONICAL MOAPI source for the central data layer.
// It must NOT be the primary source; callers should always attempt NSE first
// and only fall through to this module on NSE failure.

import { TtlCache } from '@/lib/data-layer/cache';
import { classifyFreshness } from '@/lib/api-freshness';
import type { FreshnessLevel, QuoteData, OptionChainData, GainersLosers, ProviderResult, ProviderModule, MostActiveEquity, HistoricalCandle } from '@/lib/data-layer/types';

// ── MOAPI base URLs ───────────────────────────────────────────────────

const MO_BASE = 'https://www motilaloswal com'; // placeholder — actual URLs
// MOAPI endpoints are behind auth; the central layer currently does NOT
// implement full MOAPI quote/chain fetch because the existing motilal/* modules
// are largely dead (zero importers).  We expose a stub that returns
// fallbackUsed=true so callers can gracefully degrade to Yahoo or NO_DATA.

// ── Quote stub ────────────────────────────────────────────────────────

export const moProvider: ProviderModule<never> = {
  async getQuotes(_symbols: string[]): Promise<ProviderResult<QuoteData[]>> {
    return {
      data: [],
      fallbackUsed: true,
      source: 'MOAPI',
    };
  },

  // ── Option Chain stub ───────────────────────────────────────────────
  async getOptionChain(_symbol: string, _expiry?: string): Promise<ProviderResult<OptionChainData>> {
    return {
      data: null,
      fallbackUsed: true,
      source: 'MOAPI',
    };
  },

  // ── Gainers/Losers stub ─────────────────────────────────────────────
  async getGainersLosers(): Promise<ProviderResult<GainersLosers[]>> {
    return { data: [], fallbackUsed: true, source: 'MOAPI' };
  },

  // ── Most‑Active stub ────────────────────────────────────────────────
  async getMostActiveEquities(): Promise<ProviderResult<MostActiveEquity[]>> {
    return { data: [], fallbackUsed: true, source: 'MOAPI' };
  },

  // ── OI Spurts stub ──────────────────────────────────────────────────
  async getOISpurts(): Promise<ProviderResult<never>> {
    return { data: [] as never, fallbackUsed: true, source: 'MOAPI' };
  },

  // ── FII/DII stub ────────────────────────────────────────────────────
  async getFiiDii(): Promise<ProviderResult<never>> {
    return { data: [] as never, fallbackUsed: true, source: 'MOAPI' };
  },

  // ── Historical candles stub ───────────────────────────────────────────
  async getHistoricalCandles(
    _symbol: string,
    _timeframe: string,
    _count = 100,
  ): Promise<ProviderResult<HistoricalCandle[]>> {
    return { data: [] as never, fallbackUsed: true, source: 'MOAPI' };
  },
};

// Default export for registry.
export default moProvider;

/** Fake for tests. */
export function __moProviderFake(): ProviderModule<never> {
  return {
    getQuotes: async () => ({ data: [], fallbackUsed: true, source: 'MOAPI' }),
    getOptionChain: async () => ({ data: null, fallbackUsed: true, source: 'MOAPI' }),
    getGainersLosers: async () => ({ data: [] as never, fallbackUsed: true, source: 'MOAPI' }),
    getMostActiveEquities: async () => ({ data: [] as never, fallbackUsed: true, source: 'MOAPI' }),
    getOISpurts: async () => ({ data: [] as never, fallbackUsed: true, source: 'MOAPI' }),
    getFiiDii: async () => ({ data: [] as never, fallbackUsed: true, source: 'MOAPI' }),
    getHistoricalCandles: async () => ({ data: [] as never, fallbackUsed: true, source: 'MOAPI' }),
  };
}