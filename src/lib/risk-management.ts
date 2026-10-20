import type {
  RiskState,
  PositionSizeInput,
  PositionSizeResult,
  RiskCheckResult,
} from "../types/sdm";
import { GATE_CONFIG, positionSize } from "./agent-brain-gate";
import { getLotSizeStrict } from "./symbol-config";

// ═══════════════════════════════════════════════════════════════════════════
// PER-TRADE SIZING MODEL — the user's rule (2026-10-20):
//   "if I spend ₹10,000 I take ₹2,000 of risk and make ₹3,000"
//     deployed = the ₹ committed to THIS trade  (≤ ₹20,000 — the per-trade cap)
//     risk     = 20% of the amount DEPLOYED     (₹10,000 ⇒ ₹2,000 at risk)
//
// `capital` in PositionSizeInput is the ACCOUNT capital. It can only SHRINK
// the per-trade deployment budget — it is NEVER the risk base. The old model
// ("risk = 1% of a ₹10L account") priced every lot as unaffordable and is
// gone. GATE_CONFIG (src/lib/agent-brain-gate.ts) is the single source of
// truth for the numbers; option-plan.ts owns the stop/target ladder.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CAPITAL = GATE_CONFIG.capital; // ₹25,000 — the real trading capital
const DEFAULT_RISK_PER_TRADE_PCT = GATE_CONFIG.riskPctOfTrade; // 20% of the DEPLOYED amount

// ─── Loss caps (2026-10-20) ─────────────────────────────────────────
// THE CAPS ARE DERIVED FROM THE PER-TRADE MODEL, not from a % of a big account:
//
//   maxRiskPerTrade = ₹20,000 deployed × 20%          = ₹4,000  (one stop)
//   maxDailyLoss    = min(capital × 40%, 2 stops)      = ₹8,000  (32% of ₹25,000)
//   maxWeeklyLoss   = min(capital, daily × 2)         = ₹16,000 (64% of ₹25,000)
//   maxMonthlyLoss  = min(capital, weekly × 2)        = ₹25,000 (the ACCOUNT — never more)
//
// The old numbers (daily ₹10,000 / weekly ₹20,000 / monthly ₹50,000) let the MONTHLY
// cap exceed the whole ₹25,000 account, and the 40% daily cap was unreachable because
// the 2-loss streak always bound first. The daily cap is now exactly the 2-stop limit:
// it is REACHABLE, and it is the same rule the streak counter enforces.
//
// ── WHICH NUMBERS ARE AUTHORITATIVE ───────────────────────────────────
//   1. GATE_CONFIG (src/lib/agent-brain-gate.ts) is THE ONE place the raw
//      numbers live: capital 25_000 · tradeBudget 20_000 · riskPctOfTrade 20
//      · maxConsecutiveLosses 2 · maxDailyLossPct 40. Nothing else in the
//      app may hardcode a cap.
//   2. RISK_LIMITS (below) is the DERIVED view: every cap is a pure function
//      of GATE_CONFIG, so moving GATE_CONFIG moves every cap at once.
//   3. The CONSECUTIVE-LOSS RULE IS THE BINDING ONE: one stop is ₹4,000 =
//      16% of the ₹25,000 account, two stops = ₹8,000 = 32%. The 40% daily
//      cap (₹10,000) can never be reached first — the streak ends the
//      session at two losses, which is exactly where the daily cap sits.
//   4. EVERY cap is ≤ the account. The old monthly cap (₹50,000) was 2× the
//      whole account and could therefore never bind.
const RISK_PER_TRADE_AMOUNT = Math.round((GATE_CONFIG.tradeBudget * GATE_CONFIG.riskPctOfTrade) / 100);
const DAILY_LOSS_FROM_PCT = Math.round((DEFAULT_CAPITAL * GATE_CONFIG.maxDailyLossPct) / 100);
const DAILY_LOSS_FROM_STREAK = RISK_PER_TRADE_AMOUNT * GATE_CONFIG.maxConsecutiveLosses;
const DAILY_LOSS_CAP = Math.min(DAILY_LOSS_FROM_PCT, DAILY_LOSS_FROM_STREAK);
const WEEKLY_LOSS_CAP = Math.min(DEFAULT_CAPITAL, DAILY_LOSS_CAP * 2);
const MONTHLY_LOSS_CAP = Math.min(DEFAULT_CAPITAL, WEEKLY_LOSS_CAP * 2);

