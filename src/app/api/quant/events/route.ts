// /api/quant/events — QuantTradeEvent rows (?tradeId=… or latest 100), or the
// alert outbox with delivery state (?view=outbox).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    if (url.searchParams.get("view") === "outbox") {
      const rows = await db.quantAlertOutbox.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true, eventId: true, idempotencyKey: true, alertType: true,
          status: true, attempts: true, lastError: true, chatId: true,
          createdAt: true, sentAt: true,
        },
      });
      return NextResponse.json({ success: true, view: "outbox", events: rows, count: rows.length });
    }

    const tradeId = url.searchParams.get("tradeId");
    if (tradeId) {
      const events = await db.quantTradeEvent.findMany({
        where: { tradeId },
        orderBy: { ts: "desc" },
      });
      return NextResponse.json({ success: true, tradeId, events, count: events.length });
    }

    const events = await db.quantTradeEvent.findMany({
      orderBy: { ts: "desc" },
      take: 100,
    });
    return NextResponse.json({ success: true, events, count: events.length });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "events failed" }, { status: 500 });
  }
}
