// ═══════════════════════════════════════════════════════════════════
// MODULE 19 — STRIKE SELECTION ENGINE
// From the REAL option chain, scores every tradable strike on the
// directional side (CE for bullish, PE for bearish) using option analytics,
// liquidity, order flow, and a slight premium-efficiency preference for
// strikes with delta 0.35–0.65. Picks the best; returns a ranked top-5.
// ═══════════════════════════════════════════════════════════════════

import { ChainStrike, ChainStats, OptionLeg } from './chain';
import { analyzeOption } from './option-analytics';
import { analyzeLiquidity } from './liquidity';
import { analyzeOrderFlow } from './order-flow';
import { Direction } from './risk';

export interface StrikeSelectionInput {
  strikes: ChainStrike[];
  spot: number;
  direction: Direction;
  stats: ChainStats;
  vix: number;
  dte: number;
  prevLtp?: (strike: number) => number | undefined;
}

export interface StrikeRank {
  strike: number;
  score: number;
  reason: string;
}

export interface StrikeSelectionResult {
  selectedStrike: number | null;
  selectedLeg: OptionLeg | null;
  score: number;
  reason: string;
  ranked: StrikeRank[];
}

export function selectStrike(input: StrikeSelectionInput): StrikeSelectionResult {
  const { strikes, spot, direction, stats, vix, dte, prevLtp } = input;
  const ranked: StrikeRank[] = [];

  for (const s of strikes) {
    const leg = direction === 'BULLISH' ? s.ce : s.pe;
    if (!leg || leg.ltp <= 0) continue;

    const analytics = analyzeOption({ leg, strike: s.strike, spot, dte, vix });
    const liq = analyzeLiquidity({ leg, strike: s.strike, spot, stats });
    const of = analyzeOrderFlow({ leg, prevLtp: prevLtp?.(s.strike), stats, direction });

    // Premium-efficiency preference: delta 0.35–0.65 ideal
    const ad = Math.abs(Math.abs(leg.delta) - 0.5);
    const deltaPref = 1 - Math.min(1, ad / 0.5);

    const score =
      analytics.quality * 0.4 +
      liq.liquidityScore * 0.25 +
      of.score * 0.15 +
      deltaPref * 100 * 0.2;

    let reason = `quality=${analytics.quality.toFixed(0)} liq=${liq.liquidityScore.toFixed(0)} OF=${of.score.toFixed(0)} δ=${leg.delta.toFixed(2)}`;
    if (liq.inLiquidityPool) reason += ' [liq-pool]';
    if (of.accumulation) reason += ' [accum]';

    ranked.push({ strike: s.strike, score: Math.round(score), reason });
  }

  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const selectedStrike = top ? top.strike : null;
  const selectedLeg = selectedStrike != null
    ? (strikes.find((s) => s.strike === selectedStrike)?.[direction === 'BULLISH' ? 'ce' : 'pe'] ?? null)
    : null;

  return {
    selectedStrike,
    selectedLeg,
    score: top ? top.score : 0,
    reason: top ? top.reason : 'no valid strikes',
    ranked: ranked.slice(0, 5),
  };
}
