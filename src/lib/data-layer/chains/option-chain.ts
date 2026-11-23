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

import { classifyFreshness, collectedFreshness, providerTimestamp } from '@/lib/api-freshness';
import { calculateGreeks } from '@/lib/greeks';
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

// ── Expiry selection — single source of truth ────────────────────────
//
// WHY this module owns every expiry decision:
// the exchange keeps the contract that JUST expired as the FIRST entry of
// its contract list. Live-verified 2026-10-20: NSE listed "19-Oct-2026"
// (a DEAD contract) ahead of "27-Oct-2026", so every `expiryDates[0]`
// consumer priced a dead contract. The bhavcopy EOD file has the same
// shape.
//
// Rules (every caller goes through here):
//   • A REQUESTED expiry is honoured when it exists in the chain.
//   • Without a request, the NEAREST expiry that is still trading wins.
//   • "Still trading" = the contract's expiry session (15:30 IST on the
//     expiry date) has not finished yet.
//   • A requested expiry that is NOT in the chain is an explicit failure —
//     never a silent substitution with another expiry.

/** IST is a fixed UTC+05:30 — no DST. */
export const IST_OFFSET_MINUTES = 330;
/** The F&O expiry session ends at 15:30 IST on the expiry date. */
const EXPIRY_SESSION_END_MINUTES = 15 * 60 + 30;

/** Marker prefixed to every "the requested expiry does not exist" reason. */
export const EXPIRY_UNAVAILABLE = 'EXPIRY_UNAVAILABLE';

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ExpiryParts {
  y: number;
  m: number; // 0-based
  d: number;
}

/**
 * Parse an expiry string in any form the app accepts:
 *   YYYY-MM-DD | DD-Mon-YYYY | DD Mon YYYY | DD-Mon | DD/MM/YYYY
 * Returns null when the string is not an expiry date.
 */
export function parseExpiryParts(raw: string | null | undefined): ExpiryParts | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return mkParts(+m[1], +m[2] - 1, +m[3]);

  // DD-Mon-YYYY | DD Mon YYYY | DD/Mon/YYYY
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{4})$/.exec(s);
  if (m) {
    const mon = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    return mkParts(+m[3], mon, +m[1]);
  }

  // DD-MM-YYYY (numeric, day first)
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return mkParts(+m[3], +m[2] - 1, +m[1]);

  return null;
}

function mkParts(y: number, m: number, d: number): ExpiryParts | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** "2026-10-22" — the canonical, comparable form of an expiry. */
export function toIsoDate(raw: string | null | undefined): string | null {
  const p = parseExpiryParts(raw);
  if (!p) return null;
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** "22-Oct-2026" — the format the NSE option-chain-v3 endpoint expects. */
export function toNseExpiry(raw: string | null | undefined): string | null {
  const p = parseExpiryParts(raw);
  if (!p) return null;
  return `${String(p.d).padStart(2, '0')}-${MONTH_NAMES[p.m]}-${p.y}`;
}

/** "22 Oct 2026" — the format the BSE DerivOptionChain_IV endpoint expects. */
export function toBseExpiry(raw: string | null | undefined): string | null {
  const p = parseExpiryParts(raw);
  if (!p) return null;
  return `${String(p.d).padStart(2, '0')} ${MONTH_NAMES[p.m]} ${p.y}`;
}

/** True when both strings denote the same calendar expiry date. */
export function isSameExpiry(a: string | null | undefined, b: string | null | undefined): boolean {
  const ia = toIsoDate(a);
  const ib = toIsoDate(b);
  return !!ia && !!ib && ia === ib;
}

/**
 * True when the contract has already died: its expiry session (15:30 IST on
 * the expiry date) is over. An expiry dated TODAY is still trading while the
 * session runs; a contract from a previous day never is.
 */
export function isExpiryExpired(raw: string | null | undefined, now: Date = new Date()): boolean {
  const p = parseExpiryParts(raw);
  if (!p) return true; // an unparseable expiry is never treated as live
  const istMidnightUtc = Date.UTC(p.y, p.m, p.d) - IST_OFFSET_MINUTES * 60_000;
  const sessionEndUtc = istMidnightUtc + EXPIRY_SESSION_END_MINUTES * 60_000;
  return now.getTime() >= sessionEndUtc;
}

/**
 * The nearest expiry in the list that is still trading. Never returns an
 * expired contract, and never invents a date that is not in the list.
 */
export function selectNearestLiveExpiry(
  expiries: Array<string | null | undefined> | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!Array.isArray(expiries)) return null;
  const live = expiries
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .filter((e) => !isExpiryExpired(e, now))
    .map((e) => ({ raw: e, iso: toIsoDate(e) }))
    .filter((e): e is { raw: string; iso: string } => !!e.iso)
    .sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  return live.length ? live[0].raw : null;
}

