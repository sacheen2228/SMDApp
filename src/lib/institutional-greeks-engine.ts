/**
 * Institutional Greeks + Option Chain Engine
 *
 * Evaluates every strike independently using ONLY option chain + Greeks data.
 * No EMA, RSI, MACD, VWAP, Supertrend, SMC, or candlestick patterns.
 *
 * Dynamic weighting adapts to market regime:
 * - Expiry day: Gamma weight increases (rapid sensitivity changes)
 * - Low-vol days: OI/OI Change weight increases (positioning matters more)
 * - High-IV days: Vega weight increases (volatility expansion/contraction)
 */

export interface OptionLeg {
  ltp: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bid: number;
  ask: number;
}

export interface StrikeData {
  strike: number;
  ce: OptionLeg | null;
  pe: OptionLeg | null;
}

export interface ChainSummary {
  spotPrice: number;
  indiaVIX: number | null;
  pcr: number;
  maxPain: number;
  atmStrike: number;
  selectedExpiry: string;
  totalCallOI: number;
  totalPutOI: number;
}

export interface StrikeScore {
  strike: number;
  type: "CE" | "PE";
  institutionalScore: number;
  gammaScore: number;
  deltaScore: number;
  thetaScore: number;
  vegaScore: number;
  oiScore: number;
  oiChangeScore: number;
  volumeScore: number;
  liquidityScore: number;
  pcrScore: number;
  ivScore: number;
  tp: number;
  sl: number;
  rr: number;
  raw: {
    gamma: number;
    delta: number;
    theta: number;
    vega: number;
    oi: number;
    oiChg: number;
    volume: number;
    spread: number;
    ltp: number;
    iv: number;
    bid: number;
    ask: number;
    pcr: number;
  };
  regime: string;
}

// ─── Market Regime Detection ──────────────────────────────────────

export type MarketRegime = "expiry" | "lowVol" | "highIV" | "normal";

export function detectRegime(vix: number | null, daysToExpiry: number): MarketRegime {
  if (daysToExpiry <= 1) return "expiry";
  if (vix !== null && vix >= 20) return "highIV";
  if (vix !== null && vix <= 12) return "lowVol";
  return "normal";
}

// ─── Dynamic Weights by Regime ────────────────────────────────────

interface WeightSet {
  gamma: number;
  oi: number;
  oiChange: number;
  delta: number;
  volume: number;
  vega: number;
  theta: number;
  liquidity: number;
}

const WEIGHTS: Record<MarketRegime, WeightSet> = {
  expiry: {
    gamma: 0.40,
    oi: 0.15,
    oiChange: 0.10,
    delta: 0.10,
    volume: 0.08,
    vega: 0.05,
    theta: 0.07,
    liquidity: 0.05,
  },
  lowVol: {
    gamma: 0.20,
    oi: 0.25,
    oiChange: 0.20,
    delta: 0.10,
    volume: 0.05,
    vega: 0.05,
    theta: 0.05,
    liquidity: 0.10,
  },
  highIV: {
    gamma: 0.20,
    oi: 0.15,
    oiChange: 0.10,
    delta: 0.10,
    volume: 0.05,
    vega: 0.25,
    theta: 0.05,
    liquidity: 0.10,
  },
  normal: {
    gamma: 0.30,
    oi: 0.20,
    oiChange: 0.15,
    delta: 0.10,
    volume: 0.10,
    vega: 0.05,
    theta: 0.05,
    liquidity: 0.05,
  },
};

export function getWeights(regime: MarketRegime): WeightSet {
  return WEIGHTS[regime];
}

// ─── Individual Factor Scores (0–100) ─────────────────────────────

function gammaScore(gamma: number): number {
  // NIFTY ATM gamma ~0.002, scale relative to that
  return Math.min(gamma / 0.004, 1) * 100;
}

function deltaScore(delta: number): number {
  // Peaks at 0.55 (or -0.55), decays toward 0 or 1
  return Math.max(0, 100 - Math.abs(Math.abs(delta) - 0.55) * 180);
}

function thetaScore(theta: number): number {
  // NIFTY ATM theta ~-20, low absolute theta is better
  return Math.max(0, 100 - Math.abs(theta) * 2);
}

function vegaScore(vega: number): number {
  // NIFTY vega ~0.5-2.0, scale relative to that
  return Math.min(vega / 2.0, 1) * 100;
}

function oiScore(oi: number): number {
  return Math.min(oi / 100000, 1) * 100;
}

function oiChangeScore(oiChg: number): number {
  return Math.min(Math.abs(oiChg) / 20000, 1) * 100;
}

function volumeScore(volume: number): number {
  // NIFTY volume in millions
  return Math.min(volume / 3000000, 1) * 100;
}

function liquidityScore(spread: number): number {
  // Lower spread = better liquidity; NIFTY spread ~₹0.5-2
  return Math.max(0, 100 - spread * 5);
}

function pcrScore(pcr: number): number {
  // PCR between 0.8 and 1.2 is ideal (balanced market)
  // Extreme PCR values indicate one-sided positioning
  const deviation = Math.abs(pcr - 1.0);
  return Math.max(0, 100 - deviation * 100);
}

function ivScore(iv: number, regime: MarketRegime): number {
  // In high-IV regime, moderate IV is fine
  // In low-IV regime, very low IV is preferred
  if (regime === "highIV") {
    return Math.min(iv / 25, 1) * 100;
  }
  // Normal: prefer IV between 12-18%
  if (iv >= 12 && iv <= 18) return 90;
  if (iv < 12) return Math.min(iv / 12, 1) * 80;
  return Math.max(0, 100 - (iv - 18) * 3);
}

// ─── TP/SL Calculation (Dynamic, Greeks-Based) ───────────────────

function computeTPSL(
  ltp: number,
  gamma: number,
  delta: number,
  theta: number,
  vega: number,
  iv: number,
  spotPrice: number,
  strike: number,
  type: "CE" | "PE"
): { tp: number; sl: number; rr: number } {
  if (ltp <= 0) return { tp: 0, sl: 0, rr: 0 };

  // Expected move: IV * spot * sqrt(1/365) for 1 day holding
  const expectedMove = spotPrice * (iv / 100) * Math.sqrt(1 / 365);

  // Delta impact: premium change from underlying moving by expectedMove
  // For OTM options, only a fraction of expected move translates to premium change
  const moneyness = type === "CE"
    ? Math.max(0, 1 - Math.abs(strike - spotPrice) / spotPrice)
    : Math.max(0, 1 - Math.abs(strike - spotPrice) / spotPrice);
  const deltaSensitivity = delta * expectedMove;
  const gammaBoost = 0.5 * gamma * expectedMove * expectedMove;

  // Theta decay to subtract (1 day)
  const thetaDecay = Math.abs(theta);

  // --- SL ---
  // SL = 2x theta decay + 2% of premium cushion
  // Floor 5% of premium, cap 25% of premium
  const slBase = thetaDecay * 2 + ltp * 0.02;
  const sl = Math.max(ltp * 0.05, Math.min(ltp * 0.25, slBase));

  // --- TP ---
  // TP = delta impact + gamma convexity - half day theta
  // Scale by moneyness (ATM gets full impact, deep OTM gets less)
  const tpRaw = (deltaSensitivity + gammaBoost) * Math.max(0.3, moneyness) - thetaDecay * 0.5;
  // Floor 10% of premium
  const tp = Math.max(ltp * 0.10, tpRaw);

  // --- R:R ---
  const rr = sl > 0 ? tp / sl : 0;

  return { tp: Math.round(tp * 100) / 100, sl: Math.round(sl * 100) / 100, rr: Math.round(rr * 100) / 100 };
}

// ─── Core Scoring Function ────────────────────────────────────────

export function institutionalScore(option: {
  gamma: number;
  delta: number;
  theta: number;
  vega: number;
  oi: number;
  oiChange: number;
  volume: number;
  spread: number;
}, weights: WeightSet): number {
  const gScore = gammaScore(option.gamma);
  const dScore = deltaScore(option.delta);
  const tScore = thetaScore(option.theta);
  const vScore = vegaScore(option.vega);
  const oScore = oiScore(option.oi);
  const ocScore = oiChangeScore(option.oiChange);
  const volScore = volumeScore(option.volume);
  const liqScore = liquidityScore(option.spread);

  return (
    gScore * weights.gamma +
    oScore * weights.oi +
    ocScore * weights.oiChange +
    dScore * weights.delta +
    volScore * weights.volume +
    vScore * weights.vega +
    tScore * weights.theta +
    liqScore * weights.liquidity
  );
}

// ─── Rejection Filters ────────────────────────────────────────────

