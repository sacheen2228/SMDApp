// POST /api/trade/register
//
// Unified trade-registration endpoint. Client-side strategy scanners (SMC /
// Smart Money, Zero Hero AI) post candidate trades here so they flow through
// the SAME lifecycle as server-side strategies: in-memory active tracking +
// Prisma journal + Trade Audit (backtest verification) engine. This guarantees
// every exit is synced everywhere (dashboard, audit, Prisma, Telegram, Agent).
//
// The tradeId is deterministic (STRAT-SYMBOL-STRIKE-TYPE-YYYYMMDD) so re-scans
// are idempotent and match the existing audit-engine records.

import { NextRequest, NextResponse } from "next/server";
import { addTrade, type ActiveTrade } from "@/lib/activeTradeTracker";
import { updatePrice } from "@/lib/trade-audit-client";

function istYmd(when = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(when)
    .replace(/-/g, "");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      strategyId,
      symbol,
      strike,
      optionType,
      entry,
      sl,
      tp1,
      tp2,
      side = "BUY",
      confidence = 0,
      price,
    } = body;

    if (!strategyId || !symbol || !entry || entry <= 0) {
      return NextResponse.json(
        { success: false, error: "strategyId, symbol and entry are required" },
        { status: 400 }
      );
    }

    const ymd = istYmd();
    const type = (optionType || "").toUpperCase() === "PE" ? "PE" : "CE";
    const id = `${strategyId}-${symbol}-${strike}-${type}-${ymd}`;

    const trade: ActiveTrade = {
      id,
      symbol,
      side: side === "SELL" ? "SELL" : "BUY",
      instrument: `${symbol} ${strike} ${type}`,
      strike: Number(strike) || 0,
      optionType: type,
      entry: Number(entry),
      sl: Number(sl) || Number(entry) * 0.78,
      tp1: Number(tp1) || Number(entry),
      tp2: Number(tp2) || Number(tp1) || Number(entry),
      status: "ACTIVE",
      sentAt: new Date().toISOString(),
      source: strategyId,
    };

    await addTrade(trade);

    // Feed the live premium as a tracking tick so the audit engine can compute
    // MFE/MAE and verify the backtest accurately.
    if (price && Number(price) > 0) {
      await updatePrice(id, Number(price)).catch(() => {});
    }

    return NextResponse.json({ success: true, id, confidence });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "register failed" },
      { status: 500 }
    );
  }
}
