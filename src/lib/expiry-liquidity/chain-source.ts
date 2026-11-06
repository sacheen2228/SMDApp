// Where GET /api/expiry-liquidity gets its option chain — one module, three
// real sources, honest labels:
//
//   1. primary   NSE (BSE for SENSEX/BANKEX) — the exchange primary
//   2. breeze    Breeze getOptionChain — live, session-authenticated
//   3. tree      market-data-manager canonical tree — NSE → MO → BHAVCOPY
//                (EOD bhavcopy last, source label preserved: "BHAVCOPY" etc.)
//
// Mirrors the main /api/option-chain route's order (exchange → Breeze →
// canonical tree). A source only wins with rows AND spot > 0; a throwing
// source falls through; when all three are dead → null, and the route turns
// that into 503 (never fabricated strikes).

import { getNSEOptionChain } from '@/lib/nse-api';
import { isBSEIndex } from '@/lib/bse-api';
import type { OptionChainData } from '@/types';

export interface ChainSource {
  rows: any[] | null;
  spot: number;
  source: string;
}

export interface ChainDeps {
  primary: (symbol: string) => Promise<ChainSource | null>;
  breeze: (symbol: string) => Promise<ChainSource | null>;
  tree: (symbol: string) => Promise<ChainSource | null>;
}

async function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error(`CHAIN_TIMEOUT_${ms}`)), ms),
    ),
  ]).catch(() => null);
}

/** Exchange primary: BSE for SENSEX/BANKEX, NSE for everything else. */
export async function primaryViaExchange(symbol: string): Promise<ChainSource | null> {
  if (isBSEIndex(symbol)) {
    const { getBSEExpiryDates, getBSEOptionChain } = await import('@/lib/bse-api');
    const expiries = await getBSEExpiryDates(symbol).catch(() => [] as string[]);
    if (!expiries[0]) return null;
    const chain = await withTimeout(getBSEOptionChain(symbol, expiries[0]), 5000);
    if (!chain?.data?.length) return null;
    return { rows: chain.data, spot: chain.spotPrice || 0, source: 'bse-api' };
  }
  const nseData = await withTimeout(getNSEOptionChain(symbol), 7000);
  if (!nseData?.records?.data?.length) return null;
  return {
    rows: nseData.records.data,
    spot: nseData.records.underlyingValue || 0,
    source: 'nse-api',
  };
}

/** Breeze live chain (auth-gated, route layer). Expiry "" = nearest listed. */
export async function viaBreeze(symbol: string): Promise<ChainSource | null> {
  try {
    const { getOptionChain } = await import('@/lib/icici-breeze/option-chain');
    const chain = await withTimeout(getOptionChain(symbol, ''), 7000);
    const grouped = chain ? breezeChainToRows(chain) : null;
    if (!grouped) return null;
    return { rows: grouped.rows, spot: grouped.spot, source: 'icici-breeze' };
  } catch {
    return null;
  }
}

/** Canonical tree — same call /api/option-chain uses (NSE → MO → BHAVCOPY). */
export async function viaTree(symbol: string): Promise<ChainSource | null> {
  try {
    const { fetchOptionChainWithFallback } = await import('@/lib/market-data-manager');
    const res = await withTimeout(fetchOptionChainWithFallback(symbol), 9000);
    const rows = res?.data?.strikes;
    if (!Array.isArray(rows) || !rows.length) return null;
    const spot = Number(res?.data?.spot ?? 0);
    if (!(spot > 0)) return null;
    return {
      rows,
      spot,
      source: String(res?.source || 'canonical'),
    };
  } catch {
    return null;
  }
}

/**
 * Breeze's flat calls/puts → the strike-row shape every chain consumer
 * reads: {strike, strikePrice, ce, pe, CE, PE} — leg values pass through
 * field-untouched (normalizeLeg reads ltp/bid/ask/volume/openInterest/
 * oiChange/iv/greeks), null for a side the chain doesn't have
 * (normalizeLeg(null) zeroes it).
 */
export function breezeChainToRows(
  chain: OptionChainData | null | undefined,
): { rows: any[]; spot: number } | null {
  if (!chain) return null;
  const byStrike = new Map<number, { ce: any | null; pe: any | null }>();
  const strikeSet = new Set<number>();
  for (const s of chain.strikes || []) {
    const k = Number(s);
    if (Number.isFinite(k) && k > 0) strikeSet.add(k);
  }
  for (const q of chain.calls || []) {
    const k = Number(q?.strikePrice);
    if (!Number.isFinite(k) || k <= 0) continue;
    strikeSet.add(k);
    const cell = byStrike.get(k) ?? { ce: null, pe: null };
    cell.ce = q;
    byStrike.set(k, cell);
  }
  for (const q of chain.puts || []) {
    const k = Number(q?.strikePrice);
    if (!Number.isFinite(k) || k <= 0) continue;
    strikeSet.add(k);
    const cell = byStrike.get(k) ?? { ce: null, pe: null };
    cell.pe = q;
    byStrike.set(k, cell);
  }
  if (!strikeSet.size) return null;
  const rows = [...strikeSet]
    .sort((a, b) => a - b)
    .map((strike) => {
      const cell = byStrike.get(strike) ?? { ce: null, pe: null };
      return {
        strike,
        strikePrice: strike,
        ce: cell.ce,
        pe: cell.pe,
        CE: cell.ce,
        PE: cell.pe,
      };
    });
  return { rows, spot: Number(chain.spotPrice) || 0 };
}

/**
 * First source that answers with rows + spot wins (short-circuit).
 * `deps` overrides let tests inject fakes; the route calls it with defaults.
 */
export async function gatherChainWithFallback(
  symbol: string,
  overrides?: Partial<ChainDeps>,
): Promise<ChainSource | null> {
  const deps: ChainDeps = {
    primary: primaryViaExchange,
    breeze: viaBreeze,
    tree: viaTree,
    ...overrides,
  };
  for (const key of ['primary', 'breeze', 'tree'] as const) {
    try {
      const src = await deps[key](symbol);
      if (src?.rows?.length && src.spot > 0) return src;
    } catch {
      // a throwing source falls through to the next one
    }
  }
  return null;
}
