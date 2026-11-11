// risk-state.server.ts
// SERVER-ONLY half of the risk frame: the journal / tracker readers that need the
// database. It is deliberately a SEPARATE module because src/lib/risk-management.ts
// is pulled into the CLIENT bundle (zero-hero → tiger-monitor → active-trade-tracker),
// and a Prisma import there breaks the client build.
//
// The pure cap maths (RISK_LIMITS, evaluateLossCaps, evaluateConcurrentExposure,
// modelTradeExposure) stay in risk-management.ts and are safe everywhere.

import {
  RISK_LIMITS,
  evaluateLossCaps,
  evaluateConcurrentExposure,
  modelTradeExposure,
  kindOf,
  estimateOpenExposure,
  OPEN_JOURNAL_STATUSES,
  evaluateSignalRiskLimits,
  istDaysAgo,
  type RiskStateSnapshot,
  type OpenExposureRow,
} from "./risk-management";
import type { RiskState } from "../types/sdm";

// Test/probe rows must never move the REAL loss caps. The audit API rejects
// `strategyId: "test"`, but rows written directly to Prisma (e2e suites,
// probes, inline checks) still land here — filter them before any cap maths.
const SYNTHETIC_STRATEGIES = new Set([
  "test",
  "e2e-test",
  "prod-verify",
  "TEST_DRY_RUN",
]);
const SYNTHETIC_TRADE_ID_PREFIXES = [
  "test-",
  "probe-",
  "zz-",
  "monerr-",
  "provenance-",
];

