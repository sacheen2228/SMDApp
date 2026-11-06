// BTST (Buy Today Sell Tomorrow) Scanner API
// GET  /api/btst          → returns last cached scan (or triggers one if none)
// POST /api/btst?alert=1  → runs scan + sends Telegram alerts for score >= 85

import { NextRequest, NextResponse } from "next/server";
import { runBTSTScan, type BTSTScanResult } from "@/lib/btst-scanner";
import { shouldAlertBTST } from "@/lib/btst-engine";
import { sendTelegramMessage } from "@/lib/telegramSend";
import { buildCardMeta, getMarketClock } from "@/lib/data-freshness";

// In-memory cache (independent of intraday engine)
let cached: BTSTScanResult | null = null;
let lastScanAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function formatAlert(a: any): string {
  return [
    `🔵 <b>BTST Alert — ${a.symbol}</b>`,
    `Grade: ${a.grade} | Score: ${a.total}/100 | Conf: ${a.confidence}%`,
    `Entry ₹${a.entry} | SL ₹${a.sl} | TP1 ₹${a.tp1}`,
    `R:R ${a.riskReward} | Gap Risk: ${a.gapRisk}`,
    `Trend: ${a.trendLabel} | Sector: ${a.sectorLabel}`,
    ``,
    `<i>Holding: 1 Day</i>`,
  ].join("\n");
}

async function scanMeta() {
  const clock = await getMarketClock();
  return buildCardMeta({
    source: "nse",
    providerTimestamp: clock.tradeDate,
    ttlMs: 24 * 3600_000,
    live: clock.isOpen,
    reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
  });
}

export async function GET(req: NextRequest) {
  const now = Date.now();
  if (cached && now - lastScanAt < CACHE_TTL) {
    const meta = await scanMeta();
    return NextResponse.json({ success: true, status: meta.status, meta, cached: true, data: cached });
  }
  try {
    const result = await runBTSTScan();
    cached = result;
    lastScanAt = now;
    const meta = await scanMeta();
    return NextResponse.json({
      success: true,
      // An empty scan on a working feed is "no candidates", not "no data".
      status: meta.status,
      meta,
      cached: false,
      data: result,
      reason: result.candidates.length ? undefined : "No candidate passed the BTST screen on real data",
    });
  } catch (err: any) {
    console.error("[btst] scan failed:", err);
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: err?.message || "scan failed" },
      { status: 500 },
    );
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

    const meta = await scanMeta();
    return NextResponse.json({ success: true, status: meta.status, meta, data: result });
  } catch (err: any) {
    console.error("[btst] scan failed:", err);
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: err?.message || "scan failed" },
      { status: 500 },
    );
  }
}
