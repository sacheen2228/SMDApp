// Hermes Trade Validator — 15-step validation pipeline
// Any CRITICAL failure = NO TRADE.

import type {
  HermesContext, TradeCandidate, ValidationResult
} from "./types";
import { isTradeAllowed, getCurrentSession } from "../market-session";

// ── Validation Pipeline ────────────────────────────────────────────────

export function validateTrade(
  ctx: HermesContext,
  candidate: TradeCandidate
): ValidationResult[] {
  const results: ValidationResult[] = [];

  results.push(checkDataAvailability(ctx));
  results.push(checkDataFreshness(ctx));
  results.push(checkMarketStatus(ctx));
  results.push(checkValidSpot(ctx));
  results.push(checkValidOptionChain(ctx));
  results.push(checkValidExpiry(ctx));
  results.push(checkValidStrike(ctx, candidate));
  results.push(checkValidPremium(ctx));
  results.push(checkValidCandidateLiquidity(ctx, candidate));
  results.push(checkValidCandidateOI(ctx, candidate));
  results.push(checkValidCandidateGreeks(ctx, candidate));
  results.push(checkValidBidAskSpread(ctx, candidate));
  results.push(checkStructureConfirmation(ctx, candidate));
  results.push(checkRiskReward(candidate));
  results.push(checkSessionAllowed(ctx, candidate));
  results.push(checkPositionSize(ctx, candidate));

  return results;
}

export function isTradeValid(results: ValidationResult[]): {
  valid: boolean;
  failures: string[];
  warnings: string[];
} {
  const failures = results.filter(r => !r.passed && r.severity === "CRITICAL").map(r => `${r.step}: ${r.reason}`);
  const warnings = results.filter(r => !r.passed && r.severity === "WARNING").map(r => `${r.step}: ${r.reason}`);

  return {
    valid: failures.length === 0,
    failures,
    warnings,
  };
}

// ── Individual Validation Steps ────────────────────────────────────────

function checkDataAvailability(ctx: HermesContext): ValidationResult {
  const spot = ctx.spot.value?.price || 0;
  const chain = ctx.optionChain.value;

  if (spot <= 0 && !chain) {
    return { step: "DATA_CHECK", passed: false, reason: "No spot or option chain data available", severity: "CRITICAL" };
  }
  if (spot <= 0) {
    return { step: "DATA_CHECK", passed: false, reason: "Spot price unavailable", severity: "CRITICAL" };
  }
  return { step: "DATA_CHECK", passed: true, reason: "Data available", severity: "CRITICAL" };
}

function checkDataFreshness(ctx: HermesContext): ValidationResult {
  const spotFresh = ctx.spot.freshness;
  const chainFresh = ctx.optionChain.freshness;

  if (spotFresh === "UNAVAILABLE") {
    return { step: "FRESHNESS_CHECK", passed: false, reason: "Spot data unavailable", severity: "CRITICAL" };
  }
  if (spotFresh === "STALE" || chainFresh === "STALE") {
    return { step: "FRESHNESS_CHECK", passed: false, reason: "Market data is stale", severity: "CRITICAL" };
  }
  if (ctx.spot.delayed || ctx.optionChain.delayed) {
    return { step: "FRESHNESS_CHECK", passed: false, reason: "Data is delayed — research only", severity: "CRITICAL" };
  }
  return { step: "FRESHNESS_CHECK", passed: true, reason: "Data freshness acceptable", severity: "CRITICAL" };
}

function checkMarketStatus(ctx: HermesContext): ValidationResult {
  if (ctx.marketStatus === "WEEKEND") {
    return { step: "MARKET_STATUS", passed: false, reason: "Market closed (weekend)", severity: "CRITICAL" };
  }
  if (ctx.marketStatus === "MARKET_CLOSED" && ctx.exchange === "NSE") {
    return { step: "MARKET_STATUS", passed: false, reason: "NSE market closed", severity: "CRITICAL" };
  }
  if (ctx.marketStatus === "PRE_MARKET") {
    return { step: "MARKET_STATUS", passed: true, reason: "Pre-market — data may be limited", severity: "WARNING" };
  }
  return { step: "MARKET_STATUS", passed: true, reason: "Market open", severity: "CRITICAL" };
}

function checkValidSpot(ctx: HermesContext): ValidationResult {
  const spot = ctx.spot.value?.price || 0;
  if (spot <= 0) {
    return { step: "VALID_SPOT", passed: false, reason: "Invalid spot price", severity: "CRITICAL" };
  }
  if (spot > 100000) {
    return { step: "VALID_SPOT", passed: false, reason: "Spot price abnormally high", severity: "WARNING" };
  }
  return { step: "VALID_SPOT", passed: true, reason: `Spot ₹${spot.toLocaleString("en-IN")}`, severity: "CRITICAL" };
}

