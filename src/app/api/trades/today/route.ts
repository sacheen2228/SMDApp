import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLotSize } from "@/lib/symbol-config";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const dateStr = searchParams.get("date");
    const symbol = searchParams.get("symbol") || "ALL";

    let startDate: Date;
    let endDate: Date;

    if (dateStr) {
      startDate = new Date(dateStr + "T00:00:00.000Z");
      endDate = new Date(dateStr + "T23:59:59.999Z");
    } else {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date();
      endDate.setHours(23, 59, 59, 999);
    }

    const where: any = {
      createdAt: { gte: startDate, lte: endDate },
    };
    if (symbol !== "ALL") {
      where.symbol = symbol;
    }

    const trades = await db.trade.findMany({
      where,
      orderBy: { entryTime: "asc" },
    });

    const rows = trades.map((t) => {
      const lotSize = getLotSize(t.symbol?.toUpperCase() || "") || Number(t.positionSize) || 65;
      const exitPrice = t.exitPrice ? t.exitPrice :
        t.status === "TP_HIT" ? (Number(t.target1) || 0) :
        t.status === "SL_HIT" ? (Number(t.stopLoss) || 0) : null;

      return {
        tradeId: t.tradeId,
        time: t.entryTime.toISOString(),
        exitTime: t.exitTime?.toISOString() || null,
        symbol: t.symbol || "NIFTY",
        type: t.type || "CE",
        strike: t.strike,
        entry: t.entryPrice,
        exit: exitPrice,
        status: mapAuditStatus(t.status),
        dbStatus: t.status,
        pnl: t.pnl || 0,
        stopLoss: t.stopLoss,
        target1: t.target1,
        target2: t.target2,
        target3: t.target3,
        tpHitLevel: t.tpHitLevel || null,
        exitReason: t.exitReason || null,
        lotSize,
        positionSize: t.positionSize,
        holdingTimeMin: t.holdingTimeMin || null,
        confidence: t.confidence,
        qualityGrade: t.qualityGrade,
        qualityScore: t.qualityScore,
        aiReason: t.aiReasonSnapshot,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
      };
    });

    const total = trades.length;
    const active = trades.filter((t) => t.status === "OPEN").length;
    const tp = trades.filter((t) => t.status === "TP_HIT").length;
    const sl = trades.filter((t) => t.status === "SL_HIT").length;
    const expired = trades.filter((t) => t.status === "EXPIRED").length;
    const partial = trades.filter((t) => t.status === "PARTIAL_EXIT").length;
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const symbols = [...new Set(trades.map((t) => t.symbol || "NIFTY"))];

    // TP level breakdown
    const tpLevels = { TP1: 0, TP2: 0, TP3: 0, TRAILING_SL: 0 };
    for (const t of trades) {
      if (t.status === "TP_HIT" && t.tpHitLevel) {
        const lvl = t.tpHitLevel as keyof typeof tpLevels;
        if (lvl in tpLevels) tpLevels[lvl]++;
      }
    }

    return NextResponse.json({
      success: true,
      date: dateStr || "today",
      total,
      active,
      tp,
      sl,
      expired,
      partial,
      tpLevels,
      totalPnl: Math.round(totalPnl * 100) / 100,
      symbols,
      trades: rows,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message });
  }
}

function mapAuditStatus(status: string): string {
  switch (status) {
    case "TP_HIT": return "TP";
    case "SL_HIT": return "SL";
    case "OPEN": return "Active";
    case "PARTIAL_EXIT": return "Partial";
    case "EXPIRED": return "Expired";
    default: return status;
  }
}
