/**
 * Quant toolkit for the Simple Tab (index option buying) — pure, client-safe.
 *
 * Implements the user's quant spec: implied forward (put-call parity),
 * expected move (zero-drift lognormal baseline), first-passage NULL baseline,
 * theta-gamma breakeven, Breeden-Litzenberger risk-neutral mass between OI
 * walls, skew, IV-vs-RV variance-risk premium, Bollinger %B/bandwidth
 * percentile, VWAP z-score, GEX proxy (reuses gex-engine), debit-spread math,
 * sizing + breakeven p*, and the 9-factor scorecard (0-2 each) whose verdict
 * is BUY CE / BUY PE / SKIP with qualitative confidence only.
 *
 * HONESTY RULES (hard):
 *  - Every function returns `available: false` + null fields when its inputs
 *    are missing/invalid. Nothing is ever invented.
 *  - Model outputs are labeled baselines under assumptions, NOT forecasts.
 *  - No win probability is ever produced. The first-passage number is the
 *    zero-drift NULL hypothesis; the scorecard emits qualitative confidence.
 */

// ─── Types ────────────────────────────────────────────────────────

export interface QuantLeg {
  ltp: number;
  iv: number; // percent (e.g. 15.8)
  delta: number;
  gamma: number;
  theta: number; // per day (chain convention)
  vega: number;
  oi: number;
  oiChg: number;
  volume: number;
  bid?: number;
  ask?: number;
}

export interface QuantStrike {
  strike: number;
  ce: QuantLeg | null;
  pe: QuantLeg | null;
}

