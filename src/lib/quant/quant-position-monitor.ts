// quant-position-monitor.ts — DB-backed monitor for quant paper positions.
//
// ISOLATION: reads/writes ONLY the Quant* tables created for this engine.
// It never places broker orders, never imports telegram senders, and never
// mutates another engine's models. Alert delivery is deferred: events are
// written to the QuantAlertOutbox as PENDING rows (idempotency-keyed) — a
// separate Phase-B sender will drain the outbox.
//
// State lives in the DB (no in-memory-only state): remaining quantity and
// tp1Hit are recomputed from persisted QuantTradeEvent rows each tick, so a
// restart recovers naturally. Stale/absent LTP (0) marks the trade
// monitorDegraded, records ONE DATA_WARNING per trade per IST day (unique
// idempotency key), and skips evaluation — a hit is never claimed from
// stale data.

import { db } from "@/lib/db";
import { fetchLTP } from "@/lib/tiger-monitor";
import { quantTelegramChatId } from "./quant-config";
import { istDayKey, istIso } from "./quant-data";
import { qid } from "./quant-types";
import {
  applyBreakevenAfterTp1,
  applyTrail,
  evaluateLevels,
  statusForStopEvent,
  type QuantExecutionTrade,
  type QuantLevelEvent,
} from "./quant-paper-execution";
import { estimateCosts } from "./quant-risk-manager";
import type { QuantAlertType } from "./quant-alert-policy";
import type { QuantPaperTrade } from "@prisma/client";

const STOP_EVENT_TYPES = new Set(["SL_HIT", "GAP_THROUGH_SL", "TRAILING_SL_HIT", "BREAKEVEN_SL_HIT"]);

/**
 * Lifecycle event → deliverable alert type. Every event the monitor records
 * MUST map to a type that exists in the alert policy union — an unmapped type
 * would sit in the outbox forever (never deliverable, never failed).
 */
const EVENT_ALERT_TYPE: Record<string, QuantAlertType> = {
  TP1_HIT: "QUANT_TP1_HIT",
  TP2_HIT: "QUANT_TP2_HIT",
  TP3_HIT: "QUANT_TP3_HIT",
  TP4_HIT: "QUANT_TP4_HIT",
  SL_HIT: "QUANT_SL_HIT",
  GAP_THROUGH_SL: "QUANT_GAP_THROUGH_SL",
  TRAILING_SL_HIT: "QUANT_TRAILING_SL_HIT",
  BREAKEVEN_SL_HIT: "QUANT_BREAKEVEN_SL_HIT",
};

/** Alert type for a monitor event; null when the event is not alertable. */
export function alertTypeForEvent(type: string): QuantAlertType | null {
  return EVENT_ALERT_TYPE[type] ?? null;
}

// ── Injectable LTP seam (tests replace; production uses fetchLTP) ────

type LtpFn = (symbol: string, strike: number, optionType: string, expiry?: string) => Promise<number>;
let ltpFetcher: LtpFn = fetchLTP;

export function __setQuantLtpFetcherForTests(fn: LtpFn | null): void {
  ltpFetcher = fn ?? fetchLTP;
}

// ── Trade opener (tests + Phase B execution use this) ───────────────

export interface CreateQuantPaperTradeInput {
  tradeId?: string;
  strategy: string;
  regime: string;
  symbol: string;
  exchange: string;
  direction: string;
  tradingsymbol?: string | null;
  strike?: number | null;
  optionType?: string | null;
  expiry?: string | null;
  lotSize?: number | null;
  lots?: number | null;
  entryPrice: number;
  entryTime?: Date | null;
  stopLoss: number;
  tp1?: number | null;
  tp2?: number | null;
  tp3?: number | null;
  tp4?: number | null;
  atrPremium?: number | null;
  riskAmount?: number | null;
  maxLossPlanned?: number | null;
  confidence?: number | null;
  dataQuality?: number | null;
  decisionId?: string | null;
  provenance?: unknown;
  mode?: string;
}

