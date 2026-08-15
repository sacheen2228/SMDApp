// Unified Indian Index Universe - Centralized definitions for all 5 primary indices
// Supports dynamic addition of new indices without algorithm changes

export type IndexSymbol =
  | 'NIFTY'
  | 'SENSEX'
  | 'BANKNIFTY'
  | 'FINNIFTY'
  | 'MIDCPNIFTY';

export const INDEX_UNIVERSE: readonly IndexSymbol[] = [
  'NIFTY',
  'SENSEX',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
] as const;

export interface IndexMeta {
  symbol: IndexSymbol;
  name: string;
  exchange: 'NSE' | 'BSE';
  segment: 'INDICES';
  lotSize: number;
  tickSize: number;
  strikeInterval: number;
  description: string;
  // Dynamic data (populated at runtime)
  currentExpiry?: string;
  nextExpiry?: string;
  availableExpiries?: string[];
  atmStrike?: number;
  itmStrikes?: number[];
  otmStrikes?: number[];
}

export const INDEX_META: Record<IndexSymbol, IndexMeta> = {
  NIFTY: {
    symbol: 'NIFTY',
    name: 'NIFTY 50',
    exchange: 'NSE',
    segment: 'INDICES',
    lotSize: 50,
    tickSize: 0.05,
    strikeInterval: 50,
    description: 'NSE NIFTY 50 Index',
  },
  SENSEX: {
    symbol: 'SENSEX',
    name: 'SENSEX',
    exchange: 'BSE',
    segment: 'INDICES',
    lotSize: 10,
    tickSize: 0.05,
    strikeInterval: 100,
    description: 'BSE SENSEX Index',
  },
  BANKNIFTY: {
    symbol: 'BANKNIFTY',
    name: 'NIFTY BANK',
    exchange: 'NSE',
    segment: 'INDICES',
    lotSize: 25,
    tickSize: 0.05,
    strikeInterval: 100,
    description: 'NSE NIFTY Bank Index',
  },
  FINNIFTY: {
    symbol: 'FINNIFTY',
    name: 'NIFTY FINANCIAL SERVICES',
    exchange: 'NSE',
    segment: 'INDICES',
    lotSize: 40,
    tickSize: 0.05,
    strikeInterval: 50,
    description: 'NSE NIFTY Financial Services Index',
  },
  MIDCPNIFTY: {
    symbol: 'MIDCPNIFTY',
    name: 'NIFTY MIDCAP SELECT',
    exchange: 'NSE',
    segment: 'INDICES',
    lotSize: 75,
    tickSize: 0.05,
    strikeInterval: 50,
    description: 'NSE NIFTY Midcap Select Index',
  },
};

// Futures contract metadata
export interface FuturesContractMeta {
  symbol: string; // e.g., 'NIFTY'
  exchange: 'NSE' | 'BSE';
  instrumentType: 'FUTIDX';
  currentExpiry: string;
  nextExpiry: string;
  availableExpiries: string[];
  lotSize: number;
  tickSize: number;
  currentContract: string; // e.g., 'NIFTY24AUG'
  nextContract: string;
}

// Options contract metadata
export interface OptionsContractMeta {
  symbol: string; // e.g., 'NIFTY'
  exchange: 'NSE' | 'BSE';
  instrumentType: 'OPTIDX';
  currentExpiry: string;
  nextExpiry: string;
  availableExpiries: string[];
  lotSize: number;
  tickSize: number;
  strikeInterval: number;
  atmStrike: number;
  strikes: number[];
  itmStrikes: { ce: number[]; pe: number[] };
  otmStrikes: { ce: number[]; pe: number[] };
}

export interface IndexDerivativesData {
  symbol: IndexSymbol;
  futures: FuturesContractMeta | null;
  options: OptionsContractMeta | null;
  spotPrice: number;
  lastUpdated: number;
}

// Dynamic universe loader - fetches from exchange instrument master
export async function loadIndexUniverse(): Promise<{
  indices: IndexMeta[];
  derivatives: Map<IndexSymbol, IndexDerivativesData>;
}> {
  const indices = INDEX_UNIVERSE.map(s => INDEX_META[s]);
  const derivatives = new Map<IndexSymbol, IndexDerivativesData>();

  // In production, fetch from Breeze/ICICI instrument master
  // For now, return static metadata with dynamic fields empty
  for (const symbol of INDEX_UNIVERSE) {
    derivatives.set(symbol, {
      symbol,
      futures: null, // populated from exchange
      options: null, // populated from exchange
      spotPrice: 0,
      lastUpdated: Date.now(),
    });
  }

  return { indices, derivatives };
}

export function getIndexMeta(symbol: IndexSymbol): IndexMeta {
  return INDEX_META[symbol];
}

export function isValidIndex(symbol: string): symbol is IndexSymbol {
  return INDEX_UNIVERSE.includes(symbol as IndexSymbol);
}

export function getAllIndexSymbols(): IndexSymbol[] {
  return [...INDEX_UNIVERSE];
}