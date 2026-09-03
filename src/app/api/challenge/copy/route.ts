// ═══════════════════════════════════════════════════════════════════════════
// Copy Trading API
// GET: config + stats + trades + pending approvals
// POST: receive signal / approve / reject / close / update config
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import {
  getCopyConfig,
  updateCopyConfig,
  receiveSignal,
  approveCopyTrade,
  rejectCopyTrade,
  closeCopyTrade,
  getCopyTrades,
  getPendingApprovals,
  getCopyStats,
  type CopyMode,
} from "@/lib/challenge/copy-trading-engine";

// ─── GET: Config + Stats + Trades ─────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const state = req.nextUrl.searchParams.get("state") as any;
    const pending = getPendingApprovals();
    const trades = getCopyTrades(state ? { state } : undefined);
    const stats = getCopyStats();
    const config = getCopyConfig();

    return NextResponse.json({
      success: true,
      config,
      stats,
      trades: trades.slice(0, 100),
      pendingApprovals: pending,
      pendingCount: pending.length,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ─── POST: Actions ─────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "receive_signal": {
        const trade = receiveSignal(body.signal);
        return NextResponse.json({
          success: true,
          trade,
          stats: getCopyStats(),
        });
      }

      case "approve": {
        const trade = approveCopyTrade(body.tradeId);
        if (!trade) return NextResponse.json({ success: false, error: "Trade not found or not pending" }, { status: 404 });
        return NextResponse.json({ success: true, trade, stats: getCopyStats() });
      }

      case "reject": {
        const trade = rejectCopyTrade(body.tradeId, body.reason || "User rejected");
        if (!trade) return NextResponse.json({ success: false, error: "Trade not found or not pending" }, { status: 404 });
        return NextResponse.json({ success: true, trade, stats: getCopyStats() });
      }

      case "close": {
        const trade = await closeCopyTrade(body.tradeId, body.exitPrice, body.exitReason || "MANUAL");
        if (!trade) return NextResponse.json({ success: false, error: "Trade not found or not open" }, { status: 404 });
        return NextResponse.json({ success: true, trade, stats: getCopyStats() });
      }

      case "update_config": {
        const config = updateCopyConfig(body.config);
        return NextResponse.json({ success: true, config });
      }

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