function checkValidOptionChain(ctx: HermesContext): ValidationResult {
  const chain = ctx.optionChain.value;
  if (!chain) {
    return { step: "VALID_OPTION_CHAIN", passed: false, reason: "No option chain data", severity: "CRITICAL" };
  }
  if (!chain.strikes || chain.strikes.length === 0) {
    return { step: "VALID_OPTION_CHAIN", passed: false, reason: "Empty option chain", severity: "CRITICAL" };
  }
  return { step: "VALID_OPTION_CHAIN", passed: true, reason: `${chain.strikes.length} strikes available`, severity: "CRITICAL" };
}

function checkValidExpiry(ctx: HermesContext): ValidationResult {
  const chain = ctx.optionChain.value;
  if (!chain?.expiry) {
    return { step: "VALID_EXPIRY", passed: false, reason: "No expiry data", severity: "CRITICAL" };
  }
  if (chain.daysToExpiry < 0) {
    return { step: "VALID_EXPIRY", passed: false, reason: "Expiry already passed", severity: "CRITICAL" };
  }
  if (chain.daysToExpiry === 0) {
    return { step: "VALID_EXPIRY", passed: true, reason: "Expiry day — Zero Hero eligible", severity: "WARNING" };
  }
  return { step: "VALID_EXPIRY", passed: true, reason: `Expiry: ${chain.expiry} (${chain.daysToExpiry} days)`, severity: "CRITICAL" };
}

function checkValidStrike(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  const chain = ctx.optionChain.value;
  if (!chain?.strikes) {
    return { step: "VALID_STRIKE", passed: false, reason: "No option chain for strike validation", severity: "CRITICAL" };
  }
  const strike = chain.strikes.find(s => s.strike === candidate.strike);
  if (!strike) {
    return { step: "VALID_STRIKE", passed: false, reason: `Strike ${candidate.strike} not found in chain`, severity: "CRITICAL" };
  }
  const side = candidate.optionSide === "CE" ? strike.ce : strike.pe;
  if (!side) {
    return { step: "VALID_STRIKE", passed: false, reason: `No ${candidate.optionSide} data at strike ${candidate.strike}`, severity: "CRITICAL" };
  }
  if (!side.ltp || side.ltp <= 0) {
    return { step: "VALID_STRIKE", passed: false, reason: `Invalid premium at strike ${candidate.strike}`, severity: "CRITICAL" };
  }
  return { step: "VALID_STRIKE", passed: true, reason: `Strike ${candidate.strike} ${candidate.optionSide} ₹${side.ltp}`, severity: "CRITICAL" };
}

function checkValidPremium(ctx: HermesContext): ValidationResult {
  const chain = ctx.optionChain.value;
  if (!chain?.strikes) {
    return { step: "VALID_PREMIUM", passed: false, reason: "No strikes for premium check", severity: "CRITICAL" };
  }
  // Check if any option has a valid premium
  const hasValidPremium = chain.strikes.some(s => s.ce?.ltp > 0 || s.pe?.ltp > 0);
  if (!hasValidPremium) {
    return { step: "VALID_PREMIUM", passed: false, reason: "No valid premiums found", severity: "CRITICAL" };
  }
  return { step: "VALID_PREMIUM", passed: true, reason: "Premiums available", severity: "CRITICAL" };
}

function checkValidCandidateLiquidity(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  const chain = ctx.optionChain.value;
  if (!chain?.strikes) {
    return { step: "VALID_LIQUIDITY", passed: false, reason: "No strikes for liquidity check", severity: "CRITICAL" };
  }
  const strike = chain.strikes.find(s => s.strike === candidate.strike);
  const side = strike?.[candidate.optionSide === "CE" ? "ce" : "pe"];
  const vol = side?.volume || 0;
  if (vol === 0) {
    return { step: "VALID_LIQUIDITY", passed: false, reason: `Zero volume at candidate strike ${candidate.strike}`, severity: "CRITICAL" };
  }
  if (vol < 100) {
    return { step: "VALID_LIQUIDITY", passed: false, reason: `Low volume (${vol}) at candidate strike ${candidate.strike}`, severity: "WARNING" };
  }
  return { step: "VALID_LIQUIDITY", passed: true, reason: `Volume ${vol.toLocaleString()} at strike ${candidate.strike}`, severity: "CRITICAL" };
}

function checkValidCandidateOI(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  const chain = ctx.optionChain.value;
  if (!chain?.strikes) {
    return { step: "VALID_OI", passed: false, reason: "No strikes for OI check", severity: "CRITICAL" };
  }
  const strike = chain.strikes.find(s => s.strike === candidate.strike);
  const side = strike?.[candidate.optionSide === "CE" ? "ce" : "pe"];
  const oi = side?.oi || 0;
  if (oi === 0) {
    return { step: "VALID_OI", passed: false, reason: `Zero OI at candidate strike ${candidate.strike}`, severity: "WARNING" };
  }
  return { step: "VALID_OI", passed: true, reason: `OI ${oi.toLocaleString()} at strike ${candidate.strike}`, severity: "CRITICAL" };
}

