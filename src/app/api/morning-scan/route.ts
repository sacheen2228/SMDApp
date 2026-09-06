// /api/morning-scan — Trigger morning trade scan
// GET: Run scan and send high-accuracy trades to Telegram

import { NextResponse } from "next/server";
import { runMorningScan } from "@/lib/morning-scan";

export async function GET() {
  try {
    const result = await runMorningScan();

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
