// app/api/intraday-scan/route.ts
//
// Manual trigger / external-cron target for the intraday scanner.
// If you're using scripts/dailyScanCron.ts as an in-process scheduler,
// you don't need to hit this route on a schedule — it's there for
// on-demand testing or if you'd rather drive the cadence externally.

import { NextRequest, NextResponse } from "next/server";
import { sendIntradayAlerts } from "@/lib/sendIntradayAlerts";

const CRON_SECRET = process.env.DAILY_SCAN_SECRET;

export async function GET(req: NextRequest) {
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-cron-secret");
  if (CRON_SECRET && provided !== CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await sendIntradayAlerts();
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[/api/intraday-scan] failed", err);
    return NextResponse.json({ error: err.message ?? "scan failed" }, { status: 500 });
  }
}
