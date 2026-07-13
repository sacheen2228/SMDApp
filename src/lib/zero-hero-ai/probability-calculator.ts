// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Probability Calculator
// Estimates probability of option expiring ITM/profit

import { calculateGreeks } from '../greeks';

export interface ProbabilityInput {
  spot: number;
  strike: number;
  expiryDays: number;
  iv: number;
  riskFreeRate?: number;
  optionType: 'CE' | 'PE';
  entryPremium: number;
  targetPremium?: number;   // for profit probability
}

export interface ProbabilityOutput {
  prob_itm: number;          // Probability of expiring ITM (0-1)
  prob_profit: number;       // Probability of profit at expiry
  prob_target: number;       // Probability of hitting target premium
  expected_value: number;    // Expected P/L at expiry
  breakeven: number;
}

// Cumulative normal distribution
function cdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function probabilityCalculator(input: ProbabilityInput): ProbabilityOutput {
  const { spot, strike, expiryDays, iv, riskFreeRate = 0.07, optionType, entryPremium, targetPremium } = input;

  const t = Math.max(1 / 365, expiryDays / 365);
  const sqrtT = Math.sqrt(t);

  if (spot <= 0 || strike <= 0 || iv <= 0) {
    return { prob_itm: 0, prob_profit: 0, prob_target: 0, expected_value: 0, breakeven: strike };
  }

  const d2 = (Math.log(spot / strike) + (riskFreeRate - (iv * iv) / 2) * t) / (iv * sqrtT);

  // Probability of expiring ITM
  let probItm: number;
  if (optionType === 'CE') {
    probItm = cdf(d2);
  } else {
    probItm = cdf(-d2);
  }

  // Breakeven at expiry
  const breakeven = optionType === 'CE' ? strike + entryPremium : strike - entryPremium;

  // Probability of profit at expiry (spot beyond breakeven)
  const d2BE = (Math.log(spot / breakeven) + (riskFreeRate - (iv * iv) / 2) * t) / (iv * sqrtT);
  const probProfit = optionType === 'CE' ? cdf(d2BE) : cdf(-d2BE);

  // Probability of hitting target premium
  let probTarget = 0;
  if (targetPremium && targetPremium > entryPremium) {
    const targetSpot = optionType === 'CE' ? strike + targetPremium : strike - targetPremium;
    const d2T = (Math.log(spot / targetSpot) + (riskFreeRate - (iv * iv) / 2) * t) / (iv * sqrtT);
    probTarget = optionType === 'CE' ? cdf(d2T) : cdf(-d2T);
  }

  // Expected value (simplified)
  const expectedValue = probProfit * (targetPremium ? targetPremium - entryPremium : entryPremium) -
                        (1 - probProfit) * entryPremium;

  return {
    prob_itm: probItm,
    prob_profit: probProfit,
    prob_target: probTarget,
    expected_value: expectedValue,
    breakeven,
  };
}
