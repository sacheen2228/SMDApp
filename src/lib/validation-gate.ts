// Validation Gate — Pre-trade safety checks
// All checks must pass before a BUY CALL / BUY PUT signal is displayed

import type { DataHealthReport } from "./data-health";
import type {
  SDMOptionStrike,
  TradeGrade,
  RiskState,
  ValidationInput,
  ValidationCheck,
  ValidationResult,
} from "../types/sdm";

// ─── Constants ───────────────────────────────────────────────────
const STALE_THRESHOLD_MS = 5000;
const MIN_OI = 50000;
const MIN_VOLUME = 10000;
const MAX_SPREAD_PCT = 5;
const MIN_HEALTH_PCT = 70;
const MIN_CONFIDENCE_SCORE = 65;
const MIN_VOLUME_RATIO = 1.5; // Require 1.5x average volume for high-prob trades
const MIN_MTF_AGREEMENT = 2; // At least 2 of 3 timeframes must agree
const GRADE_RANK: Record<TradeGrade, number> = {
  "A+": 5,
  A: 4,
  B: 3,
  C: 2,
  D: 1,
};

// ─── Individual Checks ───────────────────────────────────────────

function checkLiveDataFresh(health: DataHealthReport): ValidationCheck {
  const passed = health.status === "HEALTHY";
  return {
    name: "live_data_fresh",
    passed,
    message: passed
      ? `Data health: ${health.status}`
      : `Data health is ${health.status} (score ${health.score}) — not safe to trade`,
  };
}

function checkGreeksUpdated(
  chain: SDMOptionStrike[],
  strike: number
): ValidationCheck {
  const row = chain.find((s) => s.strike === strike);
  if (!row) {
    return {
      name: "greeks_updated",
      passed: false,
      message: `Strike ${strike} not found in option chain`,
    };
  }
  const hasCE = row.ce !== null;
  const hasPE = row.pe !== null;
  const passed = hasCE && hasPE;
  return {
    name: "greeks_updated",
    passed,
    message: passed
      ? `Greeks present for strike ${strike}`
      : `Greeks missing at strike ${strike} — CE: ${hasCE}, PE: ${hasPE}`,
  };
}

function checkOIUpdated(
  chain: SDMOptionStrike[],
  strike: number
): ValidationCheck {
  const row = chain.find((s) => s.strike === strike);
  if (!row) {
    return {
      name: "oi_updated",
      passed: false,
      message: `Strike ${strike} not found in option chain`,
    };
  }
  const ceOI = row.ce?.oi ?? 0;
  const peOI = row.pe?.oi ?? 0;
  const passed = ceOI > 0 && peOI > 0;
  return {
    name: "oi_updated",
    passed,
    message: passed
      ? `OI present — CE: ${ceOI}, PE: ${peOI}`
      : `OI data incomplete at strike ${strike}`,
  };
}

function checkNoStaleTicks(health: DataHealthReport): ValidationCheck {
  const passed = health.freshnessMs < STALE_THRESHOLD_MS;
  return {
    name: "no_stale_ticks",
    passed,
    message: passed
      ? `Data age: ${health.freshnessMs}ms`
      : `Last update ${health.freshnessMs}ms ago — exceeds ${STALE_THRESHOLD_MS}ms threshold`,
  };
}

function checkConfidence(
  grade: TradeGrade,
  score: number
): ValidationCheck {
  const gradeOk = GRADE_RANK[grade] >= GRADE_RANK["B"];
  const scoreOk = score >= MIN_CONFIDENCE_SCORE;
  const passed = gradeOk && scoreOk;
  return {
    name: "confidence",
    passed,
    message: passed
      ? `Grade ${grade} (${score}) meets threshold`
      : `Grade ${grade} (${score}) below minimum B / 65`,
  };
}

function checkRiskCaps(risk: RiskState): ValidationCheck {
  if (!risk.canTrade) {
    return {
      name: "risk_caps",
      passed: false,
      message: `Trading blocked: ${risk.blockReason ?? "unspecified"}`,
    };
  }
  const dailyBreached = risk.dailyPnL < -risk.maxDailyLoss;
  const weeklyBreached = risk.weeklyPnL < -risk.maxWeeklyLoss;
  const monthlyBreached = risk.monthlyPnL < -risk.maxMonthlyLoss;
  const posBreached = risk.openPositions >= risk.maxConcurrentTrades;

  const breaches: string[] = [];
  if (dailyBreached) breaches.push(`daily loss ${risk.dailyPnL} exceeds max ${risk.maxDailyLoss}`);
  if (weeklyBreached) breaches.push(`weekly loss ${risk.weeklyPnL} exceeds max ${risk.maxWeeklyLoss}`);
  if (monthlyBreached) breaches.push(`monthly loss ${risk.monthlyPnL} exceeds max ${risk.maxMonthlyLoss}`);
  if (posBreached) breaches.push(`open positions ${risk.openPositions} at max ${risk.maxConcurrentTrades}`);

  const passed = breaches.length === 0;
  return {
    name: "risk_caps",
    passed,
    message: passed
      ? `Risk within limits — daily ${risk.dailyPnL}, weekly ${risk.weeklyPnL}, monthly ${risk.monthlyPnL}`
      : breaches.join("; "),
  };
}