/** The human-readable reason used when a requested expiry is not available. */
export function expiryUnavailableReason(
  symbol: string,
  requested: string,
  available: Array<string | null | undefined> | null | undefined,
): string {
  const list = (available || [])
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .slice(0, 12);
  return `${EXPIRY_UNAVAILABLE}: expiry "${requested}" is not available for ${symbol}. Available: ${list.length ? list.join(', ') : 'none'}`;
}

/** True when a provider reason reports an unavailable requested expiry. */
export function isExpiryUnavailableReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(EXPIRY_UNAVAILABLE);
}

/**
 * The provider's own publication timestamp (ISO) — WHEN the chain was
 * priced. Null when the payload carries none (an undated payload is
 * undated — never pretend it was priced now).
 */
export function providerAsOf(raw: any): string | null {
  const ts = providerTimestamp(raw);
  return ts ? ts.toISOString() : null;
}

// ── Canonical chain type (OptionChainData + provenance stamps) ───────

/**
 * The canonical option chain. Extends the shared schema with the stamps a
 * caller needs to know WHICH contract it holds and WHEN it was priced:
 *   asOf            — the provider's own publication/pricing timestamp
 *   expiryRequested — what the caller asked for (null = auto-selected)
 *   expirySelection — how the expiry was chosen
 *   isEod           — true for end-of-day bhavcopy data (never a live chain)
 */
export interface CanonicalOptionChain extends OptionChainData {
  asOf?: string;
  expiryRequested?: string | null;
  expirySelection?: 'requested' | 'nearest-live' | 'provider';
  isEod?: boolean;
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

// ── Per-strike greeks: provider first, Black-Scholes(IV) as the honest
//    fallback, null when neither is possible. ─────────────────────────
//
// WHY: the engine-path normalizer used to drop delta/gamma/theta/vega
// entirely, so selectStrike saw no delta anywhere ("delta unavailable")
// and assessTargets ran its TP math on a 0.50 guess. NSE publishes greeks;
// Breeze/MO often ship IV only (or `Number(x) || 0` zeros) — from a live IV
// the BS delta IS computable and is labelled "bs", never passed off as
// provider data. No IV → null, honestly.

export interface DerivedGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  deltaSource: "provider" | "bs" | null;
}

/** Years to expiry from an ISO date at the 15:30 IST session end; floor = 0.002. */
function tYears(expiry: string | null | undefined, now: Date = new Date()): number | null {
  const iso = toIsoDate(expiry);   // accepts "2026-11-17" | "17-Nov-2026" | "17 Nov 2026"
  if (!iso) return null;
  const end = Date.parse(`${iso}T15:30:00+05:30`);
  if (!Number.isFinite(end)) return null;
  const days = (end - now.getTime()) / 86_400_000;
  return Math.max(days / 365, 0.002);
}

