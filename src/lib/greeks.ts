// Black-Scholes Greeks Calculator
// Used for both simulated and live option chain data

const RISK_FREE_RATE = 0.07; // Risk-free rate ~7% (India)

// Standard normal CDF (Abramowitz-Stegun approximation)
function normCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496791;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ── Black-Scholes option PRICE (European, same r as calculateGreeks) ──
// Used by the Challenge engine to re-price an option at the spot stop/target
// (playbook: "repriced stop premium, not a flat guess").
export function bsPrice(
  spot: number,
  strike: number,
  timeToExpiry: number, // years
  iv: number, // decimal (0.14 = 14%)
  isCall: boolean,
): number {
  const intrinsic = isCall
    ? Math.max(spot - strike, 0)
    : Math.max(strike - spot, 0);
  const T = timeToExpiry;
  if (!(spot > 0) || !(strike > 0) || !(T > 0) || !(iv > 0)) {
    return intrinsic; // degenerate: no time value
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (RISK_FREE_RATE + (iv * iv) / 2) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const disc = Math.exp(-RISK_FREE_RATE * T);
  const price = isCall
    ? spot * normCdf(d1) - strike * disc * normCdf(d2)
    : strike * disc * normCdf(-d2) - spot * normCdf(-d1);
  // Full precision here — callers round for display; rounding here would
  // break put-call parity and the IV round-trip.
  return Math.max(price, 0);
}

// ── Implied volatility from a LIVE market premium (bisection) ──
// Returns null when no IV can explain the premium (bad/missing inputs,
// premium below discounted intrinsic, or above the no-arb upper bound) —
// callers must treat null as "cannot size honestly", never fabricate.
export function impliedVolFromPremium(
  premium: number,
  spot: number,
  strike: number,
  timeToExpiry: number, // years
  isCall: boolean,
): number | null {
  if (!(premium > 0) || !(spot > 0) || !(strike > 0) || !(timeToExpiry > 0)) return null;
  const disc = Math.exp(-RISK_FREE_RATE * timeToExpiry);
  const intrinsic = isCall ? Math.max(spot - strike * disc, 0) : Math.max(strike * disc - spot, 0);
  const upper = isCall ? spot : strike * disc; // no-arb bounds
  if (premium < intrinsic - 0.01 || premium > upper + 0.01) return null;

  const price = (iv: number) => bsPrice(spot, strike, timeToExpiry, iv, isCall);
  let lo = 0.0001;
  let hi = 5; // 500% IV cap
  if (price(hi) < premium) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (price(mid) < premium) lo = mid;
    else hi = mid;
  }
  const iv = (lo + hi) / 2;
  // Verify (bsPrice rounds to 2dp → allow half a paisa + rounding headroom)
  if (Math.abs(price(iv) - premium) > 0.05) return null;
  return iv;
}

export function calculateGreeks(
  spot: number,
  strike: number,
  timeToExpiry: number,
  iv: number, // as decimal (e.g., 0.15 for 15%)
  isCall: boolean
): { delta: number; theta: number; gamma: number; vega: number; d1: number; d2: number } {
  const r = 0.07; // Risk-free rate ~7%
  const sqrtT = Math.sqrt(Math.max(timeToExpiry, 0.0001));

  // Avoid division by zero
  if (iv <= 0 || sqrtT <= 0) {
    return { delta: 0, theta: 0, gamma: 0, vega: 0, d1: 0, d2: 0 };
  }

  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * timeToExpiry) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;

  // Cumulative normal distribution approximation
  const cdf = (x: number): number => {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return 0.5 * (1.0 + sign * y);
  };

  // PDF of normal distribution
  const pdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  let delta: number;
  const gamma = pdf(d1) / (spot * iv * sqrtT);
  const vega = spot * pdf(d1) * sqrtT / 100; // Per 1% change in IV
  let theta: number;

  if (isCall) {
    delta = cdf(d1);
    theta = (-(spot * pdf(d1) * iv) / (2 * sqrtT) - r * strike * Math.exp(-r * timeToExpiry) * cdf(d2)) / 365;
  } else {
    delta = cdf(d1) - 1;
    theta = (-(spot * pdf(d1) * iv) / (2 * sqrtT) + r * strike * Math.exp(-r * timeToExpiry) * cdf(-d2)) / 365;
  }

  return {
    delta: Math.round(delta * 100) / 100,
    theta: Math.round(theta * 100) / 100,
    gamma: Math.round(gamma * 10000) / 10000,
    vega: Math.round(vega * 100) / 100,
    d1,
    d2,
  };
}

// ── Expiry parsing (dd-Mon-yyyy / dd-mm-yyyy / ISO → Date | null) ──
// Moved from challenge-engine so premium-space conversion can live here too
// (challenge imports trade-intelligence → trade-intelligence must not import
// challenge; greeks stays a pure leaf). challenge-engine re-exports both.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a broker/NSE expiry string to a Date (expiry valid until 15:30 IST =
 * 10:00 UTC that day). Returns null when unparseable or long expired.
 */
