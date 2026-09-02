// lib/cas-straddle-strategy.ts
//
// CAS Straddle / Strangle Strategy Engine
// ───────────────────────────────────────────────────────────────────
// Uses CAS dislocation + ATM straddle range + market regime to generate
// directional or non-directional options trades.
//
// Shared between LIVE and BACKTEST — only the data source changes.

export type StrategyType = "CALL" | "PUT" | "STRADDLE" | "STRANGLE" | "NO_TRADE";
export type StrikeSelection = "ITM" | "ATM" | "OTM" | "OPTIMIZED" | "AUTO";
export type ExpiryType = "weekly" | "monthly";

export interface MarketSnapshot {
  timestamp: string;
  spot: number;
  symbol: string;
  // CAS data
  casReferencePrice: number;
  casDislocationPct: number;
  casDislocationStrength: "NONE" | "WEAK" | "MODERATE" | "STRONG" | "EXTREME";
  casVelocity: number;
  casAboveReference: boolean;
  // Straddle data
  atmStrike: number;
  atmCE: number;
  atmPE: number;
  combinedPremium: number;
  expectedMove: number;
  // Chain context
  pcr: number;
  maxPain: number;
  iv: number;
  // Option chain (for strike optimization)
  chain: Array<{
    strike: number;
    ce?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta?: number; spread?: number } | null;
    pe?: { ltp: number; oi: number; oiChg: number; volume: number; iv: number; delta?: number; spread?: number } | null;
  }>;
  // Market context
  regime: "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "HIGH_VOL" | "LOW_VOL";
  vix: number;
  // Candles (for confirmation)
  candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}

export interface StrategySignal {
  strategy: StrategyType;
  confidence: number; // 0-100
  reasoning: string[];
  // Strike details
  ceStrike: number;
  peStrike: number;
  cePremium: number;
  pePremium: number;
  combinedPremium: number;
  // Risk
  maxRisk: number;
  maxReward: number;
  breakevenUpper: number;
  breakevenLower: number;
  riskReward: number;
  // CAS score
  casScore: number;
  // Expected move
  expectedMove: number;
  expectedMovePct: number;
  // Entry/exit
  entryTime: string;
  exitTime: string;
  targetPct: number;
  stopLossPct: number;
}

export interface StrategyConfig {
  strategy: StrategyType | "AUTO";
  strikeSelection: StrikeSelection;
  expiryType: ExpiryType;
  initialCapital: number;
  maxRiskPct: number;
  entryTime: string; // HH:MM
  exitTime: string;  // HH:MM
  targetPct: number;
  stopLossPct: number;
  chargesMode: "realistic" | "custom";
  slippageMode: "realistic" | "custom";
}

// ─── CAS Score (0-100) ─────────────────────────────────────────────
function computeCASScore(snap: MarketSnapshot): number {
  let score = 50; // neutral baseline

  // CAS dislocation strength
  const strengthMap: Record<string, number> = {
    NONE: 0, WEAK: 10, MODERATE: 25, STRONG: 40, EXTREME: 50,
  };
  score += strengthMap[snap.casDislocationStrength] || 0;

  // CAS velocity (momentum of dislocation)
  if (Math.abs(snap.casVelocity) > 0.5) score += 10;
  if (Math.abs(snap.casVelocity) > 1.0) score += 10;

  // PCR confirmation
  if (snap.pcr > 1.1 && snap.casAboveReference) score += 5; // bullish confirmation
  if (snap.pcr < 0.9 && !snap.casAboveReference) score += 5; // bearish confirmation

  // IV regime
  if (snap.iv > 15 && snap.iv < 25) score += 5; // sweet spot for options buying

  return Math.min(100, Math.max(0, score));
}