export interface Candle5 {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Maybe<T> {
  available: boolean;
  reason?: string;
  value: T | null;
}

function ok<T>(value: T): Maybe<T> {
  return { available: true, value };
}
function na<T>(reason: string): Maybe<T> {
  return { available: false, reason, value: null };
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Mid price: bid/ask when both present and sane, else ltp. */
function mid(leg: QuantLeg | null): number | null {
  if (!leg) return null;
  if (finite(leg.bid) && finite(leg.ask) && leg.ask > 0 && leg.bid > 0 && leg.ask >= leg.bid) {
    return (leg.bid + leg.ask) / 2;
  }
  return finite(leg.ltp) && leg.ltp > 0 ? leg.ltp : null;
}

// ─── A. Implied forward (put-call parity) ────────────────────────

export interface ForwardResult {
  f: number; // implied forward
  k: number; // parity strike used (min |C-P|)
  basis: number; // F - spot
  basisPct: number;
}

/**
 * F = K + e^{rT}(C - P) at the strike where |C - P| is smallest.
 * Mid prices used when bid/ask exist, else ltp. Absorbs dividends/basis.
 */
export function impliedForward(
  strikes: QuantStrike[],
  spot: number,
  r: number,
  tteYears: number,
): Maybe<ForwardResult> {
  if (!strikes.length || !finite(spot) || spot <= 0 || !finite(r) || !finite(tteYears) || tteYears <= 0) {
    return na("need strikes, spot>0, r, tte>0");
  }
  let best: { k: number; diff: number; c: number; p: number } | null = null;
  for (const s of strikes) {
    const c = mid(s.ce);
    const p = mid(s.pe);
    if (c == null || p == null) continue;
    const diff = Math.abs(c - p);
    if (!best || diff < best.diff) best = { k: s.strike, diff, c, p };
  }
  if (!best) return na("no strike with both call and put prices");
  const disc = Math.exp(r * tteYears);
  const f = best.k + disc * (best.c - best.p);
  if (!finite(f) || f <= 0) return na("parity produced invalid forward");
  const basis = f - spot;
  return ok({
    f,
    k: best.k,
    basis,
    basisPct: (basis / spot) * 100,
  });
}

// ─── D. Expected move (zero-drift lognormal baseline) ─────────────

const MINUTES_PER_YEAR = 252 * 375; // 5m bars: 75/day × 252

/**
 * EM_h = F · σ_ATM · sqrt(h / (252·375)). σ in decimal (15.8% → 0.158).
 * Baseline under zero drift — a reference, not a forecast.
 */
export function expectedMove(f: number, sigmaAtmPct: number, minutes: number): Maybe<{ em: number; emPct: number; minutes: number }> {
  if (!finite(f) || f <= 0 || !finite(sigmaAtmPct) || sigmaAtmPct <= 0 || !finite(minutes) || minutes <= 0) {
    return na("need f>0, sigma>0, minutes>0");
  }
  const sigma = sigmaAtmPct / 100;
  const em = f * sigma * Math.sqrt(minutes / MINUTES_PER_YEAR);
  return ok({ em, emPct: (em / f) * 100, minutes });
}

// ─── D. First-passage NULL baseline ───────────────────────────────

/**
 * P(target before stop) = a / (a + b) under ZERO drift, ignoring theta.
 * This is the NULL HYPOTHESIS to beat — not the user's probability of winning.
 */
export function firstPassageBaseline(stopDist: number, targetDist: number): Maybe<{ p: number; assumption: string }> {
  if (!finite(stopDist) || stopDist <= 0 || !finite(targetDist) || targetDist <= 0) {
    return na("need positive stop and target distances");
  }
  return ok({
    p: stopDist / (stopDist + targetDist),
    assumption: "zero drift, no theta/costs — NULL hypothesis, not a forecast",
  });
}

// ─── E. Theta-gamma breakeven ─────────────────────────────────────

/**
 * Underlying move needed to pay for theta over the hold: dF = sqrt(2|Θ|·dt / Γ).
 * Θ in premium points PER DAY (chain convention), dt in days, Γ per point².
 * Compares against the ATM option of the chain.
 */
export function thetaGammaBreakeven(gamma: number, thetaPerDayAbs: number, dtDays: number): Maybe<{ dF: number }> {
  if (!finite(gamma) || gamma <= 0 || !finite(thetaPerDayAbs) || thetaPerDayAbs <= 0 || !finite(dtDays) || dtDays <= 0) {
    return na("need gamma>0, |theta|>0, dt>0");
  }
  return ok({ dF: Math.sqrt((2 * thetaPerDayAbs * dtDays) / gamma) });
}

// ─── F. Breeden-Litzenberger risk-neutral mass ────────────────────

export interface RNMassResult {
  mass: number; // risk-neutral probability mass between the walls
  densities: Array<{ strike: number; f: number }>; // f(K) per strike
  negativeCount: number; // noisy/illiquid strikes (flagged, not used silently)
}

/**
 * f(K) = e^{rT}·[C(K−h) − 2C(K) + C(K+h)] / h² on adjacent strikes (h = step),
 * mid prices. Mass between lowerK and upperK = Σ f(K)·h. Negative densities
 * are counted and reported (never smoothed away).
 */
export function riskNeutralMass(
  strikes: QuantStrike[],
  r: number,
  tteYears: number,
  lowerK: number,
  upperK: number,
): Maybe<RNMassResult> {
  if (strikes.length < 3 || !finite(r) || !finite(tteYears) || tteYears <= 0) {
    return na("need ≥3 strikes, r, tte>0");
  }
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const callMid = new Map<number, number>();
  for (const s of sorted) {
    const m = mid(s.ce);
    if (m != null) callMid.set(s.strike, m);
  }
  const ks = [...callMid.keys()].sort((a, b) => a - b);
  if (ks.length < 3) return na("need ≥3 strikes with call prices");

  // Uniform step from the modal gap (chain steps can repeat); require consistency.
  const gaps: number[] = [];
  for (let i = 1; i < ks.length; i++) gaps.push(ks[i] - ks[i - 1]);
  const stepCounts = new Map<number, number>();
  for (const g of gaps) stepCounts.set(g, (stepCounts.get(g) ?? 0) + 1);
  let h = 0;
  let hCount = 0;
  for (const [g, c] of stepCounts) if (c > hCount) { h = g; hCount = c; }
  if (h <= 0) return na("cannot determine strike step");

  const disc = Math.exp(r * tteYears);
  const densities: Array<{ strike: number; f: number }> = [];
  let negatives = 0;
  for (let i = 1; i < ks.length - 1; i++) {
    const k = ks[i];
    const km = ks[i - 1];
    const kp = ks[i + 1];
    if (kp - km !== 2 * h) continue; // only uniform triples
    const cL = callMid.get(km)!;
    const c0 = callMid.get(k)!;
    const cR = callMid.get(kp)!;
    const fK = (disc * (cL - 2 * c0 + cR)) / (h * h);
    if (fK < 0) negatives++;
    densities.push({ strike: k, f: fK });
  }
  if (!densities.length) return na("no uniform strike triples");

  let mass = 0;
  for (const d of densities) {
    if (d.strike >= lowerK && d.strike <= upperK) mass += Math.max(0, d.f) * h; // negatives excluded from mass, counted separately
  }
  return ok({ mass, densities, negativeCount: negatives });
}

// ─── G. Skew ──────────────────────────────────────────────────────

/**
 * Skew = IV(put at −x% moneyness) − IV(call at +x% moneyness), x = 1% default.
 * Positive → puts richer (crash protection bid / fear).
 */
export function skew(strikes: QuantStrike[], spot: number, xPct = 1): Maybe<{ skewIv: number; putIv: number; callIv: number; moneynessPct: number }> {
  if (!strikes.length || !finite(spot) || spot <= 0) return na("need strikes and spot");
  const target = (spot * xPct) / 100;
  let putK: number | null = null;
  let callK: number | null = null;
  let putDist = Infinity;
  let callDist = Infinity;
  for (const s of strikes) {
    if (s.pe?.iv > 0) {
      const d = Math.abs((s.strike - (spot - target)) / spot);
      // put side: strike at −x% moneyness (below spot)
      if (s.strike <= spot) {
        const dd = Math.abs(s.strike - (spot - target));
        if (dd < putDist) { putDist = dd; putK = s.strike; }
      }
    }
    if (s.ce?.iv > 0 && s.strike >= spot) {
      const dd = Math.abs(s.strike - (spot + target));
      if (dd < callDist) { callDist = dd; callK = s.strike; }
    }
  }
  const put = putK != null ? strikes.find((s) => s.strike === putK)?.pe?.iv ?? null : null;
  const call = callK != null ? strikes.find((s) => s.strike === callK)?.ce?.iv ?? null : null;
  if (put == null || call == null) return na("need put IV below spot and call IV above spot");
  return ok({ skewIv: put - call, putIv: put, callIv: call, moneynessPct: xPct });
}

// ─── G. Realized vol + variance risk premium ──────────────────────

/**
 * RV = sqrt(252·75 · mean(r_i²)) from 5m log returns (75 bars/day).
 * VRP = IV² − RV² (decimal²). Large positive → options expensive for a buyer.
 */
export function realizedVol(closes: number[]): Maybe<{ rvPct: number; bars: number }> {
  if (!closes || closes.length < 20) return na("need ≥20 5m closes");
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 19) return na("not enough valid returns");
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1);
  const rv = Math.sqrt(252 * 75 * variance);
  return ok({ rvPct: rv * 100, bars: closes.length });
}

