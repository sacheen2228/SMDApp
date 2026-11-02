// Post-09:15 opening confirmation.
// Validate actual futures open vs indicative IEP, recompute bias, gap cont/rev.

import type { PreopenStudyDay, CombinedQuantScore } from "./types";
import { getStudyDay, saveStudyDay } from "./storage";
import { gapPct, gapContinued, gapReversed } from "./analytics";
import { computeCombinedScore } from "./score";

export interface OpeningConfirmation {
  tradeDate: string;
  symbol: string;
  indicativeIep: number | null;
  actualOpen: number | null;
  openVsIepPct: number | null;
  iepConfirmed: boolean | null;
  spotFuturesAligned: boolean | null;
  gapPct: number | null;
  gapContinued: boolean | null;
  gapReversed: boolean | null;
  fiveMinAction: "WITH_GAP" | "AGAINST_GAP" | "NEUTRAL" | null;
  biasAfter: CombinedQuantScore | null;
  notes: string[];
}

/**
 * Build confirmation from study day + live open prints.
 * Caller supplies open data from candle/quote providers (no fabrication here).
 */
export function confirmOpening(
  tradeDate: string,
  symbol: string,
  live: {
    spotOpen: number | null;
    futuresOpen: number | null;
    fiveMinClose: number | null;
    dayHigh?: number | null;
    dayLow?: number | null;
    volume?: number | null;
  },
): OpeningConfirmation | null {
  const day = getStudyDay(tradeDate, symbol);
  if (!day) return null;

  const notes: string[] = [];
  const indicativeIep = day.futures?.iep ?? day.cm?.iep ?? null;
  const actualFutOpen = live.futuresOpen;
  const actualSpotOpen = live.spotOpen;

  let openVsIepPct: number | null = null;
  let iepConfirmed: boolean | null = null;
  if (indicativeIep != null && actualFutOpen != null && indicativeIep !== 0) {
    openVsIepPct = ((actualFutOpen - indicativeIep) / indicativeIep) * 100;
    iepConfirmed = Math.abs(openVsIepPct) < 0.15; // within 15 bps
    notes.push(
      iepConfirmed
        ? "Futures open matches indicative IEP"
        : `Futures open deviates ${openVsIepPct.toFixed(3)}% from IEP`,
    );
  } else {
    notes.push("Indicative IEP or futures open unavailable — confirmation incomplete");
  }

  let spotFuturesAligned: boolean | null = null;
  if (actualSpotOpen != null && actualFutOpen != null) {
    const sGap = gapPct(actualSpotOpen, day.cm?.previousClose ?? null);
    const fGap = gapPct(actualFutOpen, day.futures?.previousClose ?? day.cm?.previousClose ?? null);
    if (sGap != null && fGap != null) {
      spotFuturesAligned = Math.sign(sGap) === Math.sign(fGap) || Math.abs(sGap) < 0.05 || Math.abs(fGap) < 0.05;
      notes.push(spotFuturesAligned ? "Spot and futures gaps aligned" : "Spot and futures gaps disagree");
    }
  }

  const gap = day.cm ? gapPct(actualSpotOpen ?? day.cm.iep ?? day.cm.finalPrice, day.cm.previousClose) : null;
  const cont = gapContinued(gap, actualSpotOpen ?? day.cm?.finalPrice ?? null, live.fiveMinClose ?? day.open?.dayClose ?? null);
  const rev = gapReversed(gap, day.cm?.previousClose ?? null, live.fiveMinClose ?? day.open?.dayClose ?? null);

  let fiveMinAction: OpeningConfirmation["fiveMinAction"] = null;
  if (gap != null && live.fiveMinClose != null && actualSpotOpen != null) {
    if (Math.abs(gap) < 0.05) fiveMinAction = "NEUTRAL";
    else if (gap > 0) fiveMinAction = live.fiveMinClose > actualSpotOpen ? "WITH_GAP" : live.fiveMinClose < actualSpotOpen ? "AGAINST_GAP" : "NEUTRAL";
    else fiveMinAction = live.fiveMinClose < actualSpotOpen ? "WITH_GAP" : live.fiveMinClose > actualSpotOpen ? "AGAINST_GAP" : "NEUTRAL";
  }

  // Persist open onto study day
  day.open = {
    spotOpen: actualSpotOpen,
    futuresOpen: actualFutOpen,
    dayHigh: live.dayHigh ?? null,
    dayLow: live.dayLow ?? null,
    dayClose: live.fiveMinClose ?? null,
    volume: live.volume ?? null,
  };
  saveStudyDay(day);

  // Recompute research score with open context (still not trade auth)
  const score = computeCombinedScore({ day, quality: day.quality });

  return {
    tradeDate,
    symbol,
    indicativeIep,
    actualOpen: actualFutOpen ?? actualSpotOpen,
    openVsIepPct,
    iepConfirmed,
    spotFuturesAligned,
    gapPct: gap,
    gapContinued: cont,
    gapReversed: rev,
    fiveMinAction,
    biasAfter: score,
    notes,
  };
}
