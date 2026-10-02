// API Route — arbitrary-symbol quotes (Watchlist tab LTP column)
// GET /api/quotes?symbols=NIFTY,RELIANCE,...
// Indices → yahoo v8 chart (lib cache), equities → yahoo v7 batch.
// 30s in-memory cache keyed by the normalized symbol set.

import { NextRequest, NextResponse } from "next/server";
import { fetchStockQuotes } from "@/lib/nse-stock-data";

const TTL = 30_000;
const cache = new Map<string, { ts: number; data: Record<string, any> }>();

export async function GET(req: NextRequest) {
  try {
    const raw = (new URL(req.url).searchParams.get("symbols") || "").split(",");
    const key = raw
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join(",");
    if (!key) {
      return NextResponse.json({ success: false, error: "symbols param required" }, { status: 400 });
    }

    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL) {
      return NextResponse.json({ success: true, data: { quotes: hit.data, count: Object.keys(hit.data).length, cached: true } });
    }

    const quotes = await fetchStockQuotes(raw);
    cache.set(key, { ts: Date.now(), data: quotes });
    if (cache.size > 50) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }

    return NextResponse.json({ success: true, data: { quotes, count: Object.keys(quotes).length } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "quote fetch failed" }, { status: 500 });
  }
}
