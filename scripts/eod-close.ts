// scripts/eod-close.ts
//
// End-of-day trade closure for the Trade Audit (backtest verification) engine.
//
// Problem this solves: trades that are still ACTIVE at market close (never hit
// TP or SL, or were manually exited) would otherwise stay "open" forever and
// skew the strategy's measured accuracy (only resolved trades count).
//
// This script force-closes every open trade using its REAL closing premium
// (pulled from the live option chain for that symbol/strike/type) so the
// audit engine can resolve a true WIN/LOSS outcome via the paper-simulation
// pipeline. Then it re-runs resolveOutcomes to refresh accuracy stats.
//
// Run manually:  bun scripts/eod-close.ts
// Or via cron (dailyScanCron calls runEodClose() after market close).

import { getTrades, closeTrade, type TradeFilters, type TradesPage } from "../src/lib/trade-audit-client";
import { resolveOutcomes, ALL_STRATEGIES } from "../src/lib/market/outcome-pipeline";

const BASE = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

async function getClosingPremium(symbol: string, strike: number, optionType: "CE" | "PE"): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    const json = await res.json();
    const rows: any[] = json?.data?.data || [];
    const row = rows.find((r) => r.strike === strike);
    if (!row) return null;
    const leg = optionType === "CE" ? row.ce : row.pe;
    return leg?.ltp > 0 ? leg.ltp : null;
  } catch {
    return null;
  }
}

export async function runEodClose(): Promise<{ closed: number; skipped: number; errors: number }> {
  const filters: TradeFilters = { status: "open" };
  let closed = 0, skipped = 0, errors = 0;
  let page = 1;
  const seen = new Set<string>();

  // The audit API paginates (default page size 50, max 500); walk all open trades.
  while (true) {
    const data: TradesPage = await getTrades({ ...filters, page, pageSize: 500 } as any);
    const trades = (data?.items || []) as any[];
    if (!trades.length) break;

    for (const t of trades) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);

      const sym = t.symbol;
      const strike = Number(t.strikePrice ?? t.strike ?? 0);
      const type: "CE" | "PE" = (t.optionType || "").toUpperCase() === "PE" ? "PE" : "CE";
      if (!sym || !strike) { skipped++; continue; }

      const closePx = await getClosingPremium(sym, strike, type);
      if (closePx === null) {
        // Contract not in today's chain (likely an expired/past expiry).
        // Close at entry price so it resolves as a scratch rather than
        // staying open forever and skewing the accuracy denominator.
        try {
          await closeTrade(t.id, Number(t.entryPrice) || 0, "time_exit");
          skipped++;
        } catch {
          errors++;
        }
        continue;
      }

      try {
        await closeTrade(t.id, closePx, "time_exit");
        closed++;
      } catch {
        errors++;
      }
    }

    if (trades.length < 500) break; // last page
    page++;
    if (page > 50) break; // safety
  }

  // Refresh verification stats (paper-simulates real outcomes for closed trades).
  try {
    await resolveOutcomes({ strategies: ALL_STRATEGIES });
  } catch (e: any) {
    console.error("[eod-close] resolveOutcomes failed:", e?.message);
  }

  return { closed, skipped, errors };
}

// Allow direct invocation: bun scripts/eod-close.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  runEodClose()
    .then((r) => {
      console.log(`[eod-close] closed=${r.closed} skipped=${r.skipped} errors=${r.errors}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("[eod-close] FAILED:", e);
      process.exit(1);
    });
}