/** Creates an OPEN paper trade row (mode SHADOW|PAPER — never live). */
export async function createQuantPaperTrade(input: CreateQuantPaperTradeInput): Promise<QuantPaperTrade> {
  const lots = input.lots ?? 1;
  const lotSize = input.lotSize ?? 0;
  return db.quantPaperTrade.create({
    data: {
      tradeId: input.tradeId ?? `QPT-${qid()}`,
      mode: input.mode ?? "SHADOW",
      strategy: input.strategy,
      regime: input.regime,
      symbol: input.symbol,
      exchange: input.exchange,
      direction: input.direction,
      tradingsymbol: input.tradingsymbol ?? null,
      strike: input.strike ?? null,
      optionType: input.optionType ?? null,
      expiry: input.expiry ?? null,
      lotSize: lotSize || null,
      lots: lots > 0 ? lots : null,
      quantity: lotSize > 0 && lots > 0 ? lots * lotSize : null,
      entryPrice: input.entryPrice,
      entryTime: input.entryTime ?? new Date(),
      stopLoss: input.stopLoss,
      currentStopLoss: input.stopLoss,
      tp1: input.tp1 ?? null,
      tp2: input.tp2 ?? null,
      tp3: input.tp3 ?? null,
      tp4: input.tp4 ?? null,
      trailingAtrPremium: input.atrPremium ?? null,
      riskAmount: input.riskAmount ?? null,
      maxLossPlanned: input.maxLossPlanned ?? null,
      confidence: input.confidence ?? null,
      dataQuality: input.dataQuality ?? null,
      decisionId: input.decisionId ?? null,
      provenance: input.provenance != null ? JSON.stringify(input.provenance) : null,
      status: "OPEN",
    },
  });
}

// ── Event/outbox persistence (idempotent) ───────────────────────────

