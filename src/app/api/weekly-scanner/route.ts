// Weekly Equity Scanner API
// Stage 1: mechanical shortlist of NSE F&O equities with weekly growth
//          potential (real exchange daily bars — no simulation fallback).
// Stage 2 (?mode=pro&symbol=XXX): deep research dossier per shortlisted
//          symbol → BUY / WATCH / AVOID verdict.
//
// Honesty note (2026-10-20 audit): the route reported its source as
// "Yahoo Finance + NSE corporate actions" and its failure message said
// "Yahoo Finance returned no real quotes". Yahoo is banned (SOP §1) — the
// scan now runs on the exchange's own daily history, and the route names
// the real source and the age of the newest bar.

import { NextRequest, NextResponse } from "next/server";
import { runWeeklyScan } from "@/lib/weekly-equity-scanner";
import { runProResearch } from "@/lib/weekly-pro-mode";
import { buildCardMeta, getMarketClock } from "@/lib/data-freshness";
import { alertScannerStock, scannerTradeId } from "@/lib/scanner-stock-alerts";

// How many weekly setups one scan may alert.
const MAX_WEEKLY_ALERTS = 3;
// Confidence floor for a weekly alert (the shortlist is long — only the
// strongest setups are worth a phone notification).
const MIN_WEEKLY_CONFIDENCE = 70;

/** IST calendar day — one weekly trade per symbol per day. */
const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/**
 * Push the strongest weekly setups to Telegram (entry price, entry zone,
 * stop loss, targets) and register them so a TP/SL hit is reported.
 *
 * Gated behind ?live=true — the same convention as /api/scanner: the tab
 * asks for it explicitly, a background fetch does not.
 */
async function alertWeeklySetups(candidates: any[]): Promise<number> {
  let sent = 0;
  for (const c of candidates || []) {
    if (sent >= MAX_WEEKLY_ALERTS) break;
    if (!c?.symbol) continue;
    if (c.weeklyTrend !== "UP") continue;
    if (c.hasEventRisk) continue;
    if ((c.confidence ?? 0) < MIN_WEEKLY_CONFIDENCE) continue;
    if (!(c.riskReward >= 1.5)) continue;
    const entry = (c.entryZone?.low + c.entryZone?.high) / 2;
    if (!(entry > 0)) continue;
    const ok = await alertScannerStock({
      symbol: c.symbol,
      name: c.name,
      side: "BUY",
      entry,
      entryZone: c.entryZone,
      stopLoss: c.stopLoss,
      target1: c.target1,
      target2: c.target2,
      spot: c.price,
      confidence: c.confidence,
      source: "weekly-equity-scanner",
      tradeId: scannerTradeId("weekly-equity-scanner", c.symbol, ymd),
      reason: c.confidenceNote,
    }).catch(() => false);
    if (ok) sent++;
  }
  return sent;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") || "default";

    // Stage 2 — deep research on a single shortlisted symbol
    if (mode === "pro") {
      const symbol = (searchParams.get("symbol") || "").toUpperCase();
      if (!symbol) {
        return NextResponse.json({ success: false, error: "Missing ?symbol=" }, { status: 400 });
      }

      const scan = await runWeeklyScan();
      const candidate = (scan.candidates || []).find(c => c.symbol === symbol);

      // If the symbol isn't in the current shortlist, still research it if we
      // can identify it in the universe, otherwise 404.
      if (!candidate) {
        return NextResponse.json(
          { success: false, error: `${symbol} is not in the current weekly shortlist.` },
          { status: 404 }
        );
      }

      const dossier = await runProResearch(candidate);
      return NextResponse.json({
        success: true,
        mode: "pro",
        data: dossier,
        // The dossier's own source label (the fundamentals layer is a
        // separate feed — see weekly-pro-mode).
        dataSource: dossier.dataSource,
        timestamp: new Date().toISOString(),
      });
    }

    // Stage 1 — full shortlist
    const result = await runWeeklyScan();

    // Telegram alerts for the strongest setups — only when the caller asks
    // for them (?live=true, the Scanner tab does; background fetches do not).
    let alerted = 0;
    if (searchParams.get("live") === "true") {
      alerted = await alertWeeklySetups(result?.candidates || []).catch(() => 0);
    }

    if (!result || result.totalScanned === 0) {
      return NextResponse.json({
        success: false,
        status: "UNAVAILABLE",
        error: "Live equity data unavailable — the exchange returned no daily bars.",
        data: buildCardMeta({
          source: "none",
          providerTimestamp: null,
          ttlMs: 60 * 60_000,
          live: false,
          reason: "The exchange returned no daily bars for the F&O universe",
        }),
      }, { status: 503 });
    }

    const clock = await getMarketClock();
    const meta = buildCardMeta({
      source: "nse",
      providerTimestamp: clock.tradeDate,
      ttlMs: 24 * 3600_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    return NextResponse.json({
      success: true,
      status: meta.status,
      meta,
      mode,
      data: result,
      dataSource: "NSE daily history + NSE corporate actions",
      alerted,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[WeeklyScanner API] Error:", error);
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: error?.message || "Weekly scanner failed" },
      { status: 500 }
    );
  }
}
