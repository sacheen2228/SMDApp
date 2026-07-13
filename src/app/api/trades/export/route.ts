// API Route — Export trades to CSV
// GET /api/trades/export?date=2026-07-13&symbol=NIFTY

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date");
    const symbol = searchParams.get("symbol");

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
    });

    const formatDate = (d: Date | null | undefined) =>
      d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "";

    const rows = [
      [
        "Trade ID", "Symbol", "Strike", "Type", "Side", "Strategy",
        "Entry Time", "Entry Price", "Exit Time", "Exit Price",
        "Stop Loss", "Target 1", "Target 2", "Target 3",
        "Status", "Exit Reason", "P&L (₹)", "P&L (%)", "Holding Time (min)",
        "Confidence", "Quality Grade",
      ].join(","),
    ];

    for (const t of trades) {
      const pnlPct = t.entryPrice > 0 ? ((t.pnl ?? 0) / t.entryPrice) * 100 : 0;
      rows.push([
        escapeCsv(t.tradeId),
        t.symbol,
        t.strike,
        t.type,
        t.side,
        t.strategy,
        formatDate(t.entryTime),
        formatDate(t.exitTime),
        t.entryPrice,
        t.exitPrice ?? "",
        t.stopLoss,
        t.target1 ?? "",
        t.target2 ?? "",
        t.target3 ?? "",
        t.status,
        t.exitReason ?? "",
        t.pnl ?? "",
        pnlPct ? pnlPct.toFixed(2) : "",
        t.holdingTimeMin ?? "",
        t.confidence,
        t.qualityGrade,
      ].join(","));
    }

    const csv = rows.join("\n");
    const filename = `trades-${date || "all"}-${new Date().toISOString().split("T")[0]}.csv`;

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

function escapeCsv(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
