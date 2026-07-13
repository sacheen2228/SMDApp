// ═══════════════════════════════════════════════════════════
// Evaluation Framework (M7)
//
// Reuses (does NOT replace) the existing components:
//   • Trade Audit   → trade-level metrics (win rate, profit factor,
//                     expectancy, max drawdown, avg R, holding time,
//                     MFE/MAE) via trade-audit-client (HTTP :4001)
//   • Scanner Results → classification metrics (precision, recall, F1,
//                     confusion matrix) from the ML dataset in
//                     market_history.db, which natively carries
//                     engineVersion / featureVersion for filtering
//
// No trading logic is modified. The recorder/replay architecture is
// untouched. Trade Audit is read through its existing client.
// ═══════════════════════════════════════════════════════════

import {
  TRADE_AUDIT_BASE,
  type TradeRecord,
  type TradeFilters,
} from "@/lib/trade-audit-client";
import { getScannerResults, getSnapshotVersion } from "@/lib/market-history-client";

export interface EvaluationFilters {
  strategy?: string; // Zero Hero | SMC | BTST | Intraday (substring match)
  symbol?: string;
  dateFrom?: string;
  dateTo?: string;
  engineVersion?: string;
  featureVersion?: number;
}

export interface TradeMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  openTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  avgRMultiple: number;
  avgHoldingTimeSec: number | null;
  avgMfe: number | null;
  avgMae: number | null;
}

export interface ClassificationMetrics {
  totalScans: number;
  labeledSamples: number;
  unlabeledSamples: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  confusionMatrix: { tp: number; fp: number; tn: number; fn: number };
}

export interface EvaluationReport {
  filters: EvaluationFilters;
  tradeMetrics: TradeMetrics;
  classification: ClassificationMetrics;
  generatedAt: string;
}

// ── Normalization / matching helpers ───────────────────────────────

function norm(s?: string): string {
  return (s || "").toLowerCase().replace(/[\s_-]+/g, "");
}

function strategyMatches(filter?: string, candidate?: string): boolean {
  if (!filter) return true;
  const f = norm(filter);
  const c = norm(candidate);
  return c.includes(f) || f.includes(c);
}

function matchDate(ts?: string, from?: string, to?: string): boolean {
  if (!ts) return true;
  if (from && ts < from) return false;
  if (to && ts > `${to}T23:59:59.999Z`) return false;
  return true;
}

const POSITIVE_TOKENS = [
  "BUYCALL", "BUYPUT", "BUY", "CALL", "PUT", "LONG", "SELL",
  "BUYCALLOPTION", "BUYPUTOPTION",
];
const NEGATIVE_TOKENS = [
  "REJECT", "NOTRADE", "NO_TRADE", "HOLD", "WAIT", "NONE",
  "SELLCALL", "SELLPUT",
];

// A scanner "decision" is a POSITIVE prediction when it says to take a
// directional trade; otherwise it is a NEGATIVE prediction (reject/hold).
export function isPositiveDecision(d?: string): boolean {
  if (!d) return false;
  const u = norm(d).toUpperCase().replace(/_/g, "");
  if (POSITIVE_TOKENS.some((t) => u === t || u.includes(t))) return true;
  if (NEGATIVE_TOKENS.some((t) => u === t || u.includes(t))) return false;
  return false;
}

// ── Trade-level metrics (from Trade Audit records) ──────────────────

function isWin(t: TradeRecord): boolean {
  if (t.verification && typeof t.verification.win === "boolean") {
    return t.verification.win;
  }
  if (typeof t.netPnl === "number") return t.netPnl > 0;
  if (typeof t.grossPnl === "number") return t.grossPnl > 0;
  return false;
}

export function computeTradeMetrics(trades: TradeRecord[]): TradeMetrics {
  const closed = trades.filter((t) => t.status === "closed");
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let rSum = 0;
  let rN = 0;
  let holdSum = 0;
  let holdN = 0;
  let mfeSum = 0;
  let mfeN = 0;
  let maeSum = 0;
  let maeN = 0;

  // Equity curve for drawdown (ordered by exit time).
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  const sorted = [...closed].sort((a, b) =>
    (a.exitTime || "").localeCompare(b.exitTime || "")
  );
  for (const t of sorted) {
    const pnl = t.netPnl ?? t.grossPnl ?? 0;
    eq += pnl;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;

    if (isWin(t)) {
      wins++;
      if (pnl > 0) grossProfit += pnl;
    } else {
      losses++;
      if (pnl < 0) grossLoss += Math.abs(pnl);
    }
    if (typeof t.rMultiple === "number") {
      rSum += t.rMultiple;
      rN++;
    }
    if (typeof t.timeInTradeSec === "number") {
      holdSum += t.timeInTradeSec;
      holdN++;
    }
    if (typeof t.mfe === "number") {
      mfeSum += t.mfe;
      mfeN++;
    }
    if (typeof t.mae === "number") {
      maeSum += t.mae;
      maeN++;
    }
  }

  const open = trades.length - closed.length;
  const total = wins + losses;
  const winRate = total > 0 ? wins / total : 0;
  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? null
        : 0;
  const expectancy = total > 0 ? (grossProfit - grossLoss) / total : 0;
  const avgR = rN > 0 ? rSum / rN : 0;
  const avgHold = holdN > 0 ? holdSum / holdN : null;
  const avgMfe = mfeN > 0 ? mfeSum / mfeN : null;
  const avgMae = maeN > 0 ? maeSum / maeN : null;
  const maxDrawdownPct = peak > 0 ? (maxDD / peak) * 100 : null;

  return {
    totalTrades: trades.length,
    wins,
    losses,
    openTrades: open,
    winRate,
    profitFactor,
    expectancy,
    maxDrawdown: maxDD,
    maxDrawdownPct,
    avgRMultiple: avgR,
    avgHoldingTimeSec: avgHold,
    avgMfe,
    avgMae,
  };
}

