import { v4 as uuidv4 } from "uuid";
import { enqueue, registerHandler } from "../queue";
import {
  closeTradeRow,
  existsById,
  findById,
  insertTrade,
  updateTracking,
} from "../repositories/tradeRepository";
import { CloseTradeInput, ExitReason, NewSignalInput, PriceUpdateInput, TradeRecord } from "../types";
import { inferMarketSession, nowIst } from "../utils/ist";
import { verifyClosedTrade } from "./verification";

const JOB_INSERT = "insert_trade";
const JOB_PRICE_UPDATE = "price_update";
const JOB_CLOSE_TRADE = "close_trade";

// ---------- Job handlers (run on the background queue, never on the request thread) ----------

registerHandler(JOB_INSERT, (payload: TradeRecord) => {
  if (existsById(payload.id)) return; // idempotent: duplicate signal, no-op
  insertTrade(payload);
});

registerHandler(JOB_PRICE_UPDATE, (payload: { tradeId: string; price: number; timestampIst: string }) => {
  applyPriceUpdate(payload.tradeId, payload.price, payload.timestampIst);
});

registerHandler(
  JOB_CLOSE_TRADE,
  (payload: { tradeId: string; exitPrice: number; exitReason: ExitReason; exitTimeIst: string; fees: number }) => {
    applyClose(payload.tradeId, payload.exitPrice, payload.exitReason, payload.exitTimeIst, payload.fees);
  }
);

// ---------- Public API (called from routes) ----------

/**
 * Records a new signal the instant a strategy generates it. Returns the
 * trade ID immediately — the actual DB write happens on the background
 * queue so this call never blocks live trading.
 */
export function recordSignal(input: NewSignalInput): { tradeId: string } {
  const tradeId = input.tradeId ?? uuidv4();
  const createdAtIst = input.signalTimeIst ?? nowIst();

  const risk = Math.abs(input.entryPrice - input.stopLoss);
  const reward = Math.abs(input.tp1 - input.entryPrice);
  const riskRewardRatio = risk > 0 ? Number((reward / risk).toFixed(3)) : 0;

  const record: TradeRecord = {
    id: tradeId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    createdAtIst,
    symbol: input.symbol,
    exchange: input.exchange,
    instrumentType: input.instrumentType,
    spotPrice: input.spotPrice,
    strikePrice: input.strikePrice ?? null,
    expiry: input.expiry ?? null,
    optionType: input.optionType ?? null,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    tp1: input.tp1,
    tp2: input.tp2 ?? null,
    tp3: input.tp3 ?? null,
    riskRewardRatio,
    signalConfidence: input.signalConfidence,
    aiConfidence: input.aiConfidence ?? null,
    probabilityScore: input.probabilityScore ?? null,
    trendDirection: input.trendDirection,
    signalReason: input.signalReason,
    marketSession: input.marketSession ?? (inferMarketSession(createdAtIst) as NewSignalInput["marketSession"]),
    userAccount: input.userAccount ?? null,
    marketContext: input.marketContext ?? {},

    status: "open",
    entryFilled: true,
    highestPrice: input.entryPrice,
    lowestPrice: input.entryPrice,
    mfe: 0,
    mae: 0,
    tp1Hit: false,
    tp1HitAt: null,
    tp2Hit: false,
    tp2HitAt: null,
    tp3Hit: false,
    tp3HitAt: null,
    slHit: false,
    trailingStop: null,
    trailingStopHit: false,
    lastPrice: input.entryPrice,
    lastUpdateAt: createdAtIst,

    exitPrice: null,
    exitTime: null,
    exitReason: null,
    grossPnl: null,
    fees: 0,
    netPnl: null,
    roiPct: null,
    rMultiple: null,
    timeInTradeSec: null,

    verification: null,
  };

  enqueue(JOB_INSERT, record);
  return { tradeId };
}

/** Feed a live price tick for an open trade. Non-blocking — enqueued and processed in order. */
export function recordPriceUpdate(tradeId: string, input: PriceUpdateInput): void {
  enqueue(JOB_PRICE_UPDATE, {
    tradeId,
    price: input.price,
    timestampIst: input.timestampIst ?? nowIst(),
  });
}

