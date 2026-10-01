import { NextResponse } from "next/server";
import { getRecorderRuntimeState } from "@/lib/market/capture";
import {
  RECORDER_CONFIG,
  getRecorderMode,
  getIntervalSeconds,
  type RecorderMode,
} from "@/lib/market/recorder-config";
import { getStatus } from "@/lib/market-history-client";
import { getSessionHealth, getSessionSummary } from "@/lib/session-health";

// GET /api/market-recorder/status
// Exposes recorder state, last successful/failed capture (with failure kind),
// last candle-chain result (source/failures), session-health (single source of
// truth for session expiry), active interval, totals, database size and uptime.
export async function GET() {
  const st = getRecorderRuntimeState();
  const mode: RecorderMode = st.mode;
  const state = mode === "MANUAL" ? "MANUAL" : "RUNNING";
  const uptimeMs = Date.now() - st.startTime;
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
    totalSnapshots: (await getStatus()).totalSnapshots,
    lastCaptureTime: (await getStatus()).lastCaptureTime,
    databaseSizeBytes: (await getStatus()).databaseSizeBytes,
    uptimeMs,
    uptime: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
  });
}
