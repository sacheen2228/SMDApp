// /api/quant/tick — one UNIVERSAL_QUANT_V1 tick: decision cycle + position
// monitor + outbox drain. The shared-secret gate (QUANT_TICK_SECRET) is
// MANDATORY: the tick mutates state (paper trades, decision log) and drains
// the Telegram outbox, so it must never be reachable without a secret. The
// port is reachable through the public tunnel, so an unset secret means the
// endpoint is CLOSED, not open.
// Never throws — every failure lands in the errors array / engine-error alert.

import { NextRequest, NextResponse } from "next/server";
import { tickQuant } from "@/lib/quant/quant-engine";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  try {
    const secret = process.env.QUANT_TICK_SECRET;
    if (!secret) {
      console.error("[quant/tick] QUANT_TICK_SECRET is not set — refusing the tick (fail closed)");
      return NextResponse.json({ success: false, error: "tick secret not configured" }, { status: 503 });
    }
    const provided = req.headers.get("x-quant-tick-secret") ?? new URL(req.url).searchParams.get("secret");
    if (provided !== secret) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 403 });
    }
    const result = await tickQuant();
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "tick failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
