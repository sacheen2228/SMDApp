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
