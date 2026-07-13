// ═══════════════════════════════════════════════════════════
// Outcome Pipeline (shared by Zero Hero, SMC, BTST, Intraday)
//
// For every Scanner Result, attaches a resolved outcome:
//   • Outcome   : WIN | LOSS | NO_FILL | CANCELLED | EXPIRED
//   • ExitReason: TP1 | TP2 | SL | Manual | Time Exit | Expiry
//   • ExitPrice, ExitTime, MFE, MAE, Final R-Multiple, Holding Time
//
// Design (reuse, no duplication):
//   • EXECUTED trades  → Trade Audit sidecar (:4001) is the single
//     source of truth. Its recorder already tracks MFE/MAE/TP-SL/R/
//     holding via price feeds; we only READ + copy those fields.
//   • UNEXECUTED tradeable signals (NO_FILL) → Replay Engine
//     (:4002) reconstructs the REAL recorded underlying candles and
//     paper-simulates the outcome. We never synthesize prices.
//   • REJECT / NO_TRADE → CANCELLED (correctly did not trade).
//
// Idempotency: writes are deterministic UPDATEs keyed by the scanner
// result id (no inserts). Matching is a stable greedy nearest-in-time
// assignment with a consumed-trade set, so re-running never produces
// duplicate updates or inconsistent outcomes.
// ═══════════════════════════════════════════════════════════

import {
  getScannerResults,
  updateScannerResultOutcome,
} from "@/lib/market-history-client";
import {
  getTrades,
  type TradeRecord,
} from "@/lib/trade-audit-client";
import { getSessionCandlesForReplay } from "@/lib/market/replay-engine";

// Scanner strategy label → Trade Audit strategy_id(s) that hold its trades.
export const STRATEGY_ALIASES: Record<string, string[]> = {
  ZERO_HERO: ["ZERO_HERO_AI", "ZERO_HERO"],
  SMC: ["SMC"],
  BTST: ["BTST"],
  INTRADAY: ["INTRADAY"],
};

export const ALL_STRATEGIES = Object.keys(STRATEGY_ALIASES);

export type PipelineOutcome =
  | "WIN"
  | "LOSS"
  | "NO_FILL"
  | "CANCELLED"
  | "EXPIRED";

export type PipelineExitReason =
  | "TP1"
  | "TP2"
  | "SL"
  | "Manual"
  | "Time Exit"
  | "Expiry"
  | null;

export interface ResolvedOutcome {
  filled: boolean;
  outcome: PipelineOutcome;
  exitReason: PipelineExitReason;
  exitPrice: number | null;
  exitTime: string | null;
  mfe: number | null;
  mae: number | null;
  finalRMultiple: number | null;
  holdingTimeSec: number | null;
  // legacy aliases retained for downstream compatibility
  result: string | null;
  finalPnl: number | null;
}

const MATCH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

function mapExitReason(er: string | null | undefined): PipelineExitReason {
  switch (er) {
    case "tp1":
      return "TP1";
    case "tp2":
    case "tp3":
      return "TP2";
    case "stop_loss":
    case "trailing_stop":
      return "SL";
    case "manual":
      return "Manual";
    case "time_exit":
    case "btst_square_off":
      return "Time Exit";
    default:
      return null;
  }
}

// Copy a CLOSED Trade Audit record's lifecycle fields onto the scanner result.
function mapTradeToOutcome(t: TradeRecord): ResolvedOutcome {
  // Options that closed with no explicit TP/SL/Manual reason are treated as
  // expired at/near expiry.
  const reason = mapExitReason(t.exitReason);
  const exitReason: PipelineExitReason =
    t.instrumentType === "OPTIONS" && !reason ? "Expiry" : reason;
  const outcome: PipelineOutcome =
    t.instrumentType === "OPTIONS" && !reason
      ? "EXPIRED"
      : (t.netPnl ?? 0) > 0
        ? "WIN"
        : "LOSS";
  const risk = Math.abs((t.entryPrice ?? 0) - (t.stopLoss ?? 0));
  const finalPnl = t.netPnl ?? null;
  const finalR =
    risk > 0 && finalPnl != null ? finalPnl / risk : (t.rMultiple ?? null);
  return {
    filled: true,
    outcome,
    exitReason,
    exitPrice: t.exitPrice ?? null,
    exitTime: t.exitTime ?? null,
    mfe: t.mfe ?? null,
    mae: t.mae ?? null,
    finalRMultiple: t.rMultiple ?? finalR,
    holdingTimeSec: t.timeInTradeSec ?? null,
    result: exitReason,
    finalPnl,
  };
}

