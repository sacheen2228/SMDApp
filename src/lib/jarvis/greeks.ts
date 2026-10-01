// Black-Scholes Greeks computed from NSE's per-strike implied volatility
// (NSE gives IV, not Greeks). Also derives IV skew, gamma-flip level, net GEX,
// expected move, and a -10..+10 "greek score".
import type { GreeksResult, OptionChain, OptionType } from "./types";

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number): number {
  // Abramowitz-Stegun approximation, good to ~1e-7
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function bsGreeks(
  S: number,
  K: number,
  T: number, // years
  sigma: number, // decimal, e.g. 0.14
  r: number,
  opt: OptionType
): { delta: number; gamma: number; theta: number; vega: number } {
  if (T <= 0 || sigma <= 0 || S <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const gamma = pdf(d1) / (S * sigma * Math.sqrt(T));
  const vega = (S * pdf(d1) * Math.sqrt(T)) / 100;
  let delta: number, theta: number;
  if (opt === "CE") {
    delta = normCdf(d1);
    theta =
      (-((S * pdf(d1) * sigma) / (2 * Math.sqrt(T))) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365;
  } else {
    delta = normCdf(d1) - 1;
    theta =
      (-((S * pdf(d1) * sigma) / (2 * Math.sqrt(T))) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365;
  }
  return {
    delta: round(delta, 4),
    gamma: round(gamma, 6),
    theta: round(theta, 2),
    vega: round(vega, 2),
  };
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

function parseExpiry(exp: string): Date {
  // "25-Sep-2026" -> Date at 15:30 IST that day
  const [dd, mon, yyyy] = exp.split("-");
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  return new Date(Number(yyyy), months[mon], Number(dd), 15, 30, 0);
}

/**
 * Analyse the option chain for the nearest expiry: ATM IV, skew, expected
 * move, net gamma exposure (GEX), gamma-flip strike, per-strike greeks
 * near ATM, and a bounded greek score used by the composite scorer.
 */
export function analyseGreeks(
  oc: OptionChain,
  opts: { r?: number; lot?: number; indiaVix?: number } = {}
): GreeksResult {
  const r = opts.r ?? 0.07;
  const lot = opts.lot ?? 75;
  const S = oc.underlyingValue;
  const expiry = oc.expiryDates[0];
  const expDt = parseExpiry(expiry);
  const T = Math.max((expDt.getTime() - Date.now()) / (365 * 24 * 3600 * 1000), 1e-6);
  const hoursToExpiry = round(T * 365 * 24, 1);
  const rows = oc.data.filter((x) => x.expiryDate === expiry);
  if (rows.length === 0) {
    throw new Error("No option-chain rows for nearest expiry");
  }
  const atm = rows.reduce((a, b) => (Math.abs(b.strikePrice - S) < Math.abs(a.strikePrice - S) ? b : a));
  const strikes = Array.from(new Set(rows.map((r) => r.strikePrice))).sort((a, b) => a - b);
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : 50;

  const ivCe = atm.CE?.impliedVolatility ?? 0;
  const ivPe = atm.PE?.impliedVolatility ?? 0;
  const atmIv = ivCe && ivPe ? (ivCe + ivPe) / 2 : Math.max(ivCe, ivPe);
  const ltpCe = atm.CE?.lastPrice ?? 0;
  const ltpPe = atm.PE?.lastPrice ?? 0;
  const straddle = ltpCe + ltpPe;

  const ivAt = (k: number, side: OptionType): number => {
    const row = rows.find((r) => r.strikePrice === k);
    return row?.[side]?.impliedVolatility ?? 0;
  };
  const putIv = ivAt(atm.strikePrice - 2 * step, "PE");
  const callIv = ivAt(atm.strikePrice + 2 * step, "CE");
  const skew = putIv && callIv ? round(putIv - callIv, 2) : null;

  const perStrike: GreeksResult["perStrike"] = [];
  const gexByStrike: Record<number, number> = {};
  for (const row of rows) {
    const K = row.strikePrice;
    let gex = 0;
    let gCe, gPe;
    for (const side of ["CE", "PE"] as OptionType[]) {
      const leg = row[side];
      if (!leg || !leg.impliedVolatility) continue;
      const g = bsGreeks(S, K, T, leg.impliedVolatility / 100, r, side);
      if (side === "CE") gCe = g;
      else gPe = g;
      const sign = side === "CE" ? 1 : -1;
      gex += sign * g.gamma * leg.openInterest * lot * S * S * 0.01;
    }
    gexByStrike[K] = gex;
    if (Math.abs(K - atm.strikePrice) <= 5 * step) {
      perStrike.push({ strike: K, CE: gCe, PE: gPe });
    }
  }
  const netGex = Object.values(gexByStrike).reduce((a, b) => a + b, 0);

  let cum = 0;
  let flip: number | null = null;
  for (const K of Object.keys(gexByStrike).map(Number).sort((a, b) => a - b)) {
    const prev = cum;
    cum += gexByStrike[K];
    if ((prev < 0 && cum >= 0) || (prev > 0 && cum <= 0)) flip = K;
  }

  const expMove = round(straddle * 0.85, 1);
  const regime: GreeksResult["regime"] = netGex < 0 ? "trending" : "pinned";

  let score = 0;
  const notes: string[] = [];
  if (skew !== null) {
    if (skew > 2) { score -= 3; notes.push(`put skew ${skew} vol pts (fear)`); }
    else if (skew < -1) { score += 3; notes.push(`call skew ${skew} (upside demand)`); }
  }
  if (flip !== null) {
    if (S > flip) { score += 3; notes.push(`spot above gamma flip ${flip}`); }
    else { score -= 3; notes.push(`spot below gamma flip ${flip}`); }
  }
  const vix = opts.indiaVix;
  if (vix !== undefined) {
    if (vix > 20) notes.push(`VIX ${vix} high: premiums rich, prefer ITM, cut size 50%`);
    else if (vix < 12) notes.push(`VIX ${vix} low: cheap premiums but small moves`);
  }

  const thetaAtm = bsGreeks(S, atm.strikePrice, T, (atmIv || 15) / 100, r, "CE").theta;
  const thetaPct = ltpCe ? round((Math.abs(thetaAtm) / ltpCe) * 100, 1) : null;

  const gatesFailed: string[] = [];
  if (hoursToExpiry < 3) gatesFailed.push("<3 hours to expiry: extreme theta, no fresh buys");

  return {
    spot: S,
    expiry,
    hoursToExpiry,
    atmStrike: atm.strikePrice,
    atmIv,
    atmStraddle: straddle,
    expectedMove1Sigma: expMove,
    skewPutMinusCall: skew,
    netGex: Math.round(netGex),
    gammaFlip: flip,
    regime,
    atmThetaPerDayPctOfPremium: thetaPct,
    greekScore: Math.max(-10, Math.min(10, score)),
    gatesFailed,
    notes,
    perStrike,
  };
}