// ─── Signal Generation (same for live and backtest) ─────────────────
export function generateStrategySignal(
  snap: MarketSnapshot,
  config: StrategyConfig,
): StrategySignal {
  const casScore = computeCASScore(snap);
  const reasoning: string[] = [];
  let strategy: StrategyType = config.strategy === "AUTO" ? "NO_TRADE" : config.strategy;

  // ─── AUTO MODE: decide strategy based on CAS + regime ────────────
  if (config.strategy === "AUTO") {
    const absDislocation = Math.abs(snap.casDislocationPct);
    const isTrending = snap.regime === "TRENDING_UP" || snap.regime === "TRENDING_DOWN";
    const isRanging = snap.regime === "RANGING";

    if (absDislocation < 0.15 && isRanging) {
      // Low CAS dislocation + ranging → sell premium via straddle/strangle
      strategy = snap.iv > 18 ? "STRADDLE" : "STRANGLE";
      reasoning.push(`CAS dislocation ${snap.casDislocationPct.toFixed(2)}% — range-bound`);
      reasoning.push(`Regime: ${snap.regime}, IV: ${snap.iv.toFixed(1)}`);
    } else if (snap.casAboveReference && snap.casDislocationPct > 0.15) {
      // CAS above reference → bullish
      strategy = snap.pcr > 1.0 ? "CALL" : "STRANGLE";
      reasoning.push(`CAS above reference by ${snap.casDislocationPct.toFixed(2)}%`);
      reasoning.push(`PCR ${snap.pcr.toFixed(2)} supports ${strategy}`);
    } else if (!snap.casAboveReference && snap.casDislocationPct < -0.15) {
      // CAS below reference → bearish
      strategy = snap.pcr < 1.0 ? "PUT" : "STRANGLE";
      reasoning.push(`CAS below reference by ${Math.abs(snap.casDislocationPct).toFixed(2)}%`);
      reasoning.push(`PCR ${snap.pcr.toFixed(2)} supports ${strategy}`);
    } else if (casScore >= 60 && isTrending) {
      // Moderate CAS + trending → directional
      strategy = snap.casAboveReference ? "CALL" : "PUT";
      reasoning.push(`CAS score ${casScore} + trending regime`);
    } else {
      strategy = "NO_TRADE";
      reasoning.push(`Insufficient CAS signal: dislocation ${snap.casDislocationPct.toFixed(2)}%, score ${casScore}`);
    }

    if (strategy !== "NO_TRADE") {
      reasoning.push(`AUTO selected: ${strategy}`);
    }
  } else {
    reasoning.push(`Manual strategy: ${strategy}`);
    reasoning.push(`CAS score: ${casScore}`);
  }

  // ─── Strike Selection ──────────────────────────────────────────
  let { ceStrike, peStrike, cePremium, pePremium } = selectStrikes(
    snap, strategy, config.strikeSelection
  );

  const combinedPremium = cePremium + pePremium;
  const expectedMove = snap.expectedMove || snap.combinedPremium;
  const expectedMovePct = snap.spot > 0 ? (expectedMove / snap.spot) * 100 : 0;

  // ─── Risk Calculation ─────────────────────────────────────────
  let maxRisk = 0, maxReward = 0, breakevenUpper = 0, breakevenLower = 0;

  if (strategy === "STRADDLE" || strategy === "STRANGLE") {
    // Short straddle/strangle: max reward = premium received, max risk = unlimited
    // Long straddle/strangle: max risk = premium paid, max reward = unlimited
    // We use SHORT (sell premium) for range-bound, LONG for breakout
    const isRangeBound = snap.regime === "RANGING" || snap.regime === "LOW_VOL";
    if (isRangeBound) {
      // SHORT: sell premium
      maxReward = combinedPremium;
      maxRisk = combinedPremium * 3; // approximate max loss
      breakevenUpper = snap.atmStrike + combinedPremium;
      breakevenLower = snap.atmStrike - combinedPremium;
      reasoning.push(`SHORT ${strategy}: premium ₹${combinedPremium.toFixed(2)}`);
    } else {
      // LONG: buy premium
      maxRisk = combinedPremium;
      maxReward = combinedPremium * 4; // approximate
      breakevenUpper = snap.atmStrike + combinedPremium;
      breakevenLower = snap.atmStrike - combinedPremium;
      reasoning.push(`LONG ${strategy}: premium ₹${combinedPremium.toFixed(2)}`);
    }
  } else if (strategy === "CALL") {
    maxRisk = cePremium;
    maxReward = expectedMove - cePremium;
    breakevenUpper = ceStrike + cePremium;
    breakevenLower = ceStrike;
    reasoning.push(`CALL @ ${ceStrike}: premium ₹${cePremium.toFixed(2)}`);
  } else if (strategy === "PUT") {
    maxRisk = pePremium;
    maxReward = expectedMove - pePremium;
    breakevenLower = peStrike - pePremium;
    breakevenUpper = peStrike;
    reasoning.push(`PUT @ ${peStrike}: premium ₹${pePremium.toFixed(2)}`);
  }

  const riskReward = maxRisk > 0 ? maxReward / maxRisk : 0;

  // ─── Confidence ───────────────────────────────────────────────
  let confidence = casScore;
  if (strategy === "NO_TRADE") confidence = 0;
  if (riskReward < 0.5 && strategy !== "NO_TRADE") confidence = Math.min(confidence, 40);
  if (snap.iv > 30) confidence = Math.min(confidence, 50); // high IV = less reliable

  return {
    strategy,
    confidence,
    reasoning,
    ceStrike,
    peStrike,
    cePremium,
    pePremium,
    combinedPremium,
    maxRisk,
    maxReward,
    breakevenUpper,
    breakevenLower,
    riskReward,
    casScore,
    expectedMove,
    expectedMovePct,
    entryTime: config.entryTime,
    exitTime: config.exitTime,
    targetPct: config.targetPct,
    stopLossPct: config.stopLossPct,
  };
}

