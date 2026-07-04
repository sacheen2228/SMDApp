// Options Strategy Builder — payoff diagrams, max profit/loss, breakeven

export interface Leg {
  type: "CE" | "PE";
  action: "BUY" | "SELL";
  strike: number;
  premium: number;
  lotSize: number;
  lots: number;
}

export interface Strategy {
  name: string;
  legs: Leg[];
  description: string;
  marketView: "bullish" | "bearish" | "neutral" | "volatile" | "directional";
}

export interface PayoffPoint {
  price: number;
  pnl: number;
}

export interface StrategyAnalysis {
  strategy: Strategy;
  maxProfit: number | "unlimited";
  maxLoss: number | "unlimited";
  breakevens: number[];
  payoffCurve: PayoffPoint[];
  marginRequired: number;
  riskReward: string;
  bestCase: string;
  worstCase: string;
}

// Calculate P&L for a single leg at a given spot price
function legPnL(leg: Leg, spot: number): number {
  let intrinsic = 0;
  if (leg.type === "CE") {
    intrinsic = Math.max(0, spot - leg.strike);
  } else {
    intrinsic = Math.max(0, leg.strike - spot);
  }

  const totalPremium = leg.premium * leg.lotSize * leg.lots;
  const totalIntrinsic = intrinsic * leg.lotSize * leg.lots;

  if (leg.action === "BUY") {
    return totalIntrinsic - totalPremium;
  } else {
    return totalPremium - totalIntrinsic;
  }
}

// Calculate total P&L for a strategy at a given spot price
function strategyPnL(strategy: Strategy, spot: number): number {
  return strategy.legs.reduce((sum, leg) => sum + legPnL(leg, spot), 0);
}

// Calculate margin for sell legs (simplified SPAN-like)
function calculateMargin(strategy: Strategy): number {
  let totalMargin = 0;
  for (const leg of strategy.legs) {
    if (leg.action === "SELL") {
      // Simplified: 20% of notional + premium
      const notional = leg.strike * leg.lotSize * leg.lots;
      const premiumCollateral = leg.premium * leg.lotSize * leg.lots;
      totalMargin += notional * 0.2 + premiumCollateral;
    }
  }
  return Math.round(totalMargin);
}

// Find breakeven points (where P&L crosses zero)
function findBreakevens(payoff: PayoffPoint[]): number[] {
  const breakevens: number[] = [];
  for (let i = 1; i < payoff.length; i++) {
    if ((payoff[i - 1].pnl <= 0 && payoff[i].pnl > 0) ||
        (payoff[i - 1].pnl >= 0 && payoff[i].pnl < 0)) {
      // Linear interpolation
      const t = Math.abs(payoff[i - 1].pnl) / (Math.abs(payoff[i - 1].pnl) + Math.abs(payoff[i].pnl));
      const be = payoff[i - 1].price + (payoff[i].price - payoff[i - 1].price) * t;
      breakevens.push(Math.round(be));
    }
  }
  return breakevens;
}

// Analyze a strategy
export function analyzeStrategy(strategy: Strategy, spotPrice: number): StrategyAnalysis {
  // Generate payoff curve (5% below to 5% above spot)
  const range = spotPrice * 0.05;
  const steps = 100;
  const minPrice = spotPrice - range;
  const maxPrice = spotPrice + range;
  const stepSize = (maxPrice - minPrice) / steps;

  const payoffCurve: PayoffPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const price = minPrice + i * stepSize;
    payoffCurve.push({ price: Math.round(price), pnl: Math.round(strategyPnL(strategy, price)) });
  }

  // Find max profit/loss
  const pnls = payoffCurve.map((p) => p.pnl);
  const maxProfitVal = Math.max(...pnls);
  const maxLossVal = Math.min(...pnls);

  // Check if unlimited
  const hasBuyCE = strategy.legs.some((l) => l.type === "CE" && l.action === "BUY");
  const hasBuyPE = strategy.legs.some((l) => l.type === "PE" && l.action === "BUY");
  const hasSellCE = strategy.legs.some((l) => l.type === "CE" && l.action === "SELL");
  const hasSellPE = strategy.legs.some((l) => l.type === "PE" && l.action === "SELL");

  const maxProfit = (hasBuyCE || hasBuyPE) && maxProfitVal >= payoffCurve[payoffCurve.length - 1].pnl ? "unlimited" : maxProfitVal;
  const maxLoss = (hasSellCE || hasSellPE) && maxLossVal <= payoffCurve[0].pnl ? "unlimited" : Math.abs(maxLossVal);

  const breakevens = findBreakevens(payoffCurve);
  const margin = calculateMargin(strategy);
  const rr = typeof maxLoss === "number" && maxLoss > 0 ? `${typeof maxProfit === "number" ? (maxProfit / maxLoss).toFixed(1) : "∞"}` : "N/A";

  // Current P&L
  const currentPnL = strategyPnL(strategy, spotPrice);

  return {
    strategy,
    maxProfit,
    maxLoss,
    breakevens,
    payoffCurve,
    marginRequired: margin,
    riskReward: rr,
    bestCase: typeof maxProfit === "number" ? `+₹${maxProfit.toLocaleString("en-IN")}` : "Unlimited upside",
    worstCase: typeof maxLoss === "number" ? `-₹${maxLoss.toLocaleString("en-IN")}` : "Unlimited risk",
  };
}

