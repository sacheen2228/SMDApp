// /api/quant/trades — paper trade history + closed-trade performance metrics.
// Filters: ?limit (default 50), ?strategy, ?symbol.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getQuantPerformanceFromDb } from "@/lib/quant/quant-performance";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
    const strategy = url.searchParams.get("strategy");
    const symbol = url.searchParams.get("symbol");

    const where: Prisma.QuantPaperTradeWhereInput = {};
    if (strategy) where.strategy = strategy;
    if (symbol) where.symbol = symbol;

    const [trades, performance] = await Promise.all([
      db.quantPaperTrade.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
      getQuantPerformanceFromDb(),
    ]);
    return NextResponse.json({ success: true, count: trades.length, trades, performance });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "trades failed" }, { status: 500 });
  }
}
