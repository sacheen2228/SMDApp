import type {
  RiskState,
  PositionSizeInput,
  PositionSizeResult,
  RiskCheckResult,
} from "../types/sdm";

const DEFAULT_CAPITAL = 1_000_000; // 10L
const DEFAULT_RISK_PER_TRADE_PCT = 1;
const DEFAULT_MAX_DAILY_LOSS = 50_000;
const DEFAULT_MAX_WEEKLY_LOSS = 150_000;
const DEFAULT_MAX_MONTHLY_LOSS = 300_000;
const DEFAULT_MAX_POSITION_SIZE = 10;
const DEFAULT_MAX_CONCURRENT_TRADES = 3;

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

export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const {
    capital,
    riskPerTradePercent,
    entryPremium,
    stopLossPremium,
    lotSize,
    maxPositionSize,
  } = input;

  const riskPerTrade = Math.min(
    (riskPerTradePercent / 100) * capital,
    maxPositionSize * lotSize * Math.max(entryPremium - stopLossPremium, 0),
  );

  const premiumDiff = Math.max(entryPremium - stopLossPremium, 0);

  let lots = 0;
  if (premiumDiff > 0 && lotSize > 0) {
    lots = Math.floor(riskPerTrade / (premiumDiff * lotSize));
  }

  lots = Math.min(lots, maxPositionSize);
  lots = Math.max(lots, 0);

  const quantity = lots * lotSize;
  const riskAmount = lots * lotSize * premiumDiff;
  const positionValue = lots * lotSize * entryPremium;

  // Estimate target1 premium as entry + 2x risk per lot (typical 1:2 RR)
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
