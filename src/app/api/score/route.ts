// POST /api/score — Unified Scoring Engine endpoint
// Accepts market data, returns scored Trade Decision with breakdown.

import { NextRequest, NextResponse } from "next/server";
import { scoreTrade, scoreAndRank, type MarketDataInput, type StrategyProfile } from "@/lib/unified-scoring-engine";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Single trade scoring
    if (body.input && !Array.isArray(body.input)) {
      const decision = scoreTrade(body.input as MarketDataInput);
      return NextResponse.json({ ok: true, decision });
    }

    // Batch scoring + ranking
    if (Array.isArray(body.input)) {
      const maxResults = body.maxResults ?? 10;
      const ranked = scoreAndRank(body.input as MarketDataInput[], maxResults);
      return NextResponse.json({ ok: true, ranked, count: ranked.length });
    }

    return NextResponse.json({ ok: false, error: "Provide { input: MarketDataInput } or { input: MarketDataInput[] }" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
