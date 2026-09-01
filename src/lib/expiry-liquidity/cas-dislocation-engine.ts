// ─── CAS Dislocation Engine ────────────────────────────────────────────
// Calculates real-time CAS dislocation after 15:15 when the auction starts.
// Tracks dislocation, velocity, acceleration, and strength classification.

import { getCASReferenceEngine } from './cas-reference-engine';
import { getCurrentSession } from './market-session-config';
import { CASDislocation } from './types';

interface DislocationState {
  currentDislocation: number;
  currentDislocationPct: number;
  velocity: number;        // dislocation change per minute
  acceleration: number;    // velocity change per minute
  previousDislocation: number;
  previousVelocity: number;
  lastUpdateTime: number;
  dislocationHistory: { time: number; dislocation: number; pct: number }[];
}

class CASDislocationEngine {
  private state: DislocationState;
  private config: { windowMinutes: number; historySize: number };
  private callbacks: Set<(dislocation: CASDislocation) => void>;

  constructor() {
    this.config = { windowMinutes: 15, historySize: 100 };
    this.callbacks = new Set();
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      currentDislocation: 0,
      currentDislocationPct: 0,
      velocity: 0,
      acceleration: 0,
      previousDislocation: 0,
      previousVelocity: 0,
      lastUpdateTime: 0,
      dislocationHistory: [],
    };
  }

  // ─── Subscribe ──────────────────────────────────────────────────────
  subscribe(callback: (dislocation: CASDislocation) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(): void {
    const dislocation = this.getDislocation();
    this.callbacks.forEach(cb => cb(dislocation));
  }

  // ─── Process Indicative Price Update ────────────────────────────────
  processIndicativePrice(indicativePrice: number, timestamp: number = Date.now()): void {
    const session = getCurrentSession('FNO_STOCK');
    const casRef = getCASReferenceEngine();
    const reference = casRef.getReference();

    // Only process during CAS phases (15:15 onwards)
    const isCasPhase = [
      'CAS_TRANSITION',
      'CAS_ORDER_ENTRY',
      'CAS_LIMIT_ONLY',
      'CAS_MATCHING',
    ].includes(getCurrentSession('FNO_STOCK').phase);

    if (!isCasPhase) {
      return;
    }

    if (!reference.isValid || reference.referencePrice === 0) {
      // Reference not yet available
      return;
    }

    const now = timestamp;
    const referencePrice = reference.referencePrice;

    // Calculate dislocation
    const dislocation = indicativePrice - referencePrice;
    const dislocationPct = (dislocation / referencePrice) * 100;

    // Calculate velocity (dislocation change per minute)
    let velocity = 0;
    let acceleration = 0;

    if (this.state.lastUpdateTime > 0) {
      const timeDiffMinutes = (now - this.state.lastUpdateTime) / (1000 * 60);
      if (timeDiffMinutes > 0) {
        velocity = (dislocation - this.state.previousDislocation) / timeDiffMinutes;
        acceleration = (velocity - this.state.previousVelocity) / timeDiffMinutes;
      }
    }

    // Update state
    this.state.previousDislocation = this.state.currentDislocation;
    this.state.previousVelocity = this.state.velocity;
    this.state.currentDislocation = dislocation;
    this.state.currentDislocationPct = dislocationPct;
    this.state.velocity = velocity;
    this.state.acceleration = acceleration;
    this.state.lastUpdateTime = now;

    // Add to history
    this.state.dislocationHistory.push({
      time: now,
      dislocation,
      pct: dislocationPct,
    });

    // Trim history
    if (this.state.dislocationHistory.length > this.config.historySize) {
      this.state.dislocationHistory.shift();
    }

    // Calculate velocity from history (smoother)
    this.updateSmoothedVelocity();

    this.notify();
  }

  private updateSmoothedVelocity(): void {
    const history = this.state.dislocationHistory;
    if (history.length < 3) return;

    // Use last 3 points for smoothed velocity
    const recent = history.slice(-3);
    const timeSpan = (recent[recent.length - 1].time - recent[0].time) / (1000 * 60);
    if (timeSpan > 0) {
      const dislocationChange = recent[recent.length - 1].dislocation - recent[0].dislocation;
      this.state.velocity = dislocationChange / timeSpan;
    }
  }

  // ─── Get Current Dislocation ────────────────────────────────────────
  getDislocation(): CASDislocation {
    const reference = getCASReferenceEngine().getReference();
    const strength = this.classifyStrength(this.state.currentDislocationPct);

    return {
      currentIndicativePrice: reference.referencePrice + this.state.currentDislocation,
      dislocation: this.state.currentDislocation,
      dislocationPct: this.state.currentDislocationPct,
      dislocationVelocity: this.state.velocity,
      dislocationAcceleration: this.state.acceleration,
      isAboveReference: this.state.currentDislocation > 0,
      strength,
    };
  }

  private classifyStrength(pct: number): CASDislocation['strength'] {
    const absPct = Math.abs(pct);
    if (absPct < 0.1) return 'NONE';
    if (absPct < 0.3) return 'WEAK';
    if (absPct < 0.6) return 'MODERATE';
    if (absPct < 1.0) return 'STRONG';
    return 'EXTREME';
  }

  // ─── Get Dislocation History ────────────────────────────────────────
  getHistory(): { time: number; dislocation: number; pct: number }[] {
    return [...this.state.dislocationHistory];
  }

  // ─── Get Velocity & Acceleration ────────────────────────────────────
  getVelocity(): number {
    return this.state.velocity;
  }

  getAcceleration(): number {
    return this.state.acceleration;
  }

  // ─── Check if CAS Phase Active ──────────────────────────────────────
  isCasActive(): boolean {
    const session = getCurrentSession('FNO_STOCK');
    return [
      'CAS_TRANSITION',
      'CAS_ORDER_ENTRY',
      'CAS_LIMIT_ONLY',
      'CAS_MATCHING',
    ].includes(session.phase);
  }

  // ─── Get Time Remaining in CAS ──────────────────────────────────────
  getCasTimeRemainingMinutes(): number {
    const session = getCurrentSession('FNO_STOCK');
    if (session.isCasActive) {
      return session.minutesRemaining;
    }
    return 0;
  }

  // ─── Reset ──────────────────────────────────────────────────────────
  reset(): void {
    this.resetState();
  }

  // ─── Check if Dislocation is Significant ────────────────────────────
  isSignificant(thresholdPct: number = 0.2): boolean {
    return Math.abs(this.state.currentDislocationPct) >= thresholdPct;
  }

  // ─── Get Dislocation Direction ──────────────────────────────────────
  getDirection(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (this.state.currentDislocationPct > 0.1) return 'BULLISH';
    if (this.state.currentDislocationPct < -0.1) return 'BEARISH';
    return 'NEUTRAL';
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let casDislocationEngineInstance: CASDislocationEngine | null = null;

export function getCASDislocationEngine(): CASDislocationEngine {
  if (!casDislocationEngineInstance) {
    casDislocationEngineInstance = new CASDislocationEngine();
  }
  return casDislocationEngineInstance;
}

// ─── Export Types ─────────────────────────────────────────────────────
export type { DislocationState };