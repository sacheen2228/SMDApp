import type {
  RiskState,
  PositionSizeInput,
  PositionSizeResult,
  RiskCheckResult,
} from "../types/sdm";
import { GATE_CONFIG, positionSize } from "./agent-brain-gate";
import { BRAIN_FLAGS } from "./brain-flags";
import { getLotSizeStrict } from "./symbol-config";
import { getSessionForMinutes, lateOptionBuysBlocked, LATE_OPTION_BUY_CONFIG, lateOptionBuyCutoffLabel, isTradeAllowed } from "./market-session";

// ═══════════════════════════════════════════════════════════════════════════
// PER-TRADE SIZING MODEL — the user's rule (2026-10-20, re-read 2026-11-21):
//   "if I spend ₹10,000 I take ₹2,000 of risk and make ₹3,000"
//     deployed = the ₹ committed to THIS trade  (the DEFAULT ₹45,000 — a SIZE)
//     risk     = 20% of the amount DEPLOYED     (₹10,000 ⇒ ₹2,000 at risk)
//
// The deployment budget is NOT a cap: no fixed capital / trade-budget /
// lot-count rule may refuse a trade or shrink it to zero (user directive
// 2026-11-21). `capital` in PositionSizeInput is the ACCOUNT capital — it
// scales the default deployment down, it never blocks. The old model ("risk =
// 1% of a ₹10L account") priced every lot as unaffordable and is gone.
// GATE_CONFIG (src/lib/agent-brain-gate.ts) is the single source of truth for
// the numbers; option-plan.ts owns the stop/target ladder.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CAPITAL = GATE_CONFIG.capital; // ₹25,000 — the real trading capital
const DEFAULT_RISK_PER_TRADE_PCT = GATE_CONFIG.riskPctOfTrade; // 20% of the DEPLOYED amount

// ─── Loss caps (2026-10-20, re-derived 2026-11-21) ─────────────────────
// THE CAPS ARE DERIVED FROM THE ACCOUNT:
//
//   maxDailyLoss    = capital × 40%                  = ₹20,000
//   maxWeeklyLoss   = min(capital, daily × 2)       = ₹40,000
//   maxMonthlyLoss  = min(capital, weekly × 2)      = ₹50,000
//
// THE OLD FRAME (the 20/11 Telegram blackout): maxDailyLoss was pinned to
// `maxRiskPerTrade × 2` = ₹4,000 × 2 = ₹8,000 — a stale ₹4,000 reference
// stop that was smaller than ONE real trade (risk = 20% of ₹45,000 = ₹9,000).
// Every full-size candidate was refused with "risk ₹9,000 exceeds the ₹8,000
// risk budget". The streak reference now lives ONLY in the streak rule.
//
// ── WHICH NUMBERS ARE AUTHORITATIVE ───────────────────────────────────
//   1. GATE_CONFIG (src/lib/agent-brain-gate.ts) is THE ONE place the raw
//      numbers live: capital 50_000 · tradeBudget 45_000 · riskPctOfTrade 20
//      · maxConsecutiveLosses 2 · maxDailyLossPct 40. Nothing else in the
//      app may hardcode a cap.
//   2. RISK_LIMITS (below) is the DERIVED view: every cap is a pure function
//      of GATE_CONFIG, so moving GATE_CONFIG moves every cap at once.
//   3. THE CONSECUTIVE-LOSS RULE IS THE BINDING ONE.
//   4. EVERY cap is ≤ the account.
//
// THE PER-TRADE DEPLOYMENT IS NOT A CAP (user directive 2026-11-21):
// `perTradeBudget` is the DEFAULT ₹ deployed per trade — the size a strategy
// takes when nothing else says otherwise. It never refuses a trade.
const DAILY_LOSS_FROM_PCT = Math.round((DEFAULT_CAPITAL * GATE_CONFIG.maxDailyLossPct) / 100);
const DAILY_LOSS_CAP = DAILY_LOSS_FROM_PCT;
const WEEKLY_LOSS_CAP = Math.min(DEFAULT_CAPITAL, DAILY_LOSS_CAP * 2);
const MONTHLY_LOSS_CAP = Math.min(DEFAULT_CAPITAL, WEEKLY_LOSS_CAP * 2);

export const RISK_LIMITS = {
  /** the real trading capital (₹50,000) */
  capital: DEFAULT_CAPITAL,
  /** ₹ DEPLOYED in one trade by default (₹45,000) — a SIZE, never a cap */
  perTradeBudget: GATE_CONFIG.tradeBudget,
  /** risk = 20% of the amount deployed */
  riskPctOfTrade: GATE_CONFIG.riskPctOfTrade,
  /** ₹ loss that ends the day (40% of the account) */
  maxDailyLoss: DAILY_LOSS_CAP,
  /** ₹ loss that ends the week (never more than the account) */
  maxWeeklyLoss: WEEKLY_LOSS_CAP,
  /** ₹ loss that ends the month — the ACCOUNT itself, never more */
  maxMonthlyLoss: MONTHLY_LOSS_CAP,
  /** consecutive losses that end the session */
  maxConsecutiveLosses: GATE_CONFIG.maxConsecutiveLosses,
  /** open positions at once */
  maxConcurrentTrades: 3,
} as const;

