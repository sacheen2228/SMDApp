// quant-performance.ts — closed-trade performance metrics for UNIVERSAL_QUANT_V1.
//
// ISOLATION: reads ONLY the Quant* tables. Pure `computePerformance` does all
// the math (unit-tested); `getQuantPerformanceFromDb` is the thin loader.
//
// Definitions:
//   closed row   status startsWith "CLOSED"
//   netPnl       Σ(realizedPnl − (estCosts ?? 0)) — null P&L counts as 0
//   win / loss   net-of-cost trade P&L > 0 / < 0 (zero-P&L rows are neither)
//   profitFactor grossWin / grossLoss (grossLoss = positive magnitude);
//                0 when grossLoss ≤ 0 and grossWin > 0; null when n = 0 or
//                there is nothing to divide (no wins AND no losses)
//   maxDrawdown  peak-to-trough of the cumulative netPnl curve ordered by
//                exitTime asc (positive number, 0 when never under water)
//   slHitRate    share closed by a stop (CLOSED_SL / CLOSED_TRAILING_SL /
//                CLOSED_BREAKEVEN)
//   tpHitRates   per-level share of rows whose terminal tpHitLevel is that
//                level (TP1..TP4)
//   partialExitRate  share that booked the TP1 partial (tpHitLevel === "TP1")
//   sampleSizeCaveat "…not statistically significant" when n < 30

import { db } from "@/lib/db";

export interface QuantPerfRow {
  status: string;
  strategy: string;
  regime: string | null;
  mode: string;
  realizedPnl: number | null;
  estCosts: number | null;
  entryTime: Date | null;
  exitTime: Date | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  tp4: number | null;
  tpHitLevel: string | null;
  lots: number | null;
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
}

export interface QuantPerfCore {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  avgWin: number | null;
  avgLoss: number | null; // negative — average signed P&L of the losing trades
  expectancy: number | null;
  profitFactor: number | null;
}

export interface QuantPerformanceResult extends QuantPerfCore {
  maxDrawdown: number;
  avgHoldingMinutes: number | null;
  slHitRate: number | null;
  tpHitRates: Record<string, number>;
  partialExitRate: number | null;
  byStrategy: Record<string, QuantPerfCore>;
  byRegime: Record<string, QuantPerfCore>;
  byMode: Record<string, QuantPerfCore>;
  sampleSizeCaveat: string | null;
}

const STOP_STATUSES = new Set(["CLOSED_SL", "CLOSED_TRAILING_SL", "CLOSED_BREAKEVEN"]);
const TP_LEVELS = ["TP1", "TP2", "TP3", "TP4"] as const;

function netOf(row: QuantPerfRow): number {
  return (row.realizedPnl ?? 0) - (row.estCosts ?? 0);
}

function core(rows: QuantPerfRow[]): QuantPerfCore {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, wins: 0, losses: 0, winRate: null, netPnl: 0, avgWin: null, avgLoss: null, expectancy: null, profitFactor: null };
  }
  const nets = rows.map(netOf);
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0)); // positive magnitude
  const netPnl = nets.reduce((a, b) => a + b, 0);
  let profitFactor: number | null;
  if (grossLoss <= 0 && grossWin > 0) profitFactor = 0;
  else if (grossLoss > 0 && grossWin > 0) profitFactor = Math.round((grossWin / grossLoss) * 1000) / 1000;
  else profitFactor = null;
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round((wins.length / n) * 10000) / 100,
    netPnl: Math.round(netPnl * 100) / 100,
    avgWin: wins.length > 0 ? Math.round((grossWin / wins.length) * 100) / 100 : null,
    avgLoss: losses.length > 0 ? Math.round((losses.reduce((a, b) => a + b, 0) / losses.length) * 100) / 100 : null,
    expectancy: Math.round((netPnl / n) * 100) / 100,
    profitFactor,
  };
}

function groupBy(rows: QuantPerfRow[], key: (r: QuantPerfRow) => string): Record<string, QuantPerfCore> {
  const buckets: Record<string, QuantPerfRow[]> = {};
  for (const r of rows) {
    const k = key(r) || "unknown";
    (buckets[k] ??= []).push(r);
  }
  const out: Record<string, QuantPerfCore> = {};
  for (const [k, bucket] of Object.entries(buckets)) out[k] = core(bucket);
  return out;
}

export function computePerformance(rows: QuantPerfRow[]): QuantPerformanceResult {
  const closed = (rows ?? []).filter((r) => typeof r.status === "string" && r.status.startsWith("CLOSED"));
  const base = core(closed);
  const n = base.n;

  // Max drawdown over the cumulative netPnl curve (exitTime asc; rows without
  // an exitTime sort last, stable).
  const ordered = [...closed].sort((a, b) => {
    const ta = a.exitTime ? a.exitTime.getTime() : Infinity;
    const tb = b.exitTime ? b.exitTime.getTime() : Infinity;
    return ta === tb ? 0 : ta - tb;
  });
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of ordered) {
    cumulative += netOf(r);
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const holding = closed
    .filter((r) => r.entryTime != null && r.exitTime != null)
    .map((r) => (r.exitTime!.getTime() - r.entryTime!.getTime()) / 60_000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  const avgHoldingMinutes =
    holding.length > 0 ? Math.round((holding.reduce((a, b) => a + b, 0) / holding.length) * 100) / 100 : null;

  const slHits = closed.filter((r) => STOP_STATUSES.has(r.status)).length;
  const tpHitRates: Record<string, number> = {};
  for (const level of TP_LEVELS) {
    const hits = closed.filter((r) => r.tpHitLevel === level).length;
    tpHitRates[level] = n > 0 ? Math.round((hits / n) * 10000) / 100 : 0;
  }
  const partials = closed.filter((r) => r.tpHitLevel === "TP1").length;

  return {
    ...base,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    avgHoldingMinutes,
    slHitRate: n > 0 ? Math.round((slHits / n) * 10000) / 100 : null,
    tpHitRates,
    partialExitRate: n > 0 ? Math.round((partials / n) * 10000) / 100 : null,
    byStrategy: groupBy(closed, (r) => r.strategy),
    byRegime: groupBy(closed, (r) => r.regime ?? "unknown"),
    byMode: groupBy(closed, (r) => r.mode),
    sampleSizeCaveat: n < 30 ? `Sample size n=${n} is small — metrics are not statistically significant` : null,
  };
}

/** Loads the most recent closed quant paper trades and computes performance. */
export async function getQuantPerformanceFromDb(): Promise<QuantPerformanceResult> {
  const rows = await db.quantPaperTrade.findMany({
    where: { status: { startsWith: "CLOSED" }, engineVersion: "UNIVERSAL_QUANT_V1" },
    orderBy: { exitTime: "desc" },
    take: 1000,
    select: {
      status: true, strategy: true, regime: true, mode: true,
      realizedPnl: true, estCosts: true, entryTime: true, exitTime: true,
      stopLoss: true, tp1: true, tp2: true, tp3: true, tp4: true,
      tpHitLevel: true, lots: true, quantity: true, entryPrice: true, exitPrice: true,
    },
  });
  return computePerformance(rows as QuantPerfRow[]);
}
