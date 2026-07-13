import { NextResponse } from "next/server";
import { getRecorderRuntimeState } from "@/lib/market/capture";
import {
  RECORDER_CONFIG,
  getRecorderMode,
  getIntervalSeconds,
  type RecorderMode,
} from "@/lib/market/recorder-config";
import { getStatus } from "@/lib/market-history-client";

// GET /api/market-recorder/status
// Exposes recorder state, last successful/failed capture, active interval,
// total snapshots, database size and uptime.
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
    totalCaptures: st.totalCaptures,
    totalFailures: st.totalFailures,
    totalSnapshots: (await getStatus()).totalSnapshots,
    lastCaptureTime: (await getStatus()).lastCaptureTime,
    databaseSizeBytes: (await getStatus()).databaseSizeBytes,
    uptimeMs,
    uptime: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
  });
}