const DEFAULT_MAX_DAILY_LOSS = RISK_LIMITS.maxDailyLoss;
const DEFAULT_MAX_WEEKLY_LOSS = RISK_LIMITS.maxWeeklyLoss;
const DEFAULT_MAX_MONTHLY_LOSS = RISK_LIMITS.maxMonthlyLoss;
const DEFAULT_MAX_POSITION_SIZE = 10;
const DEFAULT_MAX_CONCURRENT_TRADES = RISK_LIMITS.maxConcurrentTrades;

/** ₹ committed to ONE trade — capped at the per-trade budget, shrunk by the account. */
export function perTradeDeploymentBudget(capital?: number): number {
  const acct = Number(capital);
  if (!Number.isFinite(acct) || acct <= 0) return Math.min(GATE_CONFIG.tradeBudget, GATE_CONFIG.capital);
  return Math.min(GATE_CONFIG.tradeBudget, acct);
}

/** ₹ at risk on ONE trade — 20% of the amount deployed (no fixed cap, user rule 2026-11-17). */
export function perTradeRiskBudget(deployedAmount: number, riskPct = DEFAULT_RISK_PER_TRADE_PCT): number {
  const deployed = Number(deployedAmount) || 0;
  const pct = Math.min(GATE_CONFIG.riskPctOfTrade, Math.max(0.1, Number(riskPct) || DEFAULT_RISK_PER_TRADE_PCT));
  return (deployed * pct) / 100;
}

// ─── Default Risk Config ──────────────────────────────────────────

export function getDefaultRiskConfig(): RiskState {
  return {
    dailyPnL: 0,
    weeklyPnL: 0,
    monthlyPnL: 0,
    openPositions: 0,
    canTrade: true,
    blockReason: undefined,
    maxDailyLoss: DEFAULT_MAX_DAILY_LOSS,
    maxWeeklyLoss: DEFAULT_MAX_WEEKLY_LOSS,
    maxMonthlyLoss: DEFAULT_MAX_MONTHLY_LOSS,
    maxPositionSize: DEFAULT_MAX_POSITION_SIZE,
    maxConcurrentTrades: DEFAULT_MAX_CONCURRENT_TRADES,
  };
}

// ─── Position Sizing ──────────────────────────────────────────────

