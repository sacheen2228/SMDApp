import { NextRequest, NextResponse } from "next/server";
import { sendTradeAlert } from "@/lib/telegram";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const symbol = url.searchParams.get("symbol") || "NIFTY";
  const action = url.searchParams.get("action") || "BUY";
  const strike = Number(url.searchParams.get("strike") || "25000");
  const type = url.searchParams.get("type") || "CE";
  const confidence = Number(url.searchParams.get("confidence") || "72");
  const sent = await sendTradeAlert({
    symbol,
    action,
    strike,
    type,
    confidence,
    entry: 120,
    stopLoss: 90,
    target1: 180,
    target2: 240,
    source: "TEST_DRY_RUN",
    instrument: "CALL",
  });
  return NextResponse.json({ sent, symbol, action, strike, type, confidence });
}
