// Strike Expiry-Risk Engine — Strict Protection Mode
// Operates in two modes: "ordinary" and "zero_hero"
// Fail-closed on every gate; live data only; no fallback simulation.
//
// System Prompt: SMDApp Strike Expiry-Risk Engine operating in Strict Protection Mode.
// Single objective: select only those option strikes whose calibrated probability
// of expiring worthless (premium → 0) is kept below a hard risk budget.
// Prioritize ATM and slightly ITM strikes. Reject every strike that fails any gate.
// Fail closed on data or model problems.
// Ordinary and Zero Hero trades share the same mathematical framework but use
// different numerical thresholds.

import { normalCDF } from './greeks';
import { getRiskFreeRate } from './greeks';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface StrikeInput {
  strike: number;
  optionType: "CE" | "PE";
  bid: number;
  ask: number;
  mid: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  openInterest: number;
  volume: number;
  lotSize: number;
  multiplier: number;
  expiryDateTime: Date;
  underlyingSpot: number;
  underlyingTimestamp: Date;
  chainTimestamp: Date;
}

export interface GateResult {
  passed: boolean;
  reason: string;
  rejectCode: "DATA_INTEGRITY" | "STRIKE_DISTANCE" | "DELTA_BAND" | "PROBABILITY" | "TIME_EXPIRY" | "NONE";
}

export interface StrikeAnalysis {
  strike: number;
  optionType: "CE" | "PE";
  d: number;
  absDelta: number;
  P_ITM: number;
  risk: number;
  designedPNotZero: number;
  mid: number;
  spreadRatio: number;
  expectedMove: number;
  tauDays: number;
  gateResults: GateResult[];
  status: "TRADE" | "NO_TRADE" | "EXIT";
  strategy: "ordinary" | "zero_hero";
}

// Engine output lives at a higher level; StrikeAnalysis has no top-level reason.
export interface EngineOutput {
  status: "TRADE" | "NO_TRADE" | "EXIT";
  reason: string;
  strategy: "ordinary" | "zero_hero";
  minDesignedPNotZero: number;
  selectedStrikes: StrikeAnalysis[];
  timestamp: string;
}

// ──────────────────────────────────────────────────────────────
// Gate 0 — Data Integrity
// ──────────────────────────────────────────────────────────────

function gate0(input: StrikeInput): GateResult {
  const ageSec = Math.max(0, (Date.now() - input.underlyingTimestamp.getTime()) / 1000);
  if (ageSec > 3) {
    return { passed: false, reason: `Quote age ${ageSec.toFixed(1)}s > 3s`, rejectCode: "DATA_INTEGRITY" };
  }

  const requiredFields = [input.bid, input.ask, input.mid, Math.abs(input.delta), input.gamma, Math.abs(input.theta), input.vega, input.iv, input.openInterest, input.volume];
  for (const f of requiredFields) {
    if (!Number.isFinite(f)) {
      return { passed: false, reason: "Non-finite field value", rejectCode: "DATA_INTEGRITY" };
    }
  }

  if (input.bid <= 0 || input.ask <= 0) {
    return { passed: false, reason: `bid=${input.bid} ≤ 0 or ask=${input.ask} ≤ 0`, rejectCode: "DATA_INTEGRITY" };
  }

  const spreadRatio = (input.ask - input.bid) / input.mid;
  if (spreadRatio > 0.08) {
    return { passed: false, reason: `spread_ratio ${spreadRatio.toFixed(4)} > 0.08`, rejectCode: "DATA_INTEGRITY" };
  }

  if (input.lotSize <= 0 || input.multiplier <= 0) {
    return { passed: false, reason: `lotSize=${input.lotSize} ≤ 0 or multiplier=${input.multiplier} ≤ 0`, rejectCode: "DATA_INTEGRITY" };
  }

  const now = new Date();
  const diffDays = Math.ceil((input.expiryDateTime.getTime() - now.getTime()) / (86_400_000));
  if (diffDays < 0 || diffDays > 3) {
    return { passed: false, reason: `Expiry diff ${diffDays}d does not match intended expiry day`, rejectCode: "DATA_INTEGRITY" };
  }

  const tsDiffSec = Math.abs((input.underlyingTimestamp.getTime() - input.chainTimestamp.getTime()) / 1000);
  if (tsDiffSec > 1) {
    return { passed: false, reason: `Timestamp diff ${tsDiffSec}s > 1s`, rejectCode: "DATA_INTEGRITY" };
  }

  return { passed: true, reason: "OK", rejectCode: "NONE" };
}

