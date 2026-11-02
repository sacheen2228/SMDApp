// GET /api/premarket-lab/compare — CM vs F&O vs combined model comparison (OOS).

import { NextRequest, NextResponse } from "next/server";
import { loadFeatures, saveModelRun, coverageStats } from "@/lib/premarket-lab/storage";
import { compareFeatureSets, walkForwardAverage, FEATURE_SETS, type ModelName } from "@/lib/premarket-lab/validation";
import type { LabeledSample } from "@/lib/premarket-lab/types";

export const dynamic = "force-dynamic";

function toSamples(target: string): LabeledSample[] {
  const rows = loadFeatures({ target });
  return rows
    .filter((r) => r.label === 0 || r.label === 1)
    .map((r) => ({
      tradeDate: r.tradeDate,
      symbol: r.symbol,
      features: r.features,
      target: r.target || target,
      label: r.label as 0 | 1,
    }));
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const target = url.searchParams.get("target") || "gap_continuation";
    const model = (url.searchParams.get("model") || "logistic") as ModelName;
    const persist = url.searchParams.get("persist") === "1";

    const samples = toSamples(target);
    const coverage = coverageStats();

    if (samples.length < 30) {
      return NextResponse.json({
        success: true,
        sufficient: false,
        n: samples.length,
        coverage,
        message:
          "Insufficient labeled samples (need ≥30). Historical validation runs after pre-open snapshots accumulate via daily collection.",
        comparison: [],
        walkForward: null,
        featureSets: FEATURE_SETS,
        disclaimer: "Research only — not a profitability claim.",
      });
    }

    const comparison = compareFeatureSets(samples, target, model, 0.7);
    const wf = walkForwardAverage(samples, target, model, "cm_fno", 4);

    if (persist) {
      for (const c of comparison) {
        saveModelRun({
          modelName: c.model,
          target: c.target,
          featureSet: c.featureSet,
          metrics: c.metrics,
        });
      }
    }

    return NextResponse.json({
      success: true,
      sufficient: true,
      n: samples.length,
      coverage,
      target,
      model,
      comparison,
      walkForward: wf,
      featureSets: FEATURE_SETS,
      disclaimer:
        "Out-of-sample research metrics only. Not guaranteed trading success probabilities. Models are not deployed to production trade execution.",
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "failed" }, { status: 500 });
  }
}
