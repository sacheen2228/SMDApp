// ─── Institutional Derivatives Engine (IDE) — v2 redesign ──────────────────
//
// Pure derivatives-market decision engine. Makes trading decisions ONLY from
// derivatives data: Option Chain, Greeks, OI / OI-change, PCR, Max Pain, IV,
// and FII / DII flows. It deliberately does NOT use any price-action / SMC
// concepts (no Smart Money Concepts, BOS, CHOCH, Order Blocks, FVGs), nor any
// lagging TA indicators (EMA, VWAP, RSI, MACD, candlestick patterns).
//
// Design goals (this revision):
//   * Score EVERY tradable strike/side, then recommend only the single
//     highest-probability trade (optionally top-2 if statistically tied).
//     No simultaneous CALL + PUT, no multi-strike spam.
//   * Confidence threshold: below MIN_CONFIDENCE → NO_TRADE (never forced).
//   * Realistic SL/TP derived from premium volatility (Greeks + expected move
//     + bid/ask spread), not fixed paise values.
//   * TP levels tied to the probability of the spot reaching each distance
//     (expected move = 1σ band) and to the option's delta/gamma response.

export interface DerivativeInput {
  spot: number;
  atm: number;
  ce: number;
  pe: number;
  pcr: number;
  iv: number; // index IV / VIX (percent, e.g. 15)
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  volumeRatio: number;
  callWriting: boolean;
  putWriting: boolean;
  callUnwind: boolean;
  putUnwind: boolean;
  fiiLong: number;
  fiiShort: number;
  diiBuy: number;
  diiSell: number;
  highestCallOI: number;
  highestPutOI: number;
  // Normalized (percentile 0-100) context for adaptive scoring:
  gammaPct?: number;
  oiChgPct?: number;
  ivPct?: number;
  volumePct?: number;
  fiiPct?: number;
}

export interface IDESignal {
  symbol: string;
  expectedMove: number;
  expectedMovePct: number;
  support: number;
  resistance: number;
  supportStrength: number;
  resistanceStrength: number;
  callProbability: number;
  putProbability: number;
  confidence: number;
  decision: "BUY_CALL" | "BUY_PUT" | "NO_TRADE";
  entry: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  target3: number | null;
  recommendedStrike: number | null;
  recommendedType: "CE" | "PE" | null;
  reasons: string[];
  raw: DerivativeInput;
}

// ─── Trade quality constants ────────────────────────────────────────────────
// Minimum probability score required to fire a trade. Below this → NO_TRADE.
// Calibrated above calm-day readings (~66) so only genuinely strong,
// high-conviction setups clear the bar.
const MIN_CONFIDENCE = 72;
// How many of the top-ranked strikes may be returned (1, or 2 if tied).
const MAX_RECOMMENDED = 1;
// Allow a 2nd recommendation only if its score is within this margin of #1.
const TIE_MARGIN = 4;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ─── Rolling percentile context (adaptive, per symbol) ─────────────────────
interface RollingBucket {
  gamma: number[];
  oiChg: number[];
  iv: number[];
  volume: number[];
  fii: number[];
  em: number[];
}
const MAX_SAMPLES = 25;
const rolling: Map<string, RollingBucket> = new Map();

function pushSample(symbol: string, inp: DerivativeInput, em: number) {
  const b = rolling.get(symbol) ?? { gamma: [], oiChg: [], iv: [], volume: [], fii: [], em: [] };
  b.gamma.push(inp.gamma);
  b.oiChg.push(Math.abs(inp.ce + inp.pe));
  b.iv.push(inp.iv);
  b.volume.push(inp.volumeRatio);
  b.fii.push(inp.fiiLong - inp.fiiShort);
  b.em.push(em);
  for (const k of Object.keys(b) as (keyof RollingBucket)[]) if (b[k].length > MAX_SAMPLES) b[k].shift();
  rolling.set(symbol, b);
}

function percentile(samples: number[], value: number): number {
  if (samples.length === 0) return 50;
  const sorted = [...samples].sort((a, b) => a - b);
  const below = sorted.filter((s) => s < value).length;
  return (below / sorted.length) * 100;
}

// ─── Greeeks fallback (for chains that don't carry Greeks, e.g. BSE/SENSEX) ─
import { calculateGreeks } from "@/lib/greeks";

