import { NextRequest, NextResponse } from "next/server";
import { recordScannerResult, getScannerResults } from "@/lib/market/record-scanner";

// POST /api/market-recorder/scanner
// Records scanner cycles as permanent AI-training rows. Accepts a single
// ScannerResultInput or { results: ScannerResultInput[] }. Every cycle is
// recorded (BUY/SELL/REJECT/NO_TRADE). snapshotId is resolved server-side
// by the Market History sidecar (:4002) to the latest recorded snapshot.
//
// GET  /api/market-recorder/scanner?symbol=&scanner=&decision=&sessionId=&date=&limit=
// Returns stored ScannerResults (the ML dataset).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const list = Array.isArray(body.results) ? body.results : body.symbol ? [body] : [];
  if (list.length === 0) {
    return NextResponse.json({ success: false, error: "no scanner results in body" }, { status: 400 });
  }
  const recorded: string[] = [];
  for (const raw of list) {
    const r = await recordScannerResult(raw);
    recorded.push(r.id);
  }
  return NextResponse.json({ success: true, recorded: recorded.length, ids: recorded });
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const rows = await getScannerResults({
    symbol: q.get("symbol") ?? undefined,
    scanner: q.get("scanner") ?? undefined,
    decision: q.get("decision") ?? undefined,
    sessionId: q.get("sessionId") ?? undefined,
    date: q.get("date") ?? undefined,
    limit: q.get("limit") ? parseInt(q.get("limit")!, 10) : 5000,
  });
  return NextResponse.json({ success: true, count: rows.length, results: rows });
}
