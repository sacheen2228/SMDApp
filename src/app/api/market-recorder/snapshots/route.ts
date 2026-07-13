import { NextRequest, NextResponse } from "next/server";
import { getSnapshotsSummary } from "@/lib/market-history-client";

// GET /api/market-recorder/snapshots?symbol=NIFTY&date=2026-07-13
// Returns stored canonical snapshot summaries (used by Dashboard / Replay / Evaluation).
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  const date = req.nextUrl.searchParams.get("date");
  if (!symbol) return NextResponse.json({ success: false, error: "symbol required" }, { status: 400 });

  const snapshots = await getSnapshotsSummary(symbol, date ?? undefined);
  return NextResponse.json({ success: true, symbol, count: snapshots.length, snapshots });
}