// Best-effort paper simulation on REAL recorded underlying candles,
// reusing the Replay Engine. Produces a DIRECTIONAL outcome
// (WIN/LOSS) + exit reason/time for tradeable signals whose
// underlying candles were captured (index strategies: ZERO_HERO/SMC/BTST).
//
// For option strategies we keep magnitude fields (MFE/MAE/R/exitPrice)
// NULL — premium excursions cannot be derived from the underlying, so
// we never emit misleading magnitudes. Equity signals (INTRADAY) only
// get full fields when their (stock) candles are recorded; otherwise
// they fall through to NO_FILL (recorder captures indices only).
async function simulatePaperOutcome(sr: any): Promise<ResolvedOutcome | null> {
  const entry = sr.entry;
  const sl = sr.sl;
  const tp1 = sr.tp1 ?? sr.tp1;
  if (typeof entry !== "number" || typeof sl !== "number") return null;

  const t0 = new Date(sr.timestamp).getTime();
  if (!Number.isFinite(t0)) return null;

  let candles: any[] = [];
  try {
    candles = await getSessionCandlesForReplay(sr.symbol, sr.timestamp);
  } catch {
    return null;
  }
  if (!candles.length) return null;

  const relevant = candles.filter(
    (c) => Number.isFinite(new Date(c.timestamp).getTime()) &&
      new Date(c.timestamp).getTime() >= t0,
  );
  if (!relevant.length) return null;

  const isLong = sr.decision !== "SELL";
  const isOption = typeof sr.selectedStrike === "number" && sr.selectedStrike > 0;
  let mfe = 0;
  let mae = 0;
  let exitPrice: number | null = null;
  let exitReason: PipelineExitReason = null;
  let exitIdx = -1;

  for (let i = 0; i < relevant.length; i++) {
    const c = relevant[i];
    const price = c.close ?? c.high ?? c.low ?? c.open;
    const fav = isLong ? price - entry : entry - price;
    const adv = isLong ? entry - price : price - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;

    if (tp1 != null) {
      if (isLong && price >= tp1) {
        exitPrice = tp1;
        exitReason = "TP1";
        exitIdx = i;
        break;
      }
      if (!isLong && price <= tp1) {
        exitPrice = tp1;
        exitReason = "TP1";
        exitIdx = i;
        break;
      }
    }
    if (isLong && price <= sl) {
      exitPrice = sl;
      exitReason = "SL";
      exitIdx = i;
      break;
    }
    if (!isLong && price >= sl) {
      exitPrice = sl;
      exitReason = "SL";
      exitIdx = i;
      break;
    }
  }

  const last = relevant[relevant.length - 1];
  if (exitIdx < 0) {
    // Session ended without a TP/SL touch → treat as Time Exit at last price.
    exitPrice = last.close ?? last.high ?? last.low ?? entry;
    exitReason = "Time Exit";
    exitIdx = relevant.length - 1;
  }

  const risk = Math.abs(entry - sl);
  const reward = exitPrice != null ? Math.abs(exitPrice - entry) : 0;
  const finalR = risk > 0 ? reward / risk : 0;
  const win = isLong ? (exitPrice ?? entry) >= entry : (exitPrice ?? entry) <= entry;
  const exitTime = relevant[exitIdx]?.timestamp ?? null;
  const holdingTimeSec = exitTime
    ? Math.max(0, Math.round((new Date(exitTime).getTime() - t0) / 1000))
    : null;
  const finalPnl = isLong ? reward : -reward;

  // Option premium magnitudes aren't derivable from the underlying → null them
  // so we never report misleading MFE/MAE/R. Equity signals keep real values.
  const magNull = isOption;
  return {
    filled: false,
    outcome: win ? "WIN" : "LOSS",
    exitReason,
    exitPrice: magNull ? null : exitPrice,
    exitTime,
    mfe: magNull ? null : mfe,
    mae: magNull ? null : mae,
    finalRMultiple: magNull ? null : finalR,
    holdingTimeSec,
    result: exitReason,
    finalPnl: magNull ? null : finalPnl,
  };
}

