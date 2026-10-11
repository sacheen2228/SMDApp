// Option‑chain canonical module — SMDApp central data layer
// Single entry point for all option-chain data. Consolidates all duplicate
// option‑chain fetchers into ONE canonical schema. All missing fields remain
// null/NO_DATA — never fabricated.
//
// Provider priority (exchange-aware):
//   NSE indices (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY) → NSE primary
//   BSE indices (SENSEX/BANKEX)                        → BSE primary
//   Fallback: MOAPI (when enabled) → NO_DATA
//   Yahoo must NEVER enter this path.
//
// The Engine (Option Engine / ₹5 gate / ₹15K gate) reads this schema;
// nothing in this module creates a trade or selects a strike.

import { classifyFreshness, collectedFreshness } from '@/lib/api-freshness';
import type { OptionChainData, OptionStrike, OptionLeg, ProviderResult } from '@/lib/data-layer/types';

// ── Exchange routing ────────────────────────────────────────────────

const NSE_INDICES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);
const BSE_INDICES = new Set(['SENSEX', 'BANKEX']);

export function getExchangeForSymbol(symbol: string): 'NSE' | 'BSE' | 'UNKNOWN' {
  const s = symbol.toUpperCase();
  if (NSE_INDICES.has(s)) return 'NSE';
  if (BSE_INDICES.has(s)) return 'BSE';
  return 'UNKNOWN';
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseNum(v: any): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// BSE ships IV at full float precision (14.215268143110801) while NSE reports
// clean 2dp (14.22). Round for display parity — never for OI, volume or price.
function roundIv(iv: number | null): number | null {
  if (iv == null) return null;
  return Math.round(iv * 100) / 100;
}

// ── Normalise NSE format (.records.data) ────────────────────────────

function normalizeNseChain(raw: any, symbol?: string): ProviderResult<OptionChainData> {
  try {
    const strikes: OptionStrike[] = [];
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
      underlying: raw?.records?.underlying ?? symbol ?? 'UNKNOWN',
      spot: raw?.records?.underlyingValue ?? null,
      expiry: raw?.records?.expiryDates?.[0] ?? null,
      strikes,
      timestamp: collectedAt,
      source: 'NSE',
      fallbackUsed: false,
      freshness: collectedFreshness(raw, 'optionChain'),
    };
    return { data, fallbackUsed: false, source: 'NSE' };
  } catch {
    return { data: null, fallbackUsed: true, source: 'NSE', fallbackReason: 'parse-error' };
  }
}

// ── Normalise BSE format (.Table) ───────────────────────────────────

function normalizeBseChain(raw: any, symbol?: string): ProviderResult<OptionChainData> {
  try {
    const strikes: OptionStrike[] = [];
    const rawArr = raw?.Table ?? [];
    for (const row of rawArr) {
      const strike = parseFloat(row?.Strike_Price1);
      if (isNaN(strike)) continue;

      // One row per strike holds BOTH sides: PE fields are unprefixed,
      // CE fields carry a `C_` prefix (see legacy `bse-api.ts` mapping).
      const ce: OptionLeg = {
        ltp: parseNum(row?.C_Last_Trd_Price),
        volume: parseNum(row?.C_Vol_Traded),
        oi: parseNum(row?.C_Open_Interest),
        oiChange: parseNum(row?.C_Absolute_Change_OI),
        iv: roundIv(parseNum(row?.C_IV)),
        bid: parseNum(row?.C_BidPrice),
        ask: parseNum(row?.C_OfferPrice),
        delta: null,
        gamma: null,
        theta: null,
        rho: null,
      };

      const pe: OptionLeg = {
        ltp: parseNum(row?.Last_Trd_Price),
        volume: parseNum(row?.Vol_Traded),
        oi: parseNum(row?.Open_Interest),
        oiChange: parseNum(row?.Absolute_Change_OI),
        iv: roundIv(parseNum(row?.IV)),
        bid: parseNum(row?.BidPrice),
        ask: parseNum(row?.OfferPrice),
        delta: null,
        gamma: null,
        theta: null,
        rho: null,
      };

      strikes.push({ strike, ce, pe });
    }

    const collectedAt = new Date().toISOString();
    const data: OptionChainData = {
      underlying: raw?.UndlVal ?? raw?.UlaValue ?? symbol ?? 'UNKNOWN',
      spot: raw?.UndlVal ?? raw?.UlaValue ?? null,
      expiry: null,
      strikes,
      timestamp: collectedAt,
      source: 'BSE',
      fallbackUsed: false,
      freshness: collectedFreshness(raw, 'optionChain'),
    };
    return { data, fallbackUsed: false, source: 'BSE' };
  } catch {
    return { data: null, fallbackUsed: true, source: 'BSE', fallbackReason: 'parse-error' };
  }
}

// ── Public: normalizeOptionChain ────────────────────────────────────
// Detects source from the data structure itself — not from a variable flag.
// Signature matches the option-chain route call: (raw, expiry?, symbol?)

export function normalizeOptionChain(
  raw?: any,
  _expiry?: string,
  symbol?: string,
): ProviderResult<OptionChainData> {
  if (raw?.records?.data) return normalizeNseChain(raw, symbol);
  if (raw?.Table) return normalizeBseChain(raw, symbol);
  return { data: null, fallbackUsed: true, source: 'NO_DATA' };
}

// ── Public: getOptionChain (canonical entry point) ──────────────────
// Exchange-aware routing: NSE indices → NSE provider, BSE indices → BSE
// provider, everything else → try NSE first (equities), then BSE.
// Falls through to MOAPI (stub) then NO_DATA.
// Does NOT fetch Breeze — that stays in the route layer (auth-gated).

export async function getOptionChain(
  symbol: string,
  expiry?: string,
): Promise<ProviderResult<OptionChainData>> {
  const exchange = getExchangeForSymbol(symbol);

  // BSE indices: BSE is primary
  if (exchange === 'BSE') {
    const { bseProvider } = await import('@/lib/data-layer/providers/bse');
    const result = await bseProvider.getOptionChain(symbol, expiry);
    if (result.data) return result;
    // BSE failed — no further fallback for BSE-only indices
    return result;
  }

  // NSE indices and equities: NSE is primary
  const { nseProvider } = await import('@/lib/data-layer/providers/nse');
  const nseResult = await nseProvider.getOptionChain(symbol, expiry);
  if (nseResult.data) return nseResult;

  // NSE failed — try MOAPI (currently a stub, returns null)
  const { moProvider } = await import('@/lib/data-layer/providers/mo');
  const moResult = await moProvider.getOptionChain(symbol, expiry);
  if (moResult.data) return moResult;

  // All providers failed
  return {
    data: null,
    fallbackUsed: true,
    source: 'NO_DATA',
    fallbackReason: `NSE + MOAPI unavailable for ${symbol}`,
  };
}

// ── Default export for the data‑layer registry ──────────────────────

export default {
  normalizeOptionChain,
  getOptionChain,
  getExchangeForSymbol,
};

/** Fake for tests — manually configure with raw provider objects. */
export function __normalizeOptionChainFake() {
  return {
    normalizeOptionChain: (
      _raw?: any,
      _expiry?: string,
      _symbol?: string,
    ): ProviderResult<OptionChainData> => {
      return { data: null, fallbackUsed: true, source: 'NO_DATA' };
    },
  };
}
