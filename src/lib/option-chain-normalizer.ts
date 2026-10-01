// Option Chain Normalizer — converts raw provider data to canonical OptionContract[]
//
// Every provider (MOAPI, Breeze, NSE, BSE) feeds through this normalizer.
// No downstream consumer should parse raw provider data directly.

import type { OptionContract, OptionStrike, OptionChain, DataProvenance } from '@/types/canonical';
import type { DataFreshness, DataStatus } from '@/lib/data-health';
import { getLotSize } from '@/lib/symbol-config';
import { getNearestExpiry, isExpiryDay as checkExpiryDay } from '@/lib/expiry-calculator';
import { calculateGreeks } from '@/lib/greeks';

// ─── Normalized Strike Input ───────────────────────────────────────

export interface NormalizedStrike {
  strike: number;
  ce: NormalizedLeg | null;
  pe: NormalizedLeg | null;
}

export interface NormalizedLeg {
  ltp: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  quoteQuality: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
  oi: number;
  oiChange: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  hasData: boolean;
}

// ─── Provider Data Types ───────────────────────────────────────────

export interface MOAPIStrike {
  strike: number;
  ltp?: number;
  ce_ltp?: number;
  pe_ltp?: number;
  ce_oi?: number;
  pe_oi?: number;
  ce_volume?: number;
  pe_volume?: number;
  ce_iv?: number;
  pe_iv?: number;
  oi?: number;
  volume?: number;
  iv?: number;
}

export interface BreezeStrike {
  strike: number;
  ce?: { ltp?: number; oi?: number; volume?: number; iv?: number; bid?: number; ask?: number; oiChange?: number };
  pe?: { ltp?: number; oi?: number; volume?: number; iv?: number; bid?: number; ask?: number; oiChange?: number };
}

export interface NSEStrike {
  strikePrice: number;
  CE?: {
    lastPrice?: number;
    openInterest?: number;
    changeinOpenInterest?: number;
    totalTradedVolume?: number;
    impliedVolatility?: number;
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    bid?: number;
    bidQty?: number;
    ask?: number;
    askQty?: number;
  };
  PE?: {
    lastPrice?: number;
    openInterest?: number;
    changeinOpenInterest?: number;
    totalTradedVolume?: number;
    impliedVolatility?: number;
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    bid?: number;
    bidQty?: number;
    ask?: number;
    askQty?: number;
  };
}

// ─── Normalization Functions ───────────────────────────────────────

