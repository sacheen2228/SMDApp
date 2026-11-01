// quant-alert-queue.ts — persistent outbox drain for UNIVERSAL_QUANT_V1 alerts.
//
// ISOLATION + DELIVERY ORDER: alerts are PERSISTED FIRST (PENDING row with an
// idempotency key), and only then delivered — a crash or a failing sender can
// never lose an alert, and a restart picks the row up again (status
// PENDING/RETRYING, attempts < 5). The Telegram sender (sendTelegramMessage)
// is loaded lazily via dynamic import inside flushOutbox: the quant namespace
// keeps its static import graph free of telegram senders, and delivery stays
// a deferred side effect owned by the drain loop alone. The other engines'
// trade-alert funnel senders are never used here.
//
// sendTelegramMessage returning false (window/token gate, provider error) is
// NOT DELIVERED: attempts+1, RETRYING (or FAILED at 5 attempts) — retried on a
// later flush. This module never throws; every failure mode lands in counters.

import { db } from "@/lib/db";
import { qid } from "./quant-types";
import { quantTelegramChatId } from "./quant-config";
import { QUANT_ALERT_POLICY, shouldDeliverNow, isAggregated, AGGREGATE_WINDOW_MINUTES, type QuantAlertType } from "./quant-alert-policy";
import { buildIdempotencyKey, isDuplicateKey } from "./quant-alert-dedupe";
import { formatQuantAlert, type QuantAlertPayload } from "./quant-alert-formatter";

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

export interface EnqueueQuantAlertInput {
  type: QuantAlertType;
  payload: QuantAlertPayload;
  tradeId?: string | null;
  level?: number | null;
  occurrence?: number | null;
  eventId?: string;
  nowMs?: number;
}

export interface EnqueueQuantAlertResult {
  queued: boolean;
  eventId?: string;
  deduped?: boolean;
  suppressed?: boolean;
}

export interface FlushQuantOutboxOptions {
  /** Only drain rows whose idempotencyKey starts with this prefix (tests/hermes scopes). */
  idempotencyKeyPrefix?: string;
  /**
   * Drain rows written by the test suite (`qtest…` keys). Production callers
   * leave this unset and those rows are EXCLUDED: tests share this SQLite DB,
   * and a live minute-tick once really delivered a TESTQ fixture to Telegram
   * ("Trade ID: TESTQ:FAIL5"). Test cycles opt in via the engine's own flush.
   */
  includeTestRows?: boolean;
}

export interface FlushQuantOutboxResult {
  flushed: number;
  sent: number;
  deferred: number;
  failed: number;
}

/** Persists an alert as a PENDING QuantAlertOutbox row. Never sends, never throws. */
export async function enqueueQuantAlert(input: EnqueueQuantAlertInput): Promise<EnqueueQuantAlertResult> {
  try {
    const policy = QUANT_ALERT_POLICY[input.type];
    if (!policy || !policy.enabled) return { queued: false, suppressed: true };

    const key = buildIdempotencyKey({
      tradeId: input.tradeId ?? null,
      type: input.type,
      level: input.level ?? null,
      occurrence: input.occurrence ?? null,
      nowMs: input.nowMs,
    });
    if (await isDuplicateKey(key)) return { queued: false, deduped: true };

    formatQuantAlert(input.type, input.payload ?? {}); // fail-fast render check before persisting (formatter is total — never throws)
    const eventId = input.eventId ?? qid();
    await db.quantAlertOutbox.create({
      data: {
        id: qid(),
        eventId,
        idempotencyKey: key,
        alertType: input.type,
        payload: JSON.stringify(input.payload ?? {}),
        status: "PENDING",
        attempts: 0,
        chatId: quantTelegramChatId() ?? null,
      },
    });
    return { queued: true, eventId };
  } catch (e: any) {
    if (e?.code === "P2002") return { queued: false, deduped: true }; // unique key race — the row already exists
    return { queued: false };
  }
}

/**
 * Drains due outbox rows: PENDING/RETRYING, attempts < 5, oldest first, max 20.
 * Immediate types are delivered now; aggregated types (NO_TRADE / DATA_FAILURE)
 * wait for the aggregate window to elapse and are delivered once, afterwards.
 * Rows whose alertType is not in the policy union are quarantined as FAILED
 * (they can never be delivered). Deliverable rows are re-rendered from the
 * stored payload and sent; false/throw increments attempts toward FAILED.
 * Never throws.
 */