export interface ResolveFilters {
  strategies?: string[];
  symbols?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface ResolveSummary {
  scanned: number;
  resolved: number;
  skippedOpen: number;
  byOutcome: Record<string, number>;
  errors: number;
}

// Resolve outcomes for every (filtered) scanner result and write them back.
// Deterministic + idempotent: same inputs → same writes.
export async function resolveOutcomes(
  filters: ResolveFilters = {},
): Promise<ResolveSummary> {
  const strategies = filters.strategies ?? ALL_STRATEGIES;

  // 1) Load scanner results, keep only the 4 migrated strategies (+ filters).
  const all = await getScannerResults({ limit: filters.limit ?? 100000 });
  const want = all
    .filter((r: any) => strategies.includes(r.strategy))
    .filter((r: any) => !filters.symbols?.length || filters.symbols.includes(r.symbol))
    .filter((r: any) => !filters.dateFrom || r.timestamp >= filters.dateFrom)
    .filter(
      (r: any) =>
        !filters.dateTo || r.timestamp <= `${filters.dateTo}T23:59:59.999Z`,
    )
    .sort(
      (a: any, b: any) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

  // 2) Load matching Trade Audit trades (strategy aliases × symbols).
  const aliases = [
    ...new Set(strategies.flatMap((s) => STRATEGY_ALIASES[s] ?? [s])),
  ];
  const symbols = filters.symbols ?? [...new Set(want.map((r: any) => r.symbol))];
  const tradesBySymbol = new Map<string, TradeRecord[]>();
  for (const alias of aliases) {
    for (const symbol of symbols) {
      try {
        const page = await getTrades({
          strategyId: alias,
          symbol,
          pageSize: 100000,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
        });
        for (const t of page.items ?? []) {
          const arr = tradesBySymbol.get(symbol) ?? [];
          arr.push(t);
          tradesBySymbol.set(symbol, arr);
        }
      } catch {
        /* trade-audit unavailable — fall back to CANCELLED/NO_FILL */
      }
    }
  }

  // 3) Greedy, nearest-in-time matching with a consumed-trade set.
  const consumed = new Set<string>();
  const summary: ResolveSummary = {
    scanned: want.length,
    resolved: 0,
    skippedOpen: 0,
    byOutcome: {},
    errors: 0,
  };

  for (const sr of want) {
    try {
      const aliasesFor = STRATEGY_ALIASES[sr.strategy] ?? [sr.strategy];
      const candidates = (tradesBySymbol.get(sr.symbol) ?? []).filter(
        (t) => aliasesFor.includes(t.strategyId) && !consumed.has(t.id),
      );
      const tScan = new Date(sr.timestamp).getTime();

      let best: TradeRecord | null = null;
      let bestDt = Infinity;
      for (const t of candidates) {
        const dt = Math.abs(new Date(t.createdAtIst).getTime() - tScan);
        if (dt < bestDt && dt <= MATCH_WINDOW_MS) {
          best = t;
          bestDt = dt;
        }
      }

      let fields: ResolvedOutcome | null = null;

      if (best) {
        if (best.status === "closed") {
          fields = mapTradeToOutcome(best);
          consumed.add(best.id);
        } else {
          // Still open → leave unresolved; re-resolved once it closes.
          summary.skippedOpen++;
          continue;
        }
      } else {
        const tradeable =
          sr.decision === "BUY" || sr.decision === "SELL";
        if (!tradeable) {
          fields = {
            filled: false,
            outcome: "CANCELLED",
            exitReason: null,
            exitPrice: null,
            exitTime: null,
            mfe: null,
            mae: null,
            finalRMultiple: null,
            holdingTimeSec: null,
            result: null,
            finalPnl: null,
          };
        } else {
          const paper = await simulatePaperOutcome(sr);
          fields = paper ?? {
            filled: false,
            outcome: "NO_FILL",
              exitReason: null,
              exitPrice: null,
              exitTime: null,
              mfe: null,
              mae: null,
              finalRMultiple: null,
              holdingTimeSec: null,
              result: null,
              finalPnl: null,
            };
        }
      }

      const ok = await updateScannerResultOutcome(sr.id, fields as any);
      if (ok) {
        summary.resolved++;
        const k = fields.outcome;
        summary.byOutcome[k] = (summary.byOutcome[k] ?? 0) + 1;
      }
    } catch {
      summary.errors++;
    }
  }

  return summary;
}
