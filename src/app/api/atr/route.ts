import { NextRequest, NextResponse } from "next/server";
import { getDailyATR } from "@/lib/atr-daily";

export const dynamic = "force-dynamic";

// Returns the real per-instrument ATR(14) (daily, from Yahoo daily candles)
// used by the Zero Hero engine (Option 1 SL/TP fix).
//   GET /api/atr?symbol=NIFTY  ->  { atr: 180.5 }  |  { atr: null }
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) {
    return NextResponse.json({ atr: null, error: "symbol required" }, { status: 400 });
  }
  try {
    const atr = await getDailyATR(symbol);
    return NextResponse.json({ atr });
  } catch {
    return NextResponse.json({ atr: null });
  }
}
