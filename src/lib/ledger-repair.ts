// ledger-repair — pure helpers for correcting corrupt closed-trade rows with
// REAL exchange closes (never fabricated values).
//
// What was actually wrong in the sidecar ledger (found 2026-09-29):
//   1. 4 BTST equity rows stamped with exit prices 1 / 10 / 100 / 3000
//      (boot-cleanup placeholders) → −9,368 phantom loss.
//   2. July time_exit option rows stamped with the NEXT WEEK expiry's premium
//      at 01:25 IST cleanup (e.g. 24150 PE recorded exit 160.75 while the
//      real Jul-14 expiry close was 92.5) — wrong contract entirely.
//   3. Some PE rows stored SL/TP1 swapped (SL above entry on a long-premium
//      trade) with short-side pnl math — sign flipped.
//
// Rules encoded here (sidecar trades are long-premium, no `side` column):
//   - exit must equal the real close of the REAL contract on the effective
//     exit date (min(expiry date, recorded exit date) — a contract cannot be
//     sold after expiry).
//   - long pnl = exit − entry − fees (qty 1 premium points).
//   - inverted levels: swap SL ↔ TP1 (the intended risk band is 22% of entry
//     either way — magnitudes are identical, only the sides were flipped).

export interface LevelFix {
  stopLoss: number;
  tp1: number;
  swapped: boolean;
}

/** Long-premium levels are inverted when SL sits ABOVE entry and TP1 BELOW. */
export function isInvertedLongLevels(
  entry: number,
  stopLoss: number | null | undefined,
  tp1: number | null | undefined
): boolean {
  if (stopLoss == null || tp1 == null) return false;
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(tp1)) return false;
  if (entry <= 0) return false;
  return stopLoss > entry && tp1 < entry;
}

/** Swap the flipped SL/TP1 pair back to long-premium orientation. */
export function fixInvertedLongLevels(
  entry: number,
  stopLoss: number,
  tp1: number
): LevelFix {
  return { stopLoss: tp1, tp1: stopLoss, swapped: true };
}

/** Long-premium P&L in premium points (qty 1). net = gross − fees. */
export function longPnl(
  entry: number,
  exit: number,
  fees = 0
): { gross: number; net: number } {
  const gross = exit - entry;
  const safeFees = Number.isFinite(fees) && fees > 0 ? fees : 0;
  return { gross, net: gross - safeFees };
}

/** R-multiple against the (possibly corrected) risk distance. */
export function rMultiple(entry: number, exit: number, stopLoss: number | null | undefined): number | null {
  if (stopLoss == null || !Number.isFinite(stopLoss)) return null;
  const risk = entry - stopLoss; // positive for a correct long SL (below entry)
  if (!(risk > 0)) return null;
  return (exit - entry) / risk;
}

/**
 * Effective exit date: a contract cannot be exited after its expiry — if the
 * recorded cleanup happened after expiry (01:25 IST next mornings), the real
 * exit is the expiry-day close.
 */
export function effExitDate(expiryDate: string, exitDate: string): string {
  return expiryDate < exitDate ? expiryDate : exitDate;
}

/**
 * Contract actually traded: the first listed expiry on/after the creation
 * date (zero-hero/SMC hold to expiry; cleanup rows for already-expired
 * contracts resolve to the NEXT expiry only if created after it — which
 * means the row was recorded post-expiry and has no real contract → null).
 */
export function chooseContractExpiry(
  expiries: string[],
  createdDate: string
): string | null {
  const sorted = [...expiries].filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  return sorted.find((e) => e >= createdDate) ?? null;
}

/**
 * Does the recorded exit differ from the real close enough to matter?
 * Threshold: ₹1 or 2% of the real close, whichever is larger — absorbs
 * close-auction vs last-print noise without churn.
 */
export function exitNeedsRepair(
  recorded: number | null | undefined,
  real: number,
  entry: number
): boolean {
  if (recorded == null || !Number.isFinite(recorded)) return true;
  if (!Number.isFinite(real) || real <= 0) return false; // no real data → never touch
  const diff = Math.abs(recorded - real);
  return diff > Math.max(1, Math.abs(real) * 0.02);
}

/** ROI % of net P&L on entry. */
export function roiPct(entry: number, net: number): number {
  if (!(entry > 0)) return 0;
  return (net / entry) * 100;
}
