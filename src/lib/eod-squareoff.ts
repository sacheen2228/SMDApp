// eod-squareoff — pure rules for the 15:31 IST end-of-day closer.
//
// Why this exists: trades that never hit SL/TP sat ACTIVE until the boot-time
// stale cleanup stamped them EXPIRED with exitTime but NO exit price or pnl
// (907 NULL-pnl rows in the journal). The EOD closer closes intraday trades
// at the real closing LTP the same day — never fabricated prices.
//
// Lifecycle split (by strategy):
//   - BTST: excluded — closeYesterdayBTST closes it next day at 15:25 with
//     the real EOD close (btst-scanner.ts).
//   - test rows (e2e-test / prod-verify): excluded, same convention as the
//     instrumentation stale cleanup.
//   - everything else (intraday + trailed TP1/TP2 rows): close at EOD.

/** Strategies whose lifecycle must outlive the trading day. */
export const EOD_SKIP_STRATEGIES = new Set(["BTST", "e2e-test", "prod-verify"]);

/** Open-but-closable statuses (terminal rows are already settled). */
export const EOD_CLOSABLE_STATUSES = new Set([
  "ACTIVE",
  "OPEN",
  "PENDING",
  "TP1_HIT",
  "TP2_HIT",
]);

export interface EodTradeRow {
  tradeId: string;
  strategy: string;
  status: string;
  side?: string | null;
  entryPrice: number;
  entryTime: Date | string;
}

/** Should this open journal row be squared off at the close? */
export function isEodEligible(row: EodTradeRow): boolean {
  if (!EOD_CLOSABLE_STATUSES.has(row.status)) return false;
  if (EOD_SKIP_STRATEGIES.has(row.strategy ?? "")) return false;
  return true;
}

/**
 * P&L for an EOD exit — same formula as getPnl() in activeTradeTracker
 * (qty 1 premium/equity points; SELL inverts). null when prices are invalid
 * so callers can refuse to write a fabricated close.
 */
export function computeEodClose(
  side: string,
  entryPrice: number,
  exitPrice: number
): { pnl: number; pnlPercent: number } | null {
  if (!(entryPrice > 0) || !(exitPrice > 0)) return null;
  const pnl = side === "SELL" ? entryPrice - exitPrice : exitPrice - entryPrice;
  const pnlPercent = (pnl / entryPrice) * 100;
  return {
    // `|| 0` normalizes -0 (float noise) so journals never store negative zero
    pnl: Math.round(pnl * 100) / 100 || 0,
    pnlPercent: Math.round(pnlPercent * 100) / 100 || 0,
  };
}

/** Whole minutes held, clamped at 0 for bad clocks. */
export function holdingMinutes(entryTime: Date | string, now: Date): number {
  const start = new Date(entryTime).getTime();
  if (!Number.isFinite(start)) return 0;
  const mins = Math.round((now.getTime() - start) / 60000);
  return mins > 0 ? mins : 0;
}