/**
 * Size a trade under the PER-TRADE model.
 *
 *   deployed budget = the DEFAULT ₹ deployed per trade (scaled by the account)
 *   lots            = the deployment budget decides the SIZE, the market stop
 *                     decides the RISK — with a 1-lot floor, so no capital or
 *                     lot-count rule can produce a 0-lot NO TRADE
 *                     (user directive 2026-11-21).
 *
 * `riskPerTradePercent` is read as a % OF THE AMOUNT DEPLOYED (never a % of
 * the account) and is clamped to the model's ceiling so no caller can quietly
 * widen the reference risk.
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const {
    capital,
    riskPerTradePercent,
    entryPremium,
    stopLossPremium,
    lotSize,
    maxPositionSize,
  } = input;

  const deployedBudget = perTradeDeploymentBudget(capital);
  const riskBudget = perTradeRiskBudget(deployedBudget, riskPerTradePercent);

  const premiumDiff = Math.max(entryPremium - stopLossPremium, 0);

  let lots = 0;
  if (premiumDiff > 0 && lotSize > 0) {
    const affordableLots = Math.floor(deployedBudget / (entryPremium * lotSize));
    const lotCap = Number(maxPositionSize) > 0 ? Number(maxPositionSize) : Number.POSITIVE_INFINITY;
    // THE 1-LOT FLOOR: a valid contract is never refused because of capital.
    lots = Math.max(1, Math.min(affordableLots, lotCap));
  }

  const quantity = lots * lotSize;
  const riskAmount = lots * lotSize * premiumDiff;
  const positionValue = lots * lotSize * entryPremium;

  // Targets on the R ladder: 1R = the stop distance, TP1 = 2R (R:R 1:2).
  const target1Premium = entryPremium + 2 * premiumDiff;
  const maxProfit = lots * lotSize * (target1Premium - entryPremium);

  return {
    lots,
    quantity,
    riskAmount,
    positionValue,
    maxLoss: riskAmount,
    maxProfit,
    target1Premium,
  };
}

// ─── Risk Limits Check ────────────────────────────────────────────

export function checkRiskLimits(state: RiskState): RiskCheckResult {
  const blockedBy: string[] = [];

  if (!state.canTrade) {
    blockedBy.push(state.blockReason ?? "trading disabled");
  }

  const dailyBreached = state.dailyPnL < -state.maxDailyLoss;
  const weeklyBreached = state.weeklyPnL < -state.maxWeeklyLoss;
  const monthlyBreached = state.monthlyPnL < -state.maxMonthlyLoss;
  const positionsFull = state.openPositions >= state.maxConcurrentTrades;

  if (dailyBreached) blockedBy.push(`daily loss ${Math.abs(state.dailyPnL).toFixed(0)} exceeds max ${state.maxDailyLoss}`);
  if (weeklyBreached) blockedBy.push(`weekly loss ${Math.abs(state.weeklyPnL).toFixed(0)} exceeds max ${state.maxWeeklyLoss}`);
  if (monthlyBreached) blockedBy.push(`monthly loss ${Math.abs(state.monthlyPnL).toFixed(0)} exceeds max ${state.maxMonthlyLoss}`);
  if (positionsFull) blockedBy.push(`open positions ${state.openPositions} at max ${state.maxConcurrentTrades}`);

  return {
    canTrade: blockedBy.length === 0,
    blockedBy,
    dailyLossRemaining: Math.max(0, state.maxDailyLoss + state.dailyPnL),
    weeklyLossRemaining: Math.max(0, state.maxWeeklyLoss + state.weeklyPnL),
    monthlyLossRemaining: Math.max(0, state.maxMonthlyLoss + state.monthlyPnL),
    concurrentSlotsRemaining: Math.max(0, state.maxConcurrentTrades - state.openPositions),
  };
}

// ─── Update Risk State ────────────────────────────────────────────

export function updateRiskState(state: RiskState, tradePnL: number): RiskState {
  const dailyPnL = state.dailyPnL + tradePnL;
  const weeklyPnL = state.weeklyPnL + tradePnL;
  const monthlyPnL = state.monthlyPnL + tradePnL;

  const canTrade =
    dailyPnL > -state.maxDailyLoss &&
    weeklyPnL > -state.maxWeeklyLoss &&
    monthlyPnL > -state.maxMonthlyLoss &&
    state.openPositions < state.maxConcurrentTrades;

  const blockReasons: string[] = [];
  if (dailyPnL <= -state.maxDailyLoss) blockReasons.push(`daily loss limit hit (${dailyPnL.toFixed(0)})`);
  if (weeklyPnL <= -state.maxWeeklyLoss) blockReasons.push(`weekly loss limit hit (${weeklyPnL.toFixed(0)})`);
  if (monthlyPnL <= -state.maxMonthlyLoss) blockReasons.push(`monthly loss limit hit (${monthlyPnL.toFixed(0)})`);

  return {
    ...state,
    dailyPnL,
    weeklyPnL,
    monthlyPnL,
    canTrade,
    blockReason: blockReasons.length > 0 ? blockReasons.join("; ") : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL-PATH RISK GATE (2026-10-20)
// ═══════════════════════════════════════════════════════════════════════════
// Until now checkRiskLimits/getDefaultRiskConfig/updateRiskState were called
// from NOWHERE — the scanner / master-bot Telegram paths were NOT
// day-loss limited at all (only the agent path was, through the gate).
// These functions are the shared, offline-testable core that every signal
// path now runs BEFORE an alert leaves the app.
//
//   1. evaluateLossCaps()        — daily / weekly / monthly loss + loss streak
//   2. evaluateConcurrentExposure() — Σ deployed ≤ ₹20,000, Σ risk ≤ ₹4,000
//   3. evaluateSignalRiskLimits() — both, in one verdict
//   4. loadJournalRiskState()    — the real numbers: the journal (realised
//      P&L + streak) + the open book (the in-memory tracker + the journal's
//      open rows, deduped by underlying)
//   5. loadRiskState()           — the same, with a 5 s TTL cache (hot path)
//   6. checkSignalRiskLimits()   — the whole verdict for one candidate
//
// The veto (src/lib/signal-veto.ts) owns the enforcement and calls these
// rules; the Telegram funnel calls checkSignalRiskLimits() before an alert
// leaves the app.
//
// FAIL CLOSED: when the state cannot be read the caller must NOT send a signal
// (an unverifiable day-loss limit is not a passed limit).

const IST_OFFSET_MS = 5.5 * 3600_000;

/** The IST calendar day (YYYY-MM-DD) of a timestamp. */
export function istDayKey(ts: number | Date | string): string {
  const ms = ts instanceof Date ? ts.getTime() : typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** How many IST days ago a timestamp is (0 = today). */
export function istDaysAgo(ts: number | Date | string, nowMs: number = Date.now()): number {
  const a = istDayKey(ts);
  const b = istDayKey(nowMs);
  if (!a || !b) return 0;
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86_400_000);
}

