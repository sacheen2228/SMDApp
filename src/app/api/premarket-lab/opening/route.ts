// GET /api/premarket-lab/opening — post-09:15 opening confirmation for a symbol.

import { NextRequest, NextResponse } from "next/server";
import { confirmOpening } from "@/lib/premarket-lab/opening-confirm";
import { istDateISO } from "@/lib/premarket-lab/calendar";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get("symbol") || "NIFTY";
    const tradeDate = url.searchParams.get("date") || istDateISO();
    const spotOpen = num(url.searchParams.get("spotOpen"));
    const futuresOpen = num(url.searchParams.get("futuresOpen"));
    const fiveMinClose = num(url.searchParams.get("fiveMinClose"));
    const dayHigh = num(url.searchParams.get("dayHigh"));
    const dayLow = num(url.searchParams.get("dayLow"));
    const volume = num(url.searchParams.get("volume"));

    if (spotOpen == null && futuresOpen == null) {
      return NextResponse.json({
        success: false,
        error: "Provide spotOpen and/or futuresOpen from live candle/quote provider",
      }, { status: 400 });
    }

    const result = confirmOpening(tradeDate, symbol, {
      spotOpen, futuresOpen, fiveMinClose, dayHigh, dayLow, volume,
    });

    if (!result) {
      return NextResponse.json({ success: false, error: "study_day_not_found_run_collect_first" }, { status: 404 });
    }

    return NextResponse.json({ success: true, result, disclaimer: "Research confirmation only — not trade authorization." });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "failed" }, { status: 500 });
  }
}

function num(s: string | null): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
