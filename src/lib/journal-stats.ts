// journal-stats — pure stats for GET /api/trade-journal.
//
// Rules (why this exists):
//   - Only PRICED terminal rows (pnl != null) may vote on win/loss. Null-pnl
//     rows used to fall into `losers` (null <= 0) and drag avgLoss/winRate.
//   - EXPIRED is terminal: repaired stale-cleanup rows belong in `closed`,
//     otherwise repaired trades would never appear in the journal stats.
//   - `unpriced` is reported so dashboards can show the honesty gap instead
//     of silently rounding it away.

export interface JournalTradeLike {
  status: string;
  pnl?: number | null;
  strategy: string;
}

// Terminal = the position is GONE. TP1/TP2 are NOT terminal — they are
// intermediate trail states while the trade is still monitored (matches
// activeTradeTracker: "INTERMEDIATE HIT — trade is still open").
export const JOURNAL_TERMINAL_STATUSES = new Set([
  "SL_HIT",
  "TP3_HIT",
  "CLOSED",
  "EXPIRED",
  "CANCELLED",
]);

export const JOURNAL_OPEN_STATUSES = new Set(["ACTIVE", "OPEN", "PENDING", "TP1_HIT", "TP2_HIT"]);

export interface JournalStats {
  total: number;
  open: number;
  closed: number;
  priced: number;
  unpriced: number;
  winners: number;
  losers: number;
  winRate: number;
  totalPnL: number;
  avgWin: number;
  avgLoss: number;
  byStrategy: Record<string, number>;
}

export function computeJournalStats(trades: JournalTradeLike[]): JournalStats {
  const terminal = trades.filter((t) => JOURNAL_TERMINAL_STATUSES.has(t.status));
  const priced = terminal.filter((t) => t.pnl != null && Number.isFinite(t.pnl));
  const winners = priced.filter((t) => (t.pnl as number) > 0);
  const losers = priced.filter((t) => (t.pnl as number) <= 0);

  const totalPnL = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const winRate = priced.length > 0 ? (winners.length / priced.length) * 100 : 0;
  const avgWin =
    winners.length > 0 ? winners.reduce((s, t) => s + (t.pnl as number), 0) / winners.length : 0;
  const avgLoss =
    losers.length > 0 ? losers.reduce((s, t) => s + (t.pnl as number), 0) / losers.length : 0;

  const byStrategy: Record<string, number> = {};
  for (const t of priced) {
    byStrategy[t.strategy] = (byStrategy[t.strategy] || 0) + (t.pnl as number);
  }

  return {
    total: trades.length,
    open: trades.filter((t) => JOURNAL_OPEN_STATUSES.has(t.status)).length,
    closed: terminal.length,
    priced: priced.length,
    unpriced: terminal.length - priced.length,
    winners: winners.length,
    losers: losers.length,
    winRate: Math.round(winRate * 10) / 10,
    totalPnL: Math.round(totalPnL * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    byStrategy,
  };
}
