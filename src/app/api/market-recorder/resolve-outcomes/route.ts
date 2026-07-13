// POST /api/market-recorder/resolve-outcomes
//
// Runs the shared Outcome Pipeline (resolves WIN/LOSS/NO_FILL/CANCELLED/
// EXPIRED + exit reason, MFE/MAE, R-multiple, holding time for every
// scanner result of the 4 migrated strategies) and then re-runs the
// Evaluation Framework so Precision / Recall / F1 / Confusion Matrix are
// populated per strategy.
//
// Body (optional): { strategies?, symbols?, dateFrom?, dateTo? }
import { NextRequest, NextResponse } from "next/server";
import { resolveOutcomes, ALL_STRATEGIES } from "@/lib/market/outcome-pipeline";
import { evaluate } from "@/lib/market/evaluation-framework";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const filters = {
      strategies:
        Array.isArray(body.strategies) && body.strategies.length
          ? body.strategies
          : ALL_STRATEGIES,
      symbols: Array.isArray(body.symbols) ? body.symbols : undefined,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
    };

    const summary = await resolveOutcomes(filters);

    // Re-run Evaluation for each strategy so metrics reflect resolved outcomes.
    const evaluations = await Promise.all(
      filters.strategies!.map(async (strategy: string) => {
        const report = await evaluate({ strategy });
        return {
          strategy,
          classification: report.classification,
          tradeMetrics: report.tradeMetrics,
        };
      }),
    );

    return NextResponse.json({ success: true, summary, evaluations });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "outcome pipeline failed" },
      { status: 500 },
    );
  }
}