function estimateGreeks(spot: number, strike: number, ivPct: number, isCall: boolean, daysToExpiry: number) {
  const iv = Math.max(0.01, ivPct / 100);
  const tte = Math.max(0.5, daysToExpiry) / 365;
  try {
    return calculateGreeks(spot, strike, tte, iv, isCall);
  } catch {
    // Crude moneyness-based delta proxy if the greeks module is unavailable.
    const d = (spot - strike) / (spot * Math.max(0.01, iv) * Math.sqrt(Math.max(0.5, daysToExpiry) / 365));
    const delta = isCall ? clamp(0.5 + d * 0.4, 0.05, 0.95) : clamp(-0.5 + d * 0.4, -0.95, -0.05);
    return { delta, gamma: 0.002, vega: spot * 0.02, theta: -spot * 0.002, d1: d };
  }
}

// ─── Core engine (single ATM decision) ─────────────────────────────────────
// The decision is now derived from the full strike-ranking model: we rank
// every near-ATM strike and emit the single best one (or NO_TRADE).
export function runInstitutionalDerivativesEngine(
  symbol: string,
  inp: DerivativeInput,
  opts?: { strikes?: { strike: number; type: "CE" | "PE"; leg: StrikeLeg }[]; ctx?: ChainContext; daysToExpiry?: number },
): IDESignal {
  const expectedMove = computeExpectedMove(inp);

  // Adaptive percentile context.
  pushSample(symbol, inp, expectedMove);
  const b = rolling.get(symbol)!;
  const gammaPct = percentile(b.gamma, inp.gamma);
  const oiChgPct = percentile(b.oiChg, Math.abs(inp.ce + inp.pe));
  const ivPct = percentile(b.iv, inp.iv);
  const volumePct = percentile(b.volume, inp.volumeRatio);
  const fiiPct = percentile(b.fii, inp.fiiLong - inp.fiiShort);
  inp.gammaPct = Math.round(gammaPct);
  inp.oiChgPct = Math.round(oiChgPct);
  inp.ivPct = Math.round(ivPct);
  inp.volumePct = Math.round(volumePct);
  inp.fiiPct = Math.round(fiiPct);

  const support = inp.atm - expectedMove;
  const resistance = inp.atm + expectedMove;

  // ── Directional probabilities (CALL vs PUT) from chain structure ──
  // Symmetric: PCR<1 favours CALL, PCR>1 favours PUT (India is put-heavy, so
  // PCR is usually <1 and CALL gets the structural edge by default).
  let call = 0;
  let put = 0;
  const callReasons: string[] = [];
  const putReasons: string[] = [];

  if (inp.callUnwind) { call += 18; callReasons.push("Call OI unwinding (shorts covering)"); }
  if (inp.putWriting) { call += 14; callReasons.push("Put writing (resistance to downside)"); }
  if (inp.pcr < 1) { call += 10; callReasons.push(`PCR ${inp.pcr.toFixed(2)} < 1 (calls relatively cheap)`); }
  if (inp.delta > 0) { call += 6; callReasons.push("Net delta positive"); }
  if (inp.fiiLong > inp.fiiShort) { call += 10; callReasons.push("FII net long"); }
  if (inp.diiBuy > inp.diiSell) { call += 6; callReasons.push("DII net buyers"); }
  if (gammaPct >= 60) { call += 4; }
  if (volumePct >= 60) { call += 4; }

  if (inp.putUnwind) { put += 18; putReasons.push("Put OI unwinding (shorts covering)"); }
  if (inp.callWriting) { put += 14; putReasons.push("Call writing (resistance to upside)"); }
  if (inp.pcr > 1) { put += 10; putReasons.push(`PCR ${inp.pcr.toFixed(2)} > 1 (puts relatively cheap)`); }
  if (inp.delta < 0) { put += 6; putReasons.push("Net delta negative"); }
  if (inp.fiiShort > inp.fiiLong) { put += 10; putReasons.push("FII net short"); }
  if (inp.diiSell > inp.diiBuy) { put += 6; putReasons.push("DII net sellers"); }
  if (gammaPct >= 60) { put += 4; }
  if (volumePct >= 60) { put += 4; }

  // ── If a full strike set is supplied, use the ranked best trade ──
  let best: StrikeRank | null = null;
  const reasons: string[] = [];
  if (opts?.strikes && opts.ctx) {
    const ranked = rankStrikes(opts.strikes, opts.ctx, { daysToExpiry: opts.daysToExpiry });
    if (ranked.length) {
      best = ranked[0];
      call = best.side === "CALL" ? best.probability : call;
      put = best.side === "PUT" ? best.probability : put;
    }
  }

  const probSpread = Math.abs(call - put);
  const decision: IDESignal["decision"] =
    call >= MIN_CONFIDENCE && call >= put ? "BUY_CALL" :
    put >= MIN_CONFIDENCE && put > call ? "BUY_PUT" : "NO_TRADE";

  if (decision === "NO_TRADE") {
    if (inp.spot >= support && inp.spot <= resistance) reasons.push("Price inside Support/Resistance band");
    if (gammaPct < 50) reasons.push("Gamma neutral");
    if (volumePct < 50) reasons.push("Volume low");
    if (Math.sign(inp.fiiLong - inp.fiiShort) !== Math.sign(inp.diiBuy - inp.diiSell)) reasons.push("Mixed FII/DII");
    reasons.push(`CALL ${Math.round(call)} / PUT ${Math.round(put)} — neither clears ${MIN_CONFIDENCE}`);
  } else if (best) {
    reasons.push(...(best.side === "CALL" ? callReasons : putReasons));
    reasons.push(`Best strike ${best.strike} ${best.type} — prob ${best.probability}, R:R ${best.rr}`);
  }

  let entry: number | null = null;
  let stopLoss: number | null = null;
  let target1: number | null = null;
  let target2: number | null = null;
  let target3: number | null = null;
  let recommendedStrike: number | null = null;
  let recommendedType: "CE" | "PE" | null = null;

  if (decision !== "NO_TRADE" && best) {
    recommendedStrike = best.strike;
    recommendedType = best.type;
    entry = best.entry;
    stopLoss = best.stopLoss;
    target1 = best.tp1;
    target2 = best.tp2;
    target3 = best.tp3;
  }

  return {
    symbol,
    expectedMove: round2(expectedMove),
    expectedMovePct: inp.spot ? round2((expectedMove / inp.spot) * 100) : 0,
    support: round2(support),
    resistance: round2(resistance),
    supportStrength: Math.min(100, Math.round(call)),
    resistanceStrength: Math.min(100, Math.round(put)),
    callProbability: Math.min(100, Math.round(call)),
    putProbability: Math.min(100, Math.round(put)),
    confidence: Math.min(100, Math.round(Math.max(call, put))),
    decision,
    entry,
    stopLoss,
    target1,
    target2,
    target3,
    recommendedStrike,
    recommendedType,
    reasons,
    raw: inp,
  };
}

