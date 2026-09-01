// ─── CAS Reference Engine ─────────────────────────────────────────────
// Calculates the CAS Reference Price (VWAP 15:00-15:15) for F&O-eligible stocks
// This becomes the anchor for all CAS dislocation calculations.

import { getCurrentSession, NSE_SESSION_CONFIG } from './market-session-config';
import { CASReference } from './types';

interface TickData {
  price: number;
  volume: number;
  timestamp: number;
}

interface CASReferenceState {
  isCalculating: boolean;
  referencePrice: number | null;
  referenceVWAP: number | null;
  referenceVolume: number;
  referenceHigh: number;
  referenceLow: number;
  referenceTimestamp: number | null;
  ticks: TickData[];
  startTime: number;
  endTime: number;
}

class CASReferenceEngine {
  private state: CASReferenceState;
  private config = NSE_SESSION_CONFIG;
  private callbacks: Set<(reference: CASReference) => void>;

  constructor() {
    this.callbacks = new Set();
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      isCalculating: false,
      referencePrice: null,
      referenceVWAP: null,
      referenceVolume: 0,
      referenceHigh: 0,
      referenceLow: 0,
      referenceTimestamp: null,
      ticks: [],
      startTime: this.config.sessions.casReference.start,
      endTime: this.config.sessions.casReference.end,
    };
  }

  // ─── Subscribe to Reference Updates ─────────────────────────────────
  subscribe(callback: (reference: CASReference) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(): void {
    const reference = this.getReference();
    this.callbacks.forEach(cb => cb(reference));
  }

  // ─── Process Incoming Tick ──────────────────────────────────────────
  processTick(tick: TickData): void {
    const session = getCurrentSession('FNO_STOCK');

    // Only process during CAS reference window (15:00-15:15)
    if (session.phase !== 'CAS_REFERENCE') {
      // If we were calculating and window ended, finalize
      if (this.state.isCalculating && session.phase !== 'CAS_REFERENCE') {
        this.finalizeReference();
      }
      return;
    }

    // Start calculating if not already
    if (!this.state.isCalculating) {
      this.state.isCalculating = true;
      this.state.ticks = [];
      this.state.referenceHigh = tick.price;
      this.state.referenceLow = tick.price;
    }

    // Add tick to calculation
    this.state.ticks.push(tick);
    this.state.referenceHigh = Math.max(this.state.referenceHigh, tick.price);
    this.state.referenceLow = Math.min(this.state.referenceLow, tick.price);
    this.state.referenceVolume += tick.volume;

    // Calculate running VWAP
    this.updateRunningVWAP();

    // Notify subscribers of live reference
    this.notify();
  }

  private updateRunningVWAP(): void {
    let cumulativePV = 0;
    let cumulativeVolume = 0;

    for (const tick of this.state.ticks) {
      cumulativePV += tick.price * tick.volume;
      cumulativeVolume += tick.volume;
    }

    if (cumulativeVolume > 0) {
      this.state.referenceVWAP = cumulativePV / cumulativeVolume;
      this.state.referencePrice = this.state.referenceVWAP;
      this.state.referenceTimestamp = Date.now();
    }
  }

  // ─── Finalize Reference at Window Close ─────────────────────────────
  private finalizeReference(): void {
    if (!this.state.isCalculating) return;

    this.state.isCalculating = false;

    // Final VWAP calculation
    this.updateRunningVWAP();

    // Validate reference
    const isValid = this.validateReference();

    const reference: CASReference = {
      referencePrice: this.state.referencePrice || 0,
      referenceVWAP: this.state.referenceVWAP || 0,
      referenceVolume: this.state.referenceVolume,
      referenceHigh: this.state.referenceHigh,
      referenceLow: this.state.referenceLow,
      referenceTimestamp: this.state.referenceTimestamp || Date.now(),
      isValid,
    };

    // Notify final reference
    this.callbacks.forEach(cb => cb(reference));

    // Reset for next day
    this.resetState();
  }

  private validateReference(): boolean {
    // Need minimum ticks and volume for valid reference
    const minTicks = 10;
    const minVolume = 1000;

    return (
      this.state.ticks.length >= minTicks &&
      this.state.referenceVolume >= minVolume &&
      this.state.referenceVWAP !== null &&
      this.state.referenceVWAP > 0
    );
  }

  // ─── Get Current Reference ──────────────────────────────────────────
  getReference(): CASReference {
    return {
      referencePrice: this.state.referencePrice || 0,
      referenceVWAP: this.state.referenceVWAP || 0,
      referenceVolume: this.state.referenceVolume,
      referenceHigh: this.state.referenceHigh,
      referenceLow: this.state.referenceLow,
      referenceTimestamp: this.state.referenceTimestamp || 0,
      isValid: this.state.isCalculating || this.state.referencePrice !== null,
    };
  }

  // ─── Check if Currently in Reference Window ─────────────────────────
  isInReferenceWindow(): boolean {
    const session = getCurrentSession('FNO_STOCK');
    return session.phase === 'CAS_REFERENCE';
  }

  // ─── Get Time Remaining in Reference Window ─────────────────────────
  getTimeRemainingMinutes(): number {
    const session = getCurrentSession('FNO_STOCK');
    if (session.phase === 'CAS_REFERENCE') {
      return session.minutesRemaining;
    }
    return 0;
  }

  // ─── Reset for New Session ──────────────────────────────────────────
  reset(): void {
    this.resetState();
  }

  // ─── Get Reference for External Use ─────────────────────────────────
  getReferenceSnapshot(): CASReference | null {
    if (this.state.referencePrice === null) return null;
    return this.getReference();
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────
let casReferenceEngineInstance: CASReferenceEngine | null = null;

export function getCASReferenceEngine(): CASReferenceEngine {
  if (!casReferenceEngineInstance) {
    casReferenceEngineInstance = new CASReferenceEngine();
  }
  return casReferenceEngineInstance;
}

// ─── Helper: Create Tick from WebSocket/Price Update ──────────────────
export function createTickFromPriceUpdate(
  price: number,
  volume: number,
  timestamp: number = Date.now()
): { price: number; volume: number; timestamp: number } {
  return { price, volume, timestamp };
}

// ─── Helper: Calculate VWAP from Tick Array ───────────────────────────
export function calculateVWAP(ticks: { price: number; volume: number }[]): number {
  if (ticks.length === 0) return 0;

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const tick of ticks) {
    cumulativePV += tick.price * tick.volume;
    cumulativeVolume += tick.volume;
  }

  return cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : 0;
}

// ─── Export Types ─────────────────────────────────────────────────────
export type { CASReference, TickData };