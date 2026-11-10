// Atomic, persistent entry-alert claims.
//
// The create() on AlertClaim is the at-most-once decision. The winner is the
// ONLY process allowed to send. A loser gets P2002 and must not send.
//
// Status machine:
//   PENDING ──send ok──▶ SENT
//      │
//      └──send fail──▶ PENDING (attempts++) ──max──▶ FAILED
//
// RetryPending() only touches PENDING rows; SENT/FAILED are never re-sent.

import { db } from "./db";
import { toIsoExpiry } from "./expiry-date";

export const ALERT_CLAIM_MAX_ATTEMPTS = 3;
export const ALERT_CLAIM_RETRY_AFTER_MS = 30_000;

export interface AlertClaimInput {
  tradeDate?: string;
  expiry?: string | null;
  symbol: string;
  strike?: number;
  optionType?: string;
  side?: string;
  strategy?: string;
  payload?: unknown;
  tradeId?: string;
  nowMs?: number;
}

export interface AlertClaimRow {
  id: string;
  tradeDate: string;
  expiry: string;
  symbol: string;
  strike: number;
  optionType: string;
  side: string;
  strategy: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  payload: string;
  tradeId: string | null;
  tradeRegistered: boolean;
  registrationError: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

export type ClaimResult =
  | { ok: true; claim: AlertClaimRow }
  | { ok: false; reason: string; existing?: AlertClaimRow | null };

/** IST calendar date for an epoch. Independent of the server timezone. */
export function istTradeDate(nowMs: number = Date.now()): string {
  const ist = new Date(nowMs + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** Normalise a real contract expiry to YYYY-MM-DD. Labels are rejected. */
export function normalizeClaimExpiry(expiry: unknown, optionType: string): string | null {
  const ot = String(optionType || "").toUpperCase();
  if (ot === "EQ" || ot === "EQUITY" || ot === "CASH") return "NA";
  return toIsoExpiry(expiry);
}

export function normalizeClaimOptionType(optionType: unknown): string {
  const ot = String(optionType || "").toUpperCase();
  if (ot === "CE" || ot === "CALL") return "CE";
  if (ot === "PE" || ot === "PUT") return "PE";
  return "EQ";
}

export function stableStrategy(source: unknown): string {
  const raw = String(source || "unknown").trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

function isP2002(err: any): boolean {
  return err?.code === "P2002";
}

export async function claimAlert(input: AlertClaimInput): Promise<ClaimResult> {
  const symbol = String(input.symbol || "").trim().toUpperCase();
  const strategy = stableStrategy(input.strategy);
  const optionType = normalizeClaimOptionType(input.optionType);
  const side = String(input.side || "BUY").trim().toUpperCase();
  const strike = Number(input.strike);
  const tradeDate = input.tradeDate || istTradeDate(input.nowMs);
  const expiry = normalizeClaimExpiry(input.expiry, optionType);

  if (!symbol) return { ok: false, reason: "missing_symbol" };
  if (!Number.isFinite(strike) || strike < 0) return { ok: false, reason: "invalid_strike" };
  if (!Number.isFinite(Date.parse(`${tradeDate}T00:00:00Z`))) return { ok: false, reason: "invalid_trade_date" };
  if (!expiry) return { ok: false, reason: "missing_or_invalid_expiry" };
  if (side !== "BUY" && side !== "SELL") return { ok: false, reason: "invalid_side" };

  const payload = JSON.stringify(input.payload ?? {});
  try {
    const claim = await db.alertClaim.create({
      data: {
        tradeDate,
        expiry,
        symbol,
        strike,
        optionType,
        side,
        strategy,
        status: "PENDING",
        attempts: 0,
        maxAttempts: ALERT_CLAIM_MAX_ATTEMPTS,
        payload,
        tradeId: input.tradeId ?? null,
      },
    });
    return { ok: true, claim: claim as AlertClaimRow };
  } catch (err: any) {
    if (isP2002(err)) {
      const existing = await db.alertClaim.findFirst({
        where: { tradeDate, expiry, symbol, strike, optionType, side, strategy },
      });
      return { ok: false, reason: "duplicate", existing: existing as AlertClaimRow | null };
    }
    console.log(`[alert-claim] create failed for ${symbol} ${strike} ${optionType}: ${err?.message || err}`);
    return { ok: false, reason: "db_error" };
  }
}

export async function markAlertClaimSent(claimId: string, tradeId?: string | null): Promise<void> {
  try {
    await db.alertClaim.update({
      where: { id: claimId },
      data: {
        status: "SENT",
        sentAt: new Date(),
        lastError: null,
        ...(tradeId ? { tradeId } : {}),
      },
    });
  } catch (err: any) {
    console.log(`[alert-claim] mark SENT failed for ${claimId}: ${err?.message || err}`);
  }
}

export async function markAlertClaimFailed(claimId: string, error: string): Promise<void> {
  try {
    const row = await db.alertClaim.findUnique({ where: { id: claimId } });
    if (!row) return;
    const attempts = row.attempts + 1;
    const status = attempts >= row.maxAttempts ? "FAILED" : "PENDING";
    await db.alertClaim.update({
      where: { id: claimId },
      data: { attempts, status, lastError: String(error || "send failed").slice(0, 500) },
    });
  } catch (err: any) {
    console.log(`[alert-claim] mark failed for ${claimId}: ${err?.message || err}`);
  }
}

export async function markAlertClaimBlocked(claimId: string, reason: string): Promise<void> {
  try {
    await db.alertClaim.update({
      where: { id: claimId },
      data: {
        status: "FAILED",
        lastError: String(reason || "blocked").slice(0, 500),
        registrationError: String(reason || "blocked").slice(0, 500),
      },
    });
  } catch (err: any) {
    console.log(`[alert-claim] mark blocked failed for ${claimId}: ${err?.message || err}`);
  }
}

export async function markAlertClaimTradeRegistered(
  claimId: string,
  registered: boolean,
  error?: string,
): Promise<void> {
  try {
    await db.alertClaim.update({
      where: { id: claimId },
      data: {
        tradeRegistered: registered,
        registrationError: registered ? null : String(error || "trade not registered").slice(0, 500),
      },
    });
  } catch (err: any) {
    console.log(`[alert-claim] mark registration failed for ${claimId}: ${err?.message || err}`);
  }
}

/** Atomically move a PENDING claim to PROCESSING. Returns false if another worker won. */
async function takePendingClaim(claimId: string): Promise<boolean> {
  const res = await db.alertClaim.updateMany({
    where: { id: claimId, status: "PENDING" },
    data: { status: "PROCESSING" },
  });
  return res.count === 1;
}

async function restorePendingClaim(claimId: string, error: string): Promise<void> {
  try {
    const row = await db.alertClaim.findUnique({ where: { id: claimId } });
    if (!row) return;
    const attempts = row.attempts + 1;
    const status = attempts >= row.maxAttempts ? "FAILED" : "PENDING";
    await db.alertClaim.update({
      where: { id: claimId },
      data: { attempts, status, lastError: String(error || "send failed").slice(0, 500) },
    });
  } catch {
    // best effort
  }
}

/**
 * Retry only PENDING rows. SENT and FAILED are terminal.
 * `send` receives the exact rendered message stored in the claim payload.
 */
export async function retryPendingAlertClaims(
  send: (text: string, claim: AlertClaimRow) => Promise<boolean>,
  opts: { limit?: number; minAgeMs?: number } = {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  const limit = opts.limit ?? 20;
  const minAgeMs = opts.minAgeMs ?? ALERT_CLAIM_RETRY_AFTER_MS;
  const cutoff = new Date(Date.now() - minAgeMs);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  let rows: AlertClaimRow[] = [];
  try {
    rows = (await db.alertClaim.findMany({
      where: { status: "PENDING", updatedAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take: limit,
    })) as AlertClaimRow[];
  } catch (err: any) {
    console.log(`[alert-claim] retry query failed: ${err?.message || err}`);
    return { sent, failed, skipped };
  }

  for (const row of rows) {
    if (row.attempts >= row.maxAttempts) {
      skipped++;
      continue;
    }
    if (!(await takePendingClaim(row.id))) {
      skipped++;
      continue;
    }
    try {
      const payload = JSON.parse(row.payload || "{}");
      const text = typeof payload?.message === "string" ? payload.message : "";
      if (!text) {
        await restorePendingClaim(row.id, "missing rendered message in claim payload");
        failed++;
        continue;
      }
      const ok = await send(text, row);
      if (ok) {
        await markAlertClaimSent(row.id, row.tradeId);
        sent++;
      } else {
        await restorePendingClaim(row.id, "retry send returned false");
        failed++;
      }
    } catch (err: any) {
      await restorePendingClaim(row.id, err?.message || String(err));
      failed++;
    }
  }

  return { sent, failed, skipped };
}

export async function getAlertClaimStats(): Promise<{
  pending: number;
  sent: number;
  failed: number;
  unregistered: number;
}> {
  try {
    const [pending, sent, failed, unregistered] = await Promise.all([
      db.alertClaim.count({ where: { status: "PENDING" } }),
      db.alertClaim.count({ where: { status: "SENT" } }),
      db.alertClaim.count({ where: { status: "FAILED" } }),
      db.alertClaim.count({ where: { tradeRegistered: false } }),
    ]);
    return { pending, sent, failed, unregistered };
  } catch {
    return { pending: 0, sent: 0, failed: 0, unregistered: 0 };
  }
}
