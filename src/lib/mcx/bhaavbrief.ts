// MCX Commodity Module — BhaavBrief API Client
// Free API for MCX option chain data with OI, IV, Volume, Bid/Ask, Max Pain, PCR
// No auth required. Supports: GOLD, SILVER, CRUDEOIL, NATURALGAS, COPPER

const BHAAVBRIEF_BASE = 'https://bhaavbrief.in/api';
const CACHE_TTL = 60_000; // 60s cache

export interface BhaavBriefOptionLeg {
  symbol: string;
  ltp: number;
  absChng: number;
  oi: number;
  oiChange: number;
  volume: number;
  iv: number;
  bid: number;
  ask: number;
  tier: string;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

interface BhaavBriefStrike {
  strike: number;
  isATM: boolean;
  isITM_CE: boolean;
  isITM_PE: boolean;
  CE: BhaavBriefOptionLeg | null;
  PE: BhaavBriefOptionLeg | null;
}

export interface BhaavBriefChain {
  instrument: string;
  meta: Record<string, unknown>;
  expiry: string;
  expiries: string[];
  futurePrice: number;
  maxPain: number;
  pcr: number;
  ivix: number;
  aav: Record<string, number | null>;
  volPremium: number;
  marketOpen: boolean;
  riskFreeRate: number;
  chain: BhaavBriefStrike[];
  lastUpdated: string;
}

// Supported instruments on BhaavBrief
const SUPPORTED = new Set(['GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'COPPER']);

// Cache
const cache = new Map<string, { data: BhaavBriefChain; ts: number }>();

export async function fetchBhaavBriefChain(instrument: string): Promise<BhaavBriefChain | null> {
  const sym = instrument.toUpperCase();
  if (!SUPPORTED.has(sym)) return null;

  const cached = cache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(`${BHAAVBRIEF_BASE}/options?instrument=${sym}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (data.error || !data.chain) return null;

    cache.set(sym, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

export function isBhaavBriefSupported(symbol: string): boolean {
  return SUPPORTED.has(symbol.toUpperCase());
}