function checkValidCandidateGreeks(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  const greeks = candidate.greeks;
  if (!greeks) {
    return { step: "VALID_GREEKS", passed: false, reason: "No Greeks on candidate", severity: "WARNING" };
  }
  if (greeks.delta === 0 && greeks.gamma === 0 && greeks.theta === 0) {
    return { step: "VALID_GREEKS", passed: false, reason: "Candidate Greeks all zero", severity: "WARNING" };
  }
  return { step: "VALID_GREEKS", passed: true, reason: `Δ${greeks.delta.toFixed(2)} Γ${greeks.gamma.toFixed(3)} Θ${greeks.theta.toFixed(2)}`, severity: "WARNING" };
}

function checkValidBidAskSpread(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  const chain = ctx.optionChain.value;
  if (!chain?.strikes) {
    return { step: "BID_ASK_SPREAD", passed: true, reason: "No chain data for spread check", severity: "WARNING" };
  }
  const strike = chain.strikes.find(s => s.strike === candidate.strike);
  const side = strike?.[candidate.optionSide === "CE" ? "ce" : "pe"];
  if (!side) {
    return { step: "BID_ASK_SPREAD", passed: true, reason: "No side data for spread check", severity: "WARNING" };
  }
  const bid = side.bid || 0;
  const ask = side.ask || 0;
  const ltp = side.ltp || 0;
  if (bid > 0 && ask > 0) {
    const spreadPct = ((ask - bid) / ltp) * 100;
    if (spreadPct > 10) {
      return { step: "BID_ASK_SPREAD", passed: false, reason: `Spread ${spreadPct.toFixed(1)}% exceeds 10%`, severity: "CRITICAL" };
    }
    if (spreadPct > 5) {
      return { step: "BID_ASK_SPREAD", passed: false, reason: `Spread ${spreadPct.toFixed(1)}% exceeds 5%`, severity: "WARNING" };
    }
    return { step: "BID_ASK_SPREAD", passed: true, reason: `Spread ${spreadPct.toFixed(1)}%`, severity: "CRITICAL" };
  }
  return { step: "BID_ASK_SPREAD", passed: true, reason: "Bid/ask data unavailable — proceeding", severity: "WARNING" };
}

function checkStructureConfirmation(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  const structure = ctx.marketStructure.value;
  if (!structure) {
    return { step: "STRUCTURE_CHECK", passed: true, reason: "No structure data — proceeding without", severity: "WARNING" };
  }

  const trend = structure.trend;
  const direction = candidate.direction;

  if (direction === "BULLISH" && trend === "DOWN") {
    return { step: "STRUCTURE_CHECK", passed: false, reason: "Bullish request but bearish structure", severity: "WARNING" };
  }
  if (direction === "BEARISH" && trend === "UP") {
    return { step: "STRUCTURE_CHECK", passed: false, reason: "Bearish request but bullish structure", severity: "WARNING" };
  }
  return { step: "STRUCTURE_CHECK", passed: true, reason: `Structure ${trend} aligns with ${direction}`, severity: "CRITICAL" };
}

function checkRiskReward(candidate: TradeCandidate): ValidationResult {
  const rr = candidate.riskReward;
  if (rr <= 0) {
    return { step: "RISK_REWARD", passed: false, reason: "Invalid risk/reward ratio", severity: "CRITICAL" };
  }
  if (rr < 1.5) {
    return { step: "RISK_REWARD", passed: false, reason: `RR ${rr.toFixed(1)}:1 below minimum 1.5:1`, severity: "CRITICAL" };
  }
  return { step: "RISK_REWARD", passed: true, reason: `RR ${rr.toFixed(1)}:1`, severity: "CRITICAL" };
}

function checkSessionAllowed(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  const session = getCurrentSession();
  const direction = candidate.direction === "BULLISH" ? "CALL" : "PUT";
  const check = isTradeAllowed(direction);

  if (!check.allowed) {
    return { step: "SESSION_CHECK", passed: false, reason: check.reason, severity: "CRITICAL" };
  }
  return { step: "SESSION_CHECK", passed: true, reason: `Session: ${session.label}`, severity: "CRITICAL" };
}

function checkPositionSize(ctx: HermesContext, candidate: TradeCandidate): ValidationResult {
  if (candidate.quantity <= 0) {
    return { step: "POSITION_SIZE", passed: false, reason: "Invalid position size", severity: "CRITICAL" };
  }
  if (candidate.riskAmount <= 0) {
    return { step: "POSITION_SIZE", passed: false, reason: "Invalid risk amount", severity: "CRITICAL" };
  }
  return { step: "POSITION_SIZE", passed: true, reason: `Qty: ${candidate.quantity}, Risk: ₹${candidate.riskAmount.toLocaleString("en-IN")}`, severity: "CRITICAL" };
}
