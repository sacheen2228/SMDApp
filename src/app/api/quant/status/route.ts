// /api/quant/status — UNIVERSAL_QUANT_V1 arm/mode/session/outbox snapshot.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTradingSession } from "@/lib/expiry-liquidity/market-session-config";
import { quantEnabled, effectiveMode } from "@/lib/quant/quant-runtime-config";
import { getOutboxStatus } from "@/lib/quant/quant-alert-queue";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const openPositions = await db.quantPaperTrade.count({
      where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] }, engineVersion: "UNIVERSAL_QUANT_V1" },
    });
    const lastDecision = await db.quantDecisionLog.findFirst({
      orderBy: { ts: "desc" },
      select: { decisionId: true, symbol: true, verdict: true, regime: true, blockReason: true, ts: true },
    });
    const outbox = await getOutboxStatus();
    return NextResponse.json({
      success: true,
      engineVersion: "UNIVERSAL_QUANT_V1",
      enabled: quantEnabled(),
      mode: effectiveMode(),
      session: getTradingSession(),
      openPositions,
      lastDecision: lastDecision ?? null,
      outbox,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "status failed" }, { status: 500 });
  }
}
