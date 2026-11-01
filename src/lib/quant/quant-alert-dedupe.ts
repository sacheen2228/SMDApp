// quant-alert-dedupe.ts — idempotency keys for UNIVERSAL_QUANT_V1 alerts.
//
// ISOLATION: quant-namespace dedupe only. Keys are deterministic
// (tradeId:type:level:occurrence:IST-day) and enforced by the UNIQUE index on
// QuantAlertOutbox.idempotencyKey — a re-tick or a replayed enqueue can never
// produce a second alert row for the same event on the same IST day.

import { db } from "@/lib/db";
import { istDayKey } from "./quant-data";
import type { QuantAlertType } from "./quant-alert-policy";

export interface QuantIdempotencyKeyInput {
  tradeId?: string | null;
  type: QuantAlertType;
  level?: number | null;
  occurrence?: number | null;
  nowMs?: number;
}

/**
 * `${tradeId ?? "NA"}:${type}:${level ?? "NA"}:${occurrence ?? 0}:${IST day}`.
 * Deterministic — the same logical alert on the same IST day always maps to
 * the same key, so the DB unique constraint is the final dedupe authority.
 */
export function buildIdempotencyKey(input: QuantIdempotencyKeyInput): string {
  const day = istDayKey(input.nowMs ?? Date.now());
  const tradeId = input.tradeId != null && String(input.tradeId).trim() !== "" ? String(input.tradeId) : "NA";
  const level = input.level != null ? String(input.level) : "NA";
  const occurrence = input.occurrence != null ? String(input.occurrence) : "0";
  return `${tradeId}:${input.type}:${level}:${occurrence}:${day}`;
}

/** True when an outbox row with this key already exists. */
export async function isDuplicateKey(key: string): Promise<boolean> {
  const row = await db.quantAlertOutbox.findUnique({ where: { idempotencyKey: key } });
  return row !== null;
}
