// /api/quant/positions — live (OPEN / PARTIALLY_CLOSED / PENDING_ENTRY) paper positions.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const positions = await db.quantPaperTrade.findMany({
      where: { status: { in: ["OPEN", "PARTIALLY_CLOSED", "PENDING_ENTRY"] } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ success: true, positions, count: positions.length });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "positions failed" }, { status: 500 });
  }
}