// ──────────────────────────────────────────────────────────────
// Gate 1 — Strike Distance
// ──────────────────────────────────────────────────────────────

function gate1(input: StrikeInput, strategy: "ordinary" | "zero_hero"): GateResult {
  const S = input.underlyingSpot;
  const K = input.strike;
  let d: number;

  if (input.optionType === "CE") {
    d = (S - K) / S;
  } else {
    d = (K - S) / S;
  }

  const ordinaryAccept = d >= -0.005 && d <= 0.015;
  const zeroHeroAccept = d >= -0.010 && d <= 0.010;

  if (strategy === "ordinary") {
    if (!ordinaryAccept) {
      return { passed: false, reason: `Strike distance d=${d.toFixed(4)} outside ordinary band [−0.005, 0.015]`, rejectCode: "STRIKE_DISTANCE" };
    }
  } else {
    if (!zeroHeroAccept) {
      return { passed: false, reason: `Strike distance d=${d.toFixed(4)} outside zero_hero band [−0.010, 0.010]`, rejectCode: "STRIKE_DISTANCE" };
    }
  }

  return { passed: true, reason: "OK", rejectCode: "NONE" };
}

// ──────────────────────────────────────────────────────────────
// Gate 2 — Delta Band + Calibrated Probability
// ──────────────────────────────────────────────────────────────

function gate2(input: StrikeInput, strategy: "ordinary" | "zero_hero", riskBudget: number): GateResult {
  const absDelta = Math.abs(input.delta);

  const deltaOK = strategy === "ordinary"
    ? absDelta >= 0.55 && absDelta <= 0.70
    : absDelta >= 0.60 && absDelta <= 0.75;

  if (!deltaOK) {
    return { passed: false, reason: `|Δ|=${absDelta.toFixed(2)} outside ${strategy} band`, rejectCode: "DELTA_BAND" };
  }

  const S = input.underlyingSpot;
  const K = input.strike;
  const sigma = input.iv;
  const r = getRiskFreeRate();
  const q = 0.07;

  const now = new Date();
  const tauSec = Math.max(input.expiryDateTime.getTime() - now.getTime(), 1);
  const tau = Math.max(tauSec / (365.25 * 24 * 3600), 1e-8);

  const logSK = Math.log(S / K);
  const d1 = (logSK + (r - q + sigma * sigma / 2) * tau) / (sigma * Math.sqrt(tau));
  const d2 = d1 - sigma * Math.sqrt(tau);

  const P_ITM = input.optionType === "CE" ? normalCDF(d2) : normalCDF(-d2);
  const risk = 1 - P_ITM;
  const designedPNotZero = strategy === "ordinary" ? 0.65 : 0.75;

  if (risk > riskBudget) {
    return { passed: false, reason: `Risk ${risk.toFixed(4)} > budget ${riskBudget.toFixed(2)}`, rejectCode: "PROBABILITY" };
  }

  return { passed: true, reason: "OK", rejectCode: "NONE" };
}

// ──────────────────────────────────────────────────────────────
// Gate 3 — Time-to-Expiry & Expected Move
// ──────────────────────────────────────────────────────────────

function gate3(input: StrikeInput, strategy: "ordinary" | "zero_hero", gate2Result: GateResult): GateResult {
  const S = input.underlyingSpot;
  const K = input.strike;
  const sigma = input.iv;

  const now = new Date();
  const tauSec = Math.max(input.expiryDateTime.getTime() - now.getTime(), 1);
  const tau = Math.max(tauSec / (365.25 * 24 * 3600), 1e-8);

  const tauThreshold = 0.4 / 365;

  if (tau >= tauThreshold) {
    return { passed: true, reason: "OK (τ sufficient)", rejectCode: "NONE" };
  }

  // τ < 0.4/365
  let d: number;
  if (input.optionType === "CE") {
    d = (S - K) / S;
  } else {
    d = (K - S) / S;
  }

  const absDeltaK = Math.abs(S - K);
  const requiredMove = absDeltaK * 1.2;
  const expectedMove = S * sigma * Math.sqrt(tau);

  if (expectedMove < requiredMove) {
    if (strategy === "ordinary") {
      return { passed: false, reason: `Expected move ${expectedMove.toFixed(2)} < required ${requiredMove.toFixed(2)}`, rejectCode: "TIME_EXPIRY" };
    } else {
      const deltaOK = input.delta >= 0.60 && input.delta <= 0.75;
      const distanceInside = d >= -0.010 && d <= 0.010;
      if (deltaOK && distanceInside) {
        return { passed: true, reason: "zero_hero exception: |Δ|≥0.65 + distance inside band", rejectCode: "NONE" };
      } else {
        return { passed: false, reason: "Expected move too small, zero_hero conditions not met", rejectCode: "TIME_EXPIRY" };
      }
    }
  }

  return { passed: true, reason: "OK", rejectCode: "NONE" };
}

