import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateSession } from "@/lib/icici-breeze/auth";

export async function GET() {
  try {
    const [breezeStatus, trades] = await Promise.allSettled([
      validateSession(),
      db.trade.findMany({ orderBy: { entryTime: "desc" }, take: 200 }),
    ]);

    const isBreezeConnected = breezeStatus.status === "fulfilled" ? breezeStatus.value : false;

    const allTrades = trades.status === "fulfilled" ? trades.value : [];
    const closed = allTrades.filter((t: any) => t.status === "TP_HIT" || t.status === "SL_HIT");
    const winners = closed.filter((t: any) => (t.pnl ?? 0) > 0);
    const totalPnL = closed.reduce((sum: number, t: any) => sum + (t.pnl ?? 0), 0);
    const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0;

    return NextResponse.json({
      success: true,
      data: {
        breeze: { connected: isBreezeConnected },
        trades: {
          total: allTrades.length,
          open: allTrades.filter((t: any) => t.status === "OPEN").length,
          closed: closed.length,
          winRate: Math.round(winRate * 10) / 10,
          totalPnL: Math.round(totalPnL * 100) / 100,
          winners: winners.length,
          losers: closed.length - winners.length,
        },
        timestamp: new Date().toISOString(),
        env: {
          hasBreezeKeys: !!(process.env.BREEZE_API_KEY || process.env.BREEZE_SECRET_KEY),
        },
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
