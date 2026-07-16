// ═══════════════════════════════════════════════════════════════════
// MODULE 3 — PREMIUM PROJECTION ENGINE
// Translates the EXPECTED INDEX MOVE (Module 2) into option-premium space
// using: Delta (primary), Gamma (convexity, if available), IV regime,
// time remaining, and current premium. Guards against unrealistic
// projections with a horizon-aware cap.
//
// Outputs are MAGNITUDES in the favorable direction. The orchestrator
// applies sign based on trade type (CE long / PE long).
// ═══════════════════════════════════════════════════════════════════

import { IVRegime } from './volatility-engine';
import { OptionType } from './types';

export interface PremiumReport {
  projectedPremiumMove: number;  // capped magnitude (favorable direction)
  rawProjected: number;          // uncapped (diagnostics)
  premiumTarget: number;         // ltp + projectedPremiumMove
  minMove: number;               // conservative (delta-only, capped)
  maxMove: number;               // delta+gamma, capped
  realistic: boolean;            // within horizon cap
  gammaAdjustment: number;       // premium points added by convexity
  method: string;
  capFactor: number;
}

export interface PremiumInput {
  ltp: number;
  type: OptionType;
  delta: number;                 // absolute delta 0..1
  gamma?: number;                // absolute gamma
  iv: number;                    // percent (context only)
  dte: number;
  expectedIndexMove: number;     // index points, absolute (from Module 2)
  ivRegime: IVRegime;
}

/** Horizon-aware cap: farther expiry → tighter realistic premium multiple. */
export function premiumCapFactor(dte: number): number {
  if (dte <= 1) return 3.0;
  if (dte <= 3) return 2.0;
  if (dte <= 7) return 1.5;
  return 1.25;
}

export function projectPremium(input: PremiumInput): PremiumReport {
  const { ltp, type, delta, gamma = 0, dte, expectedIndexMove, ivRegime } = input;
  const absDelta = Math.min(1, Math.max(0, Math.abs(delta)));
  const dx = Math.abs(expectedIndexMove);

  // Linear (delta) component
  const linear = absDelta * dx;
  // Convexity (gamma): ½·Γ·dx² — only adds in the direction of the move
  const gammaTerm = 0.5 * Math.abs(gamma) * dx * dx;
  const rawProjected = linear + gammaTerm;

  // Horizon-aware realism cap
  const capFactor = premiumCapFactor(dte);
  const maxMove = ltp * capFactor;
  const realistic = rawProjected <= maxMove * 1.05;
  const projected = Math.min(rawProjected, maxMove);

  const minMove = Math.min(linear, maxMove);

  return {
    projectedPremiumMove: projected,
    rawProjected,
    premiumTarget: ltp + projected,
    minMove,
    maxMove: projected,
    realistic,
    gammaAdjustment: gammaTerm,
    method: `delta${gamma ? '+gamma' : ''}·Δindex, capped ${capFactor}x (${ivRegime})`,
    capFactor,
  };
}