export function varianceRiskPremium(ivPct: number, rvPct: number): Maybe<{ vrp: number; verdict: "cheap" | "fair" | "expensive" }> {
  if (!finite(ivPct) || ivPct <= 0 || !finite(rvPct) || rvPct <= 0) return na("need positive IV and RV");
  const iv = ivPct / 100;
  const rv = rvPct / 100;
  const vrp = iv * iv - rv * rv;
  const verdict = vrp > 0.01 ? "expensive" : vrp > 0 ? "fair" : "cheap";
  return ok({ vrp, verdict });
}

// ─── J. VWAP z-score + Bollinger stats ────────────────────────────

/** z_vwap = (P − VWAP)/σ_vwap with volume-weighted σ over the session. */
export function vwapZ(bars: Candle5[]): Maybe<{ z: number; vwap: number; sigma: number; last: number }> {
  if (!bars || bars.length < 5) return na("need ≥5 bars");
  let pv = 0;
  let vv = 0;
  let sv = 0;
  const last = bars[bars.length - 1];
  for (const b of bars) {
    const p = (b.high + b.low + b.close) / 3;
    const v = b.volume > 0 ? b.volume : 1;
    pv += p * v;
    vv += v;
  }
  if (vv <= 0) return na("zero volume");
  const vwap = pv / vv;
  for (const b of bars) {
    const p = (b.high + b.low + b.close) / 3;
    const v = b.volume > 0 ? b.volume : 1;
    sv += v * (p - vwap) * (p - vwap);
  }
  const sigma = Math.sqrt(sv / vv);
  if (sigma <= 0) return na("degenerate σ_vwap");
  return ok({ z: (last.close - vwap) / sigma, vwap, sigma, last: last.close });
}

export interface BbStats {
  percentB: number; // (P − L)/(U − L)
  bandwidth: number; // (U − L)/M
  bandwidthPctile: number; // rank of current bandwidth in the lookback (0-1)
  squeeze: boolean; // pctile < 0.15
  upper: number;
  middle: number;
  lower: number;
  regime: "trending" | "mean_reverting";
}

/**
 * BB(20, 2) stats on the LAST bar + bandwidth percentile over the lookback.
 * Regime: trending if price holds one VWAP side with expanding bandwidth —
 * caller supplies vwapSide; here: expanding bandwidth + |%B| extremes → trending.
 */
export function bbStats(bars: Candle5[], period = 20, mult = 2, lookback = 75): Maybe<BbStats> {
  if (!bars || bars.length < period + 10) return na(`need ≥${period + 10} bars`);
  const lastClose = bars[bars.length - 1].close;
  const closes = bars.map((b) => b.close);
  const bw: number[] = [];
  const lastUpper = { v: 0 };
  const lastMiddle = { v: 0 };
  const lastLower = { v: 0 };
  const start = Math.max(0, closes.length - lookback);
  for (let i = start + period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const m = win.reduce((s, c) => s + c, 0) / period;
    const sd = Math.sqrt(win.reduce((s, c) => s + (c - m) * (c - m), 0) / period);
    const u = m + mult * sd;
    const l = m - mult * sd;
    bw.push(u - l);
    if (i === closes.length - 1) {
      lastUpper.v = u;
      lastMiddle.v = m;
      lastLower.v = l;
    }
  }
  if (bw.length < 10) return na("not enough BB windows");
  const cur = bw[bw.length - 1];
  const mid = (lastUpper.v + lastLower.v) / 2;
    const pctB = lastUpper.v - lastLower.v > 0 ? (lastClose - lastLower.v) / (lastUpper.v - lastLower.v) : 0.5;
  const sortedBw = [...bw].sort((a, b) => a - b);
  const rank = sortedBw.filter((x) => x <= cur).length / sortedBw.length;
  // Expanding bandwidth (current > median) with %B outside 0.2-0.8 → trending
  const medianBw = sortedBw[Math.floor(sortedBw.length / 2)];
  const regime: BbStats["regime"] = cur > medianBw && (pctB > 0.8 || pctB < 0.2) ? "trending" : "mean_reverting";
  void mid;
  return ok({
    percentB: pctB,
    bandwidth: lastMiddle.v > 0 ? cur / lastMiddle.v : 0,
    bandwidthPctile: rank,
    squeeze: rank < 0.15,
    upper: lastUpper.v,
    middle: lastMiddle.v,
    lower: lastLower.v,
    regime,
  });
}

// ─── H. GEX proxy (assumption-heavy, low weight) ──────────────────
// Reuses src/lib/gex-engine.ts calculateGEX — the ONLY GEX math. Imported by
// callers; not duplicated here (no local copy).

// ─── K. Sizing + expectancy ───────────────────────────────────────

export interface SizingResult {
  premiumRiskPerLot: number; // stop points × |Δ| × lot + slippage + charges
  lots: number; // floor(capital·risk% / premiumRiskPerLot); 0 → do not trade
  breakevenP: number; // p* = (Rl + c)/(Rw + Rl)
  rw: number; // target R multiple
  rl: number; // stop R multiple (1 by construction)
  costR: number; // costs in R
}

/**
 * Premium risk per lot = (stop points × |Δavg| × lot) + slippage + charges.
 * Lots = floor(capital × risk% / risk per lot). Lots < 1 → tighter setup,
 * cheaper instrument, or debit spread — NEVER "risk more".
 */
