import { NextRequest, NextResponse } from "next/server";
import { sendTradeAlert } from "@/lib/telegram";
import { sendTelegramMessage } from "@/lib/telegram";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const symbol = url.searchParams.get("symbol") || "NIFTY";
  const action = url.searchParams.get("action") || "BUY";
  const strike = Number(url.searchParams.get("strike") || "22450");
  const type = url.searchParams.get("type") || "CE";
  const confidence = Number(url.searchParams.get("confidence") || "55");
  const entry = Number(url.searchParams.get("entry") || "336.70");
  const stop = Number(url.searchParams.get("stop") || "235.69");
  const t1 = Number(url.searchParams.get("t1") || "505.05");
  const t2 = Number(url.searchParams.get("t2") || "673.40");
  const tradeId = `${symbol}-${strike}-${type}-${url.searchParams.get("expiry") || "20261027"}`;

  const prev = process.env.TELEGRAM_ALLOW_OFFHOURS;
  process.env.TELEGRAM_ALLOW_OFFHOURS = "1";

  const { sendTradeAlert } = await import("@/lib/telegram");
  const sent = await sendTradeAlert({
    symbol,
    action,
    strike,
    type,
    confidence,
    entry,
    stopLoss: stop,
    target1: t1,
    target2: t2,
    source: "TEST_DRY_RUN",
    instrument: type === "CE" ? "CALL" : "PUT",
    spot: 24800,
    expiry: "2026-11-27",
  });

  if (prev) process.env.TELEGRAM_ALLOW_OFFHOURS = prev; else delete process.env.TELEGRAM_ALLOW_OFFHOURS;

  return NextResponse.json({ sent, symbol, action, strike, type, confidence, entry, stop, t1, t2, tradeId });
}
