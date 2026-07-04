// Trade Journal API — CRUD for trade persistence

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get("symbol");
    const date = searchParams.get("date");

    const where: any = {};
    if (symbol) where.symbol = symbol;
    if (date) {
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      where.createdAt = { gte: dayStart, lte: dayEnd };
    }

    const trades = await db.trade.findMany({
      where,
      orderBy: { entryTime: "desc" },
      take: 100,
    });

    // Compute stats
    const closed = trades.filter((t) => t.status === "TP_HIT" || t.status === "SL_HIT");
    const winners = closed.filter((t) => (t.pnl ?? 0) > 0);
    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0;

    return NextResponse.json({
      success: true,
      trades,
      stats: {
        total: trades.length,
        open: trades.filter((t) => t.status === "OPEN").length,
        closed: closed.length,
        winRate: Math.round(winRate * 10) / 10,
        totalPnL: Math.round(totalPnL),
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { tradeId, status, pnl, exitPrice, exitReason, holdingTimeMin } = body;

    if (!tradeId) {
      return NextResponse.json({ success: false, error: "tradeId required" }, { status: 400 });
    }

    const update: any = {};
    if (status) update.status = status;
    if (pnl !== undefined) update.pnl = pnl;
    if (exitPrice !== undefined) update.exitPrice = exitPrice;
    if (exitReason) update.exitReason = exitReason;
    if (holdingTimeMin !== undefined) update.holdingTimeMin = holdingTimeMin;
    if (status === "TP_HIT" || status === "SL_HIT" || status === "EXPIRED") {
      update.exitTime = new Date();
    }

    const trade = await db.trade.update({
      where: { tradeId },
      data: update,
    });

    return NextResponse.json({ success: true, trade });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const tradeId = searchParams.get("tradeId");

    if (!tradeId) {
      return NextResponse.json({ success: false, error: "tradeId required" }, { status: 400 });
    }

    await db.trade.delete({ where: { tradeId } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