export function deriveLegGreeks(
  raw: { delta?: any; gamma?: any; theta?: any; vega?: any; iv?: any },
  spot: number,
  strike: number,
  expiryIso: string | null | undefined,
  isCall: boolean,
): DerivedGreeks {
  const d = Number(raw?.delta);
  const g = Number(raw?.gamma);
  const th = Number(raw?.theta);
  const v = Number(raw?.vega);
  const hasProvider =
    Number.isFinite(d) && Number.isFinite(g) && Number.isFinite(th) &&
    (d !== 0 || g !== 0 || th !== 0);   // all-zero = "unknown" sentinel, not a real greek
  if (hasProvider) {
    return {
      delta: d, gamma: g, theta: th,
      vega: Number.isFinite(v) ? v : null,
      deltaSource: "provider",
    };
  }

  const ivPct = Number(raw?.iv);
  const T = tYears(expiryIso);
  if (
    Number.isFinite(ivPct) && ivPct > 0 &&
    Number.isFinite(spot) && spot > 0 &&
    Number.isFinite(strike) && strike > 0 &&
    T != null && T > 0
  ) {
    const gv = calculateGreeks(spot, strike, T, ivPct / 100, isCall);
    // Valid inputs → the BS values ARE the greeks, even when 2dp/4dp rounding
    // puts a far-OTM delta/gamma at exactly 0. The all-zero sentinel only
    // applies to the PROVIDER path above (a provider that shipped IV but no
    // greeks); rejecting here used to null out 100+ live legs and starve
    // seller-intel of analysable data.
    if (Number.isFinite(gv.delta)) {
      return { delta: gv.delta, gamma: gv.gamma, theta: gv.theta, vega: gv.vega, deltaSource: "bs" };
    }
  }

  return { delta: null, gamma: null, theta: null, vega: null, deltaSource: null };
}

function mapLeg(
  leg: any,
  spot: number,
  strike: number,
  expiryIso: string | null | undefined,
  isCall: boolean,
): OptionLeg | null {
  if (!leg) return null;
  const gk = deriveLegGreeks(leg, spot, strike, expiryIso, isCall);
  const num = (x: any): number | null => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const oiChange = num(leg.oiChange) ?? num(leg.oiChg);
  return {
    ltp: num(leg.ltp),
    oi: num(leg.oi),
    oiChange,
    oiChg: num(leg.oiChg) ?? oiChange,   // both names — type says oiChange, legacy readers use oiChg
    volume: num(leg.volume),
    iv: num(leg.iv),
    bid: num(leg.bid),
    ask: num(leg.ask),
    rho: num(leg.rho),
    delta: gk.delta,
    gamma: gk.gamma,
    theta: gk.theta,
    vega: gk.vega,
    deltaSource: gk.deltaSource,
  };
}

/**
 * The ONE mapper for market-data-service engine payloads → canonical strikes.
 * Keeps provider greeks, derives BS(IV) greeks when the provider ships none,
 * and emits `oiChange` + `oiChg` so every consumer reads the real ΔOI.
 */
export function mapEngineStrikes(
  rawStrikes: any[],
  spot: number,
  expiryIso: string | null | undefined,
): OptionStrike[] {
  const out: OptionStrike[] = [];
  for (const s of rawStrikes || []) {
    const rawStrike = s?.strike;
    if (rawStrike == null || rawStrike === '') continue;
    const strike = Number(rawStrike);
    if (!Number.isFinite(strike)) continue;
    out.push({
      strike,
      ce: mapLeg(s.ce, spot, strike, expiryIso, true),
      pe: mapLeg(s.pe, spot, strike, expiryIso, false),
    });
  }
  return out;
}

// ── Normalise NSE format (.records.data) ────────────────────────────

