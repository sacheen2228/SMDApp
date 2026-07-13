// GET /api/evaluate
// Evaluation Framework endpoint (M7). Returns an EvaluationReport:
//   • tradeMetrics   — from Trade Audit (win rate, profit factor,
//                      expectancy, max drawdown, avg R, holding time, MFE/MAE)
//   • classification  — from Scanner Results (precision, recall, F1, confusion)
// Filters: strategy, symbol, dateFrom, dateTo, engineVersion, featureVersion.
import { NextRequest, NextResponse } from "next/server";
import { evaluate, type EvaluationFilters } from "@/lib/market/evaluation-framework";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const filters: EvaluationFilters = {
    strategy: sp.get("strategy") ?? undefined,
    symbol: sp.get("symbol") ?? undefined,
    dateFrom: sp.get("dateFrom") ?? undefined,
    dateTo: sp.get("dateTo") ?? undefined,
    engineVersion: sp.get("engineVersion") ?? undefined,
    featureVersion: sp.get("featureVersion")
      ? Number(sp.get("featureVersion"))
      : undefined,
  };

  try {
    const report = await evaluate(filters);
    return NextResponse.json(report);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "evaluation failed" },
      { status: 500 }
    );
  }
}
