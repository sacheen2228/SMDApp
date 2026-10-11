// Data Layer Types — SMDApp central data layer
// Single source of truth for all data-layer interfaces.
// Breaks the circular import chain: providers ← index → providers.
//
// These types are CONSUMED by the option-chain route, hermes context,
// agent pipeline, and all provider modules. They are NOT the same as
// src/types/canonical.ts (which is the engine-level canonical schema).

import type { FreshnessLevel } from '@/lib/api-freshness';

export type { FreshnessLevel };

// ── Provenance ──────────────────────────────────────────────────────

export interface DataProvenance {
  source: string;
  publishedAt?: string;   // ORIGINAL provider timestamp (never rewritten)
  collectedAt?: string;   // when the collector fetched it
  retrievedAt?: string;   // when this module read it
  fallbackUsed: boolean;
  fallbackReason?: string;
}

// ── Option Chain ────────────────────────────────────────────────────

export interface OptionStrike {
  strike: number;
  ce: OptionLeg | null;
  pe: OptionLeg | null;
}

export interface OptionLeg {
  ltp: number | null;
  volume: number | null;
  oi: number | null;
  oiChange: number | null;
  iv: number | null;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  rho: number | null;
}

export interface OptionChainData {
  underlying: string;
  spot: number | null;
  expiry: string | null;
  strikes: OptionStrike[];
  timestamp: string;          // collection time (NOT provider time)
  source: string;             // 'NSE' | 'BSE' | 'MOAPI' | 'NO_DATA'
  fallbackUsed: boolean;
  freshness: FreshnessLevel;
}

// ── Quotes ──────────────────────────────────────────────────────────

export interface QuoteData {
  symbol: string;
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  timestamp: string;
  source: string;
  fallbackUsed: boolean;
}

// ── Gainers / Losers ────────────────────────────────────────────────

export interface GainersLosers {
  rank: number;
  symbol: string;
  name?: string;
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  timestamp: string;
  source: string;
  fallbackUsed: boolean;
}

// ── Most Active ─────────────────────────────────────────────────────

export interface MostActiveEquity {
  symbol: string;
  name?: string;
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  timestamp: string;
  source: string;
  fallbackUsed: boolean;
}

export interface MostActiveContract {
  symbol: string;
  expiry?: string;
  ltp: number | null;
  volume: number | null;
  oi: number | null;
  timestamp: string;
  source: string;
  fallbackUsed: boolean;
}

// ── OI Spurts ───────────────────────────────────────────────────────

export interface OISpurt {
  symbol: string;
  expiry?: string;
  strike?: number;
  optionType?: 'CE' | 'PE';
  oiChange: number;
  oiChangePct?: number;
  ltp?: number;
  timestamp: string;
  source: string;
  fallbackUsed: boolean;
}

// ── FII/DII ─────────────────────────────────────────────────────────

export interface FiiDiiRow {
  date: string;
  fiiNet?: number;
  diiNet?: number;
  fiiBuy?: number;
  fiiSell?: number;
  diiBuy?: number;
  diiSell?: number;
  source: string;
  fallbackUsed: boolean;
}

// ── News ────────────────────────────────────────────────────────────

export interface EnrichedNewsItem {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  collectedAt: string;
  source: string;
  url: string;
  sentimentScore: number;
  sentimentLabel: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  eventType: string;
  stockEntities: string[];
  sectorEntities: string[];
  provenance: DataProvenance;
  fallbackUsed: boolean;
}

// ── Historical Candles ──────────────────────────────────────────────

export interface HistoricalCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Provider Result ─────────────────────────────────────────────────

export interface ProviderResult<T> {
  data: T | null;
  fallbackUsed: boolean;
  source: string;
  fallbackReason?: string;
}

// ── Provider Module Contract ────────────────────────────────────────

export interface ProviderModule<T = never> {
  getQuotes(symbols: string[]): Promise<ProviderResult<QuoteData[]>>;
  getOptionChain(symbol: string, expiry?: string): Promise<ProviderResult<OptionChainData>>;
  getGainersLosers(): Promise<ProviderResult<GainersLosers[]>>;
  getMostActiveEquities(): Promise<ProviderResult<MostActiveEquity[]>>;
  getOISpurts(): Promise<ProviderResult<OISpurt[] | never>>;
  getFiiDii(): Promise<ProviderResult<FiiDiiRow[] | never>>;
  getHistoricalCandles(
    symbol: string,
    timeframe: string,
    count?: number,
  ): Promise<ProviderResult<HistoricalCandle[] | never>>;
}

// ── Agent Context Fragment ──────────────────────────────────────────

export interface AgentContextFragment {
  quotes: Record<string, QuoteData>;
  optionChain: OptionChainData | null;
  gainersLosers: GainersLosers[];
  mostActiveEquities: MostActiveEquity[];
  mostActiveContracts: MostActiveContract[];
  oiSpurts: OISpurt[];
  fiiDii: FiiDiiRow[];
  newsSentiment: {
    label: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    score: number;
    timestamp: string;
  };
  marketFreshness: FreshnessLevel | 'NO_DATA';
  lastUpdated: string;
}