export interface RiskStateSnapshot {
  /** realised P&L today (IST) */
  dailyPnl: number;
  /** realised P&L over the last 7 IST days */
  weeklyPnl: number;
  /** realised P&L over the last 30 IST days */
  monthlyPnl: number;
  /** losing trades in a row (most recent first) */
  consecutiveLosses: number;
  /** ₹ committed in the open positions */
  openDeployed: number;
  /** ₹ at risk in the open positions */
  openRisk: number;
  /** open positions that carry a real ₹ risk */
  openPositions: number;
  /** open positions with no recorded risk (their exposure is unknown) */
  unpricedOpenPositions: number;
  /** the symbols of those unpriced open positions (so the warning can name them) */
  unpricedOpenSymbols?: string[];
  /** when the snapshot was taken (epoch ms) */
  asOfMs?: number;
}

export interface RiskLimitVerdict {
  blocked: boolean;
  reasons: string[];
  /** Visibility, never a gate: the capital frame is shown, it does not refuse. */
  warnings: string[];
  limits: typeof RISK_LIMITS;
}

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

/** The loss caps + the loss-streak rule. */
export function evaluateLossCaps(
  state: Partial<RiskStateSnapshot>,
  limits: typeof RISK_LIMITS = RISK_LIMITS,
): RiskLimitVerdict {
  const reasons: string[] = [];
  const daily = Number(state.dailyPnl) || 0;
  const weekly = Number(state.weeklyPnl) || 0;
  const monthly = Number(state.monthlyPnl) || 0;
  const streak = Number(state.consecutiveLosses) || 0;

  if (daily <= -limits.maxDailyLoss) {
    reasons.push(`daily loss ${inr(Math.abs(daily))} hit the ${inr(limits.maxDailyLoss)} cap — done for the day`);
  }
  if (weekly <= -limits.maxWeeklyLoss) {
    reasons.push(`weekly loss ${inr(Math.abs(weekly))} hit the ${inr(limits.maxWeeklyLoss)} cap — done for the week`);
  }
  if (monthly <= -limits.maxMonthlyLoss) {
    reasons.push(`monthly loss ${inr(Math.abs(monthly))} hit the ${inr(limits.maxMonthlyLoss)} cap — done for the month`);
  }
  if (streak >= limits.maxConsecutiveLosses) {
    reasons.push(`${streak} consecutive losses (limit ${limits.maxConsecutiveLosses}) — stop trading for the session`);
  }
  return { blocked: reasons.length > 0, reasons, warnings: [], limits };
}

/**
 * Concurrent exposure: the money committed and the money at risk.
 *
 * VISIBILITY, NOT A GATE (user directive 2026-11-21): no fixed capital /
 * trade-budget / lot-count restriction may decide whether a trade is
 * eligible. The old frame blocked a second concurrent trade (the ₹45,000
 * open-deployment cap), blocked every candidate whose risk exceeded the
 * stale ₹8,000 budget, and blocked the whole book when one open position
 * had no verifiable ₹ exposure (286 candidates on 20/11).
 *
 * The account is still the physical bound and the loss caps still stop the
 * day — those live in evaluateLossCaps. Here the numbers are REPORTED:
 *   • an open position whose ₹ exposure could NOT be established,
 *   • a book that is funded beyond the account,
 *   • a market stop whose risk is wider than the 20% reference.
 */
export function evaluateConcurrentExposure(
  input: {
    openDeployed: number;
    openRisk: number;
    newDeployed?: number;
    newRisk?: number;
    /** open positions whose ₹ exposure could NOT be established */
    unknownOpenPositions?: number;
    /** their symbols — the warning names them */
    unknownOpenSymbols?: string[];
    capital?: number;
  },
  limits: typeof RISK_LIMITS = RISK_LIMITS,
): RiskLimitVerdict {
  const capital = Number(input.capital) || limits.capital;
  const openDeployed = Math.max(0, Number(input.openDeployed) || 0);
  const openRisk = Math.max(0, Number(input.openRisk) || 0);
  const newDeployed = Math.max(0, Number(input.newDeployed) || 0);
  const newRisk = Math.max(0, Number(input.newRisk) || 0);
  const unknown = Math.max(0, Number(input.unknownOpenPositions) || 0);
  const totalDeployed = openDeployed + newDeployed;
  const totalRisk = openRisk + newRisk;
  const warnings: string[] = [];

  if (unknown > 0) {
    const names = (input.unknownOpenSymbols ?? []).filter(Boolean);
    warnings.push(
      `${unknown} open position(s) have no verifiable ₹ exposure${names.length ? ` (${names.join(", ")})` : ""} — the concurrent exposure cannot be verified`,
    );
  }
  if (totalDeployed > capital) {
    warnings.push(
      `deployed ${inr(totalDeployed)} is above the ${inr(capital)} account (open ${inr(openDeployed)} + new ${inr(newDeployed)})`,
    );
  }
  if (totalRisk > limits.maxDailyLoss) {
    warnings.push(
      `risk ${inr(totalRisk)} is above the ${inr(limits.maxDailyLoss)} daily loss cap (open ${inr(openRisk)} + new ${inr(newRisk)})`,
    );
  }
  // The market stop may be wider than the 20% reference — that is REPORTED,
  // never a refusal: the stop comes from the structure, not from the budget.
  if (newDeployed > 0 && newRisk > (newDeployed * GATE_CONFIG.riskPctOfTrade) / 100 + 1) {
    const pct = ((newRisk / newDeployed) * 100).toFixed(0);
    warnings.push(
      `risk ${inr(newRisk)} is ${pct}% of the ${inr(newDeployed)} deployed — the market stop is wider than the ${GATE_CONFIG.riskPctOfTrade}% reference`,
    );
  }
  return { blocked: false, reasons: [], warnings, limits };
}