/** Explicitly close a trade (manual close, time exit, etc). Non-blocking. */
export function closeTrade(tradeId: string, input: CloseTradeInput): void {
  enqueue(JOB_CLOSE_TRADE, {
    tradeId,
    exitPrice: input.exitPrice,
    exitReason: input.exitReason,
    exitTimeIst: input.exitTimeIst ?? nowIst(),
    fees: input.fees ?? 0,
  });
}

// ---------- Internal logic (runs inside the queue worker) ----------

function applyPriceUpdate(tradeId: string, price: number, timestampIst: string): void {
  const trade = findById(tradeId);
  if (!trade || trade.status !== "open") return;

  const isLong = trade.entryPrice <= trade.tp1; // long-only assumption (CE / bullish equity/futures)
  const highestPrice = Math.max(trade.highestPrice ?? trade.entryPrice, price);
  const lowestPrice = Math.min(trade.lowestPrice ?? trade.entryPrice, price);

  const mfe = isLong
    ? Math.max(0, highestPrice - trade.entryPrice)
    : Math.max(0, trade.entryPrice - lowestPrice);
  const mae = isLong
    ? Math.max(0, trade.entryPrice - lowestPrice)
    : Math.max(0, highestPrice - trade.entryPrice);

  const tp1Hit = trade.tp1Hit || (isLong ? price >= trade.tp1 : price <= trade.tp1);
  const tp2Hit = trade.tp2Hit || (trade.tp2 != null && (isLong ? price >= trade.tp2 : price <= trade.tp2));
  const tp3Hit = trade.tp3Hit || (trade.tp3 != null && (isLong ? price >= trade.tp3 : price <= trade.tp3));
  const slHit = trade.slHit || (isLong ? price <= trade.stopLoss : price >= trade.stopLoss);

  updateTracking(tradeId, {
    highestPrice,
    lowestPrice,
    mfe,
    mae,
    tp1Hit,
    tp1HitAt: tp1Hit && !trade.tp1Hit ? timestampIst : trade.tp1HitAt,
    tp2Hit,
    tp2HitAt: tp2Hit && !trade.tp2Hit ? timestampIst : trade.tp2HitAt,
    tp3Hit,
    tp3HitAt: tp3Hit && !trade.tp3Hit ? timestampIst : trade.tp3HitAt,
    slHit,
    lastPrice: price,
    lastUpdateAt: timestampIst,
  });

  // Auto-close on final target or stop-loss touch.
  if (slHit && !trade.slHit) {
    applyClose(tradeId, trade.stopLoss, "stop_loss", timestampIst, 0);
  } else if (tp3Hit && !trade.tp3Hit && trade.tp3 != null) {
    applyClose(tradeId, trade.tp3, "tp3", timestampIst, 0);
  }
}

function applyClose(
  tradeId: string,
  exitPrice: number,
  exitReason: ExitReason,
  exitTimeIst: string,
  fees: number
): void {
  const trade = findById(tradeId);
  if (!trade || trade.status !== "open") return;

  const isLong = trade.entryPrice <= trade.tp1;
  const grossPnl = isLong
    ? (exitPrice - trade.entryPrice)
    : (trade.entryPrice - exitPrice);
  const netPnl = grossPnl - (fees ?? 0);
  const roiPct = trade.entryPrice !== 0 ? (grossPnl / trade.entryPrice) * 100 : 0;

  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  const rMultiple = risk > 0 ? Number((netPnl / risk).toFixed(3)) : 0;

  const entryMs = Date.parse(trade.createdAtIst);
  const exitMs = Date.parse(exitTimeIst);
  const timeInTradeSec = Number.isFinite(entryMs) && Number.isFinite(exitMs)
    ? Math.max(0, Math.round((exitMs - entryMs) / 1000))
    : 0;

  const verification = verifyClosedTrade({
    ...trade,
    exitReason,
    grossPnl,
    netPnl,
    rMultiple,
  });

  closeTradeRow(tradeId, {
    exitPrice,
    exitTime: exitTimeIst,
    exitReason,
    grossPnl,
    netPnl,
    fees: fees ?? 0,
    roiPct,
    rMultiple,
    timeInTradeSec,
    verification,
  });
}
