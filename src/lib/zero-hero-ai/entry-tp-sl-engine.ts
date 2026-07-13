// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Entry / TP / SL Engine
// Determines entry price, take profit, stop loss

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
}

export interface EntryTPSLOutput {
  entry: number;
  target: number;
  stopLoss: number;
  riskReward: number;
  strategy: 'ZERO_HERO_SCALP' | 'ZERO_HERO_SWING' | 'STANDARD';
  notes: string;
}

export function entryTPSLEngine(input: EntryTPSLInput): EntryTPSLOutput {
  const {
    entryPremium, spot, strike, optionType, delta, gamma, theta,
    atr, daysToExpiry, bias, expected_move, instrument, expiry_mode,
  } = input;

  let target: number;
  let stopLoss: number;
  let strategy: EntryTPSLOutput['strategy'];
  let notes = '';

  if (expiry_mode === 'ZERO_HERO') {
    // Zero Hero: quick scalp on expiry day
    if (daysToExpiry <= 1) {
      strategy = 'ZERO_HERO_SCALP';
      // Target: premium doubles or 1 ATR move
      target = entryPremium * 2;
      stopLoss = entryPremium * 0.5;
      notes = 'Zero Hero scalp: quick momentum play, tight SL';
    } else {
      strategy = 'ZERO_HERO_SWING';
      // Target: 1.5x premium or based on expected move
      target = entryPremium * 1.5;
      stopLoss = entryPremium * 0.6;
      notes = 'Zero Hero swing: capture gamma move';
    }
  } else {
    strategy = 'STANDARD';
    // Standard: based on expected move and delta
    const moveTarget = expected_move * 0.5;
    if (optionType === 'CE') {
      target = entryPremium + moveTarget;
    } else {
      target = entryPremium + moveTarget;
    }
    stopLoss = entryPremium * 0.7;
    notes = 'Standard expiry play';
  }

  const riskReward = stopLoss > 0 ? (target - entryPremium) / (entryPremium - stopLoss) : 0;

  return {
    entry: entryPremium,
    target: Math.round(target * 100) / 100,
    stopLoss: Math.round(stopLoss * 100) / 100,
    riskReward,
    strategy,
    notes,
  };
}
