// app/api/premarket-readiness/route.ts
//
// Pre-flight readiness check — call at 09:10 IST (cron) or manually.
// Aggregates feed gate + data health + session health + provider circuits +
// morning brief into ONE verdict and optionally pushes it to Telegram.
//
//   GET /api/premarket-readiness                → evaluate only
//   GET /api/premarket-readiness?notify=1       → also send to digest chats
//   GET /api/premarket-readiness?notify=always  → send even when READY
//
// Auth: CRON_SECRET (Bearer or ?secret=), same convention as other crons.
// When CRON_SECRET is unset the route stays open (local/dev), matching
// /api/morning-signals.

import { NextRequest, NextResponse } from "next/server";
import {
  evaluatePremarketReadiness,
  formatReadinessMessage,
} from "@/lib/premarket-readiness";

const CRON_SECRET = process.env.CRON_SECRET || "";

// The evaluation runs live probes (feed service, option chain, session
// health). Dashboard polls and cron both hit this route, so share a short
// cache instead of hammering NSE/BSE/broker endpoints.
const CACHE_MS = 60_000;
let cached: { at: number; report: Awaited<ReturnType<typeof evaluatePremarketReadiness>> } | null = null;

async function getReport(force: boolean) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  const report = await evaluatePremarketReadiness();
  cached = { at: Date.now(), report };
  return report;
}

function digestChatIds(): string[] {
  return (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secretParam = req.nextUrl.searchParams.get("secret");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}` && secretParam !== CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const notify = req.nextUrl.searchParams.get("notify") ?? "";
  const force = req.nextUrl.searchParams.get("fresh") === "1";

  try {
    const report = await getReport(force);

    // notify=always → always send; notify=1 → send only when something is
    // wrong; no param → evaluate only.
    const shouldNotify = notify === "always" || (notify === "1" && report.gate !== "READY");

    let notified = false;
    let notifyNote = "not requested";
    if (shouldNotify) {
      const ids = digestChatIds();
      if (ids.length === 0) {
        notifyNote = "TELEGRAM_DIGEST_CHAT_IDS not configured";
      } else {
        const text = formatReadinessMessage(report);
        const { sendTelegramMessage } = await import("@/lib/telegramSend");
        const results = await Promise.all(ids.map((id) => sendTelegramMessage(id, text)));
        notified = results.some(Boolean);
        notifyNote = notified ? `sent to ${ids.length} chat(s)` : "suppressed by Telegram send window";
      }
    }

    return NextResponse.json({
      success: true,
      gate: report.gate,
      ready: report.ready,
      summary: report.summary,
      tradingDay: report.tradingDay,
      minutesToOpen: report.minutesToOpen,
      blockers: report.blockers,
      warnings: report.warnings,
      checks: report.checks,
      notified,
      notifyNote,
      message: formatReadinessMessage(report),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[PremarketReadiness] Error:", err?.message);
    return NextResponse.json(
      { success: false, error: err?.message || "readiness check failed" },
      { status: 500 }
    );
  }
}
