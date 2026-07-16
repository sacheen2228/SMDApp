// ═══════════════════════════════════════════════════════════════════
// MODULE 10 — ORDER FLOW ENGINE
// Reads REAL OI change / volume to detect accumulation, absorption
// (OI rising but price pinned) and failed breakouts.
// ═══════════════════════════════════════════════════════════════════

import { OptionLeg, ChainStats } from './chain';

export interface OrderFlowReport {
  oiChangePct: number;        // oiChg / oi
  volumeExpansion: number;    // volume / avgVolume
  accumulation: boolean;      // OI rising meaningfully
  absorption: boolean;        // OI up strongly but price barely moved
  failedBreakout: boolean;    // high volume but weak price continuation
  continuationStrength: number; // 0..100
  score: number;              // 0..100
}

export interface OrderFlowInput {
  leg: OptionLeg;
  prevLtp?: number;           // previous premium (for absorption)
  stats: ChainStats;
  direction: 'BULLISH' | 'BEARISH';
}

export function analyzeOrderFlow(input: OrderFlowInput): OrderFlowReport {
  const { leg, prevLtp, stats, direction } = input;

  const oiChangePct = leg.oi > 0 ? leg.oiChg / leg.oi : 0;
  const volumeExpansion =
    stats.avgVolume > 0 ? leg.volume / stats.avgVolume : 1;

  const accumulation = oiChangePct > 0.15;

  // Absorption: OI jumps but premium barely moved (institutions absorbing)
  let absorption = false;
  if (prevLtp && prevLtp > 0) {
    const priceMovePct = Math.abs(leg.ltp - prevLtp) / prevLtp;
    absorption = oiChangePct > 0.25 && priceMovePct < 0.04;
  }

  // Failed breakout: volume expanded a lot but premium did not follow through
  const failedBreakout =
    volumeExpansion > 2.5 && oiChangePct < 0.05;

  // Continuation strength: OI + volume rising in the directional bias
  const dirSign = direction === 'BULLISH' ? 1 : 1; // OI rise supports both via pressure
  const strength =
    Math.min(1, Math.max(0, oiChangePct)) * 0.5 +
    Math.min(1, volumeExpansion / 3) * 0.3 +
    (accumulation ? 0.2 : 0);
  const continuationStrength = clamp(strength * 100, 0, 100);

  let score = continuationStrength;
  if (absorption) score -= 15;
  if (failedBreakout) score -= 25;
  score = clamp(score, 0, 100);

  return {
    oiChangePct,
    volumeExpansion,
    accumulation,
    absorption,
    failedBreakout,
    continuationStrength,
    score,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
