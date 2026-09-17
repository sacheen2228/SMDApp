// ═══════════════════════════════════════════════════════════════════════════
// Challenge API — ₹15K → ₹1L Challenge
// GET: scan + status + trade feed + auto-execute
// POST: manual execute trade
// PATCH: close trade / toggle auto mode
// DELETE: reset
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { runChallengeScan, type ChallengeScanResult } from "@/lib/challenge/challenge-engine";
import {
  getChallenge,
  initChallenge,
  closeTrade,
  resetChallenge,
  getTodayPnL,
} from "@/lib/challenge/challenge-tracker";
import {
  executeTrade,
  closeTradeExecution,
  getTradeLog,
  getTradeStats,
  getOpenTrades,
  type ExecutionMode,
} from "@/lib/challenge/auto-executor";
import { getCurrentSession } from "@/lib/market-session";
import { getNSEIndiaVIX } from "@/lib/nse-api";

// ── Scan cache ──
let lastScan: ChallengeScanResult | null = null;
let lastScanTime = 0;
const SCAN_TTL_MS = 15_000;

// ── Auto-execute state ──
let autoExecuteEnabled = false;
let autoExecuteMode: "PAPER" | "LIVE" = "PAPER";
let lastAutoExecTime = 0;
const AUTO_EXEC_COOLDOWN_MS = 60_000; // 1 min between auto-trades

async function getCachedScan(): Promise<ChallengeScanResult> {
  const now = Date.now();
  if (lastScan && now - lastScanTime < SCAN_TTL_MS) return lastScan;
  lastScan = await runChallengeScan();
  lastScanTime = now;
  return lastScan;
}

// ── Auto-execute logic ──
async function tryAutoExecute(scan: ChallengeScanResult) {
  if (!autoExecuteEnabled) return null;
  if (scan.decision !== "TRADE" || !scan.bestTrade) return null;

  const now = Date.now();
  if (now - lastAutoExecTime < AUTO_EXEC_COOLDOWN_MS) return null;

  const ch = getChallenge();
  if (ch.status !== "ACTIVE") return null;

  // Check we don't already have too many open trades
  const openTrades = getOpenTrades();
  if (openTrades.length >= 3) return null;

  lastAutoExecTime = now;
  const result = await executeTrade(scan.bestTrade, autoExecuteMode);
  if (result.success) {
    ch.totalTrades++;
    ch.lastUpdate = new Date().toISOString();
  }
  return result;
}

