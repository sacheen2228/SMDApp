// GET /api/jarvis?symbol=NIFTY — read-only signal endpoint.
// Reads the worker cache first via getJarvisSignal() (the SAME function the
// /api/agent chat command calls); falls back to a one-off buildSignal() when
// stale. Never calls AlertSink — a page reload can never send Telegram.

import { NextRequest, NextResponse } from "next/server";
import { getJarvisSignal } from "@/lib/jarvis-adapters";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol") || "NIFTY";
  try {
    const read = await getJarvisSignal(symbol);
    if (!read) {
      return NextResponse.json({ success: false, error: `no signal for ${symbol}` }, { status: 503 });
    }
    return NextResponse.json({
      success: true,
      signal: read.signal,
      history: read.history,
      source: read.source,
      servedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.warn("[jarvis-api] read failed:", error?.message || error);
    return NextResponse.json(
      { success: false, error: String(error?.message || error) },
      { status: 502 }
    );
  }
}
