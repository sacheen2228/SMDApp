// Shared option chain data fetcher.
// Used by atm-straddle, ide, daily-ide, today-trades, greek-flow,
// institutional-greeks — eliminates HTTP self-fetch which breaks on Render.
//
// @deprecated — thin adapter over the canonical data-layer entry point.
//   Canonical: `getOptionChain()` from '@/lib/data-layer/chains/option-chain'
//   (exchange-aware: NSE primary for NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY,
//   BSE primary for SENSEX/BANKEX, MOAPI fallback, NO_DATA otherwise).
//   Yahoo never enters this path; Breeze is never an implicit fallback.
//   New consumers should import the canonical module directly — this file
//   only exists to keep the 10 legacy routes' response shape stable.

import { getOptionChain as canonicalGetOptionChain } from '@/lib/data-layer/chains/option-chain';
import { calculateGreeks, parseExpiryDateLoose } from '@/lib/greeks';
import { getAllExpiries, getNearestExpiry } from '@/lib/expiry-calculator';
import { buildFreshnessMeta } from '@/lib/api-freshness';
import type { OptionChainData, OptionLeg } from '@/lib/data-layer/types';

export interface OptionChainResult {
  success: boolean;
  source: string;
  ageMs?: number; // age of the chain data (0 = just fetched)
  freshness?: string;
  fallbackUsed?: boolean;
  data?: {
    data: any[];
    spotPrice: number;
    summary: {
      spotPrice: number;
      indiaVIX: number | null;
      maxPain: number;
      // Consumers type this as `number`; adapter keeps the legacy contract.
      // When either side has no OI the legacy code passed null anyway.
      pcr: number;
      totalCallOI: number;
      totalPutOI: number;
      callOiChange: number;
      putOiChange: number;
      atmStrike: number;
      [key: string]: any;
    };
    expiries: any[];
    selectedExpiry: string;
    candles?: any[];
    [key: string]: any;
  };
  error?: string;
}

/**
 * Volatility to feed the pricing/scoring engines.
 *
 * `summary.indiaVIX` is null whenever NSE's allIndices call fails (blocked IP,
 * holiday, cookie churn) and several callers used `indiaVIX || 0` — which turns
 * "we don't know" into a real-looking 0% VIX. A 0 VIX then collapses every
 * VIX-derived number to zero: `expectedMove` becomes ±0.0, "IV low — options
 * cheap" fires, and the mood gauge reads calm. Never emit 0.
 *
 * Order of preference: the exchange's INDIA VIX → the chain's own ATM IV
 * (real provider data, not an estimate) → 15 as a stated assumption.
 */
export function resolveVix(
  summary: { indiaVIX?: number | null } | null | undefined,
  strikes?: any[],
  spot?: number | null,
): { vix: number | null; source: 'india-vix' | 'atm-iv' | 'none' } {
  const published = summary?.indiaVIX;
  if (typeof published === 'number' && Number.isFinite(published) && published > 0) {
    return { vix: published, source: 'india-vix' };
  }

  const rows = (Array.isArray(strikes) ? strikes : []).filter(
    (r) => r && Number.isFinite(Number(r.strike)),
  );
  if (rows.length) {
    const ref = Number.isFinite(Number(spot)) ? Number(spot) : Number(rows[0].strike);
    const nearest = rows
      .slice()
      .sort((a, b) => Math.abs(Number(a.strike) - ref) - Math.abs(Number(b.strike) - ref))[0];
    const ivs = [Number(nearest?.ce?.iv), Number(nearest?.pe?.iv)].filter(
      (v) => Number.isFinite(v) && v > 0 && v < 200,
    );
    if (ivs.length) {
      const avg = ivs.reduce((a, b) => a + b, 0) / ivs.length;
      return { vix: Math.round(avg * 100) / 100, source: 'atm-iv' };
    }
  }

  return { vix: null, source: 'none' };
}

// Canonical OptionLeg uses `oiChange`/`rho`; legacy consumers read `oiChg`/`vega`.
// `vega` is not in the canonical schema — derive it from Black-Scholes so the
// downstream Greeks consumers keep working without the canonical type growing.
function toLegacyLeg(
  leg: OptionLeg | null,
  spot: number,
  strike: number,
  tte: number,
  isCall: boolean,
): any {
  if (!leg) return null;

  const ivRaw = leg.iv ?? 0;
  const ivDecimal = ivRaw > 0 ? ivRaw / 100 : 0;

  // NSE V3 and BSE DerivOptionChain_IV ship no greeks — compute them the
  // way the pre-refactor code did, but never overwrite a provider-supplied
  // value (missing stays missing only if we genuinely cannot derive it).
  let delta = leg.delta, gamma = leg.gamma, theta = leg.theta, vega = 0;
  if (ivDecimal > 0 && tte > 0) {
    const g = calculateGreeks(spot, strike, tte, ivDecimal, isCall);
    if (delta == null) delta = g.delta;
    if (gamma == null) gamma = g.gamma;
    if (theta == null) theta = g.theta;
    vega = g.vega;
  }

  return {
    ltp: leg.ltp,
    priceChg: null, // canonical schema has no per-leg price delta
    bid: leg.bid,
    ask: leg.ask,
    oi: leg.oi,
    oiChg: leg.oiChange,
    volume: leg.volume,
    iv: leg.iv,
    delta,
    gamma,
    theta,
    vega,
    // cas-straddle scores on spread; derive from bid/ask when both exist.
    spread:
      typeof leg.bid === 'number' && typeof leg.ask === 'number' && leg.ask > leg.bid
        ? Math.round((leg.ask - leg.bid) * 100) / 100
        : 0,
  };
}

