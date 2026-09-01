// ─── Volume Velocity Engine ────────────────────────────────────────────
// Tracks volume velocity, acceleration, and state classification

import { VolumeVelocityAnalysis } from './types';

interface VolumeVelocityState {
  prevVolume: number;
  prevVelocity: number;
  prevTime: number;
  velocityHistory: number[];
  expectedVolume: number; // intraday baseline
}

interface VolumeVelocityConfig {
  windowMinutes: number;
  historySize: number;
  highVolumeThreshold: number; // ratio vs expected
  extremeVolumeThreshold: number;
}

class VolumeVelocityEngine {
  private state: Map<string, VolumeVelocityState> = new Map();
  private config: VolumeVelocityConfig = {
    windowMinutes: 5,
    historySize: 60,
    highVolumeThreshold: 2,    // 2x expected
    extremeVolumeThreshold: 5, // 5x expected
  };

  // ─── Process Volume Update ──────────────────────────────────────────
  processUpdate(
    key: string,
    volume: number,
    expectedVolume: number = 100, // would come from intraday baseline
    timestamp: number = Date.now()
  ): VolumeVelocityAnalysis {
    let state = this.state.get(key);

    if (!state) {
      state = {
        prevVolume: volume,
        prevVelocity: 0,
        prevTime: timestamp,
        velocityHistory: [],
        expectedVolume,
      };
      this.state.set(key, state);
      return this.createZeroAnalysis();
    }

    // Update expected volume baseline (exponential moving average)
    state.expectedVolume = state.expectedVolume * 0.95 + volume * 0.05;

    const timeDiffMinutes = (timestamp - state.prevTime) / (1000 * 60);
    if (timeDiffMinutes <= 0) {
      return this.getCurrentAnalysis(state);
    }

    // Calculate velocity (volume change per minute)
    const velocity = (volume - state.prevVolume) / timeDiffMinutes;

    // Calculate acceleration
    const acceleration = (velocity - state.prevVelocity) / Math.max(timeDiffMinutes, 1/60);

    // Update state
    state.prevVolume = volume;
    state.prevVelocity = velocity;
    state.prevTime = Date.now();

    // Add to history
    state.velocityHistory.push(velocity);
    if (state.velocityHistory.length > 60) {
      state.velocityHistory.shift();
    }

    return this.createAnalysis(volume, velocity, acceleration, state.expectedVolume);
  }

  private createAnalysis(
    currentVolume: number,
    velocity: number,
    acceleration: number,
    expectedVolume: number
  ): VolumeVelocityAnalysis {
    const volumeRatio = expectedVolume > 0 ? currentVolume / expectedVolume : 1;

    let state: VolumeVelocityAnalysis['state'] = 'NORMAL';
    if (volumeRatio > 5) state = 'EXTREME_VOLUME';
    else if (volumeRatio > 3) state = 'ABNORMAL_VOLUME';
    else if (volumeRatio > 1.5) state = 'HIGH_VOLUME';

    // Check if volume confirms price move (would need price direction)
    const isConfirming = velocity > 0; // simplified

    return {
      volumeRatio,
      velocity,
      acceleration,
      state,
      isConfirming,
    };
  }

  private createZeroAnalysis(): VolumeVelocityAnalysis {
    return {
      volumeRatio: 1,
      velocity: 0,
      acceleration: 0,
      state: 'NORMAL',
      isConfirming: false,
    };
  }

  private getCurrentAnalysis(state: VolumeVelocityState): VolumeVelocityAnalysis {
    const volumeRatio = state.expectedVolume > 0 ? state.prevVolume / state.expectedVolume : 1;
    let stateStr: VolumeVelocityAnalysis['state'] = 'NORMAL';
    if (volumeRatio > 5) stateStr = 'EXTREME_VOLUME';
    else if (volumeRatio > 3) stateStr = 'ABNORMAL_VOLUME';
    else if (volumeRatio > 1.5) stateStr = 'HIGH_VOLUME';

    return {
      volumeRatio,
      velocity: state.prevVelocity,
      acceleration: 0,
      state: stateStr,
      isConfirming: state.prevVelocity > 0,
    };
  }

  // ─── Getters ────────────────────────────────────────────────────────

  getAnalysis(key: string): VolumeVelocityAnalysis {
    const state = this.state.get(key);
    if (!state) return { volumeRatio: 1, velocity: 0, acceleration: 0, state: 'NORMAL', isConfirming: false };
    return {
      volumeRatio: state.expectedVolume > 0 ? state.prevVolume / state.expectedVolume : 1,
      velocity: state.prevVelocity,
      acceleration: 0,
      state: this.getState(key),
      isConfirming: state.prevVelocity > 0,
    };
  }

  getVolumeRatio(key: string): number {
    const state = this.state.get(key);
    if (!state) return 1;
    return state.expectedVolume > 0 ? state.prevVolume / state.expectedVolume : 1;
  }

  getVelocity(key: string): number {
    const state = this.state.get(key);
    return state?.prevVelocity || 0;
  }

  getAcceleration(key: string): number {
    const state = this.state.get(key);
    if (!state || state.velocityHistory.length < 2) return 0;
    const recent = state.velocityHistory.slice(-2);
    return recent[1] - recent[0];
  }

  getState(key: string): VolumeVelocityAnalysis['state'] {
    const ratio = this.getVolumeRatio(key);
    if (ratio > 5) return 'EXTREME_VOLUME';
    if (ratio > 3) return 'ABNORMAL_VOLUME';
    if (ratio > 1.5) return 'HIGH_VOLUME';
    return 'NORMAL';
  }

  // ─── Check if Volume Confirms Price ────────────────────────────────
  confirmsPrice(key: string, priceDirection: 'UP' | 'DOWN'): boolean {
    const vel = this.getVelocity(key);
    if (priceDirection === 'UP') return vel > 0;
    if (priceDirection === 'DOWN') return vel < 0;
    return false;
  }

  // ─── Check for Abnormal Volume ──────────────────────────────────────
  isAbnormal(key: string): boolean {
    const ratio = this.getVolumeRatio(key);
    return ratio > 3;
  }

  // ─── Reset ──────────────────────────────────────────────────────────
  resetKey(key: string): void {
    this.state.delete(key);
  }

  reset(): void {
    this.state.clear();
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<{ highVolumeThreshold: number; extremeVolumeThreshold: number }>): void {
    if (config.highVolumeThreshold) this.config.highVolumeThreshold = config.highVolumeThreshold;
    if (config.extremeVolumeThreshold) this.config.extremeVolumeThreshold = config.extremeVolumeThreshold;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let volumeVelocityEngineInstance: VolumeVelocityEngine | null = null;

export function getVolumeVelocityEngine(): VolumeVelocityEngine {
  if (!volumeVelocityEngineInstance) {
    volumeVelocityEngineInstance = new VolumeVelocityEngine();
  }
  return volumeVelocityEngineInstance;
}

// ─── Helper: Create Key ───────────────────────────────────────────────
export function createVolumeKey(symbol: string, strike: number, type: 'CE' | 'PE'): string {
  return `${symbol}_${strike}_${type}_VOL`;
}