function shouldReject(
  leg: OptionLeg,
  spread: number,
  regime: MarketRegime
): boolean {
  const hasOI = leg.oi > 0 || leg.volume > 0;

  // Low liquidity: spread > 3% of LTP
  if (leg.ltp > 0 && spread / leg.ltp > 0.03) return true;

  // Wide spread: absolute spread > 8% of LTP
  if (leg.ltp > 0 && spread > leg.ltp * 0.08) return true;

  // Only enforce volume/OI filters when data is available (SENSEX BSE has no OI)
  if (hasOI) {
    if (leg.volume < 5000) return true;
  }

  // Extreme theta: > ₹50/day decay
  if (Math.abs(leg.theta) > 50) return true;

  // Low gamma: < 0.0003
  if (leg.gamma < 0.0003) return true;

  return false;
}

// ─── Bullish/Bearish Direction Logic ──────────────────────────────

function getDirection(
  ceOiChg: number,
  peOiChg: number,
  gamma: number,
  delta: number,
  gammaThreshold: number
): "BULLISH" | "BEARISH" | null {
  // Bullish: Put OI increasing + Call OI unwinding + high gamma + delta in 0.45-0.65
  const bullish =
    peOiChg > 0 &&
    ceOiChg < 0 &&
    gamma > gammaThreshold &&
    delta > 0.45 &&
    delta < 0.65;

  // Bearish: Call OI increasing + Put OI unwinding + high gamma + delta in -0.45 to -0.65
  const bearish =
    ceOiChg > 0 &&
    peOiChg < 0 &&
    gamma > gammaThreshold &&
    delta < -0.45 &&
    delta > -0.65;

  if (bullish) return "BULLISH";
  if (bearish) return "BEARISH";
  return null;
}

// ─── Main Engine ──────────────────────────────────────────────────

export interface EngineResult {
  strikes: StrikeScore[];
  topCalls: StrikeScore[];
  topPuts: StrikeScore[];
  regime: MarketRegime;
  regimeLabel: string;
  weights: WeightSet;
  symbol: string;
  spot: number;
  atmStrike: number;
  totalStrikes: number;
  qualifiedStrikes: number;
  timestamp: string;
}