function normalizeNseChain(
  raw: any,
  symbol?: string,
  requestedExpiry?: string | null,
): ProviderResult<CanonicalOptionChain> {
  try {
    // The chain's contract list. The exchange keeps the just-expired
    // contract as the first entry — never take it blindly.
    const available: string[] = Array.isArray(raw?.records?.expiryDates)
      ? raw.records.expiryDates.filter((e: any) => typeof e === 'string' && e.trim())
      : [];

    // Which contract is this payload actually for? NSE stamps every row.
    const rowExpiry: string | null =
      (raw?.records?.data ?? []).find((r: any) => r?.expiryDates)?.expiryDates ?? null;

    const requested = requestedExpiry ? toIsoDate(requestedExpiry) : null;
    let selected: string | null = null;
    let failure: string | null = null;

    if (requested) {
      // A requested expiry must EXIST in the chain — otherwise say so.
      const match = available.find((e) => isSameExpiry(e, requested));
      if (match) {
        selected = match;
      } else if (rowExpiry && isSameExpiry(rowExpiry, requested)) {
        selected = rowExpiry;
      } else {
        failure = expiryUnavailableReason(symbol || 'UNKNOWN', requestedExpiry!, available);
      }
    } else {
      // No request: the nearest expiry that is still trading.
      selected = selectNearestLiveExpiry(available);
      if (!selected && rowExpiry && !isExpiryExpired(rowExpiry)) {
        selected = rowExpiry;
      }
      if (!selected) {
        failure = available.length
          ? `${EXPIRY_UNAVAILABLE}: no live expiry for ${symbol || 'UNKNOWN'} (all ${available.length} contracts have expired)`
          : `${EXPIRY_UNAVAILABLE}: chain for ${symbol || 'UNKNOWN'} carries no expiry list`;
      }
    }

    if (failure) {
      return { data: null, fallbackUsed: true, source: 'NSE', fallbackReason: failure };
    }

    const strikes: OptionStrike[] = [];
    const rawArr = raw?.records?.data ?? [];
    const spotVal = Number(raw?.records?.underlyingValue) || 0;
    for (const row of rawArr) {
      const strike = row?.strikePrice ?? row?.strike ?? null;
      if (strike === null || isNaN(strike)) continue;

      const ceGk = deriveLegGreeks(
        {
          delta: row?.CE?.greeks?.delta, gamma: row?.CE?.greeks?.gamma,
          theta: row?.CE?.greeks?.theta, vega: row?.CE?.greeks?.vega,
          iv: row?.CE?.impliedVolatility,
        },
        spotVal, Number(strike), selected, true,
      );
      const ce: OptionLeg = {
        ltp: row?.CE?.lastPrice ?? null,
        volume: row?.CE?.totalTradedVolume ?? row?.CE?.totalTradedQuantity ?? null,
        oi: row?.CE?.openInterest ?? null,
        oiChange: row?.CE?.changeinOpenInterest ?? null,
        oiChg: row?.CE?.changeinOpenInterest ?? null,
        iv: row?.CE?.impliedVolatility ?? null,
        bid: row?.CE?.bidprice ?? row?.CE?.bid ?? null,
        ask: row?.CE?.askPrice ?? row?.CE?.ask ?? null,
        delta: ceGk.delta,
        gamma: ceGk.gamma,
        theta: ceGk.theta,
        vega: ceGk.vega,
        deltaSource: ceGk.deltaSource,
        rho: row?.CE?.greeks?.rho ?? null,
      };

      const peGk = deriveLegGreeks(
        {
          delta: row?.PE?.greeks?.delta, gamma: row?.PE?.greeks?.gamma,
          theta: row?.PE?.greeks?.theta, vega: row?.PE?.greeks?.vega,
          iv: row?.PE?.impliedVolatility,
        },
        spotVal, Number(strike), selected, false,
      );
      const pe: OptionLeg = {
        ltp: row?.PE?.lastPrice ?? null,
        volume: row?.PE?.totalTradedVolume ?? row?.PE?.totalTradedQuantity ?? null,
        oi: row?.PE?.openInterest ?? null,
        oiChange: row?.PE?.changeinOpenInterest ?? null,
        oiChg: row?.PE?.changeinOpenInterest ?? null,
        iv: row?.PE?.impliedVolatility ?? null,
        bid: row?.PE?.bidprice ?? row?.PE?.bid ?? null,
        ask: row?.PE?.askPrice ?? row?.PE?.ask ?? null,
        delta: peGk.delta,
        gamma: peGk.gamma,
        theta: peGk.theta,
        vega: peGk.vega,
        deltaSource: peGk.deltaSource,
        rho: row?.PE?.greeks?.rho ?? null,
      };

      strikes.push({ strike, ce, pe });
    }

    const collectedAt = new Date().toISOString();
    const data: CanonicalOptionChain = {
      underlying: raw?.records?.underlying ?? symbol ?? 'UNKNOWN',
      spot: raw?.records?.underlyingValue ?? null,
      expiry: selected,
      strikes,
      timestamp: collectedAt,
      source: 'NSE',
      fallbackUsed: false,
      freshness: collectedFreshness(raw, 'optionChain'),
      // Provenance: WHEN the exchange priced this chain + WHICH contract.
      asOf: providerAsOf(raw) ?? collectedAt,
      expiryRequested: requestedExpiry ?? null,
      expirySelection: requested ? 'requested' : 'nearest-live',
      isEod: false,
    };
    return { data, fallbackUsed: false, source: 'NSE' };
  } catch {
    return { data: null, fallbackUsed: true, source: 'NSE', fallbackReason: 'parse-error' };
  }
}