function checkEntryValid(
  chain: SDMOptionStrike[],
  strike: number,
  entryPrice: number,
  spot: number,
  direction?: 'CALL' | 'PUT'
): ValidationCheck {
  // Minimum premium threshold — entries below this are stale/closing data, not tradeable
  const MIN_PREMIUM = 5;

  if (entryPrice > 0 && entryPrice < MIN_PREMIUM) {
    return {
      name: "entry_valid",
      passed: false,
      message: `Entry ₹${entryPrice} below minimum ₹${MIN_PREMIUM} — likely stale closing data`,
    };
  }

  const row = chain.find((s) => s.strike === strike);
  if (!row) {
    return {
      name: "entry_valid",
      passed: false,
      message: `Strike ${strike} not found in chain`,
    };
  }

  const isCall = direction ? direction === 'CALL' : strike >= spot;
  const leg = isCall ? row.ce : row.pe;
  if (!leg) {
    return {
      name: "entry_valid",
      passed: false,
      message: `${isCall ? "CE" : "PE"} leg missing at strike ${strike}`,
    };
  }

  const hasBidAsk = leg.bid !== undefined && leg.ask !== undefined && leg.bid > 0 && leg.ask > 0;
  if (!hasBidAsk) {
    return {
      name: "entry_valid",
      passed: entryPrice >= MIN_PREMIUM,
      message: entryPrice >= MIN_PREMIUM
        ? `Entry ${entryPrice} accepted — bid/ask not available for range check`
        : `Entry ₹${entryPrice} below minimum ₹${MIN_PREMIUM}`,
    };
  }

  const inRange = entryPrice >= leg.bid! && entryPrice <= leg.ask!;
  return {
    name: "entry_valid",
    passed: inRange,
    message: inRange
      ? `Entry ${entryPrice} within bid/ask [${leg.bid}–${leg.ask}]`
      : `Entry ${entryPrice} outside bid/ask range [${leg.bid}–${leg.ask}]`,
  };
}

function checkLiquidity(
  chain: SDMOptionStrike[],
  spot: number,
  direction?: 'CALL' | 'PUT'
): ValidationCheck {
  let atmStrike = chain[0]?.strike ?? 0;
  let minDist = Infinity;
  for (const s of chain) {
    const d = Math.abs(s.strike - spot);
    if (d < minDist) {
      minDist = d;
      atmStrike = s.strike;
    }
  }

  const row = chain.find((s) => s.strike === atmStrike);
  const isCall = direction ? direction === 'CALL' : true;
  const leg = isCall ? row?.ce : row?.pe;
  if (!leg) {
    return {
      name: "liquidity_sufficient",
      passed: false,
      message: `No ${isCall ? "CE" : "PE"} data at ATM strike ${atmStrike}`,
    };
  }

  const oiOk = leg.oi > MIN_OI;
  const volOk = leg.volume > MIN_VOLUME;
  const passed = oiOk && volOk;
  return {
    name: "liquidity_sufficient",
    passed,
    message: passed
      ? `ATM ${atmStrike} ${isCall ? "CE" : "PE"} — OI ${leg.oi}, volume ${leg.volume}`
      : `ATM ${atmStrike} ${isCall ? "CE" : "PE"} liquidity low — OI ${leg.oi} (need >${MIN_OI}), volume ${leg.volume} (need >${MIN_VOLUME})`,
  };
}

function checkSpreadAcceptable(
  chain: SDMOptionStrike[],
  strike: number,
  direction?: 'CALL' | 'PUT'
): ValidationCheck {
  const row = chain.find((s) => s.strike === strike);
  if (!row) {
    return {
      name: "spread_acceptable",
      passed: false,
      message: `Strike ${strike} not found in chain`,
    };
  }

  const isCall = direction ? direction === 'CALL' : true;
  const leg = isCall ? (row.ce ?? row.pe) : (row.pe ?? row.ce);
  if (!leg) {
    return {
      name: "spread_acceptable",
      passed: false,
      message: `No leg data at strike ${strike}`,
    };
  }

  if (leg.bid === undefined || leg.ask === undefined || leg.bid <= 0 || leg.ask <= 0) {
    return {
      name: "spread_acceptable",
      passed: true,
      message: "Bid/ask not available — spread check skipped",
    };
  }

  const mid = (leg.bid + leg.ask) / 2;
  if (mid === 0) {
    return {
      name: "spread_acceptable",
      passed: false,
      message: "Mid price is zero — cannot evaluate spread",
    };
  }

  const spreadPct = ((leg.ask - leg.bid) / mid) * 100;
  const passed = spreadPct <= MAX_SPREAD_PCT;
  return {
    name: "spread_acceptable",
    passed,
    message: passed
      ? `Spread ${spreadPct.toFixed(2)}% (bid ${leg.bid} / ask ${leg.ask})`
      : `Spread ${spreadPct.toFixed(2)}% exceeds ${MAX_SPREAD_PCT}% limit`,
  };
}

