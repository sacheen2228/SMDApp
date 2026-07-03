// SDM Trade Tracker
// Persistent trade journal using Prisma + SQLite with in-memory cache

import type { TradeRecord, TradeGrade } from "@/types/sdm";
import { db } from "@/lib/db";

// ─── State (module-level) ────────────────────────────────────────
let trades: TradeRecord[] = [];
let cacheLoaded = false;
const MAX_TRADES_EXPIRY = 4;
let lotSize = 65;
let currentSymbol = "NIFTY";

// ─── Cache Management ────────────────────────────────────────────
async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dbTrades = await db.trade.findMany({
    where: { createdAt: { gte: today } },
    orderBy: { entryTime: "asc" },
  });

  trades = dbTrades.map(dbTradeToRecord);
  cacheLoaded = true;
}

function dbTradeToRecord(t: any): TradeRecord {
  return {
    id: t.tradeId,
    time: new Date(t.entryTime).toLocaleTimeString("en-IN", { hour12: false }),
    direction: t.type as TradeRecord["direction"],
    strike: t.strike,
    entry: t.entryPrice,
    tp1: t.target1 ?? 0,
    tp2: t.target2 ?? 0,
    tp3: t.target3 ?? 0,
    sl: t.stopLoss,
    status: mapDbStatus(t.status),
    pnl: t.pnl ?? 0,
    grade: t.qualityGrade as TradeGrade,
    confidence: t.confidence,
    reason: t.aiReasonSnapshot,
    exitReason: t.exitReason ?? undefined,
    holdingTime: t.holdingTimeMin ?? undefined,
    entryMs: new Date(t.entryTime).getTime(),
    partialExits: [],
  };
}

function mapDbStatus(
  status: string
): "active" | "tp_hit" | "sl_hit" | "expired" | "partial_exit" {
  switch (status) {
    case "OPEN":
      return "active";
    case "PARTIAL_EXIT":
      return "partial_exit";
    case "TP_HIT":
      return "tp_hit";
    case "SL_HIT":
      return "sl_hit";
    case "EXPIRED":
      return "expired";
    default:
      return "active";
  }
}

function mapStatusToDb(
  status: string
): "OPEN" | "PARTIAL_EXIT" | "TP_HIT" | "SL_HIT" | "EXPIRED" {
  switch (status) {
    case "active":
      return "OPEN";
    case "partial_exit":
      return "PARTIAL_EXIT";
    case "tp_hit":
      return "TP_HIT";
    case "sl_hit":
      return "SL_HIT";
    case "expired":
      return "EXPIRED";
    default:
      return "OPEN";
  }
}

// ─── Add Trade ───────────────────────────────────────────────────
export function addTrade(
  direction: "CALL" | "PUT" | "SELL_CALL" | "SELL_PUT",
  strike: number,
  entry: number,
  tp1: number,
  tp2: number,
  tp3: number,
  sl: number,
  isExpiryDay: boolean,
  grade: TradeGrade = "C",
  confidence: number = 50,
  reason: string = ""
): TradeRecord | null {
  if (isExpiryDay && trades.length >= MAX_TRADES_EXPIRY) {
    return null;
  }

  const now = new Date();
  const tradeId =
    Date.now().toString(36) + Math.random().toString(36).substring(2, 7);

  const trade: TradeRecord = {
    id: tradeId,
    time: now.toLocaleTimeString("en-IN", { hour12: false }),
    direction,
    strike,
    entry,
    tp1,
    tp2,
    tp3,
    sl,
    status: "active",
    pnl: 0,
    grade,
    confidence,
    reason,
    entryMs: now.getTime(),
    partialExits: [],
  };

  trades.push(trade);

  // Persist to DB (fire-and-forget)
  db.trade
    .create({
      data: {
        tradeId,
        symbol: currentSymbol,
        strike,
        type: direction,
        entryTime: now,
        entryPrice: entry,
        confidence,
        qualityScore: 0,
        qualityGrade: grade,
        aiReasonSnapshot: reason,
        status: "OPEN",
        riskPerTrade: 0,
        positionSize: lotSize,
        stopLoss: sl,
        target1: tp1,
        target2: tp2,
        target3: tp3,
      },
    })
    .catch((err) => console.error("[TradeTracker] Failed to persist trade:", err));

  return trade;
}

// ─── Partial Exit ────────────────────────────────────────────────
export function partialExit(
  tradeId: string,
  percent: number,
  price: number
): boolean {
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade || trade.status !== "active") return false;

  const exitQuantity = Math.floor(lotSize * (percent / 100));
  const pnl = trade.direction.includes("CALL")
    ? (price - trade.entry) * exitQuantity
    : (trade.entry - price) * exitQuantity;

  trade.partialExits.push({
    time: new Date().toLocaleTimeString("en-IN", { hour12: false }),
    percent,
    price,
    pnl,
  });

  trade.pnl += pnl;
  trade.status = "partial_exit";

  const totalExited = trade.partialExits.reduce(
    (sum, e) => sum + e.percent,
    0
  );
  if (totalExited >= 75) {
    trade.status = "tp_hit";
  }

  // Persist to DB
  db.trade
    .update({
      where: { tradeId: trade.id },
      data: {
        pnl: trade.pnl,
        status: mapStatusToDb(trade.status),
      },
    })
    .catch((err) =>
      console.error("[TradeTracker] Failed to update partial exit:", err)
    );

  return true;
}