// ─── GET: Status + Scan + Auto-Execute ──────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const ch = getChallenge();
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";

    const scan = refresh ? await runChallengeScan() : await getCachedScan();
    const tradeLog = getTradeLog(50);
    const tradeStats = getTradeStats();
    const openTrades = getOpenTrades();

    // Auto-execute if enabled
    let autoExecResult = null;
    if (autoExecuteEnabled) {
      autoExecResult = await tryAutoExecute(scan);
    }

    // TIGER system context
    const session = getCurrentSession();
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hour = ist.getHours();
    const minute = ist.getMinutes();
    const dayOfWeek = ist.getDay();

    // Time window
    let timeWindow = "CLOSED";
    if (hour === 9 && minute >= 15 && minute < 30) timeWindow = "GAP_TRAP";
    else if (hour === 9 && minute >= 30 || hour === 10 && minute <= 30) timeWindow = "WINDOW_1";
    else if (hour === 11 && minute >= 30 || hour === 12) timeWindow = "LUNCH_CHOP";
    else if (hour === 13 && minute >= 30 || hour === 14 && minute <= 45) timeWindow = "WINDOW_2";
    else if (hour === 14 && minute > 45 || hour === 15 && minute <= 15) timeWindow = "EXIT_ZONE";
    else if (hour >= 9 && hour < 15) timeWindow = "ACTIVE";

    // VIX regime — fetch real VIX if scan didn't provide it
    let vix = scan.marketContext.vix || 0;
    if (vix <= 0) {
      try {
        const vixData = await getNSEIndiaVIX();
        if (vixData && vixData.value > 0) vix = vixData.value;
      } catch { /* VIX fetch failed — leave as 0 */ }
    }
    let vixRegime = "UNKNOWN";
    if (vix > 0 && vix < 12) vixRegime = "COMPLACENT";
    else if (vix >= 12 && vix < 15) vixRegime = "CALM";
    else if (vix >= 15 && vix < 20) vixRegime = "NORMAL";
    else if (vix >= 20 && vix < 25) vixRegime = "ELEVATED";
    else if (vix >= 25) vixRegime = "FEAR";

    // Trend-day checks (from scan data)
    const trendChecks = {
      orbBreak: scan.decision === "TRADE",
      straddleExpanding: vix >= 12 && vix < 20,
      oiUnwinding: scan.bestTrade?.score >= 70,
      pcrShift: scan.marketContext.regime === "BULLISH" || scan.marketContext.regime === "BEARISH",
      breadthAligned: scan.marketContext.breadth === "BULLISH" || scan.marketContext.breadth === "BEARISH",
    };
    const trendScore = Object.values(trendChecks).filter(Boolean).length;
    const isTrendDay = trendScore >= 3;

    // Risk status
    const tradesToday = tradeStats?.total || 0;
    const lossesToday = tradeStats?.losses || 0;
    const dailyStopHit = lossesToday >= 2;
    const weeklyStopHit = ch.maxDrawdownPct >= 12;

    return NextResponse.json({
      success: true,
      challenge: {
        number: ch.challengeNumber,
        status: ch.status,
        startingCapital: ch.startingCapital,
        currentCapital: ch.currentCapital,
        peakCapital: ch.peakCapital,
        targetCapital: ch.targetCapital,
        progressPct: ch.progressPct,
        progressLabel: ch.progressLabel,
        totalTrades: ch.totalTrades,
        winCount: ch.winCount,
        lossCount: ch.lossCount,
        winRate: ch.winRate,
        profitFactor: ch.profitFactor,
        expectancy: ch.expectancy,
        maxDrawdownPct: ch.maxDrawdownPct,
        consecutiveLosses: ch.consecutiveLosses,
        milestones: ch.milestones,
        todayPnL: getTodayPnL(),
        drawdown: ch.currentDrawdown,
        equityCurve: ch.equityCurve.slice(-50),
      },
      tiger: {
        timeWindow,
        vixRegime,
        vix,
        trendDay: { checks: trendChecks, score: trendScore, isTrendDay },
        risk: {
          tradesToday,
          lossesToday,
          maxTradesPerDay: 2,
          dailyStopHit,
          weeklyStopHit,
          canTrade: !dailyStopHit && !weeklyStopHit && (session?.isMarketOpen ?? false),
          capitalDeployedPct: openTrades.length > 0 ? Math.round((openTrades.reduce((s: number, t: any) => s + (t.entry * t.quantity), 0) / ch.currentCapital) * 100) : 0,
        },
        session: session?.session || "UNKNOWN",
        isMarketOpen: session?.isMarketOpen ?? false,
        allowedInstruments: ["NIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "BANKNIFTY"],
      },
      scan,
      tradeFeed: tradeLog,
      tradeStats,
      openTrades,
      autoExecute: {
        enabled: autoExecuteEnabled,
        mode: autoExecuteMode,
        lastTrade: autoExecResult,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ─── POST: Manual Execute / Toggle Auto ────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action = "execute", mode = "PAPER", opportunityIndex = 0 } = body;

    // Toggle auto-execute
    if (action === "toggle_auto") {
      autoExecuteEnabled = !autoExecuteEnabled;
      autoExecuteMode = (body.mode as "PAPER" | "LIVE") || autoExecuteMode;
      return NextResponse.json({
        success: true,
        autoExecute: { enabled: autoExecuteEnabled, mode: autoExecuteMode },
        message: autoExecuteEnabled ? `Auto-trade ON (${autoExecuteMode})` : "Auto-trade OFF",
      });
    }

    // Manual execute
    const scan = await runChallengeScan();
    const opp = scan.topOpportunities[opportunityIndex] || scan.bestTrade;
    if (!opp) {
      return NextResponse.json({ success: false, error: "No trade available", scan }, { status: 400 });
    }

    const result = await executeTrade(opp, mode as ExecutionMode);
    const ch = getChallenge();
    if (result.success) {
      ch.totalTrades++;
      ch.lastUpdate = new Date().toISOString();
    }

    lastScan = null;

    return NextResponse.json({
      success: true,
      execution: result,
      challenge: {
        currentCapital: ch.currentCapital,
        totalTrades: ch.totalTrades,
        status: ch.status,
        progressPct: ch.progressPct,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ─── PATCH: Close Trade ────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { tradeId, exitPrice, exitReason = "MANUAL" } = body;

    if (!tradeId || exitPrice === undefined) {
      return NextResponse.json({ success: false, error: "tradeId and exitPrice required" }, { status: 400 });
    }

    const execResult = await closeTradeExecution(tradeId, exitPrice, exitReason);
    const trackerTrade = closeTrade(tradeId, exitPrice, exitReason);
    const ch = getChallenge();
    lastScan = null;

    return NextResponse.json({
      success: true,
      execution: execResult,
      trade: trackerTrade,
      challenge: {
        currentCapital: ch.currentCapital,
        progressPct: ch.progressPct,
        progressLabel: ch.progressLabel,
        status: ch.status,
        winRate: ch.winRate,
        profitFactor: ch.profitFactor,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ─── DELETE: Reset ─────────────────────────────────────────────────
export async function DELETE() {
  try {
    const ch = resetChallenge();
    lastScan = null;
    autoExecuteEnabled = false;
    return NextResponse.json({
      success: true,
      message: `Challenge #${ch.challengeNumber} initialized`,
      challenge: {
        number: ch.challengeNumber,
        status: ch.status,
        startingCapital: ch.startingCapital,
        currentCapital: ch.currentCapital,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
