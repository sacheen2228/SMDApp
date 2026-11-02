#!/usr/bin/env bun
// scripts/premarket-lab-daily.ts
// Phase 12 CLI — one stage or the full daily research pipeline.
// Research-only: no Telegram, no trade alerts, no production path changes.
//
// Usage:
//   bun scripts/premarket-lab-daily.ts                  # full pipeline for today
//   bun scripts/premarket-lab-daily.ts collect
//   bun scripts/premarket-lab-daily.ts record
//   bun scripts/premarket-lab-daily.ts attach_partial
//   bun scripts/premarket-lab-daily.ts attach_eod
//   bun scripts/premarket-lab-daily.ts option_sim
//   bun scripts/premarket-lab-daily.ts report
//   bun scripts/premarket-lab-daily.ts full --date=2026-11-03
//   bun scripts/premarket-lab-daily.ts report --date=2026-11-03

import {
  runFullPipeline,
  runCollectStage,
  runRecordStage,
  runAttachStage,
  runOptionSimStage,
  runReportStage,
  type PipelineStage,
  type PipelineResult,
} from "../src/lib/premarket-lab/daily-pipeline";
import { istDateISO, isTradingDay } from "../src/lib/premarket-lab/calendar";

const args = process.argv.slice(2);
const stageArg = args.find((a) => !a.startsWith("--")) || "full";
const dateArg = args.find((a) => a.startsWith("--date="))?.slice("--date=".length);
const skipResearch = args.includes("--skip-research");
const tradeDate = dateArg || istDateISO();

function print(r: PipelineResult): void {
  const flag = r.ok ? "OK" : r.skipped ? `SKIP(${r.skipped})` : "FAIL";
  console.log(`[${flag}] ${r.stage} ${r.tradeDate}: ${r.message}`);
  if (r.data?.text && r.stage === "report") {
    console.log(r.data.text);
  }
}

async function main(): Promise<void> {
  console.log(`premarket-lab-daily stage=${stageArg} date=${tradeDate} tradingDay=${isTradingDay(tradeDate)}`);

  if (!isTradingDay(tradeDate) && stageArg !== "report") {
    // report can still run on any date for historical review
    console.log(`SKIP — not a trading day (${tradeDate})`);
    process.exit(0);
  }

  let results: PipelineResult[] = [];
  switch (stageArg) {
    case "collect":
      results = [await runCollectStage({ tradeDate, skipResearch })];
      break;
    case "record":
      results = [await runRecordStage({ tradeDate, skipResearch })];
      break;
    case "attach_partial":
      results = [await runAttachStage({ tradeDate, eod: false })];
      break;
    case "attach_eod":
      results = [await runAttachStage({ tradeDate, eod: true })];
      break;
    case "option_sim":
      results = [await runOptionSimStage({ tradeDate })];
      break;
    case "report":
      results = [await runReportStage({ tradeDate })];
      break;
    case "full":
      results = await runFullPipeline({ tradeDate, skipResearch });
      break;
    default:
      console.error(`unknown stage: ${stageArg}`);
      process.exit(2);
  }

  for (const r of results) print(r);
  const failed = results.some((r) => !r.ok && !r.skipped);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
