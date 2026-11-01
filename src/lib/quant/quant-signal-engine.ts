// quant-signal-engine.ts — winner selection across the strategy signals.
// PURE. Picks the highest eligible score ≥ QUANT_MIN_SIGNAL_SCORE; when two
// eligible signals disagree on direction the result is a conflict (no
// winner → the caller records WAIT). Ties break on strategy name (asc) so
// the choice is deterministic.

import type { QuantFeatures, QuantRegimeResult, QuantStrategySignal } from "./quant-types";

/** Minimum score an eligible signal must clear to win. */
export const QUANT_MIN_SIGNAL_SCORE = 55;

export function selectWinner(
  signals: QuantStrategySignal[],
  _regime: QuantRegimeResult,
  _features: QuantFeatures,
  minScore: number = QUANT_MIN_SIGNAL_SCORE,
): { winner: QuantStrategySignal | null; conflict: string | null } {
  const gate = typeof minScore === "number" && minScore >= 0 ? minScore : QUANT_MIN_SIGNAL_SCORE;
  const eligible = signals.filter((s) => s.eligible && s.score != null && s.score >= gate);
  if (eligible.length === 0) return { winner: null, conflict: null };

  const directions = Array.from(new Set(eligible.map((s) => s.direction)));
  if (directions.length > 1) {
    return {
      winner: null,
      conflict: `eligible signals disagree on direction (${eligible.map((s) => `${s.strategy}:${s.direction}@${s.score}`).join(", ")})`,
    };
  }

  const sorted = [...eligible].sort((a, b) => {
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    return a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0;
  });
  return { winner: sorted[0], conflict: null };
}