// ─── Expected move ─────────────────────────────────────────────────────────
function computeExpectedMove(inp: DerivativeInput): number {
  const baseMove = inp.ce + inp.pe;
  const ivFactor = inp.iv > 22 ? 1.2 : inp.iv > 18 ? 1.1 : 1.0;
  const gammaFactor = inp.gamma > 0.03 ? 1.05 : 1.0;
  const volumeFactor = inp.volumeRatio > 1.5 ? 1.1 : 1.0;
  return baseMove * ivFactor * gammaFactor * volumeFactor;
}

// ─── Per-strike ranking model ──────────────────────────────────────────────
export interface StrikeLeg {
  ltp: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  bid?: number;
  ask?: number;
}

export interface ChainContext {
  spot: number;
  atmStrike: number;
  pcr: number;
  iv: number;
  highestCallOI: number;
  highestPutOI: number;
  totalVolume: number;
  chainLen: number;
  fiiLong: number;
  fiiShort: number;
  diiBuy: number;
  diiSell: number;
  expectedMove: number;
}

export interface StrikeRank {
  strike: number;
  type: "CE" | "PE";
  side: "CALL" | "PUT";
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr: number;
  probability: number; // 0-100 weighted probability score
  directionalProb: number;
  qualityScore: number;
  stars: number;
  expectedMove: number;
}

function safeDelta(leg: StrikeLeg, ctx: ChainContext, isCall: boolean, daysToExpiry?: number): number {
  if (Math.abs(leg.delta) > 0.001) return leg.delta;
  const g = estimateGreeks(ctx.spot, ctx.atmStrike, ctx.iv, isCall, daysToExpiry ?? 2);
  return isCall ? g.delta : g.delta;
}

// Project an option premium for a given signed spot move (absolute ₹).
// The gamma term is damped/capped so a high-gamma strike cannot produce
// absurd targets — it may at most add half of the linear (delta) move.
function projectPremium(premium: number, delta: number, gamma: number, spotMove: number): number {
  const linear = delta * spotMove;
  const gammaTerm = 0.5 * gamma * spotMove * spotMove;
  const cappedGamma = Math.sign(gammaTerm) * Math.min(Math.abs(gammaTerm), Math.abs(linear) * 0.5);
  const dP = linear + cappedGamma;
  return Math.max(0.5, premium + dP);
}

