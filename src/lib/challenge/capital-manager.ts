// ═══════════════════════════════════════════════════════════════════════════
// Capital Manager — ₹15K → ₹1L Challenge
// Position sizing, drawdown protection, risk limits, compounding.
// ═══════════════════════════════════════════════════════════════════════════

export interface CapitalConfig {
  startingCapital: number;       // ₹15,000
  targetCapital: number;         // ₹1,00,000
  maxRiskPerTradePct: number;    // 5% of current capital
  maxDailyDrawdownPct: number;   // 10% of starting capital
  maxTotalDrawdownPct: number;   // 20% of starting capital
  maxConcurrentTrades: number;   // 3
  maxPositionPct: number;        // 40% of capital per trade
  lotSizeBuffer: number;         // 10% buffer on lot cost
  minTradeValue: number;         // ₹1,000 minimum
}

export const DEFAULT_CAPITAL_CONFIG: CapitalConfig = {
  startingCapital: 15000,
  targetCapital: 100000,
  maxRiskPerTradePct: 5,
  maxDailyDrawdownPct: 10,
  maxTotalDrawdownPct: 20,
  maxConcurrentTrades: 3,
  maxPositionPct: 40,
  lotSizeBuffer: 10,
  minTradeValue: 1000,
};

export interface PositionSizing {
  quantity: number;
  lotSize: number;
  lots: number;
  totalCost: number;
  maxLoss: number;
  maxLossPct: number;
  riskAmount: number;
  canTrade: boolean;
  reason?: string;
}

export interface DrawdownState {
  currentCapital: number;
  peakCapital: number;
  dailyPnL: number;
  totalDrawdown: number;
  totalDrawdownPct: number;
  dailyDrawdown: number;
  dailyDrawdownPct: number;
  challengeFailed: boolean;
  failureReason?: string;
}

// ── Lot sizes for common F&O symbols ──
const LOT_SIZES: Record<string, number> = {
  NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 40, MIDCPNIFTY: 50, SENSEX: 15,
  NIFTY50: 25, SENSEX30: 15,
  // Individual stock lot sizes (approximate — varies by price)
  // Most stocks have lot size of 1 unless they're in F&O
};

export function getLotSize(symbol: string): number {
  if (LOT_SIZES[symbol]) return LOT_SIZES[symbol];
  // For stocks, F&O lot sizes depend on price bracket
  // Most liquid stocks: lot size = 1 for delivery, varies for F&O
  // Default to 1 for equity, check F&O rules
  return 1;
}

// ── Calculate position size for equity trade ──
export function calculateEquityPosition(
  capital: number,
  entry: number,
  stopLoss: number,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): PositionSizing {
  const riskPerShare = Math.abs(entry - stopLoss);
  if (riskPerShare <= 0) {
    return { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Stop loss must differ from entry" };
  }

  const riskAmount = capital * (config.maxRiskPerTradePct / 100);
  const maxPositionValue = capital * (config.maxPositionPct / 100);
  const maxQuantity = Math.floor(maxPositionValue / entry);

  // Risk-based quantity
  const riskBasedQty = Math.floor(riskAmount / riskPerShare);
  const quantity = Math.min(riskBasedQty, maxQuantity);

  const totalCost = quantity * entry;
  const maxLoss = quantity * riskPerShare;
  const maxLossPct = (maxLoss / capital) * 100;

  if (quantity <= 0 || totalCost < config.minTradeValue) {
    return { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Position too small or capital insufficient" };
  }

  return {
    quantity,
    lotSize: 1,
    lots: quantity,
    totalCost,
    maxLoss,
    maxLossPct: Math.round(maxLossPct * 100) / 100,
    riskAmount,
    canTrade: true,
  };
}

// ── Calculate position size for F&O trade ──
export function calculateFOPosition(
  capital: number,
  entry: number,
  stopLoss: number,
  symbol: string,
  isOption = false,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): PositionSizing {
  const lotSize = getLotSize(symbol);
  const riskPerLot = Math.abs(entry - stopLoss) * lotSize;
  if (riskPerLot <= 0) {
    return { quantity: 0, lotSize, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Stop loss must differ from entry" };
  }

  const riskAmount = capital * (config.maxRiskPerTradePct / 100);
  const maxLotsByRisk = Math.floor(riskAmount / riskPerLot);
  const lotCost = entry * lotSize * (1 + config.lotSizeBuffer / 100);
  const maxLotsByCapital = Math.floor((capital * config.maxPositionPct / 100) / lotCost);

  const lots = Math.min(maxLotsByRisk, maxLotsByCapital);
  if (lots <= 0) {
    return { quantity: 0, lotSize, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Capital too small for minimum lot" };
  }

  const quantity = lots * lotSize;
  const totalCost = lots * lotCost;
  const maxLoss = lots * riskPerLot;
  const maxLossPct = (maxLoss / capital) * 100;

  return {
    quantity,
    lotSize,
    lots,
    totalCost: Math.round(totalCost),
    maxLoss: Math.round(maxLoss),
    maxLossPct: Math.round(maxLossPct * 100) / 100,
    riskAmount: Math.round(riskAmount),
    canTrade: true,
  };
}

// ── Check drawdown limits ──
export function checkDrawdown(
  currentCapital: number,
  peakCapital: number,
  dailyPnL: number,
  startingCapital: number,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): DrawdownState {
  const totalDrawdown = peakCapital - currentCapital;
  const totalDrawdownPct = peakCapital > 0 ? (totalDrawdown / peakCapital) * 100 : 0;
  const dailyDrawdown = dailyPnL < 0 ? Math.abs(dailyPnL) : 0;
  const dailyDrawdownPct = startingCapital > 0 ? (dailyDrawdown / startingCapital) * 100 : 0;

  const challengeFailed = totalDrawdownPct >= config.maxTotalDrawdownPct || dailyDrawdownPct >= config.maxDailyDrawdownPct;
  const failureReason = totalDrawdownPct >= config.maxTotalDrawdownPct
    ? `Max total drawdown reached (${totalDrawdownPct.toFixed(1)}% >= ${config.maxTotalDrawdownPct}%)`
    : dailyDrawdownPct >= config.maxDailyDrawdownPct
    ? `Max daily drawdown reached (${dailyDrawdownPct.toFixed(1)}% >= ${config.maxDailyDrawdownPct}%)`
    : undefined;

  return {
    currentCapital,
    peakCapital,
    dailyPnL,
    totalDrawdown,
    totalDrawdownPct: Math.round(totalDrawdownPct * 100) / 100,
    dailyDrawdown,
    dailyDrawdownPct: Math.round(dailyDrawdownPct * 100) / 100,
    challengeFailed,
    failureReason,
  };
}

// ── Get milestone status ──
export function getMilestones(currentCapital: number, startingCapital: number) {
  const milestones = [20000, 30000, 50000, 75000, 100000];
  return milestones.map(target => ({
    target,
    label: `₹${(target / 1000).toFixed(0)}K`,
    reached: currentCapital >= target,
    progress: Math.min(100, Math.round((currentCapital / target) * 100)),
  }));
}

// ── Calculate progress percentage ──
export function getChallengeProgress(currentCapital: number, config: CapitalConfig = DEFAULT_CAPITAL_CONFIG) {
  const range = config.targetCapital - config.startingCapital;
  const progress = currentCapital - config.startingCapital;
  return Math.max(0, Math.round((progress / range) * 100));
}