// ── Normalise BSE format (.Table) ───────────────────────────────────

function normalizeBseChain(
  raw: any,
  symbol?: string,
  requestedExpiry?: string | null,
): ProviderResult<CanonicalOptionChain> {
  try {
    const strikes: OptionStrike[] = [];
    const rawArr = raw?.Table ?? [];

    // Expiry + spot first — the BS(IV) greek fallback needs both while the
    // legs are being built. BSE stamps the contract on every row
    // (format: "22 Oct 2026").
    const collectedAt = new Date().toISOString();
    const rowExpiry: string | null =
      rawArr.find((r: any) => r?.EXPIRY_DT || r?.ExpiryDate || r?.expiryDate)?.EXPIRY_DT ??
      rawArr.find((r: any) => r?.EXPIRY_DT || r?.ExpiryDate || r?.expiryDate)?.ExpiryDate ??
      rawArr.find((r: any) => r?.EXPIRY_DT || r?.ExpiryDate || r?.expiryDate)?.expiryDate ??
      null;

    // A requested expiry is honoured verbatim; without one we take the
    // contract the rows are dated to (never an expired one).
    let selected: string | null = null;
    let failure: string | null = null;
    if (requestedExpiry) {
      const iso = toIsoDate(requestedExpiry);
      if (!iso) {
        failure = `${EXPIRY_UNAVAILABLE}: "${requestedExpiry}" is not a valid expiry date`;
      } else if (rowExpiry && !isSameExpiry(rowExpiry, iso)) {
        failure = expiryUnavailableReason(symbol || 'UNKNOWN', requestedExpiry, rowExpiry ? [rowExpiry] : []);
      } else {
        selected = rowExpiry || toBseExpiry(iso) || iso;
      }
    } else if (rowExpiry) {
      if (isExpiryExpired(rowExpiry)) {
        failure = `${EXPIRY_UNAVAILABLE}: the BSE chain for ${symbol || 'UNKNOWN'} is dated to the expired contract ${rowExpiry}`;
      } else {
        selected = rowExpiry;
      }
    }

    if (failure) {
      return { data: null, fallbackUsed: true, source: 'BSE', fallbackReason: failure };
    }

    const spotVal = Number(raw?.UndlVal ?? raw?.UlaValue) || 0;
    for (const row of rawArr) {
      const strike = parseFloat(row?.Strike_Price1);
      if (isNaN(strike)) continue;

      // One row per strike holds BOTH sides: PE fields are unprefixed,
      // CE fields carry a `C_` prefix (see legacy `bse-api.ts` mapping).
      // BSE publishes no greeks — IV only — so delta comes from BS(IV).
      const ceGk = deriveLegGreeks({ iv: row?.C_IV }, spotVal, strike, selected, true);
      const ce: OptionLeg = {
        ltp: parseNum(row?.C_Last_Trd_Price),
        volume: parseNum(row?.C_Vol_Traded),
        oi: parseNum(row?.C_Open_Interest),
        oiChange: parseNum(row?.C_Absolute_Change_OI),
        oiChg: parseNum(row?.C_Absolute_Change_OI),
        iv: roundIv(parseNum(row?.C_IV)),
        bid: parseNum(row?.C_BidPrice),
        ask: parseNum(row?.C_OfferPrice),
        delta: ceGk.delta,
        gamma: ceGk.gamma,
        theta: ceGk.theta,
        vega: ceGk.vega,
        deltaSource: ceGk.deltaSource,
        rho: null,
      };

      const peGk = deriveLegGreeks({ iv: row?.IV }, spotVal, strike, selected, false);
      const pe: OptionLeg = {
        ltp: parseNum(row?.Last_Trd_Price),
        volume: parseNum(row?.Vol_Traded),
        oi: parseNum(row?.Open_Interest),
        oiChange: parseNum(row?.Absolute_Change_OI),
        oiChg: parseNum(row?.Absolute_Change_OI),
        iv: roundIv(parseNum(row?.IV)),
        bid: parseNum(row?.BidPrice),
        ask: parseNum(row?.OfferPrice),
        delta: peGk.delta,
        gamma: peGk.gamma,
        theta: peGk.theta,
        vega: peGk.vega,
        deltaSource: peGk.deltaSource,
        rho: null,
      };

      strikes.push({ strike, ce, pe });
    }

    const data: CanonicalOptionChain = {
      underlying: raw?.UndlVal ?? raw?.UlaValue ?? symbol ?? 'UNKNOWN',
      spot: raw?.UndlVal ?? raw?.UlaValue ?? null,
      expiry: selected,
      strikes,
      timestamp: collectedAt,
      source: 'BSE',
      fallbackUsed: false,
      freshness: collectedFreshness(raw, 'optionChain'),
      asOf: providerAsOf(raw) ?? collectedAt,
      expiryRequested: requestedExpiry ?? null,
      expirySelection: requestedExpiry ? 'requested' : 'provider',
      isEod: false,
    };
    return { data, fallbackUsed: false, source: 'BSE' };
  } catch {
    return { data: null, fallbackUsed: true, source: 'BSE', fallbackReason: 'parse-error' };
  }
}

