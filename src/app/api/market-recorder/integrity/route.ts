import { NextRequest, NextResponse } from "next/server";
import { validateRecorderIntegrity } from "@/lib/market/replay-engine";

// GET /api/market-recorder/integrity?symbol=NIFTY&date=2026-07-13
// Reports recorder health: missing intervals, duplicate timestamps,
// incomplete captures, and an overall status.
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "NIFTY";
  const date = req.nextUrl.searchParams.get("date") ?? undefined;
  const intervalParam = req.nextUrl.searchParams.get("expectedIntervalSec");
  const expectedIntervalSec = intervalParam ? parseInt(intervalParam, 10) : undefined;
  const report = await validateRecorderIntegrity(symbol, { date, expectedIntervalSec });
  return NextResponse.json({ success: true, report });
}
