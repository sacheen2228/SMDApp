// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Greeks Engine using Black-Scholes
// Delta / Gamma / Theta / Vega

import { calculateGreeks } from '../greeks';

export interface GreeksInput {
  spot: number;
  strike: number;
  expiryDays: number;       // days to expiry
  iv: number;               // implied volatility (decimal, e.g. 0.15)
  optionType: 'CE' | 'PE';
}

export interface GreeksOutput {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  confidence: number;
}

export function greeksEngine(input: GreeksInput): GreeksOutput {
  const { spot, strike, expiryDays, iv, optionType } = input;

  const timeToExpiry = Math.max(1 / 365, expiryDays / 365);

  const greeks = calculateGreeks(
    spot,
    strike,
    timeToExpiry,
    iv,
    optionType === 'CE'
  );

  return {
    delta: greeks.delta,
    gamma: greeks.gamma,
    theta: greeks.theta,
    vega: greeks.vega,
    confidence: 90,
  };
}
