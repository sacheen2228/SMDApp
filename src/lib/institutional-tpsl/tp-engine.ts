// ═══════════════════════════════════════════════════════════════════
// MODULE 14 — DYNAMIC TP ENGINE
// Builds a 4-tier target ladder (TP1 / TP2 / TP3 / Runner) in INDEX space
// from: expected index move (Module 2), structure resistance/support
// (swings + liquidity shelves from OI), and the expiry tpFactor. Returns
// both index and estimated-premium targets via delta.
// ═══════════════════════════════════════════════════════════════════

import { StructureReport } from './structure-analyzer';
import { VolatilityReport } from './volatility-engine';
import { ExpiryReport } from './expiry-model';
import { RiskReport } from './risk';
import { ChainStats } from './chain';

export interface DynamicTPReport {
  tp1: number;
  tp2: number;
  tp3: number;
  runner: number;
  tp1Premium: number;
  tp2Premium: number;
  tp3Premium: number;
  runnerPremium: number;
  primaryTarget: number;
  rationale: string;
}

export interface TPInput {
  direction: 'BULLISH' | 'BEARISH';
  entry: number;
  structure: StructureReport;
  vol: VolatilityReport;
  expiry: ExpiryReport;
  risk: RiskReport;
  stats?: ChainStats;
  delta: number;
  ltp: number;
}

export function computeDynamicTP(input: TPInput): DynamicTPReport {
  const { direction, entry, structure, vol, expiry, risk, stats, delta, ltp } = input;
  const sign = direction === 'BULLISH' ? 1 : -1;
  const move = Math.max(vol.expectedIndexMove, entry * 0.002);
  const tf = expiry.tpFactor;

  const m1 = move * 0.5 * tf;
  const m2 = move * 1.0 * tf;
  const m3 = move * 1.5 * tf;
  const runner = move * 2.0 * tf;

  let tp1 = entry + sign * m1;
  let tp2 = entry + sign * m2;
  let tp3 = entry + sign * m3;
  let runnerIdx = entry + sign * runner;

  // Anchor to structure / liquidity shelf beyond entry
  const resist =
    direction === 'BULLISH'
      ? (structure.lastSwingHigh?.price ?? (stats?.callOiShelf && stats.callOiShelf > entry ? stats.callOiShelf : null))
      : (structure.lastSwingLow?.price ?? (stats?.putOiShelf && stats.putOiShelf < entry ? stats.putOiShelf : null));
  if (resist != null) {
    if (direction === 'BULLISH') tp2 = Math.max(tp2, Math.min(resist, runnerIdx));
    else tp2 = Math.min(tp2, Math.max(resist, runnerIdx));
  }

  // Enforce ordering
  if (direction === 'BULLISH') {
    tp1 = Math.min(tp1, tp2); tp3 = Math.max(tp3, tp2); runnerIdx = Math.max(runnerIdx, tp3);
  } else {
    tp1 = Math.max(tp1, tp2); tp3 = Math.min(tp3, tp2); runnerIdx = Math.min(runnerIdx, tp3);
  }

  const toPrem = (idx: number) => Math.max(0, ltp + Math.abs(delta) * sign * (idx - entry));

  return {
    tp1, tp2, tp3, runner: runnerIdx,
    tp1Premium: toPrem(tp1),
    tp2Premium: toPrem(tp2),
    tp3Premium: toPrem(tp3),
    runnerPremium: toPrem(runnerIdx),
    primaryTarget: tp2,
    rationale: `TP ladder from expected move ${move.toFixed(1)} ×tpFactor ${tf}; anchored resist ${resist?.toFixed(1) ?? 'n/a'}`,
  };
}
