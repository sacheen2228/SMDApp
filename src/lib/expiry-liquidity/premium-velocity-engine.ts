// ─── Premium Velocity Engine ───────────────────────────────────────────
// Calculates premium velocity, acceleration, and abnormality detection
// per strike per leg (CE/PE)

import { PremiumVelocityAnalysis } from './types';

interface PremiumVelocityState {
  prevLtp: number;
  prevVelocity: number;
  prevTime: number;
  velocityHistory: number[];
}

interface PremiumVelocityConfig {
  windowMinutes: number;
  historySize: number;
  abnormalZScore: number;
}

class PremiumVelocityEngine {
  private state: Map<string, PremiumVelocityState> = new Map();
  private config: PremiumVelocityConfig = {
    windowMinutes: 5,
    historySize: 60,
    abnormalZScore: 2.5,
  };

  // ─── Process Premium Update ──────────────────────────────────────────
  processUpdate(
    key: string,          // e.g., "NIFTY_25000_CE"
    ltp: number,
    timestamp: number = Date.now()
  ): PremiumVelocityAnalysis {
    let state = this.state.get(key);

    if (!state) {
      state = {
        prevLtp: ltp,
        prevVelocity: 0,
        prevTime: timestamp,
        velocityHistory: [],
      };
      this.state.set(key, state);
      return this.createZeroAnalysis();
    }

    const timeDiffMinutes = (timestamp - state.prevTime) / (1000 * 60);
    if (timeDiffMinutes <= 0) {
      return this.getCurrentAnalysis(state);
    }

    // Calculate velocity (LTP change per minute)
    const velocity = (ltp - state.prevLtp) / timeDiffMinutes;

    // Calculate acceleration
    const acceleration = (velocity - state.prevVelocity) / Math.max(timeDiffMinutes, 1/60);

    // Update state
    state.prevLtp = ltp;
    state.prevVelocity = velocity;
    state.prevTime = Date.now();

    // Add to history
    state.velocityHistory.push(velocity);
    if (state.velocityHistory.length > this.config.historySize) {
      state.velocityHistory.shift();
    }

    return this.createAnalysis(velocity, acceleration, state.velocityHistory);
  }

  private createAnalysis(
    velocity: number,
    acceleration: number,
    history: number[]
  ): PremiumVelocityAnalysis {
    // Calculate Z-score
    const mean = history.length > 0
      ? history.reduce((a, b) => a + b, 0) / history.length
      : 0;
    const stdDev = history.length > 1
      ? Math.sqrt(history.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / history.length)
      : 1;

    const zScore = stdDev > 0 ? (velocity - mean) / stdDev : 0;
    const isAbnormal = Math.abs(zScore) > this.config.abnormalZScore;

    // Strength classification
    const velocityPct = 0; // would need LTP to calculate %
    let strength: PremiumVelocityAnalysis['strength'] = 'NONE';
    const absVel = Math.abs(velocity);
    if (absVel > 10) strength = 'EXTREME';
    else if (absVel > 5) strength = 'STRONG';
    else if (absVel > 2) strength = 'MODERATE';
    else if (absVel > 0.5) strength = 'WEAK';

    let direction: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
    if (velocity > 0.01) direction = 'UP';
    else if (velocity < -0.01) direction = 'DOWN';

    return {
      velocity,
      acceleration,
      velocityZScore: zScore,
      accelerationZScore: 0, // would need acceleration history
      isAbnormal,
      direction,
      strength,
      // Expected premium move per point spot move (delta + gamma)
      premiumGainPerPoint: 0, // would need delta/gamma
    };
  }

  private createZeroAnalysis(): PremiumVelocityAnalysis {
    return {
      velocity: 0,
      acceleration: 0,
      velocityZScore: 0,
      accelerationZScore: 0,
      isAbnormal: false,
      direction: 'FLAT',
      strength: 'NONE',
      premiumGainPerPoint: 0,
    };
  }

  private getCurrentAnalysis(state: PremiumVelocityState): PremiumVelocityAnalysis {
    return {
      velocity: state.prevVelocity,
      acceleration: 0,
      velocityZScore: 0,
      accelerationZScore: 0,
      isAbnormal: false,
      direction: 'FLAT',
      strength: 'NONE',
      premiumGainPerPoint: 0,
    };
  }

  // ─── Get Analysis for Key ───────────────────────────────────────────
  getAnalysis(key: string): PremiumVelocityAnalysis {
    const state = this.state.get(key);
    if (!state) return this.createZeroAnalysis();
    return this.getCurrentAnalysis(state);
  }

  // ─── Get Velocity ───────────────────────────────────────────────────
  getVelocity(key: string): number {
    const state = this.state.get(key);
    return state?.prevVelocity || 0;
  }

  // ─── Get Acceleration ───────────────────────────────────────────────
  getAcceleration(key: string): number {
    const state = this.state.get(key);
    if (!state || state.velocityHistory.length < 2) return 0;

    const recent = state.velocityHistory.slice(-2);
    return recent[1] - recent[0];
  }

  // ─── Check if Abnormal ──────────────────────────────────────────────
  isAbnormal(key: string): boolean {
    const analysis = this.getAnalysis(key);
    return analysis.isAbnormal;
  }

  // ─── Get Velocity Direction ─────────────────────────────────────────
  getDirection(key: string): 'UP' | 'DOWN' | 'FLAT' {
    const vel = this.getVelocity(key);
    if (vel > 0.01) return 'UP';
    if (vel < -0.01) return 'DOWN';
    return 'FLAT';
  }

  // ─── Get Velocity Strength ──────────────────────────────────────────
  getStrength(key: string): PremiumVelocityAnalysis['strength'] {
    const vel = Math.abs(this.getVelocity(key));
    if (vel > 10) return 'EXTREME';
    if (vel > 5) return 'STRONG';
    if (vel > 2) return 'MODERATE';
    if (vel > 0.5) return 'WEAK';
    return 'NONE';
  }

  // ─── Reset Key ──────────────────────────────────────────────────────
  resetKey(key: string): void {
    this.state.delete(key);
  }

  // ─── Reset All ──────────────────────────────────────────────────────
  reset(): void {
    this.state.clear();
  }

  // ─── Get All Velocities ─────────────────────────────────────────────
  getAllVelocities(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [key, state] of this.state.entries()) {
      map.set(key, state.prevVelocity);
    }
    return map;
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<PremiumVelocityConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let premiumVelocityEngineInstance: PremiumVelocityEngine | null = null;

export function getPremiumVelocityEngine(): PremiumVelocityEngine {
  if (!premiumVelocityEngineInstance) {
    premiumVelocityEngineInstance = new PremiumVelocityEngine();
  }
  return premiumVelocityEngineInstance;
}

// ─── Helper: Create Key ───────────────────────────────────────────────
export function createPremiumKey(symbol: string, strike: number, type: 'CE' | 'PE'): string {
  return `${symbol}_${strike}_${type}`;
}

// ─── Export Types ─────────────────────────────────────────────────────
export type { PremiumVelocityState, PremiumVelocityConfig };