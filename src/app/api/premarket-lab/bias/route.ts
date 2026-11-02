// GET /api/premarket-lab/bias — read-only market bias for SDM engines (Phase 9).
// Does NOT bypass SDM 14-factor, risk, strike protection, or signal gates.
// Options remain BUY CE / BUY PE only under existing production rules.

import { NextRequest, NextResponse } from "next/server";
import { getLatestScore, getStudyDay, coverageStats } from "@/lib/premarket-lab/storage";
import { computeCombinedScore, optionsSetupHint } from "@/lib/premarket-lab/score";
import { istDateISO, isTradingDay } from "@/lib/premarket-lab/calendar";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get("symbol") || "NIFTY";
    const tradeDate = url.searchParams.get("date") || istDateISO();

    const stored = getLatestScore(symbol);
    const day = getStudyDay(tradeDate, symbol);
    let live: import("@/lib/premarket-lab/types").CombinedQuantScore | null = null;
    if (day) {
      live = computeCombinedScore({ day, quality: day.quality });
    }

    const score = live || stored;
    const coverage = coverageStats();
    const trading = isTradingDay(tradeDate);

    return NextResponse.json({
      success: true,
      symbol,
      tradeDate,
      isTradingDay: trading,
      // Read-only research context — consumers must still run full SDM gates
      marketBias: score?.bias ?? "WAIT",
      quantScore: score?.score ?? null,
      sourceScores: score?.sourceScores ?? null,
      dataQuality: score?.quality ?? null,
      optionsHint: score ? optionsSetupHint(score) : { side: "NONE", reason: "no score" },
      gapStats: day?.cm
        ? {
            cmPChange: day.cm.pChange,
            fnoPChange: day.futures?.pChange ?? null,
            basisPct: day.futures?.basisPct ?? null,
          }
        : null,
      futuresStrength: day?.futures?.pChange ?? null,
      breadth: null, // reserved — filled when breadth rows attached
      volatilityRegime: day?.vix != null ? (day.vix > 20 ? "HIGH" : day.vix > 15 ? "ELEVATED" : "NORMAL") : null,
      modelPrediction: null, // filled when compare endpoint has sufficient samples
      modelReliability: null,
      dataQualityScore: score?.quality?.score ?? null,
      disclaimer:
        "Research context only. Does not replace SDM 14-factor checks, risk management, " +
        "strike protection, min R:R, or signal confirmation. No option selling. No auto-trade.",
      coverage,
      calculatedAt: score?.calculatedAt ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "failed" }, { status: 500 });
  }
}
