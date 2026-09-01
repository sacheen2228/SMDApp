// ─── IV Velocity Engine ────────────────────────────────────────────────
// Tracks IV velocity, acceleration, and state classification (EXPANSION/CONTRACTION/SHOCK)

import { IVVelocityAnalysis } from './types';

interface IVVelocityState {
  prevIv: number;
  prevVelocity: number;
  prevTime: number;
  velocityHistory: number[];
}

interface IVVelocityConfig {
  windowMinutes: number;
  historySize: number;
  shockThresholdPct: number; // IV change % per minute for shock
  expansionThreshold: number; // IV velocity for expansion
  contractionThreshold: number; // IV velocity for contraction
}

class IVVelocityEngine {
  private state: Map<string, IVVelocityState> = new Map();
  private config: IVVelocityConfig = {
    windowMinutes: 5,
    historySize: 60,
    shockThresholdPct: 2, // 2% per minute = shock
    expansionThreshold: 0.5, // IV velocity > 0.5 = expansion
    contractionThreshold: -0.5, // IV velocity < -0.5 = contraction
  };

  // ─── Process IV Update ──────────────────────────────────────────────
  processUpdate(
    key: string,
    iv: number,
    timestamp: number = Date.now()
  ): IVVelocityAnalysis {
    let state = this.state.get(key);

    if (!state) {
      state = {
        prevIv: iv,
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

    // Calculate velocity (IV change per minute)
    const velocity = (iv - state.prevIv) / timeDiffMinutes;

    // Calculate acceleration
    const acceleration = (velocity - state.prevVelocity) / Math.max(timeDiffMinutes, 1/60);

    // Update state
    state.prevIv = iv;
    state.prevVelocity = velocity;
    state.prevTime = Date.now();

    // Add to history
    state.velocityHistory.push(velocity);
    if (state.velocityHistory.length > 60) {
      state.velocityHistory.shift();
    }

    return this.createAnalysis(velocity, acceleration, iv, state.velocityHistory);
  }

  private createAnalysis(
    velocity: number,
    acceleration: number,
    currentIv: number,
    history: number[]
  ): IVVelocityAnalysis {
    // Classify state
    let state: IVVelocityAnalysis['state'] = 'NORMAL';
    if (Math.abs(velocity) > this.config.shockThresholdPct) {
      state = 'IV_SHOCK';
    } else if (velocity > this.config.expansionThreshold) {
      state = 'IV_EXPANSION';
    } else if (velocity < this.config.contractionThreshold) {
      state = 'IV_CONTRACTION';
    }

    // IV Rank (percentile of current IV vs history)
    // Would need IV history - placeholder
    const ivRank = 0;
    const ivPercentile = 0;

    const isExtreme = Math.abs(velocity) > this.config.shockThresholdPct * 2;

    return {
      velocity,
      acceleration,
      state,
      ivRank: 0,
      ivPercentile: 0,
      isExtreme,
    };
  }

  private createZeroAnalysis(): IVVelocityAnalysis {
    return {
      velocity: 0,
      acceleration: 0,
      state: 'NORMAL',
      ivRank: 0,
      ivPercentile: 0,
      isExtreme: false,
    };
  }

  private getCurrentAnalysis(state: IVVelocityState): IVVelocityAnalysis {
    return {
      velocity: state.prevVelocity,
      acceleration: 0,
      state: 'NORMAL',
      ivRank: 0,
      ivPercentile: 0,
      isExtreme: false,
    };
  }

  // ─── Get Analysis ───────────────────────────────────────────────────
  getAnalysis(key: string): IVVelocityAnalysis {
    const state = this.state.get(key);
    if (!state) return this.createZeroAnalysis();
    return {
      velocity: state.prevVelocity,
      acceleration: 0,
      state: 'NORMAL',
      ivRank: 0,
      ivPercentile: 0,
      isExtreme: false,
    };
  }

  // ─── Get Velocity ───────────────────────────────────────────────────
  getVelocity(key: string): number {
    const state = this.state.get(key);
    return state?.prevVelocity || 0;
  }

  // ─── Get State ──────────────────────────────────────────────────────
  getState(key: string): IVVelocityAnalysis['state'] {
    const vel = this.getVelocity(key);
    if (Math.abs(vel) > 2) return 'IV_SHOCK';
    if (vel > 0.5) return 'IV_EXPANSION';
    if (vel < -0.5) return 'IV_CONTRACTION';
    return 'NORMAL';
  }

  // ─── Check if Extreme ───────────────────────────────────────────────
  isExtreme(key: string): boolean {
    return Math.abs(this.getVelocity(key)) > 2;
  }

  // ─── Reset Key ──────────────────────────────────────────────────────
  resetKey(key: string): void {
    this.state.delete(key);
  }

  // ─── Reset All ──────────────────────────────────────────────────────
  reset(): void {
    this.state.clear();
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<IVVelocityConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let ivVelocityEngineInstance: IVVelocityEngine | null = null;

export function getIVVelocityEngine(): IVVelocityEngine {
  if (!ivVelocityEngineInstance) {
    ivVelocityEngineInstance = new IVVelocityEngine();
  }
  return ivVelocityEngineInstance;
}

// ─── Helper: Create Key ───────────────────────────────────────────────
export function createIVKey(symbol: string, strike: number, type: 'CE' | 'PE'): string {
  return `${symbol}_${strike}_${type}_IV`;
}

// ─── Export Types ──────────────────────────────────────────────────────
export type { IVVelocityState, IVVelocityConfig };