// ── Public: normalizeOptionChain ────────────────────────────────────
// Detects source from the data structure itself — not from a variable flag.
// Signature matches the option-chain route call: (raw, expiry?, symbol?)
// The `expiry` argument is HONOURED: it is used when it exists in the
// chain, and its absence is an explicit failure (never a silent swap).

export function normalizeOptionChain(
  raw?: any,
  expiry?: string,
  symbol?: string,
): ProviderResult<CanonicalOptionChain> {
  if (raw?.records?.data) return normalizeNseChain(raw, symbol, expiry);
  if (raw?.Table) return normalizeBseChain(raw, symbol, expiry);
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
): Promise<ProviderResult<CanonicalOptionChain>> {
  const exchange = getExchangeForSymbol(symbol);

  // The requested expiry, normalised to the comparable ISO form. A malformed
  // expiry is an honest failure — never a silent "nearest contract" swap.
  const requestedIso = expiry ? toIsoDate(expiry) : null;
  const requestedRaw = expiry || null;
  if (expiry && !requestedIso) {
    return {
      data: null,
      fallbackUsed: true,
      source: 'NO_DATA',
      fallbackReason: `${EXPIRY_UNAVAILABLE}: "${expiry}" is not a valid expiry date (use YYYY-MM-DD or DD-Mon-YYYY)`,
    };
  }

    // Fetch via the central engine: parallel provider race
  // (Breeze → MOAPI → NSE → BSE, first complete valid fresh chain wins,
  // NseGate-protected, circuit-breaker aware). Never merge providers; never
  // label stale/delayed data as live.
  const mds = await import('@/lib/market-data-service');
  const env = await mds.fetchMarketData({
    symbol,
    category: "option-chain",
    exchange,
    instrument: undefined,
    expiry: requestedIso,
    nowMs: Date.now(),
  });

  if (env.available && env.data) {
    const raw: any = env.data;
    const spotPrice = Number(raw.spotPrice) || 0;
    const chainExpiry = raw.selectedExpiry || raw.expiry || null;
    // Single mapper: keeps provider greeks, BS(IV) fallback, both oiChange names.
    const strikes: OptionStrike[] = mapEngineStrikes(raw.strikes, spotPrice, chainExpiry);
    const chain: any = {
      underlying: symbol,
      spot: spotPrice,
      exchange,
      strikes,
      expiry: chainExpiry,
      providerTimestamp: env.providerTimestamp ?? null,
      source: env.provider,
      fetchedAt: env.fetchedAt,
      sourceType: env.source,
      fallbackUsed: env.fallbackUsed,
      freshness: env.freshness,
    };
    const result: ProviderResult<CanonicalOptionChain> = {
      data: chain,
      fallbackUsed: env.fallbackUsed,
      source: engineSourceToLayer(env.provider),
      fallbackReason: env.fallbackReason,
    };
    return settle(result, requestedIso, requestedRaw);
  }

  // Last resort: end-of-day bhavcopy (clearly labelled, never a live chain).
  const { bhavcopyProvider } = await import('@/lib/data-layer/providers/bhavcopy');
  const eod = await bhavcopyProvider.getOptionChain(symbol, requestedIso ?? undefined);
  if (eod.data) {
    const result: ProviderResult<CanonicalOptionChain> = {
      data: eod.data,
      fallbackUsed: true,
      source: 'BHAVCOPY',
      fallbackReason: eod.fallbackReason ?? 'live chain unavailable; serving EOD bhavcopy',
    };
    return settle(result, requestedIso, requestedRaw);
  }
  if (isExpiryUnavailableReason(eod.fallbackReason)) {
    return { data: null, fallbackUsed: true, source: 'NO_DATA', fallbackReason: eod.fallbackReason };
  }
  return {
    data: null,
    fallbackUsed: true,
    source: 'NO_DATA',
    fallbackReason: `live option chain unavailable for ${symbol}`,
  };
}