function buildExpiries(symbol: string, selected: string) {
  // Expiry list comes from the canonical SEBI staggered-expiry calculator —
  // never from a provider guess. Format "DD-MMM-YYYY" matches parseExpiryDays.
  try {
    return getAllExpiries(symbol).map((e) => ({
      date: e.date,
      label: e.label,
      daysToExpiry: e.daysToExpiry,
    }));
  } catch {
    return selected ? [{ date: selected, label: selected, daysToExpiry: 0 }] : [];
  }
}

export async function fetchLiveOptionChain(
  symbol: string,
  expiry?: string,
  signal?: AbortSignal,
): Promise<OptionChainResult> {
  if (signal?.aborted) return { success: false, source: 'none', error: 'aborted' };

  const started = Date.now();
  const result = await canonicalGetOptionChain(symbol, expiry);
  const chain: OptionChainData | null = result.data;

  if (!chain || !chain.strikes?.length) {
    return {
      success: false,
      source: result.source || 'NO_DATA',
      fallbackUsed: true,
      error: result.fallbackReason || 'No option chain data available',
    };
  }

  const spotPrice = chain.spot ?? 0;
  if (!spotPrice) {
    return { success: false, source: chain.source, error: 'No spot price available' };
  }

  const selectedExpiry =
    expiry ||
    chain.expiry ||
    getNearestExpiry(symbol)?.date ||
    '';

  // time-to-expiry in years for Black-Scholes — Breeze/DD-MMM-YYYY/ISO safe
  const expiryDate = selectedExpiry ? (parseExpiryDateLoose(selectedExpiry) ?? new Date(selectedExpiry)) : null;
  const daysToExpiry = expiryDate && !isNaN(expiryDate.getTime())
    ? Math.max(1, Math.ceil((expiryDate.getTime() - Date.now()) / 86_400_000))
    : 7;
  const tte = daysToExpiry / 365;

  const rawStrikes = chain.strikes.map((s) => ({
    strike: s.strike,
    ce: toLegacyLeg(s.ce, spotPrice, s.strike, tte, true),
    pe: toLegacyLeg(s.pe, spotPrice, s.strike, tte, false),
  }));

  // Summary — computed from real strikes (never fabricated when absent).
  let totalCallOI = 0, totalPutOI = 0, callOiChg = 0, putOiChg = 0;
  let maxPain = spotPrice, maxTotalOI = 0, atmStrike = 0, bestAtmDist = Infinity;
  for (const s of rawStrikes) {
    totalCallOI += s.ce?.oi || 0;
    totalPutOI += s.pe?.oi || 0;
    callOiChg += s.ce?.oiChg || 0;
    putOiChg += s.pe?.oiChg || 0;
    const total = (s.ce?.oi || 0) + (s.pe?.oi || 0);
    if (total > maxTotalOI) { maxTotalOI = total; maxPain = s.strike; }
    const dist = Math.abs(s.strike - spotPrice);
    if (dist < bestAtmDist) { bestAtmDist = dist; atmStrike = s.strike; }
  }
  const pcr =
    totalCallOI > 0 && totalPutOI > 0
      ? Math.round((totalPutOI / totalCallOI) * 100) / 100
      : null;

  // VIX — optional enrichment; null when unavailable (never a fabricated 15).
  // Free NSE source (the data policy bans Yahoo quotes).
  let liveVix: number | null = null;
  try {
    const { getNSEIndiaVIX } = await import('@/lib/nse-api');
    liveVix = (await getNSEIndiaVIX())?.value ?? null;
  } catch {}

  // ageMs must reflect the PROVIDER's published timestamp, not when we
  // collected it — otherwise a cache hit or a delayed feed reads as LIVE.
  const ageMs = chain.timestamp ? Math.max(0, Date.now() - new Date(chain.timestamp).getTime()) : 0;
  // chain.freshness is classifyFreshness() over the provider's own timestamp.
  const freshness = chain.freshness ?? buildFreshnessMeta({
    provider: chain.source,
    source: chain.source,
    dataTimestamp: chain.timestamp,
    dataType: 'optionChain',
    fallbackUsed: chain.fallbackUsed,
  }).freshness;

  return {
    success: true,
    source: chain.source,
    ageMs,
    freshness,
    fallbackUsed: chain.fallbackUsed,
    data: {
      data: rawStrikes,
      spotPrice,
      summary: {
        spotPrice,
        indiaVIX: liveVix,
        maxPain,
        // Legacy contract types pcr as `number`; null is passed through when
        // either side has no OI (identical to the pre-refactor behaviour).
        pcr: pcr as number,
        totalCallOI,
        totalPutOI,
        callOiChange: callOiChg,
        putOiChange: putOiChg,
        atmStrike,
      },
      expiries: buildExpiries(symbol, selectedExpiry),
      selectedExpiry,
      candles: [],
      collectedAt: chain.timestamp,
      providerFreshness: chain.freshness,
    },
  };
}