export function runInstitutionalEngine(
  chain: StrikeData[],
  summary: ChainSummary,
  symbol: string,
  daysToExpiry: number
): EngineResult {
  const spot = summary.spotPrice;
  const vix = summary.indiaVIX;
  const regime = detectRegime(vix, daysToExpiry);
  const weights = getWeights(regime);

  const regimeLabels: Record<MarketRegime, string> = {
    expiry: "Expiry Day (Gamma-heavy)",
    lowVol: "Low Volatility (OI-heavy)",
    highIV: "High IV Event (Vega-heavy)",
    normal: "Normal Market (Balanced)",
  };

  // Global PCR for scoring
  const globalPcr = summary.pcr;

  const scored: StrikeScore[] = [];

  for (const row of chain) {
    const isATM = row.strike === summary.atmStrike;

    // Evaluate CE
    if (row.ce) {
      const spread = row.ce.ask > 0 && row.ce.bid > 0
        ? row.ce.ask - row.ce.bid
        : row.ce.ltp * 0.01; // estimate 1% spread if no bid/ask

      if (!shouldReject(row.ce, spread, regime)) {
        const gScore = gammaScore(row.ce.gamma);
        const dScore = deltaScore(row.ce.delta);

        // Direction gate: CE must be bullish OR no direction signal
        const direction = getDirection(
          row.ce.oiChg,
          row.pe?.oiChg || 0,
          row.ce.gamma,
          row.ce.delta,
          0.01 // gamma threshold for bullish CE
        );

        // For CE: bullish direction is natural (or no direction filter)
        const passDirection = direction === "BULLISH" || direction === null;

        const score = institutionalScore({
          gamma: row.ce.gamma,
          delta: row.ce.delta,
          theta: row.ce.theta,
          vega: row.ce.vega,
          oi: row.ce.oi,
          oiChange: row.ce.oiChg,
          volume: row.ce.volume,
          spread,
        }, weights);

        const tpsl = computeTPSL(
          row.ce.ltp, row.ce.gamma, Math.abs(row.ce.delta),
          row.ce.theta, row.ce.vega, row.ce.iv,
          spot, row.strike, "CE"
        );

        scored.push({
          strike: row.strike,
          type: "CE",
          institutionalScore: Math.round(score * 10) / 10,
          gammaScore: Math.round(gScore * 10) / 10,
          deltaScore: Math.round(dScore * 10) / 10,
          thetaScore: Math.round(thetaScore(row.ce.theta) * 10) / 10,
          vegaScore: Math.round(vegaScore(row.ce.vega) * 10) / 10,
          oiScore: Math.round(oiScore(row.ce.oi) * 10) / 10,
          oiChangeScore: Math.round(oiChangeScore(row.ce.oiChg) * 10) / 10,
          volumeScore: Math.round(volumeScore(row.ce.volume) * 10) / 10,
          liquidityScore: Math.round(liquidityScore(spread) * 10) / 10,
          pcrScore: Math.round(pcrScore(globalPcr) * 10) / 10,
          ivScore: Math.round(ivScore(row.ce.iv, regime) * 10) / 10,
          tp: tpsl.tp,
          sl: tpsl.sl,
          rr: tpsl.rr,
          raw: {
            gamma: row.ce.gamma,
            delta: row.ce.delta,
            theta: row.ce.theta,
            vega: row.ce.vega,
            oi: row.ce.oi,
            oiChg: row.ce.oiChg,
            volume: row.ce.volume,
            spread,
            ltp: row.ce.ltp,
            iv: row.ce.iv,
            bid: row.ce.bid,
            ask: row.ce.ask,
            pcr: globalPcr,
          },
          regime,
        });
      }
    }

    // Evaluate PE
    if (row.pe) {
      const spread = row.pe.ask > 0 && row.pe.bid > 0
        ? row.pe.ask - row.pe.bid
        : row.pe.ltp * 0.01;

      if (!shouldReject(row.pe, spread, regime)) {
        const gScore = gammaScore(row.pe.gamma);
        const dScore = deltaScore(Math.abs(row.pe.delta)); // use absolute delta for scoring

        const direction = getDirection(
          row.ce?.oiChg || 0,
          row.pe.oiChg,
          row.pe.gamma,
          row.pe.delta,
          0.01
        );

        // For PE: bearish direction is natural (or no direction filter)
        const passDirection = direction === "BEARISH" || direction === null;

        const score = institutionalScore({
          gamma: row.pe.gamma,
          delta: Math.abs(row.pe.delta),
          theta: row.pe.theta,
          vega: row.pe.vega,
          oi: row.pe.oi,
          oiChange: row.pe.oiChg,
          volume: row.pe.volume,
          spread,
        }, weights);

        const tpsl = computeTPSL(
          row.pe.ltp, row.pe.gamma, Math.abs(row.pe.delta),
          row.pe.theta, row.pe.vega, row.pe.iv,
          spot, row.strike, "PE"
        );

        scored.push({
          strike: row.strike,
          type: "PE",
          institutionalScore: Math.round(score * 10) / 10,
          gammaScore: Math.round(gScore * 10) / 10,
          deltaScore: Math.round(dScore * 10) / 10,
          thetaScore: Math.round(thetaScore(row.pe.theta) * 10) / 10,
          vegaScore: Math.round(vegaScore(row.pe.vega) * 10) / 10,
          oiScore: Math.round(oiScore(row.pe.oi) * 10) / 10,
          oiChangeScore: Math.round(oiChangeScore(row.pe.oiChg) * 10) / 10,
          volumeScore: Math.round(volumeScore(row.pe.volume) * 10) / 10,
          liquidityScore: Math.round(liquidityScore(spread) * 10) / 10,
          pcrScore: Math.round(pcrScore(globalPcr) * 10) / 10,
          ivScore: Math.round(ivScore(row.pe.iv, regime) * 10) / 10,
          tp: tpsl.tp,
          sl: tpsl.sl,
          rr: tpsl.rr,
          raw: {
            gamma: row.pe.gamma,
            delta: row.pe.delta,
            theta: row.pe.theta,
            vega: row.pe.vega,
            oi: row.pe.oi,
            oiChg: row.pe.oiChg,
            volume: row.pe.volume,
            spread,
            ltp: row.pe.ltp,
            iv: row.pe.iv,
            bid: row.pe.bid,
            ask: row.pe.ask,
            pcr: globalPcr,
          },
          regime,
        });
      }
    }
  }

  // Sort all by institutional score
  scored.sort((a, b) => b.institutionalScore - a.institutionalScore);

  // Separate and take top 5
  const calls = scored.filter((s) => s.type === "CE").slice(0, 5);
  const puts = scored.filter((s) => s.type === "PE").slice(0, 5);

  return {
    strikes: scored,
    topCalls: calls,
    topPuts: puts,
    regime,
    regimeLabel: regimeLabels[regime],
    weights,
    symbol,
    spot,
    atmStrike: summary.atmStrike,
    totalStrikes: chain.length,
    qualifiedStrikes: scored.length,
    timestamp: new Date().toISOString(),
  };
}
