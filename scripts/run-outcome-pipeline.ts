// scripts/run-outcome-pipeline.ts
//
// Manual / cron entry point for the shared Outcome Pipeline.
// Resolves outcomes for all 4 migrated strategies, then re-runs the
// Evaluation Framework and prints Precision / Recall / F1 / Confusion
// per strategy.
//
// Run:  bun scripts/run-outcome-pipeline.ts
// Or against a remote:  NEXT_PUBLIC_TRADE_AUDIT_URL=... bun scripts/run-outcome-pipeline.ts
import { resolveOutcomes, ALL_STRATEGIES } from "../src/lib/market/outcome-pipeline";
import { evaluate } from "../src/lib/market/evaluation-framework";

async function main() {
  console.log("▶ Running Outcome Pipeline for:", ALL_STRATEGIES.join(", "));
  const summary = await resolveOutcomes({ strategies: ALL_STRATEGIES });
  console.log("  resolved:", summary.resolved, "| skipped(open):", summary.skippedOpen, "| errors:", summary.errors);
  console.log("  by outcome:", JSON.stringify(summary.byOutcome));

  console.log("\n▶ Evaluation (Precision / Recall / F1 / Confusion):\n");
  for (const strategy of ALL_STRATEGIES) {
    const report = await evaluate({ strategy });
    const c = report.classification;
    console.log(`[${strategy}]`);
    console.log(`  scans=${c.totalScans} labeled=${c.labeledSamples} unlabeled=${c.unlabeledSamples}`);
    console.log(`  precision=${c.precision} recall=${c.recall} f1=${c.f1}`);
    console.log(`  confusion={tp:${c.confusionMatrix.tp}, fp:${c.confusionMatrix.fp}, tn:${c.confusionMatrix.tn}, fn:${c.confusionMatrix.fn}}`);
    const tm = report.tradeMetrics;
    console.log(`  tradeMetrics: winRate=${(tm.winRate * 100).toFixed(1)}% avgR=${tm.avgRMultiple} closed=${tm.totalTrades - tm.openTrades}/${tm.totalTrades}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