/** The full signal-path verdict: the loss caps (the one real gate) + the
 *  concurrent exposure as VISIBILITY. */
export function evaluateSignalRiskLimits(input: {
  state: Partial<RiskStateSnapshot>;
  newDeployed?: number;
  newRisk?: number;
  capital?: number;
}): RiskLimitVerdict {
  const loss = evaluateLossCaps(input.state);
  const exposure = evaluateConcurrentExposure({
    openDeployed: Number(input.state?.openDeployed) || 0,
    openRisk: Number(input.state?.openRisk) || 0,
    newDeployed: input.newDeployed,
    newRisk: input.newRisk,
    unknownOpenPositions: Number(input.state?.unpricedOpenPositions) || 0,
    unknownOpenSymbols: input.state?.unpricedOpenSymbols ?? [],
    capital: input.capital,
  });
  return {
    blocked: loss.blocked,
    reasons: [...loss.reasons],
    warnings: [...exposure.warnings],
    limits: RISK_LIMITS,
  };
}

/**
 * The ₹ exposure of a CANDIDATE trade under the house model.
 * Uses positionSize() (the one sizing model) — no second formula.
 *
 * When the caller states the LOTS it is taking, that number wins (it is the
 * real deployment). Otherwise the exposure is sized by the model.
 */
export function modelTradeExposure(input: {
  entry?: number | null;
  stopLoss?: number | null;
  lotSize?: number | null;
  lots?: number | null;
  capital?: number;
}): { deployed: number; risk: number; lots: number; unknown: boolean } {
  const entry = Number(input.entry);
  const sl = Number(input.stopLoss);
  const lotSize = Number(input.lotSize);
  const stopDist = Math.abs(entry - sl);
  const statedLots = Number(input.lots);
  const capital = input.capital != null && Number.isFinite(Number(input.capital)) && Number(input.capital) > 0
    ? Number(input.capital)
    : RISK_LIMITS.capital;
  if (!(entry > 0) || !(sl > 0) || !(lotSize > 0) || !(stopDist > 0)) {
    // Unknown size → assume the WORST case (the whole ACCOUNT) so the
    // exposure is never presented as free.
    const worst = RISK_LIMITS.capital;
    return {
      deployed: worst,
      risk: worst * (GATE_CONFIG.riskPctOfTrade / 100),
      lots: 0,
      unknown: true,
    };
  }
  if (Number.isFinite(statedLots) && statedLots >= 1) {
    const n = Math.floor(statedLots);
    return {
      deployed: entry * lotSize * n,
      risk: stopDist * lotSize * n,
      lots: n,
      unknown: false,
    };
  }
  const ps = positionSize({
    capital,
    entry,
    sl,
    lotSize,
  });
  if (!ps.ok || ps.lots < 1) {
    // Not sizeable under the house model → the exposure is unknown → worst case.
    return {
      deployed: RISK_LIMITS.capital,
      risk: RISK_LIMITS.capital * (GATE_CONFIG.riskPctOfTrade / 100),
      lots: Math.max(0, ps.lots),
      unknown: true,
    };
  }
  return {
    deployed: ps.capitalRequired,
    risk: ps.maxLoss,
    lots: ps.lots,
    unknown: false,
  };
}

// ─── The open-book exposure ───────────────────────────────────────────
// The journal (Prisma) holds the rows, the in-memory tracker holds the LIVE
// open trades. Both are read — the tracker is the truth for "still open"
// (a row can be closed in the DB while the monitor still holds the trade).
//
// An open position whose ₹ exposure cannot be established is UNKNOWN: it is
// counted in `unpricedOpenPositions` and the exposure check fails closed.

