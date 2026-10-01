// Trade Journal API — CRUD for trade persistence

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { formatTradeStatus } from "@/lib/activeTradeTracker";
import { computeJournalStats } from "@/lib/journal-stats";

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
    const statusFilter = searchParams.get("status");

    const where: any = {};
    if (symbol) where.symbol = symbol;
    if (statusFilter) where.status = statusFilter;
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

    // Priced-only win/loss (null-pnl rows never count as losers); EXPIRED
    // included as terminal so repaired stale rows show up in stats.
    const stats = computeJournalStats(trades);

    return NextResponse.json({
      success: true,
      trades: trades.map((t: any) => ({ ...t, displayStatus: formatTradeStatus(t.status) })),
      stats,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  let tradeId: string | undefined;
  try {
    const body = await req.json();
    tradeId = body.tradeId;
    const { status, pnl, pnlPercent, exitPrice, exitReason, holdingTimeMin, tpHitLevel } = body;

    if (!tradeId) {
      return NextResponse.json({ success: false, error: "tradeId required" }, { status: 400 });
    }

    const update: any = {};
    if (status) update.status = status;
    if (pnl !== undefined) update.pnl = pnl;
    if (pnlPercent !== undefined) update.pnlPercent = pnlPercent;
    if (exitPrice !== undefined) update.exitPrice = exitPrice;
    if (exitReason !== undefined) update.exitReason = exitReason;
    if (holdingTimeMin !== undefined) update.holdingTimeMin = holdingTimeMin;
    if (tpHitLevel !== undefined) update.tpHitLevel = tpHitLevel;
    // Exit time only for terminal statuses (NOT intermediate TP1/TP2 trail hits)
    if (status === "TP3_HIT" || status === "TP_HIT" || status === "SL_HIT" ||
        status === "EXPIRED" || status === "CLOSED" || status === "CANCELLED") {
      update.exitTime = new Date();
    }

    const trade = await db.trade.update({
      where: { tradeId },
      data: update,
    });

    return NextResponse.json({ success: true, trade });
  } catch (error: any) {
    // Prisma P2025 = record not found — not a server error
    if (error?.code === "P2025" || /not found/i.test(error?.message || "")) {
      return NextResponse.json(
        { success: false, error: `Trade not found: ${tradeId ?? "?"}` },
        { status: 404 }
      );
    }
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
