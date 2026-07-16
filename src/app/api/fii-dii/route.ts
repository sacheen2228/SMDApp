import { NextRequest, NextResponse } from "next/server";
import { fetchFIIDII } from "@/lib/fii-dii-scraper";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const data = await fetchFIIDII();
    if (data.source === "live" || data.source === "stale") {
      // `stale: true` means the live scrape failed but we are serving the last
      // known REAL figures from cache (never fabricated data).
      return NextResponse.json({ success: true, stale: data.source === "stale", ...data });
    }
    // Do NOT fabricate. Return 503 so callers know FII/DII data is unavailable.
    return NextResponse.json(
      { success: false, error: "FII/DII data unavailable — scrape failed or source blocked" },
      { status: 503 },
    );
  } catch (error: any) {
    console.error("[FII/DII API] Error:", error);
    return NextResponse.json({ success: false, error: error?.message }, { status: 500 });
  }
}
