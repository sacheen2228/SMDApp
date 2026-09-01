import { NextRequest, NextResponse } from "next/server";
import { getAlertEngine, type AlertType } from "@/lib/expiry-liquidity/alert-engine";

export async function GET(req: NextRequest) {
  try {
    const engine = getAlertEngine();
    const { searchParams } = new URL(req.url);

    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const unacknowledgedOnly = searchParams.get("unacknowledgedOnly") === "true";
    const typeFilter = searchParams.get("type") as AlertType | null;

    let alerts = unacknowledgedOnly ? engine.getUnacknowledged() : engine.getHistory(limit);

    if (typeFilter) {
      alerts = alerts.filter((a) => a.type === typeFilter);
    }

    return NextResponse.json({
      alerts,
      stats: engine.getStats(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to fetch alerts" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const engine = getAlertEngine();
    const body = await req.json();
    const { type, symbol, message, severity, data } = body;

    if (!type || !symbol || !message) {
      return NextResponse.json({ error: "type, symbol, and message are required" }, { status: 400 });
    }

    const alert = engine.fire(type, symbol, message, severity || "WARNING", data || {});
    if (!alert) {
      return NextResponse.json({ error: "Alert suppressed by cooldown or rate limit" }, { status: 429 });
    }

    return NextResponse.json({ alert });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to fire alert" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const engine = getAlertEngine();
    const body = await req.json();
    const { id, acknowledgeAll } = body;

    if (acknowledgeAll) {
      const unacknowledged = engine.getUnacknowledged();
      for (const alert of unacknowledged) {
        engine.acknowledge(alert.id);
      }
      return NextResponse.json({ acknowledged: unacknowledged.length });
    }

    if (!id) {
      return NextResponse.json({ error: "id or acknowledgeAll is required" }, { status: 400 });
    }

    const success = engine.acknowledge(id);
    if (!success) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }

    return NextResponse.json({ acknowledged: 1 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to acknowledge alert" }, { status: 500 });
  }
}
