// ═══════════════════════════════════════════════════════════════════
// MODULE 8 — OPTION ANALYTICS ENGINE
// Reads REAL greeks / IV / premium from the chain leg and derives
// moneyness, time decay, premium elasticity and a composite quality.
// ═══════════════════════════════════════════════════════════════════

import { OptionType } from './types';
import { OptionLeg } from './chain';
import { IVRegime, classifyIVRegime } from './volatility-engine';

export interface OptionAnalytics {
  type: OptionType;
  intrinsic: number;
  timeValue: number;
  moneyness: number;          // signed (spot - strike)/spot
  strikeDistancePct: number;  // |strike - spot|/spot
  iv: number;
  ivRegime: IVRegime;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  thetaPerDay: number;
  thetaDecayPct: number;      // |theta|/ltp per day
  premiumElasticity: number;  // premium % move per 1% index move
  quality: number;            // 0..100 composite
}

export interface AnalyticsInput {
  leg: OptionLeg;
  strike: number;
  spot: number;
  dte: number;
  vix: number;
}

export function analyzeOption(input: AnalyticsInput): OptionAnalytics {
  const { leg, strike, spot, dte, vix } = input;
  const intrinsic =
    leg.type === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const timeValue = Math.max(0, leg.ltp - intrinsic);
  const moneyness = spot > 0 ? (spot - strike) / spot : 0;
  const strikeDistancePct = spot > 0 ? Math.abs(strike - spot) / spot : 1;
  const ivRegime = classifyIVRegime(leg.iv, vix);
  const thetaPerDay = dte > 0 ? leg.theta / dte : leg.theta;
  const thetaDecayPct = leg.ltp > 0 ? Math.abs(leg.theta) / leg.ltp : 0;

  // Premium elasticity: % premium move per 1% index move (delta * spot / ltp)
  const premiumElasticity =
    leg.ltp > 0 && spot > 0 ? (Math.abs(leg.delta) * spot) / leg.ltp : 0;

  // Quality: liquid + sane decay + tradable delta + reasonable IV
  let q = 0;
  const spread = leg.ask > leg.bid && leg.ask > 0 ? (leg.ask - leg.bid) / leg.ask : 1;
  const liqQ = Math.max(0, 1 - spread * 6);                      // tight spread good
  const oiQ = leg.oi > 0 ? Math.min(1, Math.log10(leg.oi + 1) / 6) : 0;
  const deltaQ = 1 - Math.min(1, Math.abs(Math.abs(leg.delta) - 0.5) * 2); // ~0.5 delta ideal
  const decayQ = thetaDecayPct <= 0.15 ? 1 : Math.max(0, 1 - (thetaDecayPct - 0.15) * 4);
  q = (liqQ * 0.35 + oiQ * 0.25 + deltaQ * 0.2 + decayQ * 0.2) * 100;

  return {
    type: leg.type,
    intrinsic,
    timeValue,
    moneyness,
    strikeDistancePct,
    iv: leg.iv,
    ivRegime,
    delta: leg.delta,
    gamma: leg.gamma,
    theta: leg.theta,
    vega: leg.vega,
    thetaPerDay,
    thetaDecayPct,
    premiumElasticity,
    quality: clamp(q, 0, 100),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
