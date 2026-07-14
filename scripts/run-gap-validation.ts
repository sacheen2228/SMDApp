/**
 * Gap Engine Validation Pipeline
 * 
 * Compares old heuristic engine vs new default-engine vs calibrated engine
 * on N=300 mock sessions. Prints markdown summary.
 */
import { runValidationPipeline, formatValidationSummary } from "../src/lib/gap-analysis/validator";

async function main() {
  console.log("Running validation pipeline (300 mock sessions)...");
  const result = await runValidationPipeline("mock", 300);

  console.log("\n" + formatValidationSummary(result));

  console.log("---\nCalibration Details:");
  console.log(`  Old (heuristic) accuracy: ${result.oldAccuracy.toFixed(2)}%`);
  console.log(`  New (default) accuracy: ${result.calibrationResult?.oldAccuracy.toFixed(2) ?? "N/A"}%`);
  console.log(`  New (optimized) accuracy: ${result.newAccuracy.toFixed(2)}%`);
  console.log(`  Improvement vs legacy: ${result.improvement >= 0 ? "+" : ""}${result.improvement.toFixed(2)}pp`);

  // Summary judgment
  console.log("\n---\nJUDGMENT:");
  const oldAcc = result.oldAccuracy;
  const newAcc = result.newAccuracy;
  if (newAcc > oldAcc) {
    console.log(`✅ New engine (${newAcc.toFixed(2)}%) outperforms legacy heuristic (${oldAcc.toFixed(2)}%). Deploy approved.`);
  } else if (Math.abs(newAcc - oldAcc) < 2) {
    console.log(`⚠️ Similar accuracy: legacy ${oldAcc.toFixed(2)}% vs new ${newAcc.toFixed(2)}%. Default weights are stable.`);
  } else {
    console.log(`❌ Legacy heuristic (${oldAcc.toFixed(2)}%) outperforms new engine (${newAcc.toFixed(2)}%). DO NOT deploy.`);
  }
}

main().catch(console.error);
