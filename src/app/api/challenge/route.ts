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
