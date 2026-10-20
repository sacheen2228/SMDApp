// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Entry / TP / SL Engine
// Determines entry price, take profit, stop loss
//
// PER-TRADE MODEL (user rule, 2026-10-20):
//   "if I spend ₹10,000 I take ₹2,000 of risk and make ₹3,000"
//     → the STOP is a RUPEE amount: 20% of the ₹ DEPLOYED in the trade
//     → the TARGETS are clean R multiples of that risk: 2R / 3R / 4R
// The old plan was "stop = X% of the premium, target = another X%" — a 1:1
// R:R that needs >50% win-rate BEFORE costs.
//
// The plan itself comes from buildOptionPlan() (src/lib/option-plan.ts) — the
// ONE plan builder every option signal uses. This module only maps the
// strategy label onto it.

import { buildOptionPlan, PLAN_CONFIG } from "../option-plan";
import { GATE_CONFIG } from "../agent-brain-gate";

export interface EntryTPSLInput {
  entryPremium: number;
  spot: number;
  strike: number;
  optionType: 'CE' | 'PE';
  delta: number;
  gamma: number;
  theta: number;
  atr: number;
  daysToExpiry: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  expected_move: number;
  instrument: string;
  expiry_mode: 'ZERO_HERO' | 'STANDARD';
  /** Contract lot size — needed to convert the rupee risk into premium points. */
  lotSize?: number;
  /** Lots being taken. Defaults to sizing from the per-trade deployment budget. */
  lots?: number;
  /** ₹ committed to this trade. Defaults to the ₹20,000 per-trade budget. */
  deployedAmount?: number;
}

export interface EntryTPSLOutput {
  entry: number;
  target: number;          // TP1 (2R) — kept for backwards compatibility
  targets: number[];       // the R ladder: 2R / 3R / 4R (reachable ones only)
  stopLoss: number;
  riskReward: number;      // R:R to TP1
  riskAmount: number;       // ₹ at risk
  deployed: number;        // ₹ committed to the trade
  strategy: 'ZERO_HERO_SCALP' | 'ZERO_HERO_SWING' | 'STANDARD';
  notes: string;
}

export function entryTPSLEngine(input: EntryTPSLInput): EntryTPSLOutput {
  const {
    entryPremium, spot, strike, optionType, delta, gamma, theta,
    atr, daysToExpiry, bias, expected_move, instrument, expiry_mode,
  } = input;

  const lotSize = input.lotSize && input.lotSize > 0 ? input.lotSize : 1;
  const deployedAmount = input.deployedAmount && input.deployedAmount > 0
    ? input.deployedAmount
    : GATE_CONFIG.tradeBudget;

  // The ONE plan builder: stop = rupee risk (20% of the amount deployed),
  // targets = 2R / 3R / 4R, unreachable targets dropped.
  const plan = buildOptionPlan({
    symbol: instrument,
    optionType,
    entryPremium,
    lotSize,
    lots: input.lots,
    deployedAmount,
  });

  let strategy: EntryTPSLOutput['strategy'];
  let notes = '';

  if (expiry_mode === 'ZERO_HERO') {
    strategy = daysToExpiry <= 1 ? 'ZERO_HERO_SCALP' : 'ZERO_HERO_SWING';
    notes = strategy === 'ZERO_HERO_SCALP'
      ? 'Zero Hero scalp: quick momentum play, tight SL'
      : 'Zero Hero swing: capture gamma move';
  } else {
    strategy = 'STANDARD';
    notes = 'Standard expiry play';
  }

  if (!plan) {
    // Honest fallback: no valid stop inside the option's value at this size.
    const slPct = 0.5;
    const stopLoss = optionType === 'CE'
      ? entryPremium * (1 - slPct)
      : entryPremium * (1 + slPct);
    const riskPoints = Math.abs(entryPremium - stopLoss);
    const targets = [entryPremium + riskPoints * 2, entryPremium + riskPoints * 3, entryPremium + riskPoints * 4]
      .filter(t => t > 0);
    return {
      entry: entryPremium,
      target: Math.round(targets[0] * 100) / 100,
      targets: targets.map(t => Math.round(t * 100) / 100),
      stopLoss: Math.round(stopLoss * 100) / 100,
      riskReward: riskPoints > 0 ? 2 : 0,
      riskAmount: 0,
      deployed: deployedAmount,
      strategy,
      notes: `${notes} — rupee-risk plan unavailable at this size; using a structural 50% stop`,
    };
  }

  const target = plan.targets[0] ?? plan.entry;

  return {
    entry: plan.entry,
    target: target,
    targets: plan.targets,
    stopLoss: plan.stopLoss,
    riskReward: plan.rr,
    riskAmount: plan.riskAmount,
    deployed: plan.deployed,
    strategy,
    notes: `${notes} — risk ₹${Math.round(plan.riskAmount).toLocaleString('en-IN')} on ₹${Math.round(plan.deployed).toLocaleString('en-IN')} deployed (${(PLAN_CONFIG.riskPctOfDeployed * 100).toFixed(0)}% of the amount deployed), targets 2R/3R/4R`,
  };
}
