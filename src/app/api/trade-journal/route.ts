// Trade Journal API — CRUD for trade persistence

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { formatTradeStatus } from "@/lib/activeTradeTracker";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      symbol, strike, type, side, entryPrice, stopLoss,
      target1, target2, target3, confidence, strategy,
      aiReasonSnapshot, riskPerTrade, positionSize, qualityScore, qualityGrade, tradeId,
    } = body;

    const trade = await db.trade.upsert({
      where: { tradeId: tradeId || `trade-${Date.now()}` },
      create: {
        tradeId: tradeId || `trade-${Date.now()}`,
        symbol: symbol || "UNKNOWN",
        strike: strike || 0,
        type: type || "CE",
        side: side || "BUY",
        entryPrice: entryPrice || 0,
        stopLoss: stopLoss || 0,
        target1: target1 || null,
        target2: target2 || null,
        target3: target3 || null,
        confidence: confidence || 0,
        strategy: strategy || "manual",
        aiReasonSnapshot: aiReasonSnapshot || "",
        riskPerTrade: riskPerTrade || 0,
        positionSize: positionSize || 0,
        qualityScore: qualityScore || 0,
        qualityGrade: qualityGrade || "N/A",
        entryTime: new Date(),
        tradedAt: new Date(),
        status: "ACTIVE",
      },
      update: {
        symbol: symbol || "UNKNOWN",
        strike: strike || 0,
        type: type || "CE",
        side: side || "BUY",
        entryPrice: entryPrice || 0,
        stopLoss: stopLoss || 0,
        target1: target1 || null,
        target2: target2 || null,
        target3: target3 || null,
        confidence: confidence || 0,
        strategy: strategy || "manual",
        aiReasonSnapshot: aiReasonSnapshot || "",
        riskPerTrade: riskPerTrade || 0,
        positionSize: positionSize || 0,
        qualityScore: qualityScore || 0,
        qualityGrade: qualityGrade || "N/A",
      },
    });

    return NextResponse.json({ success: true, trade });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

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
      where.tradedAt = { gte: dayStart, lte: dayEnd };
    }

    const trades = await db.trade.findMany({
      where,
      orderBy: { entryTime: "desc" },
      take: 200,
    });

    const closedStatuses = ["SL_HIT", "TP1_HIT", "TP2_HIT", "TP3_HIT", "CLOSED"];
    const closed = trades.filter((t) => closedStatuses.includes(t.status));
    const winners = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losers = closed.filter((t) => (t.pnl ?? 0) <= 0);
    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0;
    const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + (t.pnl ?? 0), 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + (t.pnl ?? 0), 0) / losers.length : 0;

    // Group by strategy
    const byStrategy: Record<string, number> = {};
    for (const t of closed) {
      byStrategy[t.strategy] = (byStrategy[t.strategy] || 0) + (t.pnl ?? 0);
    }

    return NextResponse.json({
      success: true,
      trades: trades.map((t: any) => ({ ...t, displayStatus: formatTradeStatus(t.status) })),
      stats: {
        total: trades.length,
        open: trades.filter((t) => t.status === "ACTIVE" || t.status === "TP1_HIT" || t.status === "TP2_HIT").length,
        closed: closed.length,
        winners: winners.length,
        losers: losers.length,
        winRate: Math.round(winRate * 10) / 10,
        totalPnL: Math.round(totalPnL * 100) / 100,
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
        byStrategy,
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
