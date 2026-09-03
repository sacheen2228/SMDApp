// app/api/challenge/route.ts
//
// ₹15K → ₹1L Challenge Engine API
// GET: scan + status + trade feed
// POST: auto-execute trade (LIVE or PAPER)
// PATCH: close trade
// DELETE: reset

import { NextRequest, NextResponse } from "next/server";
import { runChallengeScan } from "@/lib/challenge/challenge-engine";
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

// ─── GET: Scan + Status + Trade Feed ──────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const ch = getChallenge();
    const scan = await runChallengeScan();
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
    if (!scan.bestTrade) {
      return NextResponse.json({ success: false, error: "No trade available", scan }, { status: 400 });
    }

    // Execute via auto-executor (LIVE or PAPER)
    const result = await executeTrade(scan.bestTrade, mode as ExecutionMode);

    // Also record in challenge tracker for capital tracking
    const ch = getChallenge();
    if (result.success) {
      ch.currentCapital -= result.maxLoss; // Reserve max loss
      ch.totalTrades++;
      ch.lastUpdate = new Date().toISOString();
    }

    return NextResponse.json({
      success: true,
      execution: result,
      challenge: {
        currentCapital: ch.currentCapital,
        totalTrades: ch.totalTrades,
        status: ch.status,
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

    // Close in auto-executor
    const execResult = await closeTradeExecution(tradeId, exitPrice, exitReason);

    // Also close in challenge tracker
    const trackerTrade = closeTrade(tradeId, exitPrice, exitReason);
    const ch = getChallenge();

    return NextResponse.json({
      success: true,
      execution: execResult,
      trade: trackerTrade,
      challenge: {
        currentCapital: ch.currentCapital,
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
