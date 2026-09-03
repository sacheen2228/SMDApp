// ═══════════════════════════════════════════════════════════════════════════
// Capital Manager — ₹15K → ₹1L Challenge
// FIXED: lot sizes, drawdown, position sizing for small accounts
// ═══════════════════════════════════════════════════════════════════════════

export interface CapitalConfig {
  startingCapital: number;
  targetCapital: number;
  maxRiskPerTradePct: number;
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  maxConcurrentTrades: number;
  maxPositionPct: number;
  lotSizeBuffer: number;
  minTradeValue: number;
}

export const DEFAULT_CAPITAL_CONFIG: CapitalConfig = {
  startingCapital: 15000,
  targetCapital: 100000,
  maxRiskPerTradePct: 5,
  maxDailyDrawdownPct: 10,
  maxTotalDrawdownPct: 20,
  maxConcurrentTrades: 3,
  maxPositionPct: 50, // Increased from 40% — was too restrictive for ₹15K
  lotSizeBuffer: 5,   // Reduced from 10% — was inflating costs
  minTradeValue: 500, // Reduced from 1000 — ₹15K needs smaller trades
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
  instrument: string;
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

// ── SEBI F&O lot sizes (as of 2024) ──
const FNO_LOT_SIZES: Record<string, number> = {
  // Index
  NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 40, MIDCPNIFTY: 50, SENSEX: 15, NIFTY_BANK: 15,
  // Large cap stocks
  RELIANCE: 250, TCS: 175, HDFCBANK: 550, INFY: 400, ICICIBANK: 700,
  SBIN: 1500, BHARTIARTL: 475, KOTAKBANK: 400, LT: 150, AXISBANK: 625,
  BAJFINANCE: 125, ASIANPAINT: 200, MARUTI: 25, SUNPHARMA: 400, TITAN: 175,
  TATAMOTORS: 1250, WIPRO: 1500, "M&M": 400, HCLTECH: 700, POWERGRID: 2700,
  NTPC: 2250, ONGC: 3750, TATASTEEL: 5500, JSWSTEEL: 675, ADANIENT: 250,
  ADANIPORTS: 600, TECHM: 600, HDFCLIFE: 1500, SBILIFE: 1000, BRITANNIA: 125,
  CIPLA: 300, DRREDDY: 125, DIVISLAB: 100, EICHERMOT: 300, GRASIM: 400,
  HEROMOTOCO: 200, HINDALCO: 1750, INDUSINDBK: 900, BAJAJFINSV: 375,
  COALINDIA: 2250, BPCL: 1800, TRENT: 550, APOLLOHOSP: 125, LTIM: 175,
  PIDILITIND: 250,
  // Midcap stocks (common F&O)
  AUROPHARMA: 500, CANBK: 4000, PFC: 2250, RECLTD: 1600, IRFC: 12500,
  IREDA: 5000, BEL: 3500, HAL: 125, BDL: 500, COCHINSHIP: 250,
  ZOMATO: 6000, NYKAA: 3000, POLYCAB: 300, KEI: 500,
};

export function getLotSize(symbol: string): number {
  return FNO_LOT_SIZES[symbol] || 1;
}

// ── Calculate position size for equity trade ──
export function calculateEquityPosition(
  capital: number,
  entry: number,
  stopLoss: number,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): PositionSizing {
  const riskPerShare = Math.abs(entry - stopLoss);
  if (riskPerShare <= 0 || entry <= 0) {
    return { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Invalid entry/SL", instrument: "EQUITY" };
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
    return { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: quantity <= 0 ? "Capital too small" : `Cost ₹${totalCost} below minimum ₹${config.minTradeValue}`, instrument: "EQUITY" };
  }

  return {
    quantity,
    lotSize: 1,
    lots: quantity,
    totalCost: Math.round(totalCost),
    maxLoss: Math.round(maxLoss),
    maxLossPct: Math.round(maxLossPct * 100) / 100,
    riskAmount: Math.round(riskAmount),
    canTrade: true,
    instrument: "EQUITY",
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
  const riskPerUnit = Math.abs(entry - stopLoss);

  if (riskPerUnit <= 0 || entry <= 0) {
    return { quantity: 0, lotSize, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Invalid entry/SL", instrument: isOption ? (symbol.includes("CE") ? "CALL" : "PUT") : "FUTURES" };
  }

  const riskPerLot = riskPerUnit * lotSize;
  const riskAmount = capital * (config.maxRiskPerTradePct / 100);
  const lotCost = entry * lotSize * (1 + config.lotSizeBuffer / 100);
  const maxLotsByRisk = Math.floor(riskAmount / riskPerLot);
  const maxLotsByCapital = Math.floor((capital * config.maxPositionPct / 100) / lotCost);

  const lots = Math.min(maxLotsByRisk, maxLotsByCapital);
  if (lots <= 0) {
    return { quantity: 0, lotSize, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: `Min lot cost ₹${Math.round(lotCost)} exceeds capital limit`, instrument: isOption ? "OPTION" : "FUTURES" };
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
    instrument: isOption ? "OPTION" : "FUTURES",
  };
}

// ── Check drawdown limits (FIXED: daily uses currentCapital, not startingCapital) ──
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
  // FIXED: daily drawdown measured against current capital, not starting capital
  const dailyDrawdownPct = currentCapital > 0 ? (dailyDrawdown / currentCapital) * 100 : 0;

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
    progress: Math.min(100, Math.max(0, Math.round(((currentCapital - startingCapital) / (target - startingCapital)) * 100))),
  }));
}