/** Map an engine provider name to the data-layer source label. */
function engineSourceToLayer(p: string): 'NSE' | 'BSE' | 'MOAPI' | 'BREEZE' | 'BHAVCOPY' | 'NO_DATA' {
  switch (p) {
    case 'nse-api': return 'NSE';
    case 'bse-api': return 'BSE';
    case 'motilal-api': return 'MOAPI';
    case 'icici-breeze': return 'BREEZE';
    default: return 'NO_DATA';
  }
}

/**
 * The nearest BSE contract that is still trading ("22 Oct 2026" — the exact
 * string BSE expects). Null when the list is unavailable.
 */
async function pickBseLiveExpiry(symbol: string): Promise<string | undefined> {
  try {
    const { getBSEExpiryDates } = await import('@/lib/bse-api');
    const list = await getBSEExpiryDates(symbol).catch(() => [] as string[]);
    return selectNearestLiveExpiry(list) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify the chain we got is the chain that was asked for, and stamp the
 * provenance. A chain for a DIFFERENT contract than the one requested is an
 * explicit failure — never a silent substitution.
 */
function settle(
  result: ProviderResult<CanonicalOptionChain>,
  requestedIso: string | null,
  requestedRaw: string | null,
): ProviderResult<CanonicalOptionChain> {
  const chain = result.data;
  if (!chain) return result;
  if (requestedIso) {
    if (!chain.expiry || !isSameExpiry(chain.expiry, requestedIso)) {
      return {
        data: null,
        fallbackUsed: true,
        source: result.source,
        fallbackReason: expiryUnavailableReason(
          chain.underlying || 'symbol',
          requestedRaw!,
          chain.expiry ? [chain.expiry] : [],
        ),
      };
    }
    return {
      ...result,
      data: { ...chain, expiryRequested: requestedRaw, expirySelection: 'requested' },
    };
  }
  return {
    ...result,
    data: {
      ...chain,
      expiryRequested: null,
      expirySelection: chain.expirySelection ?? (chain.expiry ? 'nearest-live' : 'provider'),
    },
  };
}

// ── Default export for the data‑layer registry ──────────────────────

export default {
  normalizeOptionChain,
  getOptionChain,
  getExchangeForSymbol,
  selectNearestLiveExpiry,
  isExpiryExpired,
  toIsoDate,
  toNseExpiry,
  toBseExpiry,
};

/** Fake for tests — manually configure with raw provider objects. */
export function __normalizeOptionChainFake() {
  return {
    normalizeOptionChain: (
      _raw?: any,
      _expiry?: string,
      _symbol?: string,
    ): ProviderResult<CanonicalOptionChain> => {
      return { data: null, fallbackUsed: true, source: 'NO_DATA' };
    },
  };
}
