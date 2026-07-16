// ═══════════════════════════════════════════════════════════════════
// MODULE 18 — CONFIDENCE ENGINE
// Weighted, EXPLAINABLE confidence from every upstream module. Never a
// black box: every weight and reason is surfaced.
// ═══════════════════════════════════════════════════════════════════

import { StructureReport } from './structure-analyzer';
import { PriceActionReport } from './price-action';
import { LiquidityReport } from './liquidity';
import { OrderFlowReport } from './order-flow';
import { VolumeReport } from './volume';

export type Grade = 'A' | 'B' | 'C' | 'F';

export interface ConfidenceInput {
  structure: StructureReport;
  priceAction: PriceActionReport;
  liquidity: LiquidityReport;
  orderFlow: OrderFlowReport;
  volume: VolumeReport;
  premiumRealistic: boolean;
  rr: number;
}

export interface ConfidenceReport {
  score: number;          // 0..100
  grade: Grade;
  reasons: string[];
}

export function computeConfidence(input: ConfidenceInput): ConfidenceReport {
  const reasons: string[] = [];
  const w = {
    structure: 0.25,
    priceAction: 0.2,
    liquidity: 0.15,
    orderFlow: 0.15,
    volume: 0.1,
    premiumRR: 0.15,
  };

  const structScore =
    (input.structure.clarity === 'CLEAR' ? 100 : 30) *
    (input.structure.alignedWithTrade ? 1 : 0.4);
  const paScore = input.priceAction.score;
  const liqScore = input.liquidity.liquidityScore;
  const ofScore = input.orderFlow.score;
  const volScore = input.volume.score;
  const prScore =
    (input.premiumRealistic ? 60 : 0) + Math.min(40, input.rr / 4.5 * 40);

  const score = clamp(
    structScore * w.structure +
    paScore * w.priceAction +
    liqScore * w.liquidity +
    ofScore * w.orderFlow +
    volScore * w.volume +
    prScore * w.premiumRR,
    0, 100
  );

  if (structScore >= 90) reasons.push('structure CLEAR & aligned (+25)');
  if (input.priceAction.mtfAlignment) reasons.push('MTF trend aligned (+PA)');
  if (liqScore > 70) reasons.push('deep liquidity (+LIQ)');
  if (input.orderFlow.absorption) reasons.push('absorption detected (caution)');
  if (!input.premiumRealistic) reasons.push('premium projection unrealistic (−PR)');
  if (input.rr >= 2.5) reasons.push(`RR ${input.rr.toFixed(2)} healthy`);

  const grade: Grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'F';
  return { score: Math.round(score), grade, reasons };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
