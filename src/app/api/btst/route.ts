// BTST (Buy Today Sell Tomorrow) Scanner API
// GET  /api/btst          → returns last cached scan (or triggers one if none)
// POST /api/btst?alert=1  → runs scan + sends Telegram alerts for score >= 85

import { NextRequest, NextResponse } from "next/server";
import { runBTSTScan, type BTSTScanResult } from "@/lib/btst-scanner";
import { shouldAlertBTST } from "@/lib/btst-engine";
import { sendTelegramMessage } from "@/lib/telegramSend";

// In-memory cache (independent of intraday engine)
let cached: BTSTScanResult | null = null;
let lastScanAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function formatAlert(a: any): string {
  return [
    `🔵 *BTST Alert — ${a.symbol}*`,
    `Grade: ${a.grade} | Score: ${a.total}/100 | Conf: ${a.confidence}%`,
    `Entry ₹${a.entry} | SL ₹${a.sl} | TP1 ₹${a.tp1}`,
    `R:R ${a.riskReward} | Gap Risk: ${a.gapRisk}`,
    `Trend: ${a.trendLabel} | Sector: ${a.sectorLabel}`,
    ``,
    `_Holding: 1 Day_`,
  ].join("\n");
}

export async function GET(req: NextRequest) {
  const now = Date.now();
  if (cached && now - lastScanAt < CACHE_TTL) {
    return NextResponse.json({ success: true, cached: true, data: cached });
  }
  try {
    const result = await runBTSTScan();
    cached = result;
    lastScanAt = now;
    return NextResponse.json({ success: true, cached: false, data: result });
  } catch (err: any) {
    console.error("[btst] scan failed:", err);
    return NextResponse.json({ success: false, error: err?.message || "scan failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const sendAlerts = req.nextUrl.searchParams.get("alert") === "1";
  try {
    const result = await runBTSTScan();
    cached = result;
    lastScanAt = Date.now();

    if (sendAlerts) {
      const chatIds = (process.env.TELEGRAM_DIGEST_CHAT_IDS || "").split(",").filter(Boolean);
      const toAlert = result.candidates.filter(shouldAlertBTST);
      for (const a of toAlert) {
        const msg = formatAlert(a);
        for (const id of chatIds) {
          await sendTelegramMessage(id, msg);
        }
      }
      return NextResponse.json({
        success: true,
        data: result,
        alerted: toAlert.length,
        alertChats: chatIds.length,
      });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (err: any) {
    console.error("[btst] scan failed:", err);
    return NextResponse.json({ success: false, error: err?.message || "scan failed" }, { status: 500 });
  }
}
