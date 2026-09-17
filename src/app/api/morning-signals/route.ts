// app/api/morning-signals/route.ts
//
// Morning Signal Generator — scans ALL instruments (NIFTY/SENSEX/Equity/MCX)
// and sends high-accuracy trades to Telegram. Call via cron or manual trigger.
// Deduplicates against signals sent today.

import { NextRequest, NextResponse } from "next/server";
import { runMorningSignalFlow } from "@/lib/morningSignalGenerator";
import { sendTelegramMessage } from "@/lib/telegramSend";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const CRON_SECRET = process.env.CRON_SECRET || "";

export async function GET(req: NextRequest) {
  // Auth: cron secret or manual trigger
  const authHeader = req.headers.get("authorization");
  const secretParam = req.nextUrl.searchParams.get("secret");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}` && secretParam !== CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (DIGEST_CHAT_IDS.length === 0) {
    return NextResponse.json(
      { error: "TELEGRAM_DIGEST_CHAT_IDS not configured" },
      { status: 500 }
    );
  }

  try {
    const result = await runMorningSignalFlow(async (text) => {
      const results = await Promise.all(
        DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
      );
      return results.some(Boolean);
    });

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[MorningSignals] Error:", err.message);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
