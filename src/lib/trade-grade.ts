// Single source of truth for the A+/A/B+/B/C ladder used by the Simple Tab
// card and any other surface that grades a 0-100 score. (Phase 5 — one
// formula; page.tsx used to inline this and agents/ used a different table.)

import type { TradeGrade } from "@/types/sdm";

/** Map a 0-100 confidence / sdmScore to the trade-grade ladder. */
export function tradeGradeFromScore(score: number): TradeGrade {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= 75) return "A+";
  if (s >= 65) return "A";
  if (s >= 55) return "B+";
  if (s >= 45) return "B";
  return "C";
}
