// EMA 9/21/50 LIVE veto — gates scanner Telegram alerts when
// BRAIN_FLAGS.emaStructureLive is true.
//
// Pure and offline: no network, no DB. Fail-open on missing/stale EMA data —
// a veto is only applied when LIVE/FRESH closed-candle evidence exists.
// Hard-opposition rule matches directional-consistency: only a FULLY opposite
// stack blocks (TRANSITIONAL / choppy = EMA50 lag, never a block alone).

import type { EmaStructure } from "./ema-structure";
import type { ConsistencyVerdict } from "./directional-consistency";
import type { OptionsConfirmationVerdict } from "./options-confirmation";

export interface EmaLiveVetoInput {
  /** BRAIN_FLAGS.emaStructureLive — OFF = shadow display only, never blocks. */
  live: boolean;
  /** Direction of the trade being alerted (BULLISH = CE/BUY, BEARISH = PE). */
  tradeDirection: "BULLISH" | "BEARISH";
  emaStructure?: Pick<EmaStructure, "alignment" | "direction" | "dataQuality" | "lastCandleTime"> | null;
  directionalCheck?: ConsistencyVerdict | null;
  optionsConfirmation?: OptionsConfirmationVerdict | null;
  /** Clock seam for tests; defaults to Date.now(). */
  nowMs?: number;
}

export interface EmaLiveVetoResult {
  block: boolean;
  reason?: string;
}

const FRESH_QUALITIES = new Set(["LIVE", "FRESH"]);
/** EMA evidence older than this is treated as stale even if quality says LIVE. */
const STALE_MS = 60 * 60 * 1000;

function hasUsableEma(e: EmaLiveVetoInput["emaStructure"], nowMs: number): e is NonNullable<EmaLiveVetoInput["emaStructure"]> {
  if (!e) return false;
  if (!FRESH_QUALITIES.has(e.dataQuality)) return false;
  if (e.lastCandleTime != null && nowMs - e.lastCandleTime > STALE_MS) return false;
  return true;
}

/**
 * Evaluate the live EMA veto for one candidate about to be alerted.
 * Returns { block: false } unless live is ON and fresh evidence is decisive.
 */
export function evaluateEmaLiveVeto(input: EmaLiveVetoInput): EmaLiveVetoResult {
  if (!input.live) return { block: false };

  const nowMs = input.nowMs ?? Date.now();
  const ema = input.emaStructure;
  if (!hasUsableEma(ema, nowMs)) return { block: false };

  // Options chain disagrees with the trade leg → hard block.
  if (input.optionsConfirmation === "ADVERSE") {
    return { block: true, reason: "EMA live: options confirmation ADVERSE" };
  }

  // EMA/MACD/structure disagree with the leg → hard block.
  if (input.directionalCheck === "CONFLICT") {
    return { block: true, reason: "EMA live: directional consistency CONFLICT" };
  }

  // Full stack against the trade → hard block. TRANSITIONAL / MIXED / NEUTRAL
  // never blocks on alignment alone (EMA50 lag must not kill an early reversal).
  const fullyOpposite =
    (input.tradeDirection === "BULLISH" && ema.alignment === "BEARISH") ||
    (input.tradeDirection === "BEARISH" && ema.alignment === "BULLISH");
  if (fullyOpposite) {
    return {
      block: true,
      reason: `EMA live: ${ema.alignment} stack opposes ${input.tradeDirection} trade`,
    };
  }

  return { block: false };
}