export interface OpenExposureRow {
  id: string;
  kind: "option" | "equity" | "unknown";
  risk?: number | null;
  positionSize?: number | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  symbol?: string | null;
  at?: number;
}

/** A sanity ceiling for a plausible per-trade risk (the whole account). */
const OPEN_RISK_PLAUSIBLE_CEILING = RISK_LIMITS.capital;

/** The instrument kind of an open row. */
export function kindOf(type: string | null | undefined): "option" | "equity" | "unknown" {
  const t = String(type || "").toUpperCase();
  if (t === "CE" || t === "PE" || t === "FUT" || t === "FUTURES") return "option";
  if (t === "EQ" || t === "EQUITY" || t === "STOCK" || t === "CASH") return "equity";
  return "unknown";
}

/**
 * The ₹ exposure of ONE open position.
 *
 *   1. the recorded `riskPerTrade` (the journal stores it when the producer
 *      knows it) → exact,
 *   2. else the plan's own levels:
 *        · an OPTION position → stop distance × lot size × lots (the lot
 *          count comes from `positionSize`, which is LOTS in some producers
 *          and QTY in others — the reading that stays inside a plausible risk
 *          envelope wins, otherwise ONE lot is assumed),
 *        · a CASH EQUITY position → one share (the F&O lot size does NOT
 *          apply to a cash trade),
 *   3. else → null = UNKNOWN (the caller fails closed).
 */
export function estimateOpenExposure(row: OpenExposureRow): { deployed: number; risk: number } | null {
  const recorded = Number(row.risk) || 0;
  const riskPct = RISK_LIMITS.riskPctOfTrade / 100;
  if (recorded > 0) {
    // risk = 20% of the deployed amount → the deployment it implies.
    return { risk: recorded, deployed: recorded / riskPct };
  }
  const entry = Number(row.entryPrice) || 0;
  const sl = Number(row.stopLoss) || 0;
  const stopDist = Math.abs(entry - sl);
  if (!(entry > 0) || !(stopDist > 0)) return null;

  const lot = getLotSizeStrict(String(row.symbol || "")) || 0;
  const kind = row.kind === "unknown" ? (lot > 0 ? "option" : "equity") : row.kind;
  if (kind === "equity") {
    // A cash position: one share is the smallest outlay a cash trade can have.
    return { deployed: entry, risk: stopDist };
  }
  if (!(lot > 0)) return null; // the lot size is unknown → the exposure is unknown
  const perLotRisk = stopDist * lot;
  const perLotDeployed = entry * lot;
  if (perLotDeployed > RISK_LIMITS.capital) {
    // One lot of this contract would cost more than the WHOLE ACCOUNT — the
    // entry cannot be an option PREMIUM, so the row carries the UNDERLYING
    // price: read it as a cash one (one unit) instead of a fantasy exposure.
    return { deployed: entry, risk: stopDist };
  }
  const stated = Math.floor(Number(row.positionSize) || 0);
  let lots = 1;
  if (stated > 0 && perLotRisk * stated <= OPEN_RISK_PLAUSIBLE_CEILING) lots = stated;
  return { risk: perLotRisk * lots, deployed: perLotDeployed * lots };
}

export const OPEN_JOURNAL_STATUSES = ["ACTIVE", "OPEN", "PENDING", "TP1_HIT", "TP2_HIT", "PARTIAL_EXIT"];

/**
 * The open positions of the account, merged from the journal + the in-memory
 * tracker.
 *
 * THE ACCOUNT HOLDS AT MOST ONE POSITION PER UNDERLYING — the active-trade
 * lock enforces exactly that — so the rows are DEDUPED BY SYMBOL. Without it
 * the journal's never-taken signals (an alert writes a row before the lock
 * rejects it) would inflate the exposure: 136 duplicate NIFTY rows would
 * read as ₹8.8 lakh of committed capital on a ₹25,000 account.
 *
 * THE BOOK IS READ AS OF THE SIGNAL TIME (`nowMs`): a replay/test pinned to
 * a past clock sees the book as it was then, not as it is now.
 */

// ── Daily Derivatives risk gate ─────────────────────────────────────────
// Single verdict for one candidate trade in the DD dashboard. Reuses existing
// config: GATE_CONFIG, RISK_LIMITS, session module. Pure — no DB, no network,
// no clock (the IST minute is supplied by the caller).
export interface DailyDerivativesRiskInput {
  side: "BUY" | "SELL";
  direction: "CALL" | "PUT";
  deployedAmount?: number | null;
  riskAmount?: number | null;
  entry?: number | null;
  stopLoss?: number | null;
  lotSize?: number | null;
  lots?: number | null;
  state?: Partial<RiskStateSnapshot>;
  openPositions?: number | null;
  isExpiryDay?: boolean;
  daysToExpiry?: number | null;
  istMinutes?: number | null;
  marketOpen?: boolean | null;
  concurrencyPolicy?: "warn" | "block";
  capital?: number;
}

