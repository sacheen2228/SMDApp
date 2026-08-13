// Weekly Equity Scanner API
// Stage 1: mechanical shortlist of NSE F&O equities with weekly growth
//          potential (real Yahoo Finance data — no simulation fallback).
// Stage 2 (?mode=pro&symbol=XXX): deep research dossier per shortlisted
//          symbol → BUY / WATCH / AVOID verdict.

import { NextRequest, NextResponse } from "next/server";
import { runWeeklyScan } from "@/lib/weekly-equity-scanner";
import { runProResearch } from "@/lib/weekly-pro-mode";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") || "default";

    // Stage 2 — deep research on a single shortlisted symbol
    if (mode === "pro") {
      const symbol = (searchParams.get("symbol") || "").toUpperCase();
      if (!symbol) {
        return NextResponse.json({ success: false, error: "Missing ?symbol=" }, { status: 400 });
      }

      const scan = await runWeeklyScan();
      const candidate = (scan.candidates || []).find(c => c.symbol === symbol);

      // If the symbol isn't in the current shortlist, still research it if we
      // can identify it in the universe, otherwise 404.
      if (!candidate) {
        return NextResponse.json(
          { success: false, error: `${symbol} is not in the current weekly shortlist.` },
          { status: 404 }
        );
      }

      const dossier = await runProResearch(candidate);
      return NextResponse.json({
        success: true,
        mode: "pro",
        data: dossier,
        dataSource: dossier.dataSource,
        timestamp: new Date().toISOString(),
      });
    }

    // Stage 1 — full shortlist
    const result = await runWeeklyScan();

    if (!result || result.totalScanned === 0) {
      return NextResponse.json({
        success: false,
        error: "Live equity data unavailable — Yahoo Finance returned no real quotes.",
      }, { status: 503 });
    }

    return NextResponse.json({
      success: true,
      mode,
      data: result,
      dataSource: "Yahoo Finance + NSE corporate actions",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[WeeklyScanner API] Error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Weekly scanner failed" },
      { status: 500 }
    );
  }
}