// ── Classification metrics (from Scanner Results dataset) ───────────

export interface ScannerEvalRow {
  symbol: string;
  strategy: string;
  timestamp: string;
  snapshotId?: string;
  decision: string;
  engineVersion?: string;
  featureVersion?: number;
  outcomeFilled: boolean;
  outcomeWin: boolean;
}

// Reconstruct an eval row from a ScannerResult payload (the stored JSON).
// Reads the enriched outcome written by the Outcome Pipeline:
//   outcome: WIN | LOSS | NO_FILL | CANCELLED | EXPIRED
//   exitReason: TP1 | TP2 | SL | Manual | Time Exit | Expiry
export function scannerRowToEval(r: any): ScannerEvalRow {
  const o = r.outcome || {};
  const outcome: string | null = o.outcome ?? null;
  const exitReason: string | null = o.exitReason ?? o.result ?? null;
  const decision = r.decision;
  // A sample is "labeled" when it has a definitive outcome we can
  // judge win/loss on: WIN, LOSS, CANCELLED (correct reject), EXPIRED.
  const labeled =
    outcome === "WIN" ||
    outcome === "LOSS" ||
    outcome === "CANCELLED" ||
    outcome === "EXPIRED" ||
    exitReason === "CANCELLED";
  const win = outcome === "WIN";
  return {
    symbol: r.symbol,
    strategy: r.strategy,
    timestamp: r.timestamp,
    snapshotId: r.snapshotId,
    decision: r.decision,
    engineVersion: r.engineVersion,
    featureVersion: r.featureVersion,
    outcomeFilled: !!labeled,
    outcomeWin: !!win,
  };
}

export function computeClassification(rows: ScannerEvalRow[]): ClassificationMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let labeled = 0;
  let unlabeled = 0;

  for (const r of rows) {
    const pos = isPositiveDecision(r.decision);
    if (!r.outcomeFilled) {
      unlabeled++;
      continue;
    }
    labeled++;
    if (pos && r.outcomeWin) tp++;
    else if (pos && !r.outcomeWin) fp++;
    else if (!pos && r.outcomeWin) fn++;
    else tn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  return {
    totalScans: rows.length,
    labeledSamples: labeled,
    unlabeledSamples: unlabeled,
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1,
    confusionMatrix: { tp, fp, tn, fn },
  };
}

// ── Trade Audit fetch (reuses trade-audit-client) ──────────────────

function snapshotIdOf(rawTrade: any): string | undefined {
  try {
    const ctx = JSON.parse(rawTrade.market_context_json);
    return ctx?.snapshotId;
  } catch {
    return undefined;
  }
}

// Fetch Trade Audit records, applying strategy/date filters server-side and
// engine/feature-version filters client-side (via snapshot → market_history).
async function fetchTradeRecords(
  filters: EvaluationFilters
): Promise<TradeRecord[]> {
  const q = new URLSearchParams();
  if (filters.symbol) q.set("symbol", filters.symbol);
  if (filters.dateFrom) q.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) q.set("dateTo", filters.dateTo);
  q.set("pageSize", "100000");

  const res = await fetch(`${TRADE_AUDIT_BASE}/api/trades?${q.toString()}`);
  if (!res.ok) throw new Error(`trade-audit /api/trades ${res.status}`);
  const data = (await res.json()) as { items: any[] };
  let items = data.items as any[];

  items = items.filter((t) => strategyMatches(filters.strategy, t.strategy_id));

  const needVersion =
    filters.engineVersion != null || filters.featureVersion != null;
  if (needVersion) {
    const versions = await Promise.all(
      items.map((t) => getSnapshotVersion(snapshotIdOf(t) ?? "")),
    );
    items = items.filter((t, i) => {
      const v = versions[i];
      if (!v) return false;
      if (
        filters.engineVersion != null &&
        String(v.engineVersion) !== String(filters.engineVersion)
      ) {
        return false;
      }
      if (
        filters.featureVersion != null &&
        Number(v.featureVersion) !== Number(filters.featureVersion)
      ) {
        return false;
      }
      return true;
    });
  }

  return items as TradeRecord[];
}

// ── Classification-only evaluation (Scanner Results) ────────────────

export async function evaluateScanner(
  filters: EvaluationFilters = {}
): Promise<ClassificationMetrics> {
  const raw = await getScannerResults({ symbol: filters.symbol });
  const rows = raw
    .map(scannerRowToEval)
    .filter(
      (r) =>
        strategyMatches(filters.strategy, r.strategy) &&
        matchDate(r.timestamp, filters.dateFrom, filters.dateTo) &&
        (filters.engineVersion == null ||
          r.engineVersion === filters.engineVersion) &&
        (filters.featureVersion == null ||
          r.featureVersion === filters.featureVersion)
    );
  return computeClassification(rows);
}

// ── Full evaluation ─────────────────────────────────────────────────

export async function evaluate(
  filters: EvaluationFilters = {}
): Promise<EvaluationReport> {
  let tradeMetrics: TradeMetrics;
  try {
    const trades = await fetchTradeRecords(filters);
    tradeMetrics = computeTradeMetrics(trades);
  } catch {
    // Trade Audit sidecar unavailable — report empty trade metrics.
    tradeMetrics = computeTradeMetrics([]);
  }

  const classification = await evaluateScanner(filters);

  return {
    filters,
    tradeMetrics,
    classification,
    generatedAt: new Date().toISOString(),
  };
}