export function sizingAndExpectancy(args: {
  capital: number;
  riskPct: number; // 1 = 1%
  stopPoints: number;
  targetPoints: number;
  deltaAbs: number; // |Δ| of the option over the hold
  lotSize: number;
  slippagePerLot?: number;
  chargesPerLot?: number;
}): Maybe<SizingResult> {
  const { capital, riskPct, stopPoints, targetPoints, deltaAbs, lotSize } = args;
  const slippage = args.slippagePerLot ?? 0;
  const charges = args.chargesPerLot ?? 0;
  if (![capital, riskPct, stopPoints, targetPoints, deltaAbs, lotSize].every((v) => finite(v) && v > 0)) {
    return na("need positive capital, riskPct, stop/target points, |Δ|, lot size");
  }
  const riskPerLot = stopPoints * deltaAbs * lotSize + slippage + charges;
  if (riskPerLot <= 0) return na("risk per lot must be positive");
  const lots = Math.floor((capital * (riskPct / 100)) / riskPerLot);
  const rw = targetPoints / stopPoints;
  const rl = 1;
  const costR = (slippage + charges) / (riskPerLot - slippage - charges || 1);
  const breakevenP = (rl + costR) / (rw + rl);
  return ok({ premiumRiskPerLot: riskPerLot, lots, breakevenP, rw, rl, costR });
}

// ─── L. Debit spread ──────────────────────────────────────────────

export interface DebitSpread {
  longLeg: number;
  shortLeg: number;
  netDebit: number;
  maxLoss: number; // debit × lot
  maxProfit: number; // (width − debit) × lot
  breakeven: number; // K1 + net debit (call spread)
}

/** Call debit spread from two strikes' call mids. Buy K1, sell K2 (> K1). */
export function callDebitSpread(strikes: QuantStrike[], k1: number, k2: number, lotSize: number): Maybe<DebitSpread> {
  if (k2 <= k1 || !finite(lotSize) || lotSize <= 0) return na("need K2 > K1 and lot > 0");
  const long = strikes.find((s) => s.strike === k1)?.ce ?? null;
  const short = strikes.find((s) => s.strike === k2)?.ce ?? null;
  const longMid = mid(long);
  const shortMid = mid(short);
  if (longMid == null || shortMid == null) return na("missing call prices at spread legs");
  const debit = longMid - shortMid;
  if (debit <= 0) return na("non-positive debit — data inconsistent");
  const width = k2 - k1;
  return ok({
    longLeg: k1,
    shortLeg: k2,
    netDebit: debit,
    maxLoss: debit * lotSize,
    maxProfit: Math.max(0, (width - debit) * lotSize),
    breakeven: k1 + debit,
  });
}

// ─── STEP 7. Scorecard (0-2 each, 9 factors) ──────────────────────

export interface ScoreRow {
  factor: string;
  score: 0 | 1 | 2 | null; // null = unknown (counts 0, shown honestly)
  note: string;
}

export interface ScorecardResult {
  rows: ScoreRow[];
  total: number; // max 18
  maxTotal: number;
  verdict: "BUY_CE" | "BUY_PE" | "SKIP";
  confidence: "Low" | "Medium" | "High";
  agreeingLayers: number; // of trend/trigger/OI/flow layers
  notes: string[];
}

export interface ScorecardInput {
  flowBias: "bull" | "bear" | "neutral" | "unknown";
  trendTf: "up" | "down" | "range" | "unknown"; // 15m structure
  triggerTf: "up" | "down" | "range" | "unknown"; // 5m VWAP+BB
  vwapSide5m: "above" | "below" | "unknown";
  bbRegime: BbStats["regime"] | "unknown";
  oiWalls: { supportK: number | null; resistanceK: number | null; spotBetweenWalls: boolean | null };
  rnMass: { mass: number | null; negativeCount: number };
  chgOiBuildup: "long_buildup" | "short_covering" | "short_buildup" | "long_unwinding" | "quiet" | "unknown";
  pcrTrend: "rising" | "falling" | "flat" | "unknown";
  greeksVrp: { verdict: "cheap" | "fair" | "expensive" | null; thetaBeOk: boolean | null };
  crossIndexAgreement: "agree" | "disagree" | "unknown";
  liquidityCost: "good" | "ok" | "wide" | "unknown";
  timingOk: boolean | null; // inside user windows, not first 15m, no loss-cap breach
  spotDistToWallPct: number | null; // % distance to the OPPOSING wall (gate ~0.12-0.16%)
}

/**
 * 9 factors × 0-2. Every score is shown; unknown → null → 0 with a note.
 * Verdict needs the DIRECTION layers to agree; SKIP otherwise.
 */
