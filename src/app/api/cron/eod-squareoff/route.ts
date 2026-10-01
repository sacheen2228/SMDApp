// EOD square-off cron route — closes intraday journal trades at their real
// closing LTP at 15:31 IST (Mon-Fri), so trades that never hit SL/TP no
// longer pile up as EXPIRED/ACTIVE rows with NULL pnl (the 907-row class of
// boot-stale cleanups). Prices come from fetchLTP (Breeze → NSE → Yahoo) —
// the same source the live SL/TP monitor uses; rows whose LTP cannot be
// fetched are reported as noPrice and left OPEN (never a fabricated close).
//
// BTST is excluded on purpose — closeYesterdayBTST (15:25) owns it.
// Scheduled from scripts/dailyScanCron.ts (`EOD_SQUAREOFF_SCHEDULE`).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isEodEligible } from "@/lib/eod-squareoff";
import { forceCloseTrade } from "@/lib/activeTradeTracker";
import { fetchLTP } from "@/lib/tiger-monitor";

const SECRET = process.env.DAILY_SCAN_SECRET;
const CLOSABLE = ["ACTIVE", "OPEN", "PENDING", "TP1_HIT", "TP2_HIT"] as const;
const LTP_TIMEOUT_MS = 10000;
const CONCURRENCY = 4;
// EOD window: closing auction has just ended (15:40) and evening cleanup
// hasn't started — blocks accidental manual runs during the session.
const WINDOW = { startMin: 15 * 60 + 25, endMin: 17 * 60 };

function istMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const [h, m] = parts.split(":").map(Number);
  return h * 60 + m;
}

function isWeekdayIst(now: Date): boolean {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(now);
  return day !== "Sat" && day !== "Sun";
}

async function ltpWithTimeout(symbol: string, strike: number, type: string): Promise<number> {
  return await Promise.race([
    fetchLTP(symbol, strike, type),
    new Promise<number>((resolve) => setTimeout(() => resolve(0), LTP_TIMEOUT_MS)),
  ]);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const authHeader = request.headers.get("authorization");
    if (!SECRET || (authHeader !== `Bearer ${SECRET}` && searchParams.get("secret") !== SECRET)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    // dry=1: list eligible rows + resolve LTPs, never write — safe any time.
    const dry = searchParams.get("dry") === "1";
    if (!dry && !isWeekdayIst(now)) {
      return NextResponse.json({ success: true, message: "Weekend — skipped", closed: 0 });
    }
    const mins = istMinutes(now);
    if (!dry && (mins < WINDOW.startMin || mins > WINDOW.endMin)) {
      return NextResponse.json({
        success: false,
        error: `Outside EOD window (${Math.floor(WINDOW.startMin / 60)}:${String(WINDOW.startMin % 60).padStart(2, "0")}–${Math.floor(WINDOW.endMin / 60)}:${String(WINDOW.endMin % 60).padStart(2, "0")} IST)`,
        closed: 0,
      });
    }

    const rows = await db.trade.findMany({
      where: { status: { in: [...CLOSABLE] } },
      select: {
        tradeId: true,
        strategy: true,
        status: true,
        side: true,
        symbol: true,
        strike: true,
        type: true,
        entryPrice: true,
        entryTime: true,
        exchange: true,
      },
    });
    const eligible = rows.filter(isEodEligible);

    const closedIds: string[] = [];
    const noPrice: string[] = [];
    const errors: { id: string; err: string }[] = [];
    const dryRows: { tradeId: string; symbol: string; type: string; strike: number; status: string; strategy: string; ltp: number }[] = [];

    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
      await Promise.all(
        eligible.slice(i, i + CONCURRENCY).map(async (row) => {
          try {
            const ltp = await ltpWithTimeout(row.symbol, row.strike ?? 0, row.type ?? "");
            if (dry) {
              dryRows.push({
                tradeId: row.tradeId,
                symbol: row.symbol,
                type: row.type,
                strike: row.strike ?? 0,
                status: row.status,
                strategy: row.strategy,
                ltp,
              });
              return;
            }
            if (!(ltp > 0)) {
              noPrice.push(row.tradeId);
              return;
            }
            const res = await forceCloseTrade(row, ltp, "eod_square_off");
            if (res.closed) closedIds.push(row.tradeId);
            else noPrice.push(row.tradeId);
          } catch (e: any) {
            errors.push({ id: row.tradeId, err: String(e?.message || e) });
          }
        })
      );
    }

    if (dry) {
      console.log(`[EOD square-off] DRY eligible=${eligible.length} rows=${dryRows.length}`);
      return NextResponse.json({ success: true, dry: true, eligible: eligible.length, rows: dryRows, closed: 0, timestamp: now.toISOString() });
    }

    console.log(
      `[EOD square-off] eligible=${eligible.length} closed=${closedIds.length} noPrice=${noPrice.length} errors=${errors.length}` +
        (noPrice.length ? ` → ${noPrice.join(",")}` : "")
    );
    return NextResponse.json({
      success: true,
      eligible: eligible.length,
      closed: closedIds.length,
      closedIds,
      noPrice,
      errors,
      timestamp: now.toISOString(),
    });
  } catch (error: any) {
    console.error("[EOD square-off] failed:", error);
    return NextResponse.json(
      { success: false, error: String(error?.message || error), closed: 0 },
      { status: 500 }
    );
  }
}