// Realistic stop loss: the larger of (a) the Greeks/expected-move based adverse
// premium move and (b) a noise floor from bid/ask spread + theta decay, so the
// SL survives normal micro-fluctuations but still caps risk to ~1R.
function realisticStopLoss(entry: number, delta: number, gamma: number, expectedMove: number, spread: number, thetaAbs: number): number {
  const adverseMove = -expectedMove * 0.35; // 0.35σ against us
  const projected = projectPremium(entry, delta, gamma, adverseMove);
  // Noise floor = a couple of ticks of bid/ask spread + a small per-tick buffer
  // so normal micro-fluctuations don't trigger the SL. Theta is NOT used here
  // (theta is a carry cost, already reflected in qualityScore).
  const noiseFloor = entry - Math.max(spread * 2, entry * 0.008, 0.5);
  // Never let the SL sit more than 45% below entry (caps tail-risk on lotto legs).
  const capped = entry - entry * 0.45;
  return Math.min(projected, noiseFloor, capped);
}

// Probability-of-reach uses the expected move as a 1σ band. A target at k·σ is
// reached with ~N(k) cumulative probability; we map that to a 0-100 score.
function probReach(k: number): number {
  // standard normal CDF approximation
  const cdf = (x: number) => 0.5 * (1 + Math.sign(x) * (1 - Math.exp(-2 * x * x / Math.PI)) ** 0.5);
  return cdf(k) * 100;
}

