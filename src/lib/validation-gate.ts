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
  spot: number
): ValidationCheck {
  const row = chain.find((s) => s.strike === strike);
  if (!row) {
    return {
      name: "entry_valid",
      passed: false,
      message: `Strike ${strike} not found in chain`,
    };
  }

  const isCall = strike >= spot;
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
      passed: true,
      message: `Entry ${entryPrice} accepted — bid/ask not available for range check`,
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
  spot: number
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
  if (!row?.ce) {
    return {
      name: "liquidity_sufficient",
      passed: false,
      message: `No CE data at ATM strike ${atmStrike}`,
    };
  }

  const oiOk = row.ce.oi > MIN_OI;
  const volOk = row.ce.volume > MIN_VOLUME;
  const passed = oiOk && volOk;
  return {
    name: "liquidity_sufficient",
    passed,
    message: passed
      ? `ATM ${atmStrike} — OI ${row.ce.oi}, volume ${row.ce.volume}`
      : `ATM ${atmStrike} liquidity low — OI ${row.ce.oi} (need >${MIN_OI}), volume ${row.ce.volume} (need >${MIN_VOLUME})`,
  };
}

function checkSpreadAcceptable(
  chain: SDMOptionStrike[],
  strike: number
): ValidationCheck {
  const row = chain.find((s) => s.strike === strike);
  if (!row) {
    return {
      name: "spread_acceptable",
      passed: false,
      message: `Strike ${strike} not found in chain`,
    };
  }

  const isCall = true;
  const leg = row.ce ?? row.pe;
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

// ─── Severity Classification ─────────────────────────────────────
// Hard failures → NO_TRADE, soft failures → WAIT

const HARD_CHECKS = new Set([
  "live_data_fresh",
  "greeks_updated",
  "oi_updated",
  "no_stale_ticks",
  "risk_caps",
  "data_integrity_healthy",
]);

const SOFT_CHECKS = new Set([
  "confidence",
  "entry_valid",
  "liquidity_sufficient",
  "spread_acceptable",
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
    checkEntryValid(input.optionChain, input.selectedStrike, input.entryPrice, input.spot),
    checkLiquidity(input.optionChain, input.spot),
    checkSpreadAcceptable(input.optionChain, input.selectedStrike),
    checkDataIntegrity(input.healthReport),
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
