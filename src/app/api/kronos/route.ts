// ─── /api/kronos — price forecast proxy ───────────────────────────
// Thin proxy to the Kronos-mini sidecar (port 8770). OHLCV path
// forecast for indices/stocks — one confluence signal, not advice.

import { NextResponse } from "next/server";

const KRONOS_URL = process.env.KRONOS_URL || "http://localhost:8770";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") || "NIFTY";
  const interval = searchParams.get("interval") || "1d";
  const predLen = Math.min(60, Math.max(1, parseInt(searchParams.get("predLen") || "10", 10) || 10));
  const samples = Math.min(10, Math.max(1, parseInt(searchParams.get("samples") || "5", 10) || 5));

  const upstream = `${KRONOS_URL}/forecast?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&pred_len=${predLen}&samples=${samples}`;

  try {
    const res = await fetch(upstream, { signal: AbortSignal.timeout(60_000) });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Kronos forecast service unavailable (sidecar :8770 not running)",
        symbol,
      },
      { status: 503 }
    );
  }
}