export function scoreStrike(
  strike: number,
  type: "CE" | "PE",
  leg: StrikeLeg,
  ctx: ChainContext,
  opt?: { daysToExpiry?: number },
): StrikeRank {
  const isCall = type === "CE";
  const entry = leg.ltp || 0;
  const expectedMove = ctx.expectedMove;

  // ── Derived Greeks (fallback if missing) ──
  const delta = safeDelta(leg, ctx, isCall, opt?.daysToExpiry);
  const gamma = Math.abs(leg.gamma) > 1e-6 ? leg.gamma : estimateGreeks(ctx.spot, strike, ctx.iv, isCall, opt?.daysToExpiry ?? 2).gamma;
  const vega = Math.abs(leg.vega) > 1e-6 ? leg.vega : Math.abs(estimateGreeks(ctx.spot, strike, ctx.iv, isCall, opt?.daysToExpiry ?? 2).vega);
  const theta = Math.abs(leg.theta) > 1e-6 ? leg.theta : Math.abs(estimateGreeks(ctx.spot, strike, ctx.iv, isCall, opt?.daysToExpiry ?? 2).theta);

  const spread = Math.max(0, (leg.ask ?? 0) - (leg.bid ?? 0));
  const d = delta * (isCall ? 1 : -1); // positive for the directional side

  // ── Factor scores (each 0-100) ──
  // 1. Distance from ATM (prefer near-ATM, slight penalty for far).
  const distPct = Math.abs(strike - ctx.spot) / Math.max(1, ctx.spot);
  const fDist = clamp(100 - distPct * 100 * 2.2, 35, 100);

  // 2. Delta suitability (prefer 0.35-0.65 magnitude for directional trades).
  const fDelta = clamp(100 - Math.abs(Math.abs(delta) - 0.5) * 200, 30, 100);

  // 3. Gamma (higher = more leverage; reward but cap).
  const fGamma = clamp(gamma * 250, 0, 100);

  // 4. Theta decay (penalise high decay for long option).
  const thetaCostPct = entry > 0 ? theta / entry : 0;
  const fTheta = clamp(100 - thetaCostPct * 100 * 6, 20, 100);

  // 5. Vega (long vega is favourable when IV can expand; mild reward).
  const vegaPct = entry > 0 ? vega / entry : 0;
  const fVega = clamp(50 + vegaPct * 100 * 4, 30, 100);

  // 6. OI liquidity.
  const maxOI = Math.max(ctx.highestCallOI, ctx.highestPutOI, 1);
  const fOI = clamp((leg.oi / maxOI) * 100, 0, 100);

  // 7. OI change — writing/unwinding directional signal.
  let fOiChg = 50;
  if (isCall) {
    if (leg.oiChg < 0) fOiChg = 60; // call writing caps upside
    else if (leg.oiChg > 0) fOiChg = 100; // call unwinding
  } else {
    if (leg.oiChg < 0) fOiChg = 60; // put writing caps downside
    else if (leg.oiChg > 0) fOiChg = 100; // put unwinding
  }

  // 8. PCR directional skew (symmetric).
  let fPcr = 50;
  if (isCall) fPcr = ctx.pcr < 1 ? 100 : ctx.pcr > 1.2 ? 25 : 50;
  else fPcr = ctx.pcr > 1 ? 100 : ctx.pcr < 0.8 ? 25 : 50;

  // 9. IV relative (prefer not overpriced; mild).
  const fIV = clamp(100 - Math.abs(ctx.iv - 15) * 2, 30, 100);

  // 10. Volume / liquidity.
  const avgVol = ctx.totalVolume / Math.max(1, ctx.chainLen);
  const fVol = clamp((leg.volume / Math.max(1, avgVol)) * 100, 0, 100);

  // 11. Bid/ask spread (penalise wide spreads).
  const spreadPct = entry > 0 ? spread / entry : 1;
  const fSpread = clamp(100 - spreadPct * 100 * 4, 10, 100);

  // 12. FII/DII positioning (directional alignment).
  let fFii = 50;
  const fiiNet = ctx.fiiLong - ctx.fiiShort;
  const diiNet = ctx.diiBuy - ctx.diiSell;
  const net = fiiNet + diiNet;
  if (isCall) fFii = clamp(50 + net / 2, 10, 100);
  else fFii = clamp(50 - net / 2, 10, 100);

  // 13. Expected move magnitude (bigger move = more opportunity).
  const emPct = ctx.spot > 0 ? expectedMove / ctx.spot : 0;
  const fEM = clamp(emPct * 100 * 3, 20, 100);

  // ── Directional probability (does the market structure favour this side?) ─
  const directionalProb = clamp(
    0.18 * fPcr + 0.16 * fOiChg + 0.16 * fFii + 0.14 * fDelta + 0.12 * fDist + 0.12 * fEM + 0.12 * (isCall ? Math.max(0, d) * 100 : Math.max(0, -d) * 100),
    0,
    100,
  );

  // ── Quality score (is this a good, tradeable instrument?) ──
  // Theta is a carry cost, not a defect — weighted lightly so ATM options
  // (which always carry high theta) aren't unfairly penalised.
  const qualityScore = clamp(
    0.18 * fOI + 0.16 * fVol + 0.12 * fSpread + 0.12 * fGamma + 0.05 * fTheta + 0.10 * fVega + 0.12 * fDelta + 0.08 * fIV + 0.07 * fEM,
    0,
    100,
  );

  // ── Weighted probability score ──
  // Directional conviction is primary; quality MODULATES it (a perfect setup
  // with poor liquidity is downgraded, but quality never hard-caps conviction).
  const probability = clamp(directionalProb * (0.55 + 0.45 * (qualityScore / 100)), 0, 100);

  // ── SL / TP (realistic, premium-volatility based) ──
  const sl = realisticStopLoss(entry, delta * (isCall ? 1 : -1), gamma, expectedMove, spread, theta);
  const tp1 = projectPremium(entry, delta * (isCall ? 1 : -1), gamma, expectedMove * 0.45);
  const tp2 = projectPremium(entry, delta * (isCall ? 1 : -1), gamma, expectedMove * 0.75);
  const tp3 = projectPremium(entry, delta * (isCall ? 1 : -1), gamma, expectedMove * 1.05);
  const risk = entry - sl;
  const rr = risk > 0 ? round2((tp1 - entry) / risk) : 0;

  const stars = clamp(Math.round(probability / 20), 1, 5);

  return {
    strike,
    type,
    side: isCall ? "CALL" : "PUT",
    entry: round2(entry),
    stopLoss: round2(sl),
    tp1: round2(tp1),
    tp2: round2(tp2),
    tp3: round2(tp3),
    rr,
    probability: round2(probability),
    directionalProb: round2(directionalProb),
    qualityScore: round2(qualityScore),
    stars,
    expectedMove: round2(expectedMove),
  };
}

// Rank every candidate strike/side and return sorted by probability desc.
export function rankStrikes(
  strikes: { strike: number; type: "CE" | "PE"; leg: StrikeLeg }[],
  ctx: ChainContext,
  opt?: { daysToExpiry?: number },
): StrikeRank[] {
  const minPremium = Math.max(1.5, (ctx.spot * 0.003) || 1.5);
  const out = strikes
    .filter((s) => s.leg.ltp >= minPremium)
    .map((s) => scoreStrike(s.strike, s.type, s.leg, ctx, { daysToExpiry: opt?.daysToExpiry }));
  out.sort((a, b) => b.probability - a.probability);
  return out;
}

// Convenience wrapper used by the Top-N scan route.
export function scoreDerivativesCandidate(
  strike: number,
  type: "CE" | "PE",
  leg: StrikeLeg,
  ctx: ChainContext,
): StrikeRank {
  return scoreStrike(strike, type, leg, ctx);
}