function checkDataIntegrity(health: DataHealthReport): ValidationCheck {
  const passed = health.score >= MIN_HEALTH_PCT;
  return {
    name: "data_integrity_healthy",
    passed,
    message: passed
      ? `Health score ${health.score}% meets ${MIN_HEALTH_PCT}% minimum`
      : `Health score ${health.score}% below ${MIN_HEALTH_PCT}% threshold`,
  };
}

// ── NEW: Multi-Timeframe Confirmation ──
function checkMultiTimeframe(
  mtfResult?: { bias: string; tf: string }[] | null,
  direction?: 'CALL' | 'PUT'
): ValidationCheck {
  if (!mtfResult || mtfResult.length === 0) {
    return {
      name: "multi_timeframe",
      passed: true,
      message: "Multi-timeframe data not available — check skipped",
    };
  }

  const dirLabel = direction === 'CALL' ? 'BULLISH' : direction === 'PUT' ? 'BEARISH' : 'BULLISH';
  const agreeing = mtfResult.filter((tf) => tf.bias === dirLabel || tf.bias === 'NEUTRAL').length;
  const passed = agreeing >= MIN_MTF_AGREEMENT;

  return {
    name: "multi_timeframe",
    passed,
    message: passed
      ? `${agreeing}/${mtfResult.length} timeframes agree (${dirLabel})`
      : `Only ${agreeing}/${mtfResult.length} timeframes agree — need ${MIN_MTF_AGREEMENT}+ for high-probability trade`,
  };
}

// ── NEW: Volume Confirmation ──
function checkVolumeConfirmation(
  chain: SDMOptionStrike[],
  strike: number,
  direction?: 'CALL' | 'PUT'
): ValidationCheck {
  const row = chain.find((s) => s.strike === strike);
  if (!row) {
    return {
      name: "volume_confirmation",
      passed: false,
      message: `Strike ${strike} not found in chain`,
    };
  }

  const isCall = direction ? direction === 'CALL' : true;
  const leg = isCall ? row.ce : row.pe;
  if (!leg) {
    return {
      name: "volume_confirmation",
      passed: false,
      message: `No ${isCall ? "CE" : "PE"} data at strike ${strike}`,
    };
  }

  // Volume ratio: current volume vs OI (proxy for average activity)
  const volume = leg.volume || 0;
  const oi = leg.oi || 0;
  const avgActivity = oi > 0 ? oi / 20 : 0; // rough daily average from total OI
  const volumeRatio = avgActivity > 0 ? volume / avgActivity : 1;
  const passed = volumeRatio >= MIN_VOLUME_RATIO || volume >= MIN_VOLUME;

  return {
    name: "volume_confirmation",
    passed,
    message: passed
      ? `Volume ${volume.toLocaleString()} (ratio ${volumeRatio.toFixed(1)}x) — confirmed`
      : `Volume ${volume.toLocaleString()} (ratio ${volumeRatio.toFixed(1)}x) — need ${MIN_VOLUME_RATIO}x average or ${MIN_VOLUME}+ for high-probability entry`,
  };
}

// ── NEW: News Sentiment Gate ──
function checkNewsSentiment(
  newsSentiment?: { score: number } | null,
  direction?: 'CALL' | 'PUT'
): ValidationCheck {
  if (!newsSentiment || newsSentiment.score === undefined) {
    return {
      name: "news_sentiment",
      passed: true,
      message: "News sentiment not available — check skipped",
    };
  }

  const score = newsSentiment.score; // -100 to +100
  const isBullish = direction === 'CALL';
  const isBearish = direction === 'PUT';

  // Strong opposite sentiment is a red flag
  const strongOpposite = (isBullish && score < -50) || (isBearish && score > 50);
  const moderateOpposite = (isBullish && score < -25) || (isBearish && score > 25);

  const passed = !strongOpposite;
  return {
    name: "news_sentiment",
    passed,
    message: passed
      ? `News sentiment: ${score > 0 ? '+' : ''}${score} ${moderateOpposite ? '(caution: moderate opposite sentiment)' : '(favorable)'}`
      : `News sentiment BLOCKED: ${score > 0 ? '+' : ''}${score} — strong ${isBullish ? 'bearish' : 'bullish'} sentiment opposes ${isBullish ? 'CALL' : 'PUT'} trade`,
  };
}