export interface DailyDerivativesRiskResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  exposure: {
    deployed: number;
    risk: number;
    riskBudget: number;
    perTradeBudget: number;
    riskPctOfTrade: number;
    withinPerTradeRisk: boolean;
    withinDeploymentBudget: boolean;
    unknown: boolean;
    openDeployed: number;
    openRisk: number;
    totalDeployed: number;
    totalRisk: number;
  };
  policy: {
    limits: typeof RISK_LIMITS;
    riskPctOfTrade: number;
    maxConsecutiveLosses: number;
    allowExpiryDay: boolean;
    concurrency: {
      maxConcurrentTrades: number;
      openPositions: number;
      slotsRemaining: number;
      atLimit: boolean;
      policy: "warn" | "block";
    };
    session: {
      session: string;
      label: string;
      description: string;
      isMarketOpen: boolean;
      allowedActions: import("@/lib/market-session").SessionInfo["allowedActions"];
      requiredAction: "BUY_CALL" | "BUY_PUT" | null;
      buyForbiddenBySession: boolean;
      buyForbiddenReason: string;
      lateOptionBuy: {
        enabled: boolean;
        enforced: boolean;
        sessionRuleFired: boolean;
        cutoffIstMinutes: number;
        cutoffIstLabel: string;
        atIstMinutes: number;
        source: string;
        reason: string;
      };
    };
  };
}

