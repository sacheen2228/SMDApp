// ═══════════════════════════════════════════════════════════════════
// MODULE 9 — LIQUIDITY ENGINE
// Reads REAL bid/ask spread, OI, market depth and chain OI shelves to
// locate liquidity pools, equal highs/lows (sell/buy-side liquidity)
// and premium/discount zones per strike.
// ═══════════════════════════════════════════════════════════════════

import { OptionLeg, ChainStats } from './chain';

export interface LiquidityReport {
  spreadPct: number;
  oiLevel: number;
  oiQuality: number;            // 0..1 normalized vs chain max
  depthBidQty: number;
  depthAskQty: number;
  depthScore: number;           // 0..1 from market depth if present
  premiumDiscountZone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  equalHigh: boolean;           // sell-side liquidity shelf (call OI peak)
  equalLow: boolean;            // buy-side liquidity shelf (put OI peak)
  inLiquidityPool: boolean;     // both call & put OI elevated
  liquidityScore: number;       // 0..100
}

export interface LiquidityInput {
  leg: OptionLeg;
  strike: number;
  spot: number;
  stats: ChainStats;
}

export function analyzeLiquidity(input: LiquidityInput): LiquidityReport {
  const { leg, strike, spot, stats } = input;

  // Spread: when real bid/ask are present use them. When the feed omits
  // bid/ask (Breeze/NSE sometimes returns 0), fall back to an OI/volume-based
  // liquidity estimate so the spread gate degrades gracefully instead of
  // hard-rejecting every candidate. High OI + meaningful volume ⇒ tight
  // effective spread; illiquid legs get a wider (but finite) estimate.
  const bidOk = leg.bid !== undefined && leg.bid > 0;
  const askOk = leg.ask !== undefined && leg.ask > 0;
  let spreadPct: number;
  if (bidOk && askOk && leg.ask >= leg.bid) {
    spreadPct = (leg.ask - leg.bid) / leg.ask;
  } else {
    const oi = leg.oi || 0;
    const vol = leg.volume || 0;
    const hasActivity = oi > 1e4 || vol > 500;
    spreadPct = hasActivity ? 0.06 : 0.25;
  }

  const oiLevel = leg.oi;
  const oiQuality =
    stats.maxOi > 0 ? Math.min(1, oiLevel / stats.maxOi) : 0;

  const depthBidQty = leg.depth?.bidQty ?? 0;
  const depthAskQty = leg.depth?.askQty ?? 0;
  // depth score: relative to OI (deep book = large qty vs OI)
  const depthRatio =
    leg.oi > 0 ? (depthBidQty + depthAskQty) / (leg.oi * 2) : 0;
  const depthScore = Math.min(1, depthRatio / 0.5);

  // Premium/Discount zone relative to spot
  const distPct = spot > 0 ? Math.abs(strike - spot) / spot : 1;
  let zone: LiquidityReport['premiumDiscountZone'] = 'EQUILIBRIUM';
  if (distPct < 0.005) zone = 'EQUILIBRIUM';
  else if (leg.type === 'CE') zone = strike < spot ? 'DISCOUNT' : 'PREMIUM';
  else zone = strike > spot ? 'DISCOUNT' : 'PREMIUM';

  const bandwidth = Math.max(50, stats.atmStrike * 0.0025);
  const equalHigh = Math.abs(strike - stats.callOiShelf) <= bandwidth;
  const equalLow = Math.abs(strike - stats.putOiShelf) <= bandwidth;
  const inLiquidityPool = stats.liquidityPools.includes(strike);

  const liqQ =
    (Math.max(0, 1 - spreadPct * 6) * 0.4 +
      oiQuality * 0.3 +
      depthScore * 0.3) * 100;

  return {
    spreadPct,
    oiLevel,
    oiQuality,
    depthBidQty,
    depthAskQty,
    depthScore,
    premiumDiscountZone: zone,
    equalHigh,
    equalLow,
    inLiquidityPool,
    liquidityScore: clamp(liqQ, 0, 100),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