// Pre-built strategies
export function buildStraddle(atmStrike: number, premium: number, lotSize: number): Strategy {
  return {
    name: "Long Straddle",
    marketView: "volatile",
    description: "Buy ATM CE + Buy ATM PE. Profits from big moves in either direction.",
    legs: [
      { type: "CE", action: "BUY", strike: atmStrike, premium, lotSize, lots: 1 },
      { type: "PE", action: "BUY", strike: atmStrike, premium, lotSize, lots: 1 },
    ],
  };
}

export function buildStrangle(otmStrike1: number, otmStrike2: number, premium1: number, premium2: number, lotSize: number): Strategy {
  return {
    name: "Long Strangle",
    marketView: "volatile",
    description: "Buy OTM CE + Buy OTM PE. Cheaper than straddle, needs bigger move.",
    legs: [
      { type: "CE", action: "BUY", strike: otmStrike1, premium: premium1, lotSize, lots: 1 },
      { type: "PE", action: "BUY", strike: otmStrike2, premium: premium2, lotSize, lots: 1 },
    ],
  };
}

export function buildIronCondor(
  farOTMPE: number, otmPE: number, otmCE: number, farOTMCE: number,
  premFarPE: number, premPE: number, premCE: number, premFarCE: number,
  lotSize: number
): Strategy {
  return {
    name: "Iron Condor",
    marketView: "neutral",
    description: "Sell OTM CE+PE, buy far OTM CE+PE. Profits from low volatility, range-bound market.",
    legs: [
      { type: "PE", action: "BUY", strike: farOTMPE, premium: premFarPE, lotSize, lots: 1 },
      { type: "PE", action: "SELL", strike: otmPE, premium: premPE, lotSize, lots: 1 },
      { type: "CE", action: "SELL", strike: otmCE, premium: premCE, lotSize, lots: 1 },
      { type: "CE", action: "BUY", strike: farOTMCE, premium: premFarCE, lotSize, lots: 1 },
    ],
  };
}

export function buildBullCallSpread(lowerStrike: number, upperStrike: number, premLower: number, premUpper: number, lotSize: number): Strategy {
  return {
    name: "Bull Call Spread",
    marketView: "bullish",
    description: "Buy lower strike CE + Sell higher strike CE. Limited profit, limited risk.",
    legs: [
      { type: "CE", action: "BUY", strike: lowerStrike, premium: premLower, lotSize, lots: 1 },
      { type: "CE", action: "SELL", strike: upperStrike, premium: premUpper, lotSize, lots: 1 },
    ],
  };
}

export function buildBearPutSpread(lowerStrike: number, upperStrike: number, premLower: number, premUpper: number, lotSize: number): Strategy {
  return {
    name: "Bear Put Spread",
    marketView: "bearish",
    description: "Buy higher strike PE + Sell lower strike PE. Limited profit, limited risk.",
    legs: [
      { type: "PE", action: "BUY", strike: upperStrike, premium: premUpper, lotSize, lots: 1 },
      { type: "PE", action: "SELL", strike: lowerStrike, premium: premLower, lotSize, lots: 1 },
    ],
  };
}

export function buildCoveredCall(spotStrike: number, otmStrike: number, premSpot: number, premOTM: number, lotSize: number): Strategy {
  return {
    name: "Covered Call (Synthetic)",
    marketView: "directional",
    description: "Buy spot equivalent + Sell OTM CE. Income strategy with capped upside.",
    legs: [
      { type: "CE", action: "BUY", strike: spotStrike, premium: premSpot, lotSize, lots: 1 },
      { type: "CE", action: "SELL", strike: otmStrike, premium: premOTM, lotSize, lots: 1 },
    ],
  };
}