// ─── Strike Selection ──────────────────────────────────────────────
function selectStrikes(
  snap: MarketSnapshot,
  strategy: StrategyType,
  selection: StrikeSelection,
): { ceStrike: number; peStrike: number; cePremium: number; pePremium: number } {
  if (strategy === "NO_TRADE") {
    return { ceStrike: 0, peStrike: 0, cePremium: 0, pePremium: 0 };
  }

  const atm = snap.atmStrike;
  const step = snap.symbol === "SENSEX" ? 100 : 50; // NIFTY=50, SENSEX=100

  if (strategy === "CALL") {
    const strike = resolveSingleStrike(snap, "CE", selection);
    return { ceStrike: strike.strike, peStrike: 0, cePremium: strike.premium, pePremium: 0 };
  }

  if (strategy === "PUT") {
    const strike = resolveSingleStrike(snap, "PE", selection);
    return { ceStrike: 0, peStrike: strike.strike, cePremium: 0, pePremium: strike.premium };
  }

  // Straddle: same strike for CE and PE
  if (strategy === "STRADDLE") {
    const strike = resolveATMStrike(snap, selection);
    const ce = snap.chain.find(s => s.strike === strike)?.ce;
    const pe = snap.chain.find(s => s.strike === strike)?.pe;
    return {
      ceStrike: strike,
      peStrike: strike,
      cePremium: ce?.ltp || snap.atmCE,
      pePremium: pe?.ltp || snap.atmPE,
    };
  }

  // Strangle: different strikes
  if (strategy === "STRANGLE") {
    const ceStrike = resolveOTMStrike(snap, "CE", selection);
    const peStrike = resolveOTMStrike(snap, "PE", selection);
    const ce = snap.chain.find(s => s.strike === ceStrike)?.ce;
    const pe = snap.chain.find(s => s.strike === peStrike)?.pe;
    return {
      ceStrike,
      peStrike,
      cePremium: ce?.ltp || 0,
      pePremium: pe?.ltp || 0,
    };
  }

  return { ceStrike: atm, peStrike: atm, cePremium: snap.atmCE, pePremium: snap.atmPE };
}

function resolveATMStrike(snap: MarketSnapshot, selection: StrikeSelection): number {
  if (selection === "ATM" || selection === "AUTO") return snap.atmStrike;

  const step = snap.symbol === "SENSEX" ? 100 : 50;
  if (selection === "ITM") return snap.atmStrike - step;
  if (selection === "OTM") return snap.atmStrike + step;

  // OPTIMIZED: pick strike with best liquidity + premium ratio
  let bestStrike = snap.atmStrike;
  let bestScore = 0;
  for (const row of snap.chain) {
    const ce = row.ce;
    if (!ce || ce.ltp <= 0) continue;
    const dist = Math.abs(row.strike - snap.spot);
    const liquidity = ce.oi > 0 ? Math.min(100, ce.oi / 10000) : 0;
    const premiumScore = ce.ltp > 0 ? Math.min(100, (ce.ltp / snap.spot) * 1000) : 0;
    const score = liquidity * 0.5 + premiumScore * 0.3 - dist * 0.001;
    if (score > bestScore) { bestScore = score; bestStrike = row.strike; }
  }
  return bestStrike;
}

function resolveOTMStrike(snap: MarketSnapshot, type: "CE" | "PE", selection: StrikeSelection): number {
  const step = snap.symbol === "SENSEX" ? 100 : 50;

  if (selection === "OTM" || selection === "AUTO") {
    // 1 step OTM
    return type === "CE" ? snap.atmStrike + step : snap.atmStrike - step;
  }

  if (selection === "ITM") {
    return type === "CE" ? snap.atmStrike - step : snap.atmStrike + step;
  }

  if (selection === "ATM") {
    return snap.atmStrike;
  }

  // OPTIMIZED: scan for best risk/reward
  let bestStrike = type === "CE" ? snap.atmStrike + step : snap.atmStrike - step;
  let bestScore = 0;
  for (const row of snap.chain) {
    const leg = type === "CE" ? row.ce : row.pe;
    if (!leg || leg.ltp <= 0) continue;
    const moneyness = type === "CE"
      ? (row.strike - snap.spot) / snap.spot
      : (snap.spot - row.strike) / snap.spot;
    if (moneyness < 0) continue; // skip ITM
    const liquidity = leg.oi > 0 ? Math.min(100, leg.oi / 10000) : 0;
    const premiumScore = leg.ltp > 0 ? Math.min(100, (leg.ltp / snap.spot) * 1000) : 0;
    const score = liquidity * 0.4 + premiumScore * 0.4 - moneyness * 100;
    if (score > bestScore) { bestScore = score; bestStrike = row.strike; }
  }
  return bestStrike;
}

