// app/api/challenge/route.ts
//
// ₹15K → ₹1L Challenge Engine API
// GET: scan + status | POST: execute trade | PATCH: close trade | DELETE: reset

import { NextRequest, NextResponse } from "next/server";
import { runChallengeScan, executeChallengeTrade } from "@/lib/challenge/challenge-engine";
import {
  getChallenge,
  initChallenge,
  closeTrade,
  resetChallenge,
  getTodayPnL,
} from "@/lib/challenge/challenge-tracker";

// ─── GET: Scan + Status ────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const ch = getChallenge();
    const scan = await runChallengeScan();

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
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ─── POST: Execute Trade ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { opportunityIndex = 0 } = body;

    const scan = await runChallengeScan();
    if (!scan.bestTrade) {
      return NextResponse.json({ success: false, error: "No trade available", scan }, { status: 400 });
    }

    const trade = executeChallengeTrade(scan.bestTrade);
    const ch = getChallenge();

    return NextResponse.json({
      success: true,
      trade,
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

    const trade = closeTrade(tradeId, exitPrice, exitReason);
    if (!trade) {
      return NextResponse.json({ success: false, error: "Trade not found or already closed" }, { status: 404 });
    }

    const ch = getChallenge();
    return NextResponse.json({
      success: true,
      trade,
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