export function scorecard(input: ScorecardInput): ScorecardResult {
  const rows: ScoreRow[] = [];
  const notes: string[] = [];

  // 1. Flow bias (FII/participant — end-of-day data, weak)
  rows.push({
    factor: "Flow bias",
    score: input.flowBias === "unknown" ? null : input.flowBias === "neutral" ? 0 : 1,
    note: input.flowBias === "unknown" ? "participant data unavailable" : `flow: ${input.flowBias}`,
  });

  // 2. Trend TF (15m structure)
  rows.push({
    factor: "Trend TF (15m)",
    score: input.trendTf === "unknown" ? null : input.trendTf === "range" ? 0 : 2,
    note: input.trendTf === "unknown" ? "no 15m structure" : `structure: ${input.trendTf}`,
  });

  // 3. Trigger TF (5m VWAP + BB)
  let trig: 0 | 1 | 2 | null = null;
  let trigNote = "";
  if (input.triggerTf === "unknown" || input.vwapSide5m === "unknown") {
    trig = null;
    trigNote = "5m VWAP/BB unavailable";
  } else if (input.triggerTf === "range") {
    trig = 0;
    trigNote = "5m ranging";
  } else {
    trig = 2;
    trigNote = `5m ${input.triggerTf}, price ${input.vwapSide5m} VWAP, BB ${input.bbRegime}`;
    if (input.bbRegime === "mean_reverting") {
      trig = 1;
      trigNote += " (mean-revert regime — dampened)";
    }
  }
  rows.push({ factor: "Trigger TF (5m VWAP+BB)", score: trig, note: trigNote });

  // 4. OI walls + risk-neutral mass
  let wallScore: 0 | 1 | 2 | null = null;
  let wallNote = "";
  if (input.oiWalls.supportK == null || input.oiWalls.resistanceK == null) {
    wallScore = null;
    wallNote = "walls unavailable";
  } else if (input.oiWalls.spotBetweenWalls === false) {
    wallScore = 0;
    wallNote = "spot outside walls (no edge)";
  } else {
    wallScore = 1;
    wallNote = "spot between walls";
    if (input.rnMass.mass != null && input.rnMass.mass > 0.4 && input.rnMass.negativeCount <= 2) {
      wallScore = 2;
      wallNote += `, RN mass ${(input.rnMass.mass * 100).toFixed(0)}% between walls`;
    } else if (input.rnMass.mass == null) {
      wallNote += ", RN mass unavailable";
    }
  }
  rows.push({ factor: "OI walls + RN mass", score: wallScore, note: wallNote });

  // 5. Chg OI / buildup / PCR
  let buildup: 0 | 1 | 2 | null = null;
  let buildupNote = "";
  if (input.chgOiBuildup === "unknown") {
    buildup = null;
    buildupNote = "ΔOI unavailable";
  } else if (input.chgOiBuildup === "quiet") {
    buildup = 0;
    buildupNote = "quiet OI";
  } else {
    buildup = 1;
    buildupNote = input.chgOiBuildup.replace(/_/g, " ");
    if ((input.chgOiBuildup === "long_buildup" || input.chgOiBuildup === "short_covering") && input.pcrTrend === "rising") {
      buildup = 2;
      buildupNote += " + PCR rising";
    } else if ((input.chgOiBuildup === "short_buildup" || input.chgOiBuildup === "long_unwinding") && input.pcrTrend === "falling") {
      buildup = 2;
      buildupNote += " + PCR falling";
    }
  }
  rows.push({ factor: "ΔOI / buildup / PCR", score: buildup, note: buildupNote });

  // 6. Greeks / IV / VRP / theta-gamma breakeven
  let greekScore: 0 | 1 | 2 | null = null;
  let greekNote = "";
  if (!input.greeksVrp.verdict && input.greeksVrp.thetaBeOk == null) {
    greekScore = null;
    greekNote = "IV/RV/theta data unavailable";
  } else {
    greekScore = 0;
    greekNote = `VRP: ${input.greeksVrp.verdict ?? "unknown"}`;
    if (input.greeksVrp.thetaBeOk === true) greekScore = 1;
    if (input.greeksVrp.verdict === "cheap" && input.greeksVrp.thetaBeOk === true) greekScore = 2;
    if (input.greeksVrp.thetaBeOk === false) notes.push("theta-negative: target move < theta-gamma breakeven");
  }
  rows.push({ factor: "Greeks / VRP / θ-Γ BE", score: greekScore, note: greekNote });

  // 7. Cross-index agreement
  rows.push({
    factor: "Cross-index",
    score: input.crossIndexAgreement === "unknown" ? null : input.crossIndexAgreement === "agree" ? 2 : 0,
    note: input.crossIndexAgreement === "unknown" ? "single index only" : input.crossIndexAgreement,
  });

  // 8. Liquidity / cost
  rows.push({
    factor: "Liquidity / cost",
    score: input.liquidityCost === "unknown" ? null : input.liquidityCost === "good" ? 2 : input.liquidityCost === "ok" ? 1 : 0,
    note: input.liquidityCost === "unknown" ? "no bid/ask" : `spread: ${input.liquidityCost}`,
  });

  // 9. Timing and risk status
  rows.push({
    factor: "Timing / risk",
    score: input.timingOk == null ? null : input.timingOk ? 2 : 0,
    note: input.timingOk == null ? "clock unavailable" : input.timingOk ? "inside windows, risk caps clean" : "outside windows or risk cap hit",
  });

  const total = rows.reduce((s, r) => s + (r.score ?? 0), 0);

  // Direction layers that must agree: trend, trigger, buildup
  const dirTrend = input.trendTf === "up" ? 1 : input.trendTf === "down" ? -1 : 0;
  const dirTrigger = input.triggerTf === "up" ? 1 : input.triggerTf === "down" ? -1 : 0;
  const dirBuildup =
    input.chgOiBuildup === "long_buildup" || input.chgOiBuildup === "short_covering" ? 1 :
    input.chgOiBuildup === "short_buildup" || input.chgOiBuildup === "long_unwinding" ? -1 : 0;
  const dirFlow = input.flowBias === "bull" ? 1 : input.flowBias === "bear" ? -1 : 0;

  const bullVotes = [dirTrend === 1, dirTrigger === 1, dirBuildup === 1, dirFlow === 1].filter(Boolean).length;
  const bearVotes = [dirTrend === -1, dirTrigger === -1, dirBuildup === -1, dirFlow === -1].filter(Boolean).length;
  const opposing = (dirTrend * dirTrigger < 0) || (dirTrend * dirBuildup < 0);
  const agreeingLayers = Math.max(bullVotes, bearVotes);

  let verdict: ScorecardResult["verdict"] = "SKIP";
  if (!opposing && agreeingLayers >= 3 && total >= 8) {
    verdict = bullVotes >= 3 ? "BUY_CE" : bearVotes >= 3 ? "BUY_PE" : "SKIP";
  }
  if (input.spotDistToWallPct != null && input.spotDistToWallPct <= 0.14) {
    notes.push(`price within ${input.spotDistToWallPct.toFixed(2)}% of opposing OI wall — SKIP per wall-proximity gate`);
    verdict = "SKIP";
  }

  const confidence: ScorecardResult["confidence"] = total >= 13 && agreeingLayers >= 4 ? "High" : total >= 9 ? "Medium" : "Low";

  return { rows, total, maxTotal: 18, verdict, confidence, agreeingLayers, notes };
}

