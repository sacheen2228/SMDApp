import { NextRequest, NextResponse } from "next/server";
import { recordAll, RECORDER_SYMBOLS, getRecorderRuntimeState } from "@/lib/market/capture";
import { RECORDER_CONFIG, getRecorderMode, getIntervalSeconds } from "@/lib/market/recorder-config";

// POST /api/market-recorder/record
// Triggered by an external timer (systemd timer / crontab) every market minute.
// Body: { "symbols": [...], "auto": true, "force": true }
//   - auto:   scheduler call — mode + interval throttle apply (MANUAL mode skips).
//   - force:  bypass mode/throttle (manual capture always allowed).
// Captures the current market state for all configured symbols and persists the
// canonical snapshots to market_history.db. No new sidecar process required.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const symbols: string[] = Array.isArray(body.symbols) && body.symbols.length ? body.symbols : RECORDER_CONFIG.symbols;
  const summary = await recordAll(symbols, { auto: !!body.auto, force: !!body.force });
  return NextResponse.json({
    success: true,
    mode: getRecorderMode(),
    intervalSeconds: getIntervalSeconds(),
    recorded: summary.recorded,
    skipped: summary.skipped ?? false,
    reason: summary.reason,
    nextIn: summary.nextIn,
    results: summary.results,
  });
}