export async function flushOutbox(nowMs?: number, opts?: FlushQuantOutboxOptions): Promise<FlushQuantOutboxResult> {
  const result: FlushQuantOutboxResult = { flushed: 0, sent: 0, deferred: 0, failed: 0 };
  try {
    const rows = await db.quantAlertOutbox.findMany({
      where: {
        status: { in: ["PENDING", "RETRYING"] },
        attempts: { lt: MAX_ATTEMPTS },
        ...(opts?.idempotencyKeyPrefix
          ? { idempotencyKey: { startsWith: opts.idempotencyKeyPrefix } }
          : opts?.includeTestRows
            ? { idempotencyKey: { contains: "qtest" } }
            : {
                NOT: [
                  { idempotencyKey: { contains: "qtest" } },
                  { idempotencyKey: { startsWith: "TESTQ" } },
                  { idempotencyKey: { contains: "QPT-TRAIL-" } },
                  { idempotencyKey: { contains: "QPT-T-" } },
                ],
              }),
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    for (const row of rows) {
      result.flushed++;
      try {
        if (!shouldDeliverNow(row.alertType as QuantAlertType)) {
          // Aggregated types (NO_TRADE / DATA_FAILURE) are delivered once the
          // aggregate window has passed — a digest pass that never ran would
          // leave them PENDING forever. Age is measured against wall clock
          // (createdAt), not the caller's clock.
          if (isAggregated(row.alertType as QuantAlertType)) {
            const ageMs = Date.now() - row.createdAt.getTime();
            if (ageMs < AGGREGATE_WINDOW_MINUTES * 60_000) {
              result.deferred++; // still inside the aggregate window
              continue;
            }
            // fall through — the window elapsed, deliver it now
          } else {
            // Unknown/disabled type — it can never be delivered. Quarantine it
            // as FAILED instead of leaving it PENDING forever.
            await db.quantAlertOutbox.update({
              where: { id: row.id },
              data: {
                status: "FAILED",
                attempts: MAX_ATTEMPTS,
                lastError: `unknown alert type "${row.alertType}" — quarantined`,
              },
            });
            result.failed++;
            continue;
          }
        }

        let payload: QuantAlertPayload = {};
        try {
          payload = JSON.parse(row.payload) as QuantAlertPayload;
        } catch {
          payload = {}; // corrupt payload — render the safe generic block, still deliver
        }
        const text = safeFormat(row.alertType, payload);

        let ok = false;
        let errText = "send-false";
        try {
          const { sendTelegramMessage } = await import("@/lib/telegram");
          ok = await sendTelegramMessage(text, row.chatId ?? undefined);
        } catch (e) {
          ok = false;
          errText = scrubToken(String(e)).slice(0, 200) || "send-false";
        }

        if (ok) {
          await db.quantAlertOutbox.update({
            where: { id: row.id },
            data: { status: "SENT", sentAt: new Date() },
          });
          result.sent++;
        } else {
          const attempts = row.attempts + 1;
          await db.quantAlertOutbox.update({
            where: { id: row.id },
            data: {
              attempts,
              status: attempts >= MAX_ATTEMPTS ? "FAILED" : "RETRYING",
              lastError: errText,
            },
          });
          if (attempts >= MAX_ATTEMPTS) result.failed++;
          else result.deferred++;
        }
      } catch {
        result.deferred++; // row-level unexpected error — leave untouched, retried on a later flush
      }
    }
  } catch {
    // never throw — the caller gets whatever was drained so far
  }
  return result;
}

function safeFormat(alertType: string, payload: QuantAlertPayload): string {
  try {
    return formatQuantAlert(alertType as QuantAlertType, payload);
  } catch {
    return `UNIVERSAL QUANT — ${alertType}\nEngine: UNIVERSAL_QUANT_V1\n(payload could not be rendered)`;
  }
}

/** Never let a provider error string carry the bot token into the DB. */
function scrubToken(s: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && s.includes(token)) return s.split(token).join("[redacted]");
  return s;
}

export interface QuantOutboxFailureRow {
  eventId: string;
  alertType: string;
  lastError: string | null;
  attempts: number;
}

export interface QuantOutboxStatus {
  counts: Record<string, number>;
  recentFailures: QuantOutboxFailureRow[];
}

/** Observability: status counts + the most recent problem rows. Never throws. */
export async function getOutboxStatus(): Promise<QuantOutboxStatus> {
  const counts: Record<string, number> = {};
  const recentFailures: QuantOutboxFailureRow[] = [];
  try {
    const groups = await db.quantAlertOutbox.groupBy({ by: ["status"], _count: { _all: true } });
    for (const g of groups) counts[g.status] = g._count._all;
    const fails = await db.quantAlertOutbox.findMany({
      where: { status: { in: ["FAILED", "RETRYING"] } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    for (const f of fails) {
      recentFailures.push({ eventId: f.eventId, alertType: f.alertType, lastError: f.lastError, attempts: f.attempts });
    }
  } catch {
    // never throw — empty status on failure
  }
  return { counts, recentFailures };
}