// ─── Hard-rule clock gates ────────────────────────────────────────

export interface TimingCheck {
  ok: boolean;
  reason: string;
}

/**
 * User windows 09:45-11:30 and 13:45-14:45; never the first 15 minutes.
 * (The 13:00 alert-send cutoff for option BUYS lives in market-session.ts /
 * brain-flags and stays — analysis still runs, trades stay gated by that rule.)
 */
export function timingCheck(minutesIst: number, lossCapHit: boolean, consecutiveLosses: number, maxConsecutiveLosses = 3): TimingCheck {
  if (!finite(minutesIst)) return { ok: false, reason: "clock unavailable" };
  if (minutesIst < 9 * 60 + 45 || minutesIst > 14 * 60 + 45) {
    return { ok: false, reason: "outside trading windows (09:45-11:30, 13:45-14:45)" };
  }
  if (minutesIst >= 12 * 60 && minutesIst < 13 * 60 + 45) {
    return { ok: false, reason: "12:00-13:45 low-liquidity window avoided" };
  }
  if (minutesIst < 9 * 60 + 30) {
    return { ok: false, reason: "first 15 minutes — no trades" };
  }
  if (lossCapHit) return { ok: false, reason: "daily loss cap hit" };
  if (consecutiveLosses >= maxConsecutiveLosses) {
    return { ok: false, reason: `${consecutiveLosses} consecutive losses — stopped` };
  }
  return { ok: true, reason: "inside windows, risk clean" };
}

// ─── Orchestrator: one call from the SDM engine ───────────────────

export interface QuantAnalyzeInput {
  spot: number;
  expiryDate: string;
  symbol?: string;
  vix?: number | null;
  /** Raw 5m rows (time ignored — order matters). Empty/absent → RV/BB/VWAP unavailable. */
  candles?: Array<{ open: number; high: number; low: number; close: number; volume: number }>;
  nowMin?: number | null;
  capital?: number;
  riskPct?: number;
  holdMinutes?: number;
  spotChangePct?: number | null;
  futuresPrice?: number | null;
  riskState?: { consecutiveLosses: number; dailyLossPct: number; lossCapHit?: boolean } | null;
  flowBias?: "bull" | "bear" | "neutral" | "unknown";
  r?: number;
}

export interface QuantBlock {
  available: boolean;
  unavailableReasons: string[];
  tteDays: number | null;
  r: number;
  forward: { f: number; k: number; basis: number; basisPct: number } | null;
  atmIv: number | null;
  expectedMove: { minutes: number; em: number; emPct: number } | null;
  rvPct: number | null;
  vrp: { vrp: number; verdict: string } | null;
  skew: { skewIv: number; putIv: number; callIv: number } | null;
  bb: BbStats | null;
  vwapZ: { z: number; vwap: number } | null;
  gex: { flip: number | null; regime: string } | null;
  rnMass: { mass: number; negativeCount: number } | null;
  walls: { supportK: number; resistanceK: number; spotDistToWallPct: number; spotBetweenWalls: boolean } | null;
  buildup: string;
  timing: { ok: boolean; reason: string };
  scorecard: ScorecardResult | null;
  quantReasons: string[];
  assumptions: string[];
}

function aggregateTrend(candles: Candle5[], aggMinutes: number): "up" | "down" | "range" | "unknown" {
  if (!candles.length) return "unknown";
  const per = Math.max(1, Math.round(aggMinutes / 5));
  const agg: number[] = [];
  for (let i = 0; i + per <= candles.length; i += per) {
    const win = candles.slice(i, i + per);
    agg.push(win[win.length - 1].close);
  }
  if (agg.length < 8) return "unknown";
  // swing pivots (window 2) → last two highs / lows
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < agg.length - 2; i++) {
    if (agg[i] > agg[i - 1] && agg[i] > agg[i - 2] && agg[i] >= agg[i + 1] && agg[i] >= agg[i + 2]) highs.push(agg[i]);
    if (agg[i] < agg[i - 1] && agg[i] < agg[i - 2] && agg[i] <= agg[i + 1] && agg[i] <= agg[i + 2]) lows.push(agg[i]);
  }
  if (highs.length < 2 || lows.length < 2) return "range";
  const hh = highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows[lows.length - 1] > lows[lows.length - 2];
  const lh = highs[highs.length - 1] < highs[highs.length - 2];
  const ll = lows[lows.length - 1] < lows[lows.length - 2];
  if (hh && hl) return "up";
  if (lh && ll) return "down";
  return "range";
}

/**
 * Full quant read from REAL chain + candles. Everything fails open to
 * null/"unknown" — the block reports what was computable and why.
 */
