// ═══════════════════════════════════════════════════════════════════════════
// Challenge API — ₹15K → ₹1L Challenge
// FIXED: scan caching, capital deduction, ID matching
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

// ── Scan cache (FIXED: don't re-scan every GET) ──
let lastScan: ChallengeScanResult | null = null;
let lastScanTime = 0;
const SCAN_TTL_MS = 15_000; // 15 seconds

async function getCachedScan(): Promise<ChallengeScanResult> {
  const now = Date.now();
  if (lastScan && now - lastScanTime < SCAN_TTL_MS) {
    return lastScan;
  }
  lastScan = await runChallengeScan();
  lastScanTime = now;
  return lastScan;
}

// ─── GET: Status + Trade Feed (scan on-demand via ?refresh=1) ─────
export async function GET(req: NextRequest) {
  try {
    const ch = getChallenge();
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";

    // Only re-scan when explicitly requested or first load
    const scan = refresh ? await runChallengeScan() : await getCachedScan();
    const tradeLog = getTradeLog(50);
    const tradeStats = getTradeStats();
    const openTrades = getOpenTrades();

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
        equityCurve: ch.equityCurve.slice(-50), // Last 50 points for chart
      },
      scan,
      tradeFeed: tradeLog,
      tradeStats,
      openTrades,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ─── POST: Auto-Execute Trade ──────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { mode = "PAPER", opportunityIndex = 0 } = body;

    const scan = await runChallengeScan();
    const opp = scan.topOpportunities[opportunityIndex] || scan.bestTrade;
    if (!opp) {
      return NextResponse.json({ success: false, error: "No trade available", scan }, { status: 400 });
    }

    // Execute via auto-executor (LIVE or PAPER)
    const result = await executeTrade(opp, mode as ExecutionMode);

    // Record in challenge tracker (FIXED: don't deduct maxLoss from capital)
    const ch = getChallenge();
    if (result.success) {
      // Track the trade but DON'T deduct maxLoss — P&L applied on close only
      ch.totalTrades++;
      ch.lastUpdate = new Date().toISOString();
    }

    // Invalidate scan cache after executing
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

    // Close in auto-executor (handles Breeze square-off + audit close)
    const execResult = await closeTradeExecution(tradeId, exitPrice, exitReason);

    // Also close in challenge tracker for capital tracking (FIXED: ID matching)
    const trackerTrade = closeTrade(tradeId, exitPrice, exitReason);
    const ch = getChallenge();

    // Invalidate scan cache
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

// ─── DELETE: Reset Challenge ───────────────────────────────────────
export async function DELETE() {
  try {
    const ch = resetChallenge();
    lastScan = null; // Invalidate cache
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