function sanitizeNum(val: unknown, fallback: number = 0): number {
  if (val === null || val === undefined) return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

function buildLeg(
  data: { ltp?: number; bid?: number; ask?: number; oi?: number; oiChange?: number; volume?: number; iv?: number; delta?: number; gamma?: number; theta?: number; vega?: number } | undefined,
  spot: number,
  strike: number,
  isCall: boolean,
  daysToExpiry: number,
  source: string
): NormalizedLeg {
  if (!data) return { ltp: 0, bid: null, ask: null, spread: null, quoteQuality: 'UNKNOWN', oi: 0, oiChange: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0, hasData: false };

  const ltp = sanitizeNum(data.ltp);
  const rawBid = sanitizeNum(data.bid);
  const rawAsk = sanitizeNum(data.ask);
  const oi = sanitizeNum(data.oi);
  const oiChange = sanitizeNum(data.oiChange);
  const volume = sanitizeNum(data.volume);
  let iv = sanitizeNum(data.iv);

  let delta = sanitizeNum(data.delta);
  let gamma = sanitizeNum(data.gamma);
  let theta = sanitizeNum(data.theta);
  let vega = sanitizeNum(data.vega);

  const hasData = ltp > 0 || oi > 0 || volume > 0;

  // Bid/Ask: NEVER fabricate from LTP. Use null when provider doesn't supply.
  const hasRawBid = data.bid !== undefined && data.bid !== null && rawBid > 0;
  const hasRawAsk = data.ask !== undefined && data.ask !== null && rawAsk > 0;
  const bid = hasRawBid ? rawBid : null;
  const ask = hasRawAsk ? rawAsk : null;
  const spread = (bid !== null && ask !== null) ? ask - bid : null;
  let quoteQuality: NormalizedLeg['quoteQuality'] = 'UNKNOWN';
  if (bid !== null && ask !== null) quoteQuality = 'COMPLETE';
  else if (bid !== null || ask !== null) quoteQuality = 'PARTIAL';

  // Calculate Greeks from IV if missing and IV is available
  if (hasData && (delta === 0 && gamma === 0 && theta === 0) && iv > 0 && daysToExpiry > 0) {
    const timeToExpiry = daysToExpiry / 365;
    const calculated = calculateGreeks(spot, strike, timeToExpiry, iv / 100, isCall);
    delta = calculated.delta;
    gamma = calculated.gamma;
    theta = calculated.theta;
    vega = calculated.vega;
  }

  // Estimate IV from moneyness if still zero (conservative estimate)
  if (hasData && iv === 0 && ltp > 0) {
    const moneyness = Math.abs(strike - spot) / spot;
    iv = Math.min(60, Math.max(10, 15 + moneyness * 200));
  }

  return {
    ltp,
    bid,
    ask,
    spread,
    quoteQuality,
    oi,
    oiChange,
    volume,
    iv,
    delta,
    gamma,
    theta,
    vega,
    hasData,
  };
}

// ─── MOAPI Normalizer ──────────────────────────────────────────────

export function normalizeMOAPI(
  rawStrikes: MOAPIStrike[],
  spot: number,
  symbol: string,
  source: string
): NormalizedStrike[] {
  const expiry = getNearestExpiry(symbol);
  const daysToExpiry = expiry?.daysToExpiry ?? 7;

  return rawStrikes.map(s => ({
    strike: sanitizeNum(s.strike),
    ce: buildLeg(
      s.ce_ltp !== undefined ? { ltp: s.ce_ltp, oi: s.ce_oi, volume: s.ce_volume, iv: s.ce_iv } : undefined,
      spot, s.strike, true, daysToExpiry, source
    ),
    pe: buildLeg(
      s.pe_ltp !== undefined ? { ltp: s.pe_ltp, oi: s.pe_oi, volume: s.pe_volume, iv: s.pe_iv } : undefined,
      spot, s.strike, false, daysToExpiry, source
    ),
  }));
}

// ─── Breeze Normalizer ─────────────────────────────────────────────

export function normalizeBreeze(
  rawStrikes: BreezeStrike[],
  spot: number,
  symbol: string,
  source: string
): NormalizedStrike[] {
  const expiry = getNearestExpiry(symbol);
  const daysToExpiry = expiry?.daysToExpiry ?? 7;

  return rawStrikes.map(s => ({
    strike: sanitizeNum(s.strike),
    ce: buildLeg(
      s.ce ? { ltp: s.ce.ltp, bid: s.ce.bid, ask: s.ce.ask, oi: s.ce.oi, oiChange: s.ce.oiChange, volume: s.ce.volume, iv: s.ce.iv } : undefined,
      spot, s.strike, true, daysToExpiry, source
    ),
    pe: buildLeg(
      s.pe ? { ltp: s.pe.ltp, bid: s.pe.bid, ask: s.pe.ask, oi: s.pe.oi, oiChange: s.pe.oiChange, volume: s.pe.volume, iv: s.pe.iv } : undefined,
      spot, s.strike, false, daysToExpiry, source
    ),
  }));
}

// ─── NSE Normalizer ────────────────────────────────────────────────

export function normalizeNSE(
  rawStrikes: NSEStrike[],
  spot: number,
  symbol: string,
  source: string
): NormalizedStrike[] {
  const expiry = getNearestExpiry(symbol);
  const daysToExpiry = expiry?.daysToExpiry ?? 7;

  return rawStrikes.map(s => ({
    strike: sanitizeNum(s.strikePrice),
    ce: s.CE ? buildLeg({
      ltp: s.CE.lastPrice,
      bid: s.CE.bid,
      ask: s.CE.ask,
      oi: s.CE.openInterest,
      oiChange: s.CE.changeinOpenInterest,
      volume: s.CE.totalTradedVolume,
      iv: s.CE.impliedVolatility,
      delta: s.CE.delta,
      gamma: s.CE.gamma,
      theta: s.CE.theta,
      vega: s.CE.vega,
    }, spot, s.strikePrice, true, daysToExpiry, source) : null,
    pe: s.PE ? buildLeg({
      ltp: s.PE.lastPrice,
      bid: s.PE.bid,
      ask: s.PE.ask,
      oi: s.PE.openInterest,
      oiChange: s.PE.changeinOpenInterest,
      volume: s.PE.totalTradedVolume,
      iv: s.PE.impliedVolatility,
      delta: s.PE.delta,
      gamma: s.PE.gamma,
      theta: s.PE.theta,
      vega: s.PE.vega,
    }, spot, s.strikePrice, false, daysToExpiry, source) : null,
  }));
}

// ─── Build Canonical OptionChain from Normalized Strikes ───────────

export function buildOptionChain(
  normalizedStrikes: NormalizedStrike[],
  spot: number,
  symbol: string,
  source: string,
  overrideExpiry?: string
): OptionChain | null {
  if (normalizedStrikes.length === 0) return null;

  const expiryInfo = getNearestExpiry(symbol);
  const expiry = overrideExpiry || expiryInfo?.date || '';
  const daysToExpiry = expiryInfo?.daysToExpiry ?? 7;
  const expiryDay = checkExpiryDay(symbol);

  // Find ATM strike
  let atmStrike = normalizedStrikes[0].strike;
  let minDiff = Math.abs(atmStrike - spot);
  for (const s of normalizedStrikes) {
    const diff = Math.abs(s.strike - spot);
    if (diff < minDiff) {
      minDiff = diff;
      atmStrike = s.strike;
    }
  }

  // Calculate OI totals
  let totalCallOI = 0;
  let totalPutOI = 0;
  let totalCallVolume = 0;
  let totalPutVolume = 0;
  let callOiChange = 0;
  let putOiChange = 0;

  for (const s of normalizedStrikes) {
    if (s.ce) {
      totalCallOI += s.ce.oi;
      totalCallVolume += s.ce.volume;
      callOiChange += s.ce.oiChange;
    }
    if (s.pe) {
      totalPutOI += s.pe.oi;
      totalPutVolume += s.pe.volume;
      putOiChange += s.pe.oiChange;
    }
  }

  // PCR
  const pcr = totalCallOI > 0 && totalPutOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : null;

  // Max Pain (simplified: strike minimizing total option writing pain)
  let maxPain = atmStrike;
  let minPain = Infinity;
  for (const s of normalizedStrikes) {
    let pain = 0;
    for (const test of normalizedStrikes) {
      if (test.ce && test.strike < s.strike) pain += (s.strike - test.strike) * test.ce.oi;
      if (test.pe && test.strike > s.strike) pain += (test.strike - s.strike) * test.pe.oi;
    }
    if (pain < minPain) {
      minPain = pain;
      maxPain = s.strike;
    }
  }

  const maxPainDistance = Math.abs(maxPain - spot);

  // Only include strikes with data
  const validStrikes = normalizedStrikes.filter(s => s.ce?.hasData || s.pe?.hasData);

  return {
    underlying: symbol,
    exchange: symbol === 'SENSEX' ? 'BFO' : 'NSE',
    spot,
    expiry,
    daysToExpiry,
    isExpiryDay: expiryDay,
    strikes: validStrikes.map(s => ({
      strike: s.strike,
      ce: s.ce?.hasData ? {
        underlying: symbol,
        exchange: symbol === 'SENSEX' ? 'BFO' : 'NSE',
        optionType: 'CE',
        strike: s.strike,
        expiry,
        premium: s.ce.ltp,
        bid: s.ce.bid,
        ask: s.ce.ask,
        spread: s.ce.spread,
        quoteQuality: s.ce.quoteQuality,
        volume: s.ce.volume,
        oi: s.ce.oi,
        oiChange: s.ce.oiChange,
        iv: s.ce.iv,
        delta: s.ce.delta,
        gamma: s.ce.gamma,
        theta: s.ce.theta,
        vega: s.ce.vega,
        timestamp: new Date().toISOString(),
        dataSource: source,
        freshness: 'REALTIME' as DataFreshness,
        dataStatus: 'LIVE' as DataStatus,
      } : null,
      pe: s.pe?.hasData ? {
        underlying: symbol,
        exchange: symbol === 'SENSEX' ? 'BFO' : 'NSE',
        optionType: 'PE',
        strike: s.strike,
        expiry,
        premium: s.pe.ltp,
        bid: s.pe.bid,
        ask: s.pe.ask,
        spread: s.pe.spread,
        quoteQuality: s.pe.quoteQuality,
        volume: s.pe.volume,
        oi: s.pe.oi,
        oiChange: s.pe.oiChange,
        iv: s.pe.iv,
        delta: s.pe.delta,
        gamma: s.pe.gamma,
        theta: s.pe.theta,
        vega: s.pe.vega,
        timestamp: new Date().toISOString(),
        dataSource: source,
        freshness: 'REALTIME' as DataFreshness,
        dataStatus: 'LIVE' as DataStatus,
      } : null,
    } as OptionStrike)),
    atmStrike,
    pcr,
    pcrChange: 0,
    maxPain,
    maxPainDistance,
    totalCallOI,
    totalPutOI,
    totalCallVolume,
    totalPutVolume,
    callOiChange,
    putOiChange,
    timestamp: new Date().toISOString(),
    dataSource: source,
    freshness: 'REALTIME' as DataFreshness,
  };
}

// ─── Shared chain statistics (real IV + premium — never fabricated) ──

export interface ChainLegLike {
  iv?: number;
  ltp?: number;
}

export interface ChainStrikeLike {
  strike: number;
  ce?: ChainLegLike | null;
  pe?: ChainLegLike | null;
}

/** Strike nearest to spot; 0 when there are no strikes. */
export function findAtmStrike(strikes: number[], spot: number): number {
  if (strikes.length === 0) return 0;
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev
  );
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Real ATM IV, median IV and ATM option premiums from a chain's strikes.
 * ivRank = percentile of today's ATM IV within today's IV distribution
 * (the same approximation the Breeze snapshot mapper has always used).
 * Missing IVs return 0 — callers must treat 0 as "unavailable", not "cheap".
 */
export function deriveIvStats(
  strikes: ChainStrikeLike[],
  atmStrike: number
): {
  ivMedian: number;
  ivRank: number;
  atmIV: number;
  atmCePremium: number;
  atmPePremium: number;
} {
  const empty = { ivMedian: 0, ivRank: 0, atmIV: 0, atmCePremium: 0, atmPePremium: 0 };
  if (!strikes || strikes.length === 0) return empty;

  const atmRow = strikes.find(s => s.strike === atmStrike) || null;
  const atmCePremium = atmRow?.ce?.ltp || 0;
  const atmPePremium = atmRow?.pe?.ltp || 0;
  const atmIV = Math.max(atmRow?.ce?.iv || 0, atmRow?.pe?.iv || 0);

  const ivs: number[] = [];
  for (const s of strikes) {
    if (s.ce && (s.ce.iv || 0) > 0) ivs.push(s.ce.iv as number);
    if (s.pe && (s.pe.iv || 0) > 0) ivs.push(s.pe.iv as number);
  }
  if (ivs.length === 0) return { ...empty, atmCePremium, atmPePremium };

  const sorted = [...ivs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ivMedian =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const ivRank =
    atmIV > 0 ? round1((ivs.filter(v => v <= atmIV).length / ivs.length) * 100) : 0;

  return {
    ivMedian: round1(ivMedian),
    ivRank,
    atmIV: round1(atmIV),
    atmCePremium,
    atmPePremium,
  };
}

// ─── Data Quality Check ────────────────────────────────────────────

export interface ChainQualityResult {
  quality: 'GOOD' | 'PARTIAL' | 'POOR' | 'INVALID';
  issues: string[];
  strikesWithData: number;
  totalStrikes: number;
  hasGreeks: boolean;
  hasOI: boolean;
  hasVolume: boolean;
}

export function assessChainQuality(chain: OptionChain): ChainQualityResult {
  const issues: string[] = [];
  let strikesWithData = 0;
  let hasGreeks = false;
  let hasOI = false;
  let hasVolume = false;

  for (const s of chain.strikes) {
    if (s.ce && s.ce.premium > 0) {
      strikesWithData++;
      if (s.ce.delta !== 0) hasGreeks = true;
      if (s.ce.oi > 0) hasOI = true;
      if (s.ce.volume > 0) hasVolume = true;
    }
    if (s.pe && s.pe.premium > 0) {
      strikesWithData++;
      if (s.pe.delta !== 0) hasGreeks = true;
      if (s.pe.oi > 0) hasOI = true;
      if (s.pe.volume > 0) hasVolume = true;
    }
  }

  if (chain.strikes.length < 5) issues.push('Less than 5 strikes');
  if (strikesWithData < 3) issues.push('Less than 3 strikes with valid premiums');
  if (!hasGreeks) issues.push('No Greeks data');
  if (!hasOI) issues.push('No OI data');
  if (!hasVolume) issues.push('No volume data');
  if (chain.pcr === 1 && !hasOI) issues.push('PCR=1 (likely fallback — no OI data)');

  const ratio = chain.strikes.length > 0 ? strikesWithData / chain.strikes.length : 0;
  let quality: ChainQualityResult['quality'] = 'GOOD';
  if (issues.length >= 3 || ratio < 0.3) quality = 'INVALID';
  else if (issues.length >= 2 || ratio < 0.5) quality = 'POOR';
  else if (issues.length >= 1 || ratio < 0.7) quality = 'PARTIAL';

  return { quality, issues, strikesWithData, totalStrikes: chain.strikes.length, hasGreeks, hasOI, hasVolume };
}