// ──────────────────────────────────────────────────────────────
// Core: analyze one strike
// ──────────────────────────────────────────────────────────────

function analyzeStrike(input: StrikeInput, strategy: "ordinary" | "zero_hero"): StrikeAnalysis {
  const gate0Result = gate0(input);
  if (!gate0Result.passed) {
    return {
      strike: input.strike,
      optionType: input.optionType,
      d: 0,
      absDelta: Math.abs(input.delta),
      P_ITM: 0,
      risk: 1,
      designedPNotZero: strategy === "ordinary" ? 0.65 : 0.75,
      mid: input.mid,
      spreadRatio: (input.ask - input.bid) / input.mid,
      expectedMove: 0,
      tauDays: 0,
      gateResults: [gate0Result],
      status: "NO_TRADE",
      strategy,
    };
  }

  const riskBudget = strategy === "ordinary" ? 0.35 : 0.25;
  const gate1Result = gate1(input, strategy);
  const gate2Result = gate2(input, strategy, riskBudget);
  const gate3Result = gate3(input, strategy, gate2Result);

  const gateResults = [gate0Result, gate1Result, gate2Result, gate3Result];

  const anyFailed = gateResults.some(g => !g.passed);
  if (anyFailed) {
    const failedGate = gateResults.find(g => !g.passed);
    return {
      strike: input.strike,
      optionType: input.optionType,
      d: 0,
      absDelta: Math.abs(input.delta),
      P_ITM: 0,
      risk: 1,
      designedPNotZero: strategy === "ordinary" ? 0.65 : 0.75,
      mid: input.mid,
      spreadRatio: (input.ask - input.bid) / input.mid,
      expectedMove: 0,
      tauDays: 0,
      gateResults,
      status: "NO_TRADE",
      strategy,
    };
  }

  // All gates 0-3 passed — compute final values
  const S = input.underlyingSpot;
  const K = input.strike;
  const sigma = input.iv;
  const r = getRiskFreeRate();
  const q = 0.07;

  const now = new Date();
  const tauSec = Math.max(input.expiryDateTime.getTime() - now.getTime(), 1);
  const tau = Math.max(tauSec / (365.25 * 24 * 3600), 1e-8);

  let d: number;
  if (input.optionType === "CE") {
    d = (S - K) / S;
  } else {
    d = (K - S) / S;
  }

  const logSK = Math.log(S / K);
  const d1 = (logSK + (r - q + sigma * sigma / 2) * tau) / (sigma * Math.sqrt(tau));
  const d2 = d1 - sigma * Math.sqrt(tau);

  const P_ITM = input.optionType === "CE" ? normalCDF(d2) : normalCDF(-d2);
  const risk = 1 - P_ITM;
  const designedPNotZero = strategy === "ordinary" ? 0.65 : 0.75;

  const expectedMove = S * sigma * Math.sqrt(tau);
  const tauDays = tau;

  const spreadRatio = (input.ask - input.bid) / input.mid;

  const analysis: StrikeAnalysis = {
    strike: input.strike,
    optionType: input.optionType,
    d,
    absDelta: Math.abs(input.delta),
    P_ITM,
    risk,
    designedPNotZero,
    mid: input.mid,
    spreadRatio,
    expectedMove,
    tauDays,
    gateResults: [gate0Result, gate1Result, gate2Result, gate3Result],
    status: "TRADE",
    strategy,
  };

  // Gate 4 — Premium-Collapse Detection (per-quote check)
  const moveAgainst: number | null =
    input.optionType === "CE" && input.underlyingSpot < input.strike
      ? input.strike - input.underlyingSpot
      : input.optionType === "PE" && input.underlyingSpot > input.strike
        ? input.underlyingSpot - input.strike
        : null;

  if (moveAgainst !== null && analysis.expectedMove > 0) {
    const againstRatio = moveAgainst / analysis.expectedMove;
    if (againstRatio > 0.6) {
      return {
        ...analysis,
        status: "EXIT",
      };
    }
  }

  return analysis;
}

// ──────────────────────────────────────────────────────────────
// Main engine
// ──────────────────────────────────────────────────────────────

