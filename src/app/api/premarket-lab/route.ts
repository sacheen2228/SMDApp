// GET /api/premarket-lab — coverage, latest score, quality, optional collect.
// Research-only read API. ?collect=1 triggers a snapshot (trading hours only).

import { NextRequest, NextResponse } from "next/server";
import {
  coverageStats, getLatestScore, listStudyDays, listModelRuns, loadFeatures,
} from "@/lib/premarket-lab/storage";
import { collectPreopenSnapshot } from "@/lib/premarket-lab/collector";
import { istDateISO, isTradingDay, isPostOpen, isPreopenWindow } from "@/lib/premarket-lab/calendar";
import { computeCombinedScore } from "@/lib/premarket-lab/score";
import { getStudyDay } from "@/lib/premarket-lab/storage";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const collect = url.searchParams.get("collect") === "1";
    const symbol = url.searchParams.get("symbol") || undefined;
    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;
    const includeFeatures = url.searchParams.get("features") === "1";
    const includeModels = url.searchParams.get("models") === "1";

    const tradeDate = url.searchParams.get("date") || istDateISO();
    let collectResult: any = null;

    if (collect) {
      // Only collect on trading days; pre-open or early session preferred
      if (isTradingDay(tradeDate) && (isPreopenWindow() || isPostOpen() || url.searchParams.get("force") === "1")) {
        collectResult = await collectPreopenSnapshot(tradeDate);
      } else {
        collectResult = { ok: false, error: "not_in_collect_window_or_not_trading_day" };
      }
    }

    const coverage = coverageStats();
    const latestScore = getLatestScore(symbol);
    const days = listStudyDays({ symbol, from, to, limit: 100 });

    // Live recompute from study day if requested
    let liveScore: import("@/lib/premarket-lab/types").CombinedQuantScore | null = null;
    if (url.searchParams.get("score") === "1") {
      const d = getStudyDay(tradeDate, symbol || "NIFTY");
      if (d) liveScore = computeCombinedScore({ day: d, quality: d.quality });
    }

    return NextResponse.json({
      success: true,
      tradeDate,
      coverage,
      latestScore,
      liveScore,
      studyDays: days.map((d) => ({
        tradeDate: d.tradeDate,
        symbol: d.symbol,
        quality: d.quality,
        cmGap: d.cm?.pChange ?? null,
        fnoGap: d.futures?.pChange ?? null,
        basisPct: d.futures?.basisPct ?? null,
        hasOpen: !!d.open,
      })),
      features: includeFeatures ? loadFeatures({ symbol, from, to }) : undefined,
      models: includeModels ? listModelRuns(30) : undefined,
      collect: collectResult,
      disclaimer:
        "Research engine only. Scores are not trade authorization. BUY CE/PE only under existing SDM gates.",
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "failed" }, { status: 500 });
  }
}
