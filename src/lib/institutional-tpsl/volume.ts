// ═══════════════════════════════════════════════════════════════════
// MODULE 11 — VOLUME ENGINE
// Reads REAL traded volume per leg vs chain average to derive relative
// volume and participation trend.
// ═══════════════════════════════════════════════════════════════════

import { OptionLeg, ChainStats } from './chain';

export interface VolumeReport {
  volume: number;
  avgVolume: number;
  relativeVolume: number;
  trend: 'RISING' | 'FLAT' | 'FALLING';
  score: number;              // 0..100
}

export function analyzeVolume(leg: OptionLeg, stats: ChainStats): VolumeReport {
  const avgVolume = stats.avgVolume;
  const relativeVolume = avgVolume > 0 ? leg.volume / avgVolume : 1;
  const trend: VolumeReport['trend'] =
    relativeVolume > 1.5 ? 'RISING' : relativeVolume < 0.6 ? 'FALLING' : 'FLAT';
  const score = clamp(Math.min(100, relativeVolume * 50), 0, 100);
  return { volume: leg.volume, avgVolume, relativeVolume, trend, score };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
