// ═══════════════════════════════════════════════════════════════════
// MODULE 13 — DYNAMIC SL ENGINE
// Refines the Risk stop: places it BEYOND the nearest OB/FVG so a liquidity
// sweep (wick) does not prematurely trigger it, and exposes a soft (trail)
// level and a hard invalidation level. Tailors buffer to IV regime.
// ═══════════════════════════════════════════════════════════════════

import { StructureReport } from './structure-analyzer';
import { VolatilityReport } from './volatility-engine';
import { ExpiryReport } from './expiry-model';
import { RiskReport } from './risk';

export interface DynamicSLReport {
  slIndex: number;             // final index SL
  slPremiumRef: number;        // estimated premium at SL (for diagnostics)
  buffer: number;              // ATR buffer beyond structure
  softLevel: number;           // trail trigger / soft invalidation
  invalidationLevel: number;   // hard exit if breached
  trailEnabled: boolean;
  rationale: string;
}

export interface SLInput {
  risk: RiskReport;
  structure: StructureReport;
  vol: VolatilityReport;
  expiry: ExpiryReport;
  delta: number;               // option delta (abs) for premium ref
  ltp: number;
}

export function computeDynamicSL(input: SLInput): DynamicSLReport {
  const { risk, structure, vol, expiry, delta, ltp } = input;
  const { direction, entry, recommendedSL } = risk;
  const atr = vol.atr > 0 ? vol.atr : entry * 0.005;

  // Buffer scales with IV regime (wider in high vol) and expiry posture
  const regimeMult =
    vol.ivRegime === 'EXTREME' ? 0.6 :
    vol.ivRegime === 'HIGH' ? 0.45 :
    vol.ivRegime === 'NORMAL' ? 0.3 : 0.2;
  const buffer = atr * regimeMult * (expiry.projectionStyle === 'SCALP' ? 0.6 : 1);

  // Nearest structure element in the protective direction
  const el =
    direction === 'BULLISH'
      ? (structure.nearestFVG?.bottom ?? structure.nearestOB?.bottom ?? recommendedSL)
      : (structure.nearestFVG?.top ?? structure.nearestOB?.top ?? recommendedSL);

  // Place SL beyond the element so sweeps don't trigger
  let slIndex =
    direction === 'BULLISH'
      ? Math.min(recommendedSL, el - buffer)
      : Math.max(recommendedSL, el + buffer);

  // Never let it cross back inside entry
  slIndex =
    direction === 'BULLISH'
      ? Math.min(slIndex, entry - atr * 0.2)
      : Math.max(slIndex, entry + atr * 0.2);

  // Soft level: just beyond structure (trail trigger)
  const softLevel =
    direction === 'BULLISH'
      ? el - buffer * 0.5
      : el + buffer * 0.5;

  // Hard invalidation: structure break level
  const invalidationLevel =
    direction === 'BULLISH'
      ? (structure.lastSwingLow?.price ?? slIndex - atr)
      : (structure.lastSwingHigh?.price ?? slIndex + atr);

  const slPremiumRef =
    ltp - Math.abs(delta) * Math.abs(entry - slIndex) * (direction === 'BULLISH' ? 1 : 1);

  const trailEnabled = expiry.projectionStyle !== 'SCALP';

  return {
    slIndex,
    slPremiumRef: Math.max(0, slPremiumRef),
    buffer,
    softLevel,
    invalidationLevel,
    trailEnabled,
    rationale: `SL ${slIndex.toFixed(1)} (buffer ${buffer.toFixed(1)} beyond structure; ${vol.ivRegime} IV)`,
  };
}