async function persistEventAndOutbox(
  trade: QuantPaperTrade,
  event: QuantLevelEvent,
  note: string | null,
  nowMs: number,
  realizedPnlCum: number,
): Promise<boolean> {
  try {
    await db.quantTradeEvent.create({
      data: {
        id: qid(),
        tradeId: trade.tradeId,
        eventId: event.eventId,
        type: event.type,
        level: event.level,
        fillPrice: event.fillPrice,
        quantityExited: event.quantityExited,
        remainingQuantity: event.remainingQuantity,
        realizedPnl: (event.fillPrice - trade.entryPrice!) * event.quantityExited,
        note,
        ts: new Date(event.ts),
      },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e; // unique eventId → already persisted
    return false;
  }
  // Alert outbox — PENDING until the sender drains it. One row per
  // trade/type/level/day (unique idempotency key dedupes re-ticks).
  const idempotencyKey = `${trade.tradeId}:${event.type}:${event.level ?? "-"}:${istDayKey(nowMs)}`;
  const alertType = alertTypeForEvent(event.type);
  if (!alertType) return true; // event recorded, no alert type (never silently dropped: policy map is exhaustive)
  try {
    await db.quantAlertOutbox.create({
      data: {
        id: qid(),
        eventId: event.eventId,
        idempotencyKey,
        alertType,
        payload: JSON.stringify({
          tradeId: trade.tradeId,
          eventId: event.eventId,
          mode: trade.mode,
          strategy: trade.strategy,
          regime: trade.regime,
          symbol: trade.symbol,
          exchange: trade.exchange,
          direction: trade.direction,
          tradingsymbol: trade.tradingsymbol,
          strike: trade.strike,
          optionType: trade.optionType,
          expiry: trade.expiry,
          lotSize: trade.lotSize,
          lots: trade.lots,
          quantity: trade.quantity,
          entry: trade.entryPrice,
          stopLoss: trade.stopLoss,
          currentStopLoss: trade.currentStopLoss,
          targets: { tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3, tp4: trade.tp4 },
          tpLevel: event.level != null ? (event.type.startsWith("TP") ? event.type.replace("_HIT", "") : null) : null,
          targetPrice: event.level,
          fillPrice: event.fillPrice,
          exitPrice: event.fillPrice,
          quantityExited: event.quantityExited,
          remainingQuantity: event.remainingQuantity,
          realizedPnl: realizedPnlCum,
          exitReason: event.type,
          type: event.type,
          level: event.level,
          ambiguity: event.ambiguity ?? null,
          eventTime: event.ts,
          ts: istIso(event.ts),
        }),
        status: "PENDING",
        chatId: quantTelegramChatId() ?? null,
      },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }
  return true;
}

async function recordDataWarning(trade: QuantPaperTrade, nowMs: number): Promise<void> {
  const day = istDayKey(nowMs);
  const eventId = `DATA_WARNING:${trade.tradeId}:${day}`;
  const idempotencyKey = eventId; // one per trade per IST day — unique constraint dedupes
  await db.quantPaperTrade.update({
    where: { tradeId: trade.tradeId },
    data: { monitorDegraded: true },
  });
  try {
    await db.quantTradeEvent.create({
      data: {
        id: qid(),
        tradeId: trade.tradeId,
        eventId,
        type: "DATA_WARNING",
        note: `option LTP unavailable this tick (${istIso(nowMs)}) — evaluation skipped, no hit claimed from stale data`,
        ts: new Date(nowMs),
      },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
    return; // already warned today
  }
  try {
    await db.quantAlertOutbox.create({
      data: {
        id: qid(),
        eventId,
        idempotencyKey,
        alertType: "QUANT_DATA_WARNING",
        payload: JSON.stringify({
          tradeId: trade.tradeId,
          mode: trade.mode,
          symbol: trade.symbol,
          exchange: trade.exchange,
          underlying: trade.symbol,
          strike: trade.strike,
          optionType: trade.optionType,
          expiry: trade.expiry,
          source: "option-ltp",
          detail: "LTP unavailable (0) from all providers — evaluation skipped, no hit claimed from stale data",
          reason: "LTP unavailable (0) from all providers",
          eventTime: nowMs,
          ts: istIso(nowMs),
        }),
        status: "PENDING",
        chatId: quantTelegramChatId() ?? null,
      },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }
}

/**
 * One PAPER_EXIT notice for a trade that is fully closed (all quantity
 * exited). Idempotent per trade per IST day — the unique idempotency key
 * makes a re-tick a no-op, so a close can never produce two exit alerts.
 */
async function enqueuePaperExitAlert(trade: QuantPaperTrade, nowMs: number): Promise<void> {
  const idempotencyKey = `${trade.tradeId}:PAPER_EXIT:-:${istDayKey(nowMs)}`;
  try {
    await db.quantAlertOutbox.create({
      data: {
        id: qid(),
        eventId: `${trade.tradeId}:PAPER_EXIT:${istDayKey(nowMs)}`,
        idempotencyKey,
        alertType: "QUANT_PAPER_EXIT",
        payload: JSON.stringify({
          tradeId: trade.tradeId,
          eventId: `${trade.tradeId}:PAPER_EXIT:${istDayKey(nowMs)}`,
          mode: trade.mode,
          strategy: trade.strategy,
          regime: trade.regime,
          symbol: trade.symbol,
          exchange: trade.exchange,
          direction: trade.direction,
          tradingsymbol: trade.tradingsymbol,
          strike: trade.strike,
          optionType: trade.optionType,
          expiry: trade.expiry,
          lotSize: trade.lotSize,
          lots: trade.lots,
          quantity: trade.quantity,
          entry: trade.entryPrice,
          stopLoss: trade.stopLoss,
          currentStopLoss: trade.currentStopLoss,
          exitPrice: trade.exitPrice,
          exitReason: trade.exitReason,
          realizedPnl: trade.realizedPnl,
          estCosts: trade.estCosts,
          remainingQuantity: 0,
          eventTime: trade.exitTime ? trade.exitTime.getTime() : nowMs,
          ts: istIso(nowMs),
        }),
        status: "PENDING",
        chatId: quantTelegramChatId() ?? null,
      },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e; // already sent for this trade today
  }
}

// ── Row → execution state (restart recovery: state lives in the DB) ──
async function executionStateFor(trade: QuantPaperTrade): Promise<{
  state: QuantExecutionTrade;
  exitedSoFar: number;
}> {
  const events = await db.quantTradeEvent.findMany({ where: { tradeId: trade.tradeId } });
  const exitedSoFar = events.reduce((a, e) => a + (e.quantityExited ?? 0), 0);
  const tp1Hit = events.some((e) => e.type === "TP1_HIT");
  const state: QuantExecutionTrade = {
    tradeId: trade.tradeId,
    direction: (trade.direction as QuantExecutionTrade["direction"]) ?? "BUY",
    entryPrice: trade.entryPrice ?? 0,
    stopLoss: trade.currentStopLoss ?? trade.stopLoss ?? 0,
    initialStopLoss: trade.stopLoss ?? 0,
    targets: { tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3, tp4: trade.tp4 },
    quantity: trade.quantity ?? 0,
    remainingQuantity: Math.max(0, (trade.quantity ?? 0) - exitedSoFar),
    tp1Hit,
    tpHitLevel: trade.tpHitLevel,
    highestSinceTp1: trade.trailingHighWater,
    breakevenArmed: tp1Hit && (trade.currentStopLoss ?? 0) >= (trade.entryPrice ?? 0),
    // Phase C: persisted with the plan (trailingAtrPremium). Null → applyTrail
    // no-ops (documented) — the trail never invents a number.
    atrPremium: trade.trailingAtrPremium ?? null,
  };
  return { state, exitedSoFar };
}

// ── The tick ─────────────────────────────────────────────────────────

export interface TickMonitorSummary {
  checked: number;
  events: number;
  degraded: number;
}

export async function tickMonitor(nowMs: number = Date.now()): Promise<TickMonitorSummary> {
  const trades = await db.quantPaperTrade.findMany({
    where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] }, engineVersion: "UNIVERSAL_QUANT_V1" },
  });
  const summary: TickMonitorSummary = { checked: 0, events: 0, degraded: 0 };

  for (const trade of trades) {
    summary.checked++;
    let ltp = 0;
    try {
      ltp = await ltpFetcher(trade.symbol, trade.strike ?? 0, trade.optionType ?? "", trade.expiry ?? undefined);
    } catch {
      ltp = 0; // feed error == unavailable — never claim a hit from this
    }
    if (!Number.isFinite(ltp) || ltp <= 0) {
      summary.degraded++;
      await recordDataWarning(trade, nowMs);
      continue;
    }

    const { state } = await executionStateFor(trade);
    if (state.remainingQuantity <= 0) {
      // All quantity already exited by prior ticks — close out the row if needed.
      // A fully-exited trade must never stay OPEN (it would hold a concurrency
      // slot forever and keep the monitor re-processing it).
      await db.quantPaperTrade.update({
        where: { tradeId: trade.tradeId },
        data: {
          status: trade.status.startsWith("CLOSED") ? trade.status : "CLOSED_TP",
          monitorDegraded: false,
          unrealizedPnl: 0,
        },
      });
      // Close-out alert — the row's last level event already alerted, but a
      // trade whose exit event was never alerted (e.g. the row was left open
      // across a restart) still gets exactly one PAPER_EXIT notice.
      await enqueuePaperExitAlert(trade, nowMs);
      continue;
    }

    const events = evaluateLevels({
      trade: state,
      observation: { ltp, high: null, low: null, ts: nowMs }, // LTP feed carries no OHLC — ltp only
    });

    let updatedState = state;
    let realizedSoFar = trade.realizedPnl ?? 0;
    let costSoFar = trade.estCosts ?? 0;
    let lastExit: { price: number; ts: number; reason: string } | null = null;
    let persistedEvents = 0;

    for (const event of events) {
      const isStop = STOP_EVENT_TYPES.has(event.type);
      const note = event.ambiguity ?? null;

      // P&L for the exited portion, net of the round-trip cost model. Computed
      // BEFORE persistence so the alert carries the running realised total.
      const gross = (event.fillPrice - state.entryPrice) * event.quantityExited;
      const costs = estimateCosts(state.entryPrice, event.fillPrice, 1, event.quantityExited);
      const realizedCum = realizedSoFar + gross - costs;

      await persistEventAndOutbox(trade, event, note, nowMs, realizedCum);
      persistedEvents++;

      realizedSoFar = realizedCum;
      costSoFar += costs;
      lastExit = { price: event.fillPrice, ts: event.ts, reason: event.type };

      if (event.type === "TP1_HIT") updatedState = { ...updatedState, tp1Hit: true, tpHitLevel: "TP1" };
      else if (event.type.startsWith("TP")) updatedState = { ...updatedState, tpHitLevel: event.type.replace("_HIT", "") };
      updatedState = { ...updatedState, remainingQuantity: event.remainingQuantity };

      if (isStop) {
        updatedState = { ...updatedState, remainingQuantity: 0 };
        break; // conservative: the stop ends the trade
      }
    }

    // Trailing/breakeven after any TP events this tick.
    if (updatedState.tp1Hit && updatedState.remainingQuantity > 0) {
      updatedState = applyBreakevenAfterTp1(updatedState);
      updatedState = applyTrail(updatedState, { ltp, high: null, low: null, ts: nowMs });
    }

    let status = trade.status;
    let exitPrice: number | null = null;
    let exitTime: Date | null = null;
    let exitReason: string | null = null;
    if (lastExit && updatedState.remainingQuantity <= 0) {
      const stopEvent = events.find((e) => STOP_EVENT_TYPES.has(e.type));
      status = stopEvent ? statusForStopEvent(stopEvent.type) : "CLOSED_TP";
      exitPrice = lastExit.price;
      exitTime = new Date(lastExit.ts);
      exitReason = lastExit.reason;
    } else if (lastExit && persistedEvents > 0) {
      status = "PARTIALLY_CLOSED";
    }

    await db.quantPaperTrade.update({
      where: { tradeId: trade.tradeId },
      data: {
        status,
        currentStopLoss: updatedState.stopLoss,
        trailingHighWater: updatedState.highestSinceTp1,
        tpHitLevel: updatedState.tpHitLevel,
        realizedPnl: realizedSoFar,
        estCosts: costSoFar,
        unrealizedPnl: updatedState.remainingQuantity > 0 ? (ltp - state.entryPrice) * updatedState.remainingQuantity : 0,
        exitPrice,
        exitTime,
        exitReason,
        monitorDegraded: false,
      },
    });
    summary.events += persistedEvents;
  }

  return summary;
}