export function isSyntheticTradeRow(t: {
  tradeId?: string | null;
  strategy?: string | null;
}): boolean {
  const strategy = String(t.strategy || "").trim();
  if (SYNTHETIC_STRATEGIES.has(strategy)) return true;
  const id = String(t.tradeId || "").trim().toLowerCase();
  return SYNTHETIC_TRADE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

async function readOpenExposure(nowMs: number): Promise<{
  deployed: number; risk: number; positions: number; unpriced: number;
}> {
  // symbol → the row that counts (the live one wins over a journal duplicate)
  const bySymbol = new Map<string, OpenExposureRow>();

  const put = (row: OpenExposureRow, force: boolean) => {
    const key = String(row.symbol || "").toUpperCase() || `id:${row.id}`;
    const prev = bySymbol.get(key);
    if (!prev || force || (row.at ?? 0) >= (prev.at ?? 0)) bySymbol.set(key, row);
  };

  // 1. the journal (the persisted record)
  try {
    const { db } = await import("./db");
    const open = await db.trade.findMany({
      where: { status: { in: OPEN_JOURNAL_STATUSES } },
      select: {
        tradeId: true, riskPerTrade: true, positionSize: true, type: true,
        entryPrice: true, stopLoss: true, symbol: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    for (const t of open) {
      if (!t.tradeId) continue;
      const at = t.createdAt instanceof Date ? t.createdAt.getTime() : Date.parse(String(t.createdAt));
      if (Number.isFinite(at) && at > nowMs) continue; // opened after the signal time
      put({
        id: t.tradeId,
        kind: kindOf(t.type),
        risk: t.riskPerTrade,
        positionSize: t.positionSize,
        entryPrice: t.entryPrice,
        stopLoss: t.stopLoss,
        symbol: t.symbol,
        at,
      }, false);
    }
  } catch {
    /* the journal is unavailable — the tracker may still know the open trades */
  }

  // 2. the in-memory tracker (the LIVE open trades) — read, never edited here.
  try {
    const { getMonitoredTrades } = await import("./activeTradeTracker");
    for (const t of getMonitoredTrades()) {
      const at = Date.parse(t.sentAt || "");
      if (Number.isFinite(at) && at > nowMs) continue; // opened after the signal time
      put({
        id: t.id,
        kind: kindOf(t.optionType),
        risk: t.riskPerTrade ?? 0,
        positionSize: t.positionSize ?? 0,
        entryPrice: t.entry,
        stopLoss: t.sl,
        symbol: t.symbol,
        at: Number.isFinite(at) ? at : undefined,
      }, true);
    }
  } catch {
    /* the tracker is unavailable — the journal rows still stand */
  }

  let deployed = 0;
  let risk = 0;
  let positions = 0;
  let unpriced = 0;
  for (const row of bySymbol.values()) {
    const exposure = estimateOpenExposure(row);
    if (!exposure) {
      unpriced++;
      continue;
    }
    positions++;
    deployed += exposure.deployed;
    risk += exposure.risk;
  }
  return { deployed, risk, positions, unpriced };
}

/**
 * The REAL risk state, read from the trade journal (Prisma) + the live
 * in-memory tracker. Server-side only (the DB client is imported lazily).
 */export async function loadJournalRiskState(
  nowMs: number = Date.now(),
): Promise<{ ok: true; state: RiskStateSnapshot } | { ok: false; reason: string }> {
  try {
    const { db } = await import("./db");

    const closed = await db.trade.findMany({
      where: { pnl: { not: null } },
      select: { tradeId: true, strategy: true, pnl: true, exitTime: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 800,
    });

    let dailyPnl = 0;
    let weeklyPnl = 0;
    let monthlyPnl = 0;
    let consecutiveLosses = 0;
    let streakBroken = false;

    const sorted = closed
      .filter((t) => !isSyntheticTradeRow(t))
      .map((t) => ({
        pnl: Number(t.pnl) || 0,
        at: t.exitTime instanceof Date ? t.exitTime.getTime() : new Date(t.exitTime as any).getTime(),
      }))
      .filter((t) => Number.isFinite(t.at))
      .sort((a, b) => b.at - a.at);

    for (const t of sorted) {
      const age = istDaysAgo(t.at, nowMs);
      if (age === 0) dailyPnl += t.pnl;
      if (age >= 0 && age < 7) weeklyPnl += t.pnl;
      if (age >= 0 && age < 30) monthlyPnl += t.pnl;
      if (!streakBroken) {
        if (t.pnl < 0) consecutiveLosses++;
        else streakBroken = true;
      }
    }

    const open = await readOpenExposure(nowMs);

    return {
      ok: true,
      state: {
        dailyPnl,
        weeklyPnl,
        monthlyPnl,
        consecutiveLosses,
        openDeployed: open.deployed,
        openRisk: open.risk,
        openPositions: open.positions,
        unpricedOpenPositions: open.unpriced,
        asOfMs: nowMs,
      },
    };
  } catch (err: any) {
    return { ok: false, reason: `risk state unavailable (${String(err?.message || err).slice(0, 120)})` };
  }
}

// ─── The hot-path cache ───────────────────────────────────────────────
// The alert funnel asks for the risk state on EVERY candidate. The journal
// read is local (SQLite) but not free, so the snapshot is cached for a few
// seconds — long enough to keep the funnel O(1)-ish, short enough that a
// fresh stop is honoured within the same minute.
const RISK_STATE_TTL_MS = 5_000;

let riskStateCache: { at: number; value: Awaited<ReturnType<typeof loadJournalRiskState>> } | null = null;

/** Drop the cached risk state (after a close, or in a test). */
export function invalidateRiskStateCache(): void {
  riskStateCache = null;
}

/**
 * ₹ STILL FREE under the open-deployment / open-risk caps.
 *
 * The ONE home for the headroom maths — the signal check and every producer
 * that must SIZE a candidate (cash equity, lot sizing) read it from here, so
 * a new producer can never invent a second budget. A producer sizes against
 * this, NOT the full cap: an open ₹7k book plus a full-size ₹20k candidate
 * would otherwise exceed the cap and block every alert.
 */
export function deploymentHeadroom(state: {
  openDeployed?: number | null;
  openRisk?: number | null;
}): { deployed: number; risk: number } {
  const openDeployed = Math.max(0, Number(state.openDeployed) || 0);
  const openRisk = Math.max(0, Number(state.openRisk) || 0);
  return {
    deployed: Math.max(
      0,
      Math.min(RISK_LIMITS.maxOpenDeployed, RISK_LIMITS.capital) - openDeployed,
    ),
    risk: Math.max(
      0,
      Math.min(RISK_LIMITS.maxOpenRisk, RISK_LIMITS.capital) - openRisk,
    ),
  };
}

/**
 * The risk state with a short TTL cache — the hot-path reader.
 * Never throws: a failure is reported as `{ ok: false }` so the caller can
 * fail closed.
 *
 * The cache is only reused for the SAME clock basis: a replay pinned to a
 * past `nowMs` must not read a snapshot that was computed for "now" (and
 * vice versa), so the cache is hit only when the two clocks are within the
 * TTL of each other.
 */
export async function loadRiskState(
  nowMs: number = Date.now(),
  ttlMs: number = RISK_STATE_TTL_MS,
): Promise<{ ok: true; state: RiskStateSnapshot } | { ok: false; reason: string }> {
  if (riskStateCache && Math.abs(nowMs - riskStateCache.at) < ttlMs) return riskStateCache.value;
  const value = await loadJournalRiskState(nowMs);
  riskStateCache = { at: nowMs, value };
  return value;
}

/**
 * THE SIGNAL-PATH CHECK — the gate every alert runs through.
 *
 * Until 2026-10-20 the loss caps and the consecutive-loss rule lived ONLY in the
 * agent's trade gate, so the scanner / Zero-Hero / master-bot Telegram paths were
 * NOT day-loss limited at all. Every one of those paths funnels through
 * sendTradeAlert() → this function → the same caps the agent uses.
 *
 * FAIL CLOSED: if the journal cannot be read, the signal is NOT sent (an
 * unverifiable loss limit is not a passed limit).
 */
export async function checkSignalRiskLimits(params: {
  symbol: string;
  entry?: number | null;
  stopLoss?: number | null;
  /** the lots the caller is taking (the real deployment when known) */
  lots?: number | null;
  /** the contract lot size (resolved from the local master when absent) */
  lotSize?: number | null;
  /** ₹ committed to this trade (when the caller knows it) */
  deployedAmount?: number | null;
  /** ₹ at risk on this trade (when the caller knows it) */
  riskAmount?: number | null;
  nowMs?: number;
}): Promise<{
  blocked: boolean;
  reasons: string[];
  state?: RiskStateSnapshot;
  exposure?: { deployed: number; risk: number; lots: number; unknown: boolean };
  unavailable?: boolean;
}> {
  const loaded = await loadRiskState(params.nowMs ?? Date.now());
  if (!loaded.ok) {
    return { blocked: true, reasons: [loaded.reason], unavailable: true };
  }
  const state = loaded.state;

  // Remaining headroom under the open-deployment cap — size against THIS,
  // not the full ₹20k budget. An open ₹4k book + a full-size ₹17k candidate
  // used to permanent-block every alert (open + new > cap).
  const { deployed: remainingHeadroom, risk: remainingRiskHeadroom } = deploymentHeadroom(state);

  // The candidate's own exposure — sized by the ONE model (positionSize),
  // against the remaining headroom (0 headroom → 0 lots → worst-case block).
  let lotSize: number | null = params.lotSize ?? null;
  if (lotSize == null || lotSize <= 0) {
    try {
      const { getLotSizeStrict } = await import("./symbol-config");
      lotSize = getLotSizeStrict(params.symbol);
    } catch {
      lotSize = null;
    }
  }
  const exposure = modelTradeExposure({
    entry: params.entry,
    stopLoss: params.stopLoss,
    lotSize,
    lots: params.lots ?? null,
    remainingHeadroom,
  });

  // A stated deployment/risk wins over the modelled one (the caller knows).
  const statedDeployed = Number(params.deployedAmount);
  const statedRisk = Number(params.riskAmount);
  const newDeployed = Number.isFinite(statedDeployed) && statedDeployed > 0 ? statedDeployed : exposure.deployed;
  const newRisk = Number.isFinite(statedRisk) && statedRisk > 0 ? statedRisk : exposure.risk;

  // Explicit no-headroom fail-closed (positionSize(0) → 0 lots → unknown worst
  // case, but say WHY when the book is simply full).
  if (remainingHeadroom <= 0 && newDeployed > 0) {
    return {
      blocked: true,
      reasons: [
        `no deployment headroom — open deployed ₹${Math.round(openDeployed)} already at the ₹${RISK_LIMITS.maxOpenDeployed} cap`,
      ],
      state,
      exposure: { deployed: newDeployed, risk: newRisk, lots: exposure.lots, unknown: exposure.unknown },
    };
  }

  const verdict = evaluateSignalRiskLimits({
    state,
    newDeployed,
    newRisk,
  });
  return {
    blocked: verdict.blocked,
    reasons: verdict.reasons,
    state,
    exposure,
  };
}