function resolveSingleStrike(snap: MarketSnapshot, type: "CE" | "PE", selection: StrikeSelection): { strike: number; premium: number } {
  const step = snap.symbol === "SENSEX" ? 100 : 50;
  let strike: number;

  if (selection === "ATM") {
    strike = snap.atmStrike;
  } else if (selection === "ITM") {
    strike = type === "CE" ? snap.atmStrike - step : snap.atmStrike + step;
  } else if (selection === "OTM") {
    strike = type === "CE" ? snap.atmStrike + step : snap.atmStrike - step;
  } else {
    // OPTIMIZED or AUTO
    strike = type === "CE" ? snap.atmStrike + step : snap.atmStrike - step;
    let bestScore = 0;
    for (const row of snap.chain) {
      const leg = type === "CE" ? row.ce : row.pe;
      if (!leg || leg.ltp <= 0) continue;
      const liquidity = leg.oi > 0 ? Math.min(100, leg.oi / 10000) : 0;
      const premiumScore = leg.ltp > 0 ? Math.min(100, (leg.ltp / snap.spot) * 1000) : 0;
      const score = liquidity * 0.5 + premiumScore * 0.5;
      if (score > bestScore) { bestScore = score; strike = row.strike; }
    }
  }

  const row = snap.chain.find(s => s.strike === strike);
  const premium = type === "CE" ? (row?.ce?.ltp || snap.atmCE) : (row?.pe?.ltp || snap.atmPE);
  return { strike, premium };
}

// ─── P&L Calculation ──────────────────────────────────────────────
export interface TradePnL {
  grossPnL: number;
  charges: number;
  slippage: number;
  netPnL: number;
  returnPct: number;
}

export function calculateTradePnL(
  signal: StrategySignal,
  exitPremium: number,
  lotSize: number,
  chargesMode: "realistic" | "custom" = "realistic",
  slippageMode: "realistic" | "custom" = "realistic",
): TradePnL {
  let grossPnL = 0;

  if (signal.strategy === "STRADDLE" || signal.strategy === "STRANGLE") {
    // Short: profit if premium decreases
    grossPnL = (signal.combinedPremium - exitPremium) * lotSize;
  } else if (signal.strategy === "CALL") {
    grossPnL = (exitPremium - signal.cePremium) * lotSize;
  } else if (signal.strategy === "PUT") {
    grossPnL = (exitPremium - signal.pePremium) * lotSize;
  }

  // Charges (realistic Indian market)
  const turnover = signal.combinedPremium * lotSize + exitPremium * lotSize;
  let charges = 0;
  if (chargesMode === "realistic") {
    charges += turnover * 0.00003; // STT on options (0.003% both sides)
    charges += turnover * 0.0000345; // Exchange txn fee
    charges += turnover * 0.00002; // SEBI charge
    charges += turnover * 0.0018; // GST on charges
  } else {
    charges = turnover * 0.0005; // flat 0.05%
  }

  // Slippage
  let slippage = 0;
  if (slippageMode === "realistic") {
    slippage = signal.combinedPremium * lotSize * 0.005; // 0.5% slippage
  } else {
    slippage = signal.combinedPremium * lotSize * 0.002; // 0.2%
  }

  const netPnL = grossPnL - charges - slippage;
  const returnPct = signal.maxRisk > 0 ? (netPnL / (signal.maxRisk * lotSize)) * 100 : 0;

  return { grossPnL, charges, slippage, netPnL, returnPct };
}

// ─── Lot Size Helper ──────────────────────────────────────────────
export function getLotSize(symbol: string, date?: string): number {
  // Current lot sizes (update if SEBI changes)
  const lots: Record<string, number> = {
    NIFTY: 25,
    BANKNIFTY: 15,
    FINNIFTY: 40,
    MIDCPNIFTY: 50,
    SENSEX: 20,
  };
  return lots[symbol] || 25;
}

// ─── Data Quality ─────────────────────────────────────────────────
export function computeDataQuality(snap: MarketSnapshot): number {
  let score = 0;
  if (snap.spot > 0) score += 20;
  if (snap.casReferencePrice > 0) score += 20;
  if (snap.chain.length > 0) score += 20;
  if (snap.iv > 0) score += 15;
  if (snap.pcr > 0) score += 10;
  if (snap.candles && snap.candles.length > 0) score += 15;
  return score;
}