export function parseExpiryDate(expiry: string, now: Date = new Date()): Date | null {
  if (!expiry || typeof expiry !== "string") return null;
  const s = expiry.trim();
  let d: Date | null = null;
  let m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) {
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      d = new Date(Date.UTC(year, mon, Number(m[1]), 10, 0, 0)); // 15:30 IST
    }
  }
  if (!d) {
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // dd-mm-yyyy
    if (m) d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 10, 0, 0));
  }
  if (!d) {
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // ISO
    if (m) d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 10, 0, 0));
  }
  if (!d || isNaN(d.getTime())) return null;
  if (d.getTime() < now.getTime() - 43200000) return null; // expired >12h ago
  return d;
}

/** Expiry → Black-Scholes time-to-expiry in years (min half a day). */
export function parseExpiryToYears(expiry: string, now: Date = new Date()): number | null {
  const d = parseExpiryDate(expiry, now);
  if (!d) return null;
  const days = (d.getTime() - now.getTime()) / 86400000;
  return Math.max(days, 0.5) / 365;
}

/** ₹0.05 tick rounding for premium display/levels. */
export const roundPremium = (x: number) => Math.round(x * 20) / 20;

/**
 * Rule set C: an option buy never risks more than 10% of its premium — the
 * engines' ATR spot stops reprice to 30-50% of premium, which at lot
 * granularity blows the ₹1,500 risk budget for every lot. Floor (tighten) the
 * repriced stop at entry × 90%; targets untouched (R:R only improves).
 */
export const OPTION_STOP_PCT = 0.10;

export type SpotToPremiumResult =
  | { ok: true; entry: number; stopLoss: number; target1: number; target2: number; riskReward: number }
  | { ok: false; reason: string };

/**
 * Convert an option setup from SPOT levels to PREMIUM levels: entry = live
 * premium, SL/TP = Black-Scholes re-price of the spot SL/TP at the IV implied
 * by that live premium (playbook: "repriced stop premium, not a flat guess"),
 * stop floored (tightened) at entry × (1 − OPTION_STOP_PCT) — Rule Set C /
 * Today's Trade. Pass `applyStopFloor: false` for the plain skill-faithful
 * conversion (stop lives on the underlying, converts via repricing — used by
 * BestTradesNow; the cap there exits before the underlying stop and inflates
 * option R:R). Fails cleanly — never fabricates — when premium, strike,
 * expiry or the IV round-trip is missing/invalid, or the repriced stop ≤ 0.
 * Used by Today's Trade (stock/index F&O modes) and the opportunities API.
 */
export function spotToPremiumLevels(input: {
  spotEntry: number;
  spotStopLoss: number;
  spotT1: number;
  spotT2: number;
  premium: number;
  strike: number;
  expiry: string;
  isCall: boolean;
  now?: Date;
  /** default true = Rule Set C 10% cap; false = pure underlying-converted stop */
  applyStopFloor?: boolean;
}): SpotToPremiumResult {
  const { spotEntry, spotStopLoss, spotT1, spotT2, isCall } = input;
  const now = input.now ?? new Date();
  const premium = input.premium;
  const strike = input.strike;

  if (!(premium > 0)) return { ok: false, reason: "No live option premium from chain" };
  if (!(strike > 0)) return { ok: false, reason: "No strike from chain" };
  const tte = parseExpiryToYears(input.expiry, now);
  if (tte === null) return { ok: false, reason: `Missing/unparseable expiry: ${input.expiry || "none"}` };

  const iv = impliedVolFromPremium(premium, spotEntry, strike, tte, isCall);
  if (iv === null) return { ok: false, reason: "IV inversion from live premium failed" };

  const entry = roundPremium(premium);
  const bsSl = roundPremium(bsPrice(spotStopLoss, strike, tte, iv, isCall));
  const floor = input.applyStopFloor === false
    ? Number.NEGATIVE_INFINITY
    : roundPremium(entry * (1 - OPTION_STOP_PCT));
  const stopLoss = Math.max(bsSl, floor);
  const t1 = roundPremium(bsPrice(spotT1, strike, tte, iv, isCall));
  const t2 = roundPremium(bsPrice(spotT2, strike, tte, iv, isCall));

  if (!(stopLoss > 0)) return { ok: false, reason: "Repriced stop ≤ 0 — no tradeable premium stop" };
  if (!(stopLoss < entry)) return { ok: false, reason: "Repriced stop not below entry — invalid option setup" };
  if (!(t1 > entry)) return { ok: false, reason: "Repriced target not above entry — invalid option setup" };

  const risk = entry - stopLoss;
  const reward = t1 - entry;
  return {
    ok: true,
    entry,
    stopLoss,
    target1: t1,
    target2: Math.max(t2, t1),
    riskReward: risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0,
  };
}
