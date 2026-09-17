// app/api/daily-digest/route.ts
//
// End-of-day digest — call at 15:25 IST to send today's summary.
// Deduplicates: only sends once per day.

import { NextRequest, NextResponse } from "next/server";
import { sendDailyDigest } from "@/lib/dailyDigest";

const CRON_SECRET = process.env.CRON_SECRET || "";

let lastSentDate = "";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secretParam = req.nextUrl.searchParams.get("secret");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}` && secretParam !== CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Only send once per day
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (lastSentDate === today) {
    return NextResponse.json({ success: true, message: "Already sent today" });
  }

  try {
    const sent = await sendDailyDigest();
    if (sent) lastSentDate = today;
    return NextResponse.json({
      success: sent,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
