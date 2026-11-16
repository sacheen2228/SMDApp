// Canonical PCR interpretation — ONE place for the put-call-ratio reading.
//
// THE BUG THIS FIXES: the Simple tab rendered the SAME PCR number with four
// different thresholds — 0.70 (LIVE strip), 0.75 (Market Mood mood score),
// 0.80 (Market Mood caption) and 0.90 (Money Flow / OI Analysis). One card
// said "Neutral" while another said "Bearish Flow" for the identical value,
// because each card carried its own cut-off.
//
// The bands below are the ones the engines already use most widely (the
// signal-persistence confirmation gate uses >1.0 bullish / <0.9 bearish; the
// SDM engine's legacy vote uses >1.2 / <0.75). The canonical reading uses
// the confirmation-gate bands, because that gate is what actually decides
// whether the card can say BUY.
//
// This helper is PRESENTATION only: it never gates a trade. The trade gates
// live in agent-brain-gate / signal-persistence / quant-toolkit.

export const PCR_BANDS = {
  /** Above this → put writing dominates (bullish positioning). */
  bullish: 1.0,
  /** Below this → call writing dominates (bearish positioning). */
  bearish: 0.9,
} as const;

export type PcrBias = "bullish" | "bearish" | "neutral";

export interface PcrReading {
  bias: PcrBias;
  label: string;
  /** Tailwind colour class for the card (text-*). */
  tone: string;
  detail: string;
}

/**
 * Interpret a PCR (total PE OI ÷ total CE OI) with the canonical bands.
 * A null / non-finite PCR is "unavailable", never "neutral" — an unknown
 * reading must not look like a measured one.
 */
export function readPcr(pcr: number | null | undefined): PcrReading {
  if (pcr == null || !Number.isFinite(pcr) || pcr <= 0) {
    return {
      bias: "neutral",
      label: "—",
      tone: "text-muted-foreground",
      detail: "PCR unavailable",
    };
  }
  if (pcr > PCR_BANDS.bullish) {
    return {
      bias: "bullish",
      label: "Bullish",
      tone: "text-emerald-500",
      detail: "Bullish — put writing dominates",
    };
  }
  if (pcr < PCR_BANDS.bearish) {
    return {
      bias: "bearish",
      label: "Bearish",
      tone: "text-red-500",
      detail: "Bearish — call writing dominates",
    };
  }
  return {
    bias: "neutral",
    label: "Neutral",
    tone: "text-yellow-500",
    detail: "Balanced market",
  };
}
