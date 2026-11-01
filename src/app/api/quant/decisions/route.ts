// /api/quant/decisions — latest QuantDecisionLog rows (payload excluded).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const decisions = await db.quantDecisionLog.findMany({
      orderBy: { ts: "desc" },
      take: 50,
      select: {
        decisionId: true, ts: true, symbol: true, verdict: true,
        regime: true, winnerStrategy: true, blockReason: true,
      },
    });
    return NextResponse.json({ success: true, decisions, count: decisions.length });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "decisions failed" }, { status: 500 });
  }
}
