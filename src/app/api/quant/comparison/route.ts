// /api/quant/comparison — honest side-by-side of UNIVERSAL_QUANT_V1 paper
// performance vs the EXISTING engines' ledger in the trade-audit sidecar
// (:4001, read-only via the existing client).
//
// HONESTY CONTRACT (spec §19 — echoed in comparisonRules on every response):
//   1. Aligned windows required — pass ?dateFrom&dateTo (IST ISO dates) to
//      filter BOTH sides to the same range; an unfiltered comparison of
//      different lifetimes is meaningless.
//   2. Net-of-costs only — the quant side reports realizedPnl − estCosts via
//      computePerformance; the audit side reports netPnl after fees.
//   3. Win rate alone never establishes superiority — profit factor,
//      expectancy and max drawdown are part of every reading.
//   4. Sample size matters — small n is noise (quant side flags n<30 via
//      sampleSizeCaveat; check the audit side's per-strategy trade counts).
//
// The audit sidecar call is read-only and wrapped: on ANY failure that side
// reports { available: false, reason } — nothing is ever fabricated.

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  computePerformance,
  getQuantPerformanceFromDb,
  type QuantPerfRow,
} from "@/lib/quant/quant-performance";
import { effectiveMode } from "@/lib/quant/quant-runtime-config";
import { istIso } from "@/lib/quant/quant-data";
import { getStats, type AggregateStats } from "@/lib/trade-audit-client";

export const dynamic = "force-dynamic";

const COMPARISON_RULES = [
  "Aligned windows required: filter BOTH sides to the same date range (?dateFrom&dateTo) before comparing anything — different lifetimes are not comparable",
  "Net-of-costs only: gross P&L flatters every engine — compare netPnl after brokerage/STT/slippage on both sides",
  "Win rate alone never establishes superiority: read profit factor, expectancy and max drawdown together with it",
  "Sample size matters: small-n metrics are noise (the quant side flags n<30 via sampleSizeCaveat — check the audit side's per-strategy trade counts too)",
];

interface ExistingEnginesSide {
  available: boolean;
  reason?: string;
  engines?: Array<{
    strategyId: string;
    trades: number;
    winRate: number;
    netPnl: number;
    profitFactor: number | null;
  }>;
}

function parseDate(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const ts = Date.parse(raw.trim().length === 10 ? `${raw.trim()}T00:00:00+05:30` : raw.trim());
  return Number.isFinite(ts) ? raw.trim() : null;
}

/** Quant closed-trade performance over an optional IST window (same row
 *  shape as getQuantPerformanceFromDb, which handles the unfiltered case). */
async function getQuantPerformanceWindowed(dateFrom: string, dateTo: string) {
  const fromTs = Date.parse(dateFrom.trim().length === 10 ? `${dateFrom.trim()}T00:00:00+05:30` : dateFrom.trim());
  const toTs = Date.parse(dateTo.trim().length === 10 ? `${dateTo.trim()}T23:59:59.999+05:30` : dateTo.trim());
  const where: Prisma.QuantPaperTradeWhereInput = {
    status: { startsWith: "CLOSED" },
    engineVersion: "UNIVERSAL_QUANT_V1",
  };
  if (Number.isFinite(fromTs) || Number.isFinite(toTs)) {
    where.exitTime = {
      ...(Number.isFinite(fromTs) ? { gte: new Date(fromTs) } : {}),
      ...(Number.isFinite(toTs) ? { lte: new Date(toTs) } : {}),
    };
  }
  const rows = await db.quantPaperTrade.findMany({
    where,
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

function mapAuditStats(stats: AggregateStats): ExistingEnginesSide {
  return {
    available: true,
    engines: (stats.byStrategy ?? []).map((b) => ({
      strategyId: b.strategyId,
      trades: b.trades,
      winRate: b.winRate,
      netPnl: b.netPnl,
      profitFactor: b.profitFactor ?? null,
    })),
  };
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dateFrom = parseDate(url.searchParams.get("dateFrom"));
    const dateTo = parseDate(url.searchParams.get("dateTo"));
    const windowed = dateFrom != null || dateTo != null;

    // Quant side — same loader as /api/quant/trades unless a window is given.
    const performance = windowed
      ? await getQuantPerformanceWindowed(dateFrom ?? "1970-01-01", dateTo ?? "2999-12-31")
      : await getQuantPerformanceFromDb();

    // Existing-engines side — read-only audit sidecar via the existing client.
    let existing: ExistingEnginesSide;
    try {
      const stats = await getStats({
        ...(dateFrom != null ? { dateFrom } : {}),
        ...(dateTo != null ? { dateTo } : {}),
      });
      existing = mapAuditStats(stats);
    } catch (e: any) {
      existing = {
        available: false,
        reason: `trade-audit sidecar unavailable (${e?.message ?? "fetch failed"}) — is the :4001 engine running?`,
      };
    }

    return NextResponse.json({
      success: true,
      quant: {
        performance,
        mode: effectiveMode(),
        sampleSizeCaveat: performance.sampleSizeCaveat,
        window: windowed ? { dateFrom, dateTo } : null,
      },
      existing,
      comparisonRules: COMPARISON_RULES,
      generatedAt: istIso(Date.now()),
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "comparison failed" }, { status: 500 });
  }
}