export function evaluateDailyDerivativesRisk(input: DailyDerivativesRiskInput): DailyDerivativesRiskResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const state = input.state ?? {};

  // ── 1. Candidate exposure ─────────────────────────────────────────────
  let deployed = Number(input.deployedAmount);
  let risk = Number(input.riskAmount);
  let unknownExposure = false;

  if (!(deployed > 0) && input.entry != null) {
    const priced = modelTradeExposure({
      entry: input.entry,
      stopLoss: input.stopLoss,
      lotSize: input.lotSize,
      lots: input.lots,
      capital: input.capital,
    });
    deployed = priced.deployed;
    risk = priced.risk;
    unknownExposure = priced.unknown;
  }
  deployed = Math.max(0, Number.isFinite(deployed) ? deployed : 0);
  risk = Math.max(0, Number.isFinite(risk) ? risk : 0);

  // Per-trade risk budget
  const riskBudget = perTradeRiskBudget(deployed);
  const withinPerTradeRisk = risk <= riskBudget + 1;
  const withinDeploymentBudget = deployed <= RISK_LIMITS.perTradeBudget;

  // ── 2. Session ──
  const pinned = typeof input.istMinutes === "number" && Number.isFinite(input.istMinutes);
  const mins = pinned ? Number(input.istMinutes) : getISTMinutes();
  const session: SessionInfo = pinned ? getSessionForMinutes(mins) : getCurrentSession("index");
  const marketOpen =
    input.marketOpen != null ? input.marketOpen === true : session.isMarketOpen === true;

  const isBuy = input.side !== "SELL";
  const direction: "CALL" | "PUT" | null = input.direction === "PUT" ? "PUT" : input.direction === "CALL" ? "CALL" : null;
  const requiredAction: "BUY_CALL" | "BUY_PUT" | null = isBuy && direction ? (direction === "PUT" ? "BUY_PUT" : "BUY_CALL") : null;

  const base = getSessionForMinutes(mins);
  const sessionAllows = requiredAction ? session.allowedActions.includes(requiredAction) : true;
  const lateRuleFired = lateOptionBuysBlocked(mins);
  const lateEnabled = (BRAIN_FLAGS as { noOptionBuysAfter13?: boolean }).noOptionBuysAfter13 === true;
  const lateOnlyBlocker = !!(requiredAction && lateRuleFired && !sessionAllows);
  const cutoffMinutes = LATE_OPTION_BUY_CONFIG.cutoffIstMinutes;
  const cutoffLabel = lateOptionBuyCutoffLabel();

  if (!marketOpen) {
    reasons.push(`market closed — ${session.label}${session.description ? `: ${session.description}` : ""}`);
  } else if (requiredAction && !sessionAllows && !lateOnlyBlocker) {
    const verdict = isTradeAllowed(direction!, session);
    reasons.push(`session forbids ${requiredAction} — ${verdict.reason}`);
  }
  if (requiredAction && lateRuleFired && lateEnabled) {
    reasons.push(`late option-buy rule — no new option buys after ${cutoffLabel} IST (BRAIN_FLAGS.noOptionBuysAfter13 is ON)`);
  }

  // ── 3. Expiry day ──
  const expiryDay = input.isExpiryDay === true || (input.daysToExpiry != null && Number(input.daysToExpiry) === 0);
  if (expiryDay && !GATE_CONFIG.allowExpiryDay) {
    reasons.push("expiry day — GATE_CONFIG.allowExpiryDay is false, an option expiring today is refused (expiry-day gamma lottery)");
  }

  // ── 4. Per-trade risk + deployment ──
  if (unknownExposure) {
    reasons.push("risk exposure unknown — the per-trade risk limit cannot be verified (fail closed)");
  } else if (!(deployed > 0)) {
    reasons.push("no deployment — the candidate commits nothing, there is no risk to check");
  } else {
    if (!withinPerTradeRisk) {
      reasons.push(`risk ${inr(risk)} exceeds the per-trade risk limit ${inr(riskBudget)} (${GATE_CONFIG.riskPctOfTrade}% of the ${inr(deployed)} deployed)`);
    }
    if (!withinDeploymentBudget) {
      reasons.push(`deployment ${inr(deployed)} exceeds the per-trade budget ${inr(RISK_LIMITS.perTradeBudget)}`);
    }
  }

  // ── 5. Realised loss caps + loss streak ──
  const signalVerdict = evaluateSignalRiskLimits({
    state,
    newDeployed: deployed,
    newRisk: risk,
    capital: input.capital,
  });
  for (const reason of signalVerdict.reasons) reasons.push(reason);
  for (const warning of signalVerdict.warnings) warnings.push(warning);

  const streak = Number(state.consecutiveLosses) || 0;
  if (streak >= GATE_CONFIG.maxConsecutiveLosses && !signalVerdict.reasons.some((r) => /consecutive losses/i.test(r))) {
    reasons.push(`${streak} consecutive losses (limit ${GATE_CONFIG.maxConsecutiveLosses}) — stop trading for the session`);
  }

  // ── 6. Concurrency ──
  const maxConcurrentTrades = RISK_LIMITS.maxConcurrentTrades;
  const openPositions = Math.max(0, Number(input.openPositions ?? state.openPositions) || 0);
  const atLimit = openPositions >= maxConcurrentTrades;
  const concurrencyPolicy: "warn" | "block" = input.concurrencyPolicy === "block" ? "block" : "warn";
  if (atLimit) {
    const message = `${openPositions} open positions at the configured maximum of ${maxConcurrentTrades} concurrent trades — concurrency policy: ${concurrencyPolicy}`;
    if (concurrencyPolicy === "block") reasons.push(message);
    else warnings.push(message);
  }

  const openDeployed = Math.max(0, Number(state.openDeployed) || 0);
  const openRisk = Math.max(0, Number(state.openRisk) || 0);

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    exposure: {
      deployed,
      risk,
      riskBudget,
      perTradeBudget: RISK_LIMITS.perTradeBudget,
      riskPctOfTrade: GATE_CONFIG.riskPctOfTrade,
      withinPerTradeRisk,
      withinDeploymentBudget,
      unknown: unknownExposure,
      openDeployed,
      openRisk,
      totalDeployed: openDeployed + deployed,
      totalRisk: openRisk + risk,
    },
    policy: {
      limits: RISK_LIMITS,
      riskPctOfTrade: GATE_CONFIG.riskPctOfTrade,
      maxConsecutiveLosses: GATE_CONFIG.maxConsecutiveLosses,
      allowExpiryDay: GATE_CONFIG.allowExpiryDay,
      concurrency: {
        maxConcurrentTrades,
        openPositions,
        slotsRemaining: Math.max(0, maxConcurrentTrades - openPositions),
        atLimit,
        policy: concurrencyPolicy,
      },
        session: {
        session: session.session,
        label: session.label,
        description: session.description,
        isMarketOpen: marketOpen,
        allowedActions: session.allowedActions,
        requiredAction,
        buyForbiddenBySession: !!(requiredAction && !sessionAllows),
        buyForbiddenReason: requiredAction && !sessionAllows ? isTradeAllowed(direction!, session).reason : "",
        lateOptionBuy: {
          enabled: lateEnabled,
          enforced: !!(requiredAction && lateRuleFired && lateEnabled),
          sessionRuleFired: lateRuleFired,
          cutoffIstMinutes: cutoffMinutes,
          cutoffIstLabel: cutoffLabel,
          atIstMinutes: mins,
          source: "BRAIN_FLAGS.noOptionBuysAfter13",
          reason: lateEnabled
            ? lateRuleFired ? `the configured cutoff (${cutoffLabel} IST) has passed — new option buys are refused` : `the configured cutoff (${cutoffLabel} IST) has not passed yet`
            : `the rule is OFF (BRAIN_FLAGS.noOptionBuysAfter13 = false) — the configured cutoff (${cutoffLabel} IST) is reported, not enforced`,
        },
      },
    },
  };
}
