// Daily Derivatives API - uses DailyDerivativesService
import { NextRequest, NextResponse } from "next/server";
import { DailyDerivativesService } from "../../../lib/DailyDerivatives";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const service = new DailyDerivativesService();

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const underlying = (searchParams.get("symbol") || "NIFTY").toUpperCase() as "NIFTY" | "SENSEX";

    if (!["NIFTY", "SENSEX"].includes(underlying)) {
      return NextResponse.json({ success: false, error: "Invalid symbol. Use NIFTY or SENSEX" }, { status: 400 });
    }

    // No hardcoded expiry — the canonical chain layer picks the nearest live
    // contract and the service derives DTE from the chain's own expiry date.
    const report = await service.getDailyDerivativesReport({
      underlying,
      interval: "5minute",
    });

    return NextResponse.json({ success: true, data: report });
  } catch (error: any) {
    console.error("[Daily Derivatives API] Error:", error);
    return NextResponse.json({ success: false, error: error.message || "Failed to generate report" }, { status: 500 });
  }
}