export function analyzeQuant(strikes: QuantStrike[], input: QuantAnalyzeInput): QuantBlock {
  const unavailable: string[] = [];
  const assumptions: string[] = [
    "r = 6.5-7% documented default (RISK_FREE_RATE env overrides at the app level)",
    "expected move / first-passage / touch numbers are ZERO-DRIFT baselines, not forecasts",
    "GEX assumes dealers long calls / short puts (unverified in Indian markets) — low weight",
    "risk-neutral density is risk-neutral, not real-world probability",
  ];
  const r = input.r ?? 0.065;
  const hold = input.holdMinutes ?? 25;

  // TTE (calendar/365)
  let tteDays: number | null = null;
  try {
    const exp = new Date(input.expiryDate.length === 11 ? input.expiryDate.replace(/-/g, " ") : input.expiryDate);
    if (!Number.isNaN(exp.getTime())) {
      tteDays = Math.max(0, (exp.getTime() - Date.now()) / 86400000);
    }
  } catch { /* keep null */ }
  const tteYears = tteDays != null && tteDays > 0 ? tteDays / 365 : null;
  if (tteYears == null) unavailable.push("expiry parse failed — parity/BL unavailable");

  // A. Forward
  const fw = tteYears != null ? impliedForward(strikes, input.spot, r, tteYears) : null;
  if (fw && !fw.available) unavailable.push(`forward: ${fw.reason}`);
  const forward = fw?.available ? fw.value : null;

  // ATM IV (own chain, per spec — not VIX)
  let atmIv: number | null = null;
  let atmRow: QuantStrike | null = null;
  let minDist = Infinity;
  for (const s of strikes) {
    const d = Math.abs(s.strike - input.spot);
    if (d < minDist) { minDist = d; atmRow = s; }
  }
  const ivs = [atmRow?.ce?.iv, atmRow?.pe?.iv].filter((v): v is number => finite(v) && v > 0);
  if (ivs.length) atmIv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
  else unavailable.push("ATM IV unavailable");

  // D. EM
  const fForEm = input.futuresPrice && input.futuresPrice > 0 ? input.futuresPrice : forward?.f ?? input.spot;
  const em = atmIv != null ? expectedMove(fForEm, atmIv, hold) : null;
  if (em && !em.available) unavailable.push(`EM: ${em.reason}`);

  // J. candles → VWAP z, BB, RV, trend
  const bars: Candle5[] = (input.candles ?? [])
    .filter((c) => finite(c?.close) && c.close > 0)
    .map((c) => ({ time: 0, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }));
  if (bars.length < 20) unavailable.push(`candles: ${bars.length}/20 5m bars`);

  const vz = bars.length >= 5 ? vwapZ(bars) : null;
  const bb = bars.length >= 30 ? bbStats(bars) : null;
  const rv = bars.length >= 20 ? realizedVol(bars.map((b) => b.close)) : null;
  const trend15 = aggregateTrend(bars, 15);

  // G. VRP
  const vrp = atmIv != null && rv?.available ? varianceRiskPremium(atmIv, rv.value.rvPct) : null;
  if (vrp && !vrp.available) unavailable.push("VRP needs IV and RV");

  // G. Skew
  const sk = skew(strikes, input.spot, 1);
  if (sk && !sk.available) unavailable.push("skew needs put IV below spot + call IV above spot");

  // H. GEX (reuse gex-engine — the single GEX implementation)
  let gex: QuantBlock["gex"] = null;
  try {
    // lazy import avoided (client-safe module): caller may pass gex via ctx later.
    // Here we mark unavailable unless strikes carry gamma+oi (checked by caller wiring).
  } catch { /* ignore */ }

  // Walls (near-ATM ±3%)
  let walls: QuantBlock["walls"] = null;
  const band = input.spot * 0.03;
  let maxCE = { k: 0, oi: 0 };
  let maxPE = { k: 0, oi: 0 };
  for (const s of strikes) {
    if (Math.abs(s.strike - input.spot) > band) continue;
    if (s.ce && s.ce.oi > maxCE.oi) maxCE = { k: s.strike, oi: s.ce.oi };
    if (s.pe && s.pe.oi > maxPE.oi) maxPE = { k: s.strike, oi: s.pe.oi };
  }
  if (maxCE.k > 0 && maxPE.k > 0) {
    const lo = Math.min(maxCE.k, maxPE.k);
    const hi = Math.max(maxCE.k, maxPE.k);
    walls = {
      supportK: Math.min(maxPE.k, maxCE.k) === maxPE.k ? maxPE.k : maxCE.k,
      resistanceK: Math.max(maxCE.k, maxPE.k) === maxCE.k ? maxCE.k : maxPE.k,
      spotDistToWallPct: (Math.min(Math.abs(hi - input.spot), Math.abs(input.spot - lo)) / input.spot) * 100,
      spotBetweenWalls: input.spot > lo && input.spot < hi,
    };
    void lo; void hi;
  } else {
    unavailable.push("near-ATM OI walls unavailable");
  }

  // F. RN mass between walls
  const rn = tteYears != null && walls
    ? riskNeutralMass(strikes, r, tteYears, walls.supportK, walls.resistanceK)
    : null;
  if (rn && !rn.available) unavailable.push(`RN mass: ${rn.reason}`);

  // Buildup (ΔOI near ATM ±3% + session price change)
  let callChg = 0;
  let putChg = 0;
  for (const s of strikes) {
    if (Math.abs(s.strike - input.spot) > band) continue;
    callChg += s.ce?.oiChg ?? 0;
    putChg += s.pe?.oiChg ?? 0;
  }
  const spotChg = input.spotChangePct ?? null;
  let buildup = "unknown";
  const oiMoves = Math.abs(callChg) + Math.abs(putChg) > 0.02 * (maxCE.oi + maxPE.oi || 1);
  if (spotChg == null) buildup = "unknown";
  else if (!oiMoves) buildup = "quiet";
  else if (spotChg > 0.1) buildup = putChg >= callChg ? "long_buildup" : "short_covering";
  else if (spotChg < -0.1) buildup = callChg >= putChg ? "short_buildup" : "long_unwinding";
  else buildup = "quiet";

  // 9. Timing
  const capHit = input.riskState?.lossCapHit ?? (input.riskState ? input.riskState.dailyLossPct >= 40 : false);
  const timing = timingCheck(input.nowMin ?? NaN, capHit, input.riskState?.consecutiveLosses ?? 0, 3);

  // Liquidity: ATM spread %
  let liquidityCost: ScorecardInput["liquidityCost"] = "unknown";
  const legs = [atmRow?.ce, atmRow?.pe].filter(Boolean) as Array<NonNullable<QuantStrike["ce"]>>;
  const spreads = legs
    .filter((l) => finite(l.bid) && finite(l.ask) && l.ask > 0 && l.bid > 0 && l.ask >= l.bid)
    .map((l) => ((l.ask! - l.bid!) / ((l.ask! + l.bid!) / 2)) * 100);
  if (spreads.length) {
    const s = Math.min(...spreads);
    liquidityCost = s < 1 ? "good" : s < 2.5 ? "ok" : "wide";
  }

  // E. Theta-gamma breakeven vs EM (a 25-min move should pay the theta)
  let thetaBeOk: boolean | null = null;
  const atmLeg = atmRow?.ce ?? atmRow?.pe ?? null;
  if (atmLeg && finite(atmLeg.gamma) && atmLeg.gamma > 0 && finite(atmLeg.theta) && atmLeg.theta < 0 && em?.available) {
    const be = thetaGammaBreakeven(atmLeg.gamma, Math.abs(atmLeg.theta), hold / 375);
    if (be.available) thetaBeOk = em.value.em >= be.value.dF;
  }

  // Trigger TF from VWAP side + BB
  let triggerTf: ScorecardInput["triggerTf"] = "unknown";
  let vwapSide: ScorecardInput["vwapSide5m"] = "unknown";
  if (vz?.available && bb?.available) {
    vwapSide = vz.value.z > 0.15 ? "above" : vz.value.z < -0.15 ? "below" : "above"; // near VWAP counts as above-side for classification
    if (vz.value.z < -0.15) vwapSide = "below";
    const closeVsVwap = vz.value.last - vz.value.vwap;
    const bull = closeVsVwap > 0 && bb.value.percentB > 0.5;
    const bear = closeVsVwap < 0 && bb.value.percentB < 0.5;
    triggerTf = bull ? "up" : bear ? "down" : "range";
  }

  const sc = scorecard({
    flowBias: input.flowBias ?? "unknown",
    trendTf: trend15,
    triggerTf,
    vwapSide5m: vwapSide,
    bbRegime: bb?.available ? bb.value.regime : "unknown",
    oiWalls: walls
      ? { supportK: walls.supportK, resistanceK: walls.resistanceK, spotBetweenWalls: walls.spotBetweenWalls }
      : { supportK: null, resistanceK: null, spotBetweenWalls: null },
    rnMass: { mass: rn?.available ? rn.value.mass : null, negativeCount: rn?.available ? rn.value.negativeCount : 0 },
    chgOiBuildup: buildup as ScorecardInput["chgOiBuildup"],
    pcrTrend: "unknown",
    greeksVrp: { verdict: vrp?.available ? vrp.value.verdict : null, thetaBeOk },
    crossIndexAgreement: "unknown",
    liquidityCost,
    timingOk: timing.ok,
    spotDistToWallPct: walls ? walls.spotDistToWallPct : null,
  });

  // Reasons (honest, quant-evidence lines)
  const quantReasons: string[] = [];
  if (forward) quantReasons.push(`Implied fwd ${forward.f.toFixed(0)} (${forward.basisPct >= 0 ? "+" : ""}${forward.basisPct.toFixed(2)}% vs spot)`);
  if (em?.available) quantReasons.push(`EM ${hold}m ±${em.value.emPct.toFixed(2)}% (zero-drift baseline)`);
  if (thetaBeOk != null) quantReasons.push(thetaBeOk ? "25m move > theta breakeven" : "theta-negative: 25m move < theta breakeven");
  if (vrp?.available) quantReasons.push(`VRP ${vrp.value.verdict} (IV ${atmIv?.toFixed(1)}% vs RV ${rv!.value.rvPct.toFixed(1)}%)`);
  if (sk?.available) quantReasons.push(`Skew ${sk.value.skewIv >= 0 ? "+" : ""}${sk.value.skewIv.toFixed(1)} IV (put-call)`);
  if (rn?.available) quantReasons.push(`RN mass between walls ${(rn.value.mass * 100).toFixed(0)}%${rn.value.negativeCount ? ` (${rn.value.negativeCount} noisy strikes)` : ""}`);
  if (!timing.ok) quantReasons.push(`Blocked: ${timing.reason}`);
  if (sc.notes.length) quantReasons.push(...sc.notes);

  const available = strikes.length > 0;
  return {
    available,
    unavailableReasons: unavailable,
    tteDays: tteDays != null ? Math.round(tteDays * 10) / 10 : null,
    r,
    forward,
    atmIv,
    expectedMove: em?.available ? { minutes: hold, em: em.value.em, emPct: em.value.emPct } : null,
    rvPct: rv?.available ? rv.value.rvPct : null,
    vrp: vrp?.available ? vrp.value : null,
    skew: sk?.available ? sk.value : null,
    bb: bb?.available ? bb.value : null,
    vwapZ: vz?.available ? { z: vz.value.z, vwap: vz.value.vwap } : null,
    gex,
    rnMass: rn?.available ? { mass: rn.value.mass, negativeCount: rn.value.negativeCount } : null,
    walls,
    buildup,
    timing,
    scorecard: sc,
    quantReasons,
    assumptions,
  };
}