// ─── Update Trades with Current LTP ──────────────────────────────
export function updateTrades(currentLTP: number, currentSpot: number): void {
  for (const trade of trades) {
    if (trade.status !== "active" && trade.status !== "partial_exit") continue;

    const isBuy =
      trade.direction === "CALL" || trade.direction === "PUT";
    const isSell =
      trade.direction === "SELL_CALL" || trade.direction === "SELL_PUT";

    let updated = false;

    if (isBuy) {
      if (currentLTP >= trade.tp1) {
        trade.status = "tp_hit";
        trade.pnl = (trade.tp1 - trade.entry) * lotSize;
        updated = true;
      } else if (currentLTP <= trade.sl) {
        trade.status = "sl_hit";
        trade.pnl = (trade.sl - trade.entry) * lotSize;
        updated = true;
      }
    } else if (isSell) {
      if (currentLTP >= trade.sl) {
        trade.status = "sl_hit";
        trade.pnl = (trade.entry - trade.sl) * lotSize;
        updated = true;
      } else if (currentLTP <= trade.tp1) {
        trade.status = "tp_hit";
        trade.pnl = (trade.entry - trade.tp1) * lotSize;
        updated = true;
      }
    }

    if (updated) {
      const exitTime = new Date();
      const holdingTimeMin =
        (exitTime.getTime() - trade.entryMs) / (1000 * 60);
      trade.holdingTime = holdingTimeMin;

      db.trade
        .update({
          where: { tradeId: trade.id },
          data: {
            pnl: trade.pnl,
            status: mapStatusToDb(trade.status),
            exitTime,
            exitPrice: currentLTP,
            holdingTimeMin,
          },
        })
        .catch((err) =>
          console.error("[TradeTracker] Failed to persist trade update:", err)
        );
    }
  }
}

// ─── Expire All Active Trades ────────────────────────────────────
export function expireAllActiveTrades(): void {
  const now = new Date();
  for (const trade of trades) {
    if (trade.status === "active" || trade.status === "partial_exit") {
      trade.status = "expired";
      trade.exitReason = "Market closed";
      trade.holdingTime = (now.getTime() - trade.entryMs) / (1000 * 60);

      db.trade
        .update({
          where: { tradeId: trade.id },
          data: {
            status: "EXPIRED",
            exitReason: "Market closed",
            exitTime: now,
            holdingTimeMin: trade.holdingTime,
          },
        })
        .catch((err) =>
          console.error("[TradeTracker] Failed to expire trade:", err)
        );
    }
  }
}

// ─── Get Today's Trades ──────────────────────────────────────────
export function getTradesToday(): TradeRecord[] {
  // Synchronous read from cache; cache is loaded lazily on first async call
  return trades;
}

// ─── Get Trades Taken Count ──────────────────────────────────────
export function getTradesTakenCount(): number {
  return trades.length;
}

// ─── Get Daily PnL ───────────────────────────────────────────────
export function getDailyPnL(): number {
  return trades
    .filter(
      (t) =>
        t.status === "tp_hit" ||
        t.status === "sl_hit" ||
        t.status === "partial_exit"
    )
    .reduce((sum, t) => sum + t.pnl, 0);
}

// ─── Get Win Rate ────────────────────────────────────────────────
export function getWinRate(): number {
  const closedTrades = trades.filter(
    (t) => t.status === "tp_hit" || t.status === "sl_hit"
  );
  if (closedTrades.length === 0) return 0;
  const winners = closedTrades.filter((t) => t.pnl > 0);
  return (winners.length / closedTrades.length) * 100;
}

// ─── Get Average Grade ───────────────────────────────────────────
export function getAverageGrade(): string {
  if (trades.length === 0) return "N/A";
  const gradeMap: Record<string, number> = {
    "A+": 5,
    A: 4,
    B: 3,
    C: 2,
    D: 1,
  };
  const avgGrade =
    trades.reduce((sum, t) => sum + (gradeMap[t.grade] || 2), 0) /
    trades.length;
  if (avgGrade >= 4.5) return "A+";
  if (avgGrade >= 3.5) return "A";
  if (avgGrade >= 2.5) return "B";
  if (avgGrade >= 1.5) return "C";
  return "D";
}

// ─── Get Holding Time Stats ──────────────────────────────────────
export function getHoldingTimeStats(): {
  avg: number;
  min: number;
  max: number;
} {
  const closedTrades = trades.filter(
    (t) =>
      t.status === "tp_hit" || t.status === "sl_hit" || t.status === "expired"
  );
  if (closedTrades.length === 0) return { avg: 0, min: 0, max: 0 };

  const holdingTimes = closedTrades.map(
    (t) => Date.now() - t.entryMs
  );
  return {
    avg: holdingTimes.reduce((a, b) => a + b, 0) / holdingTimes.length,
    min: Math.min(...holdingTimes),
    max: Math.max(...holdingTimes),
  };
}

// ─── Can Take Trade ──────────────────────────────────────────────
export function canTakeTrade(isExpiryDay: boolean): boolean {
  if (isExpiryDay) return trades.length < MAX_TRADES_EXPIRY;
  return true;
}

// ─── Reset (new day or manual) ───────────────────────────────────
export function reset(): void {
  trades = [];
}

// ─── Set Lot Size ────────────────────────────────────────────────
export function setLotSize(size: number): void {
  lotSize = size;
}

// ─── Export Journal Data ─────────────────────────────────────────
export function exportJournal(): string {
  const header =
    "Time,Direction,Strike,Entry,TP1,TP2,TP3,SL,Status,PnL,Grade,Confidence,Reason\n";
  const rows = trades
    .map(
      (t) =>
        `${t.time},${t.direction},${t.strike},${t.entry},${t.tp1},${t.tp2},${t.tp3},${t.sl},${t.status},${t.pnl.toFixed(2)},${t.grade},${t.confidence.toFixed(1)},"${t.reason}"`
    )
    .join("\n");
  return header + rows;
}

// ─── Initialize Cache (call on app startup) ──────────────────────
export async function initTradeCache(): Promise<void> {
  await ensureCacheLoaded();
}