export const RISK_LIMITS = {
  /** the real trading capital (₹25,000) */
  capital: DEFAULT_CAPITAL,
  /** ₹ DEPLOYED in one trade (₹20,000) */
  perTradeBudget: GATE_CONFIG.tradeBudget,
  /** risk = 20% of the amount deployed */
  riskPctOfTrade: GATE_CONFIG.riskPctOfTrade,
  /** ₹ at risk on ONE trade (₹20,000 × 20% = ₹4,000) */
  maxRiskPerTrade: RISK_PER_TRADE_AMOUNT,
  /** ₹ loss that ends the day (two stops) */
  maxDailyLoss: DAILY_LOSS_CAP,
  /** ₹ loss that ends the week (never more than the account) */
  maxWeeklyLoss: WEEKLY_LOSS_CAP,
  /** ₹ loss that ends the month — the ACCOUNT itself, never more */
  maxMonthlyLoss: MONTHLY_LOSS_CAP,
  /** consecutive losses that end the session */
  maxConsecutiveLosses: GATE_CONFIG.maxConsecutiveLosses,
  /** open positions at once */
  maxConcurrentTrades: 3,
  /**
   * Σ COMMITTED DEPLOYMENT of the OPEN trades (₹20,000 — the per-trade
   * budget). A ₹25,000 account can never fund two full-size ₹20,000
   * deployments, so this is the real concurrent-exposure cap.
   */
  maxOpenDeployed: GATE_CONFIG.tradeBudget,
  /** Σ ₹ AT RISK of the OPEN trades (₹8,000 — the day's risk budget = 2 stops) */
  maxOpenRisk: DAILY_LOSS_CAP,
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

/** ₹ at risk on ONE trade — 20% of the amount deployed. */
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
 *   deployed budget = min(₹20,000 per-trade cap, account capital)
 *   risk budget     = deployed budget × riskPctOfTrade (20%)
 *   lots            = min( risk-limited lots , affordable lots , maxPositionSize )
 *
 * `riskPerTradePercent` is now read as a % OF THE AMOUNT DEPLOYED (never a %
 * of the account) and is clamped to the model's ceiling so no caller can
 * quietly widen the risk.
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
    const riskLimitedLots = Math.floor(riskBudget / (premiumDiff * lotSize));
    const affordableLots = Math.floor(deployedBudget / (entryPremium * lotSize));
    lots = Math.min(riskLimitedLots, affordableLots, maxPositionSize);
  }

  lots = Math.max(lots, 0);

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
// from NOWHERE — the scanner / Zero-Hero / master-bot Telegram paths were NOT
// day-loss limited at all (only the agent path was, through the gate).
// These functions are the shared, offline-testable core that every signal
// path now runs BEFORE an alert leaves the app.
//
//   1. evaluateLossCaps()        — daily / weekly / monthly loss + loss streak
//   2. evaluateConcurrentExposure() — Σ deployed ≤ ₹20,000, Σ risk ≤ ₹8,000
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
  /** when the snapshot was taken (epoch ms) */
  asOfMs?: number;
}

export interface RiskLimitVerdict {
  blocked: boolean;
  reasons: string[];
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
  return { blocked: reasons.length > 0, reasons, limits };
}

/**
 * Concurrent exposure: the money committed and the money at risk.
 *
 *   Σ deployed ≤ the open-deployment budget (₹20,000 — the per-trade budget)
 *   Σ risk     ≤ the open-risk budget (₹8,000 — the day's risk budget = 2 stops)
 *
 * The account is ₹25,000, so two full-size ₹20,000 deployments (₹40,000
 * committed, ₹8,000 = 32% at risk) can never be funded: the deployment cap
 * binds first and the second trade is refused.
 *
 * FAIL CLOSED:
 *   • an open position whose ₹ exposure could NOT be established blocks the
 *     candidate (an unknown exposure is not a zero exposure),
 *   • a candidate that would push either sum over the line is blocked.
 */
export function evaluateConcurrentExposure(
  input: {
    openDeployed: number;
    openRisk: number;
    newDeployed?: number;
    newRisk?: number;
    /** open positions whose ₹ exposure could NOT be established */
    unknownOpenPositions?: number;
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
  // The account is the outer bound; the per-trade budget is the real cap.
  const deployedCap = Math.min(limits.maxOpenDeployed, capital);
  const riskCap = Math.min(limits.maxOpenRisk, capital);
  const totalDeployed = openDeployed + newDeployed;
  const totalRisk = openRisk + newRisk;
  const reasons: string[] = [];

  if (unknown > 0) {
    reasons.push(
      `${unknown} open position(s) have no verifiable ₹ exposure — the concurrent exposure cannot be verified (fail closed)`,
    );
  }
  if (totalDeployed > deployedCap) {
    reasons.push(
      `deployed ${inr(totalDeployed)} exceeds the ${inr(deployedCap)} open-deployment budget (open ${inr(openDeployed)} + new ${inr(newDeployed)})`,
    );
  }
  if (totalRisk > riskCap) {
    reasons.push(
      `risk ${inr(totalRisk)} exceeds the ${inr(riskCap)} risk budget (open ${inr(openRisk)} + new ${inr(newRisk)})`,
    );
  }
  return { blocked: reasons.length > 0, reasons, limits };
}

/** The full signal-path verdict: loss caps AND concurrent exposure. */
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
    capital: input.capital,
  });
  return {
    blocked: loss.blocked || exposure.blocked,
    reasons: [...loss.reasons, ...exposure.reasons],
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
  if (!(entry > 0) || !(sl > 0) || !(lotSize > 0) || !(stopDist > 0)) {
    // Unknown size → assume the WORST case (the whole per-trade budget) so the
    // exposure check fails closed instead of pretending the trade is free.
    return {
      deployed: RISK_LIMITS.perTradeBudget,
      risk: RISK_LIMITS.maxRiskPerTrade,
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
    capital: input.capital ?? RISK_LIMITS.capital,
    entry,
    sl,
    lotSize,
  });
  if (!ps.ok || ps.lots < 1) {
    // Not sizeable under the house model → the exposure is unknown → worst case.
    return {
      deployed: RISK_LIMITS.perTradeBudget,
      risk: RISK_LIMITS.maxRiskPerTrade,
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

/** A sanity ceiling for a plausible per-trade risk (2 stops). */
const OPEN_RISK_PLAUSIBLE_CEILING = RISK_LIMITS.maxRiskPerTrade * 2;

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
  if (perLotDeployed > RISK_LIMITS.perTradeBudget) {
    // The entry cannot be an option PREMIUM (one lot would blow the whole
    // per-trade budget) — the row carries the UNDERLYING price, so the
    // position is read as a cash one (one unit) instead of a fantasy
    // ₹8-lakh option.
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

// ─── Server-only readers live in ./risk-state.server ────────────────────
// (the database and the in-memory tracker must never enter the client bundle).
// Import them from "./risk-state.server" directly — re-exporting here would
// pull Prisma into every client bundle that touches this file.
