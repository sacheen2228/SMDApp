// DEPRECATED: duplicate of the consolidated Zero Hero engine in src/lib/zero-hero.ts.
// Kept on disk until production consolidation is verified (see AGENTS.md Architecture Guardian).
// Do NOT use in new code.

// Gamma-Theta Decision Engine
// Combines Gamma, Theta, Delta, IV, ATR into a score
// Thresholds are configurable and calibrated per instrument/expiry type

export interface GammaThetaConfig {
  // Per-instrument thresholds (calibrate from historical DB)
  gamma_high: number;        // e.g. 0.07 for NIFTY ATM weekly
  gamma_medium: number;      // e.g. 0.05
  theta_low: number;         // e.g. 3 (abs)
  theta_medium: number;      // e.g. 6 (abs)
  delta_min: number;         // e.g. 0.40
  delta_max: number;         // e.g. 0.60
  iv_rank_max: number;       // e.g. 60
  atr_multiplier: number;    // e.g. 1.0
}

export const DEFAULT_GAMMA_THETA_CONFIG: GammaThetaConfig = {
  gamma_high: 0.07,
  gamma_medium: 0.05,
  theta_low: 3,
  theta_medium: 6,
  delta_min: 0.40,
  delta_max: 0.60,
  iv_rank_max: 60,
  atr_multiplier: 1.0,
};

// Per-instrument calibration (illustrative - should be tuned from historical trades)
export const INSTRUMENT_GAMMA_THETA_CONFIG: { [instrument: string]: Partial<GammaThetaConfig> } = {
  NIFTY: { gamma_high: 0.07, gamma_medium: 0.05, theta_low: 3, theta_medium: 6 },
  BANKNIFTY: { gamma_high: 0.06, gamma_medium: 0.04, theta_low: 4, theta_medium: 8 },
  SENSEX: { gamma_high: 0.05, gamma_medium: 0.035, theta_low: 5, theta_medium: 10 },
  FINNIFTY: { gamma_high: 0.07, gamma_medium: 0.05, theta_low: 3, theta_medium: 6 },
  MIDCPNIFTY: { gamma_high: 0.08, gamma_medium: 0.06, theta_low: 3, theta_medium: 6 },
  // Stock options typically have lower gamma
  RELIANCE: { gamma_high: 0.04, gamma_medium: 0.025, theta_low: 2, theta_medium: 4 },
  HDFCBANK: { gamma_high: 0.04, gamma_medium: 0.025, theta_low: 2, theta_medium: 4 },
};

export function getGammaThetaConfig(instrument: string): GammaThetaConfig {
  const override = INSTRUMENT_GAMMA_THETA_CONFIG[instrument] || {};
  return { ...DEFAULT_GAMMA_THETA_CONFIG, ...override };
}

export interface GammaThetaInput {
  gamma: number;
  theta: number;
  delta: number;
  iv_rank: number;
  atr: number;
  expected_move: number;
  instrument?: string;       // for config calibration
}

export interface GammaThetaOutput {
  score: number;
  gamma_score: number;
  theta_score: number;
  delta_score: number;
  iv_score: number;
  atr_score: number;
  config: GammaThetaConfig;
  verdict: 'STRONG' | 'MODERATE' | 'WEAK';
}

export function gammaThetaEngine(input: GammaThetaInput): GammaThetaOutput {
  const config = getGammaThetaConfig(input.instrument || 'NIFTY');
  const { gamma, theta, delta, iv_rank, atr, expected_move } = input;

  let score = 0;
  let gammaScore = 0;
  let thetaScore = 0;
  let deltaScore = 0;
  let ivScore = 0;
  let atrScore = 0;

  // Gamma
  if (gamma > config.gamma_high) {
    gammaScore = 30;
  } else if (gamma > config.gamma_medium) {
    gammaScore = 20;
  } else {
    gammaScore = 5;
  }
  score += gammaScore;

  // Theta
  const absTheta = Math.abs(theta);
  if (absTheta < config.theta_low) {
    thetaScore = 20;
  } else if (absTheta < config.theta_medium) {
    thetaScore = 10;
  } else {
    thetaScore = -20;
  }
  score += thetaScore;

  // Delta
  if (delta >= config.delta_min && delta <= config.delta_max) {
    deltaScore = 20;
  }
  score += deltaScore;

  // IV
  if (iv_rank < config.iv_rank_max) {
    ivScore = 10;
  }
  score += ivScore;

  // ATR
  if (expected_move > atr * config.atr_multiplier) {
    atrScore = 20;
  }
  score += atrScore;

  let verdict: 'STRONG' | 'MODERATE' | 'WEAK';
  if (score >= 85) verdict = 'STRONG';
  else if (score >= 65) verdict = 'MODERATE';
  else verdict = 'WEAK';

  return {
    score,
    gamma_score: gammaScore,
    theta_score: thetaScore,
    delta_score: deltaScore,
    iv_score: ivScore,
    atr_score: atrScore,
    config,
    verdict,
  };
}

// Gamma Blast detector
export interface GammaBlastInput {
  gamma: number;
  delta_change: number;
  oi_change: number;        // %
  volume_ratio: number;
  iv_change: number;        // absolute IV change
  instrument?: string;
}

export function gammaBlast(input: GammaBlastInput): boolean {
  const config = getGammaThetaConfig(input.instrument || 'NIFTY');
  return (
    input.gamma > config.gamma_high &&
    input.delta_change > 0.08 &&
    input.volume_ratio > 2 &&
    input.oi_change > 5 &&
    input.iv_change > 1
  );
}

// Theta Killer detector
export interface ThetaKillerInput {
  theta: number;
  atr: number;
  range_size: number;
  minutes_to_close: number;
}

export function thetaKiller(input: ThetaKillerInput): boolean {
  return (
    Math.abs(input.theta) > 8 &&
    input.range_size < input.atr * 0.4 &&
    input.minutes_to_close < 90
  );
}
