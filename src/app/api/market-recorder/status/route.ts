import { NextResponse } from "next/server";
import { getRecorderRuntimeState } from "@/lib/market/capture";
import {
  RECORDER_CONFIG,
  getRecorderMode,
  getIntervalSeconds,
  type RecorderMode,
} from "@/lib/market/recorder-config";
import { getStatus, getCaptureCoverage } from "@/lib/market-history-client";
import { getSessionHealth, getSessionSummary } from "@/lib/session-health";

// GET /api/market-recorder/status
// Exposes recorder state, last successful/failed capture (with failure kind),
// last candle-chain result (source/failures), session-health (single source of
// truth for session expiry), active interval, totals, database size and uptime.
//
// P0: also reports SESSION COVERAGE — how much of the trading day was really
// recorded and which minutes were missed. A recorder that "ran" but hung (the
// 18-Nov flock deadlock) looks healthy in a counter and is exposed here.
export async function GET(req: Request) {
  const st = getRecorderRuntimeState();
  const mode: RecorderMode = st.mode;
  const state = mode === "MANUAL" ? "MANUAL" : "RUNNING";
  const uptimeMs = Date.now() - st.startTime;

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  let coverage: unknown = null;
  let coverageError: string | null = null;
  try {
    coverage = await getCaptureCoverage(date);
  } catch (e: any) {
    coverageError = String(e?.message ?? e);
  }

  const status = await getStatus();
  return NextResponse.json({
    success: true,
    state,
    mode,
    autoCapture: mode !== "MANUAL",
    captureIntervalSeconds: getIntervalSeconds(mode),
    tickGranularitySeconds: RECORDER_CONFIG.tickGranularity,
    symbols: RECORDER_CONFIG.symbols,
    lastSuccessfulCapture: st.lastSuccess,
    lastFailedCapture: st.lastFailure,
    lastCandleCapture: st.lastCandle,
    sessionHealth: getSessionHealth(),
    sessionSummary: getSessionSummary(),
    totalCaptures: st.totalCaptures,
    totalFailures: st.totalFailures,
    totalSnapshots: status.totalSnapshots,
    lastCaptureTime: status.lastCaptureTime,
    databaseSizeBytes: status.databaseSizeBytes,
    coverageDate: date,
    coverage,
    coverageError,
    uptimeMs,
    uptime: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
  });
}