export async function runStrikeExpiryRiskEngine(
  strikes: StrikeInput[],
  strategy: "ordinary" | "zero_hero"
): Promise<EngineOutput> {
  const riskBudgets = { ordinary: 0.35, zero_hero: 0.25 };
  const budget = riskBudgets[strategy];

  const analyses: StrikeAnalysis[] = [];

  for (const input of strikes) {
    const result = analyzeStrike(input, strategy);
    analyses.push(result);
  }

  const tradeStrikes = analyses.filter(a => a.status === "TRADE");

  if (tradeStrikes.length === 0) {
    return {
      status: "NO_TRADE",
      reason: `No strikes passed gates 0-3 for ${strategy} strategy (min P(not zero) = ${budget.toFixed(2)})`,
      strategy,
      minDesignedPNotZero: budget,
      selectedStrikes: [],
      timestamp: new Date().toISOString(),
    };
  }

  // Gate 5 — Ranking & Output
  tradeStrikes.sort((a, b) => {
    if (a.risk !== b.risk) return a.risk - b.risk;
    if (a.absDelta !== b.absDelta) return b.absDelta - a.absDelta;
    if (a.spreadRatio !== b.spreadRatio) return a.spreadRatio - b.spreadRatio;
    return 0;
  });

  return {
    status: "TRADE",
    reason: `${tradeStrikes.length} strikes passed all gates`,
    strategy,
    minDesignedPNotZero: budget,
    selectedStrikes: tradeStrikes,
    timestamp: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
// Format Telegram alert text (returned to caller)
// ──────────────────────────────────────────────────────────────

/** Format a human-readable strike summary for the Telegram alert. */
function formatStrikeSummary(s: StrikeAnalysis): string {
  const { strike, optionType, d, absDelta, P_ITM, risk, designedPNotZero, mid, spreadRatio, expectedMove, tauDays } = s;
  const side = optionType === "CE" ? "Call" : "Put";
  const itmLabel = d > 0 ? "ITM" : d < 0 ? "OTM" : "ATM";
  return `📈 ${side} Strike ${strike} (${itmLabel})\n` +
    `   Δ=${absDelta.toFixed(2)} | P_ITM=${P_ITM.toFixed(4)} | risk=${risk.toFixed(4)}\n` +
    `   designedP_not_zero=${designedPNotZero.toFixed(2)} | mid=${mid.toFixed(2)} | spread=${spreadRatio.toFixed(4)}\n` +
    `   τ=${tauDays.toFixed(4)}y | expected_move=${expectedMove.toFixed(2)}`;
}

/** Build the Telegram trade-alert text from a TRADE engine output. */
function buildTelegramText(output: EngineOutput): string | null {
  if (output.status !== "TRADE") return null;

  const s = output.selectedStrikes[0];
  if (!s) return null;

  const action = s.optionType === "CE" ? "BUY CE" : "BUY PUT";
  const confidence = Math.round(s.designedPNotZero * 100);

  const parts = [
    `🚀 *Strike Expiry-Risk Engine — TRADE*`,
    `Strategy: *${output.strategy}*`,
    `Min designed P(not zero): *${output.minDesignedPNotZero.toFixed(2)}*`,
    `• Strike: *${s.strike}* (${s.optionType === "CE" ? "Call" : "Put"})`,
    `• Δ* = *${s.absDelta.toFixed(2)}* | *P_ITM* = *${s.P_ITM.toFixed(4)}*`,
    `• Risk = *${s.risk.toFixed(4)}* (1 − P_ITM)`,
    `• designed P(not zero) = *${s.designedPNotZero.toFixed(2)}*`,
    `• Mid = *${s.mid.toFixed(2)}* | Spread ratio = *${s.spreadRatio.toFixed(4)}*`,
    `• Expected move = *${s.expectedMove.toFixed(2)}* | τ = *${s.tauDays.toFixed(4)}y*`,
    `• ${formatStrikeSummary(s)}`,
  ];

  return parts.join("\n");
}

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/** Run the engine and return the output text for Telegram (or other). */
export async function runEngineForTelegram(
  strikes: StrikeInput[],
  strategy: "ordinary" | "zero_hero"
): Promise<{
  engineOutput: EngineOutput;
  alertText: string | null;
}> {
  const engineOutput = await runStrikeExpiryRiskEngine(strikes, strategy);

  const alertText = engineOutput.status === "TRADE" ? buildTelegramText(engineOutput) : null;

  return { engineOutput, alertText };
}
