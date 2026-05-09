// Black-Scholes Greeks Calculator
// Used for both simulated and live option chain data

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
