// ═══════════════════════════════════════════════════════════════════
// MODULE 12 — RISK ENGINE
// Derives the structure-based stop (proximal swing/OB/FVG invalidation)
// with an ATR floor, an expiry-aware tightness multiplier, the dynamic
// reward:risk target, and position sizing from the risk budget.
// ═══════════════════════════════════════════════════════════════════

import { StructureReport } from './structure-analyzer';
import { VolatilityReport } from './volatility-engine';
import { ExpiryReport } from './expiry-model';

export type Direction = 'BULLISH' | 'BEARISH';

export interface RiskReport {
  direction: Direction;
  entry: number;
  structureSL: number | null;
  atrSL: number;
  recommendedSL: number;
  riskIndexPct: number;
  dynamicRR: number;
  positionSizePct: number;
  suggestedLots: number;
  reasons: string[];
}

export interface RiskInput {
  direction: Direction;
  entry: number;                 // index entry (typically spot)
  structure: StructureReport;
  vol: VolatilityReport;
  expiry: ExpiryReport;
  liquidityScore: number;        // 0..100
  lotSize: number;
  capital?: number;              // default 100000
  riskPerTradePct?: number;      // default 1
}

export function computeRisk(input: RiskInput): RiskReport {
  const {
    direction, entry, structure, vol, expiry,
    liquidityScore, lotSize, capital = 100000, riskPerTradePct = 1,
  } = input;
  const reasons: string[] = [];
  const atr = vol.atr > 0 ? vol.atr : entry * 0.005;

  // Base structure stop (index space)
  const structureSL = structure.structureStopLevel;

  // ATR floor: never closer than 0.35×ATR to entry
  const atrFloorDist = atr * 0.35;
  const atrSL =
    direction === 'BULLISH' ? entry - atrFloorDist : entry + atrFloorDist;

  // Recommended: more-protective of (structure, atr-floor)
  let recommended =
    direction === 'BULLISH'
      ? Math.min(structureSL ?? atrSL, atrSL)
      : Math.max(structureSL ?? atrSL, atrSL);

  // Expiry tightness multiplier (SCALP → tighter)
  const dist = Math.abs(entry - recommended);
  recommended =
    direction === 'BULLISH'
      ? entry - dist * expiry.slFactor
      : entry + dist * expiry.slFactor;
  // Re-enforce a minimum distance (0.25×ATR) so scalp stops aren't trivial
  const minDist = atr * 0.25;
  recommended =
    direction === 'BULLISH'
      ? Math.min(recommended, entry - minDist)
      : Math.max(recommended, entry + minDist);

  const riskIndexPct = entry > 0 ? Math.abs(entry - recommended) / entry : 0;

  // Dynamic RR: base 2.5, scaled by structure clarity + liquidity, capped 4.5
  let rr = 2.5;
  if (structure.clarity === 'CLEAR') rr += 1.0;
  else if (structure.clarity === 'UNCLEAR') rr -= 0.7;
  if (liquidityScore > 70) rr += 0.5;
  if (expiry.projectionStyle === 'SCALP') rr *= 0.8;
  rr = Math.max(1.5, Math.min(4.5, rr));

  // Position sizing from risk budget
  const riskCapital = (capital * riskPerTradePct) / 100;
  const lotRisk = Math.abs(entry - recommended) * lotSize;
  const suggestedLots = lotRisk > 0 ? Math.max(1, Math.floor(riskCapital / lotRisk)) : 1;

  if (structureSL != null) reasons.push(`SL at structure ${structureSL.toFixed(1)}`);
  else reasons.push('SL at ATR floor (no clear structure)');
  reasons.push(`expiry ${expiry.profile} slFactor=${expiry.slFactor}`);
  reasons.push(`RR target ${rr.toFixed(2)}`);

  return {
    direction, entry, structureSL, atrSL, recommendedSL: recommended,
    riskIndexPct, dynamicRR: rr, positionSizePct: riskPerTradePct,
    suggestedLots, reasons,
  };
}