// ─── Severity Classification ─────────────────────────────────────
// Hard failures → NO_TRADE, soft failures → WAIT

const HARD_CHECKS = new Set([
  "live_data_fresh",
  "greeks_updated",
  "oi_updated",
  "no_stale_ticks",
  "risk_caps",
  "data_integrity_healthy",
  "news_sentiment",
]);

const SOFT_CHECKS = new Set([
  "confidence",
  "entry_valid",
  "liquidity_sufficient",
  "spread_acceptable",
  "multi_timeframe",
  "volume_confirmation",
]);

// ─── Main Gate ───────────────────────────────────────────────────

export function validateTrade(input: ValidationInput): ValidationResult {
  const checks: ValidationCheck[] = [
    checkLiveDataFresh(input.healthReport),
    checkGreeksUpdated(input.optionChain, input.selectedStrike),
    checkOIUpdated(input.optionChain, input.selectedStrike),
    checkNoStaleTicks(input.healthReport),
    checkConfidence(input.qualityGrade, input.qualityScore),
    checkRiskCaps(input.riskState),
    checkEntryValid(input.optionChain, input.selectedStrike, input.entryPrice, input.spot, input.direction),
    checkLiquidity(input.optionChain, input.spot, input.direction),
    checkSpreadAcceptable(input.optionChain, input.selectedStrike, input.direction),
    checkDataIntegrity(input.healthReport),
    // NEW: High-probability filters
    checkMultiTimeframe(input.mtfResult, input.direction),
    checkVolumeConfirmation(input.optionChain, input.selectedStrike, input.direction),
    checkNewsSentiment(input.newsSentiment, input.direction),
  ];

  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    return { passed: true, failedChecks: [], action: "PROCEED", reason: "All checks passed" };
  }

  const hardFailed = failed.some((c) => HARD_CHECKS.has(c.name));
  const softFailed = failed.some((c) => SOFT_CHECKS.has(c.name));

  let action: ValidationResult["action"];
  let reason: string;

  if (hardFailed) {
    action = "NO_TRADE";
    reason = failed
      .filter((c) => HARD_CHECKS.has(c.name))
      .map((c) => `${c.name}: ${c.message}`)
      .join("; ");
  } else {
    action = "WAIT";
    reason = failed
      .filter((c) => SOFT_CHECKS.has(c.name))
      .map((c) => `${c.name}: ${c.message}`)
      .join("; ");
  }

  return { passed: false, failedChecks: failed, action, reason };
}

// ─── Training-Enhanced Validation ────────────────────────────────
// Uses learned data to adjust confidence thresholds and provide regime-aware validation

export interface TrainingEnhancedResult extends ValidationResult {
  regime?: string;
  adjustedConfidence?: number;
  regimeAdjustments?: string[];
  learnedInsights?: string[];
}

export function validateTradeWithTraining(
  input: ValidationInput,
  regime?: string,
  factors?: Record<string, number>
): TrainingEnhancedResult {
  // Run standard validation first
  const baseResult = validateTrade(input);

  // Try to apply training enhancements
  try {
    // Dynamic import to avoid circular dependencies
    const { adjustConfidence } = require("./training/confidence-calibrator");
    const { adaptScoreForRegime, getRegimeWeights } = require("./training/regime-learner");

    const result: TrainingEnhancedResult = { ...baseResult, regime };
    const learnedInsights: string[] = [];

    // Adjust confidence based on calibration data
    if (input.qualityScore) {
      const adjusted = adjustConfidence(input.qualityScore, regime);
      result.adjustedConfidence = adjusted;
      if (adjusted !== input.qualityScore) {
        learnedInsights.push(`Confidence adjusted: ${input.qualityScore} → ${adjusted} (calibration)`);
      }
    }

    // Apply regime-specific adaptations
    if (regime && factors) {
      const adaptation = adaptScoreForRegime(input.qualityScore || 0, regime, factors);
      result.regimeAdjustments = adaptation.adjustments;
      if (adaptation.adjustments.length > 0) {
        learnedInsights.push(`Regime ${regime}: applied ${adaptation.adjustments.length} factor adjustments`);
      }
    }

    // Check regime-specific confidence threshold
    if (regime) {
      const regimeWeights = getRegimeWeights(regime);
      if (regimeWeights.confidenceMultiplier !== 1.0) {
        learnedInsights.push(`Regime ${regime}: confidence multiplier ${regimeWeights.confidenceMultiplier}`);
      }
    }

    result.learnedInsights = learnedInsights;
    return result;
  } catch {
    // Training module not available — return base result
    return baseResult;
  }
}
