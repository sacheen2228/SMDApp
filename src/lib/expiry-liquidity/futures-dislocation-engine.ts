// ─── Futures Dislocation Engine ────────────────────────────────────────
// Tracks futures basis, basis velocity, acceleration, and dislocation
// relative to spot. Critical for CAS expiry confirmation.

import { FuturesSnapshot, CASDislocation } from './types';

interface FuturesState {
  currentBasis: number;
  currentBasisPct: number;
  basisVelocity: number;
  basisAcceleration: number;
  previousBasis: number;
  previousBasisVelocity: number;
  lastUpdateTime: number;
  basisHistory: { time: number; basis: number; basisPct: number; futuresPrice: number; spotPrice: number }[];
  futuresPrice: number;
  spotPrice: number;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  priceChange: number;
  priceChangePct: number;
  oiState: 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';
  isConfirmed: boolean;
}

class FuturesDislocationEngine {
  private state: FuturesState;
  private config: { windowMinutes: number; historySize: number };
  private callbacks: Set<(futures: FuturesSnapshot) => void>;
  private casDislocationEngine: ReturnType<typeof import('./cas-dislocation-engine').getCASDislocationEngine> | null;

  constructor() {
    this.config = { windowMinutes: 15, historySize: 100 };
    this.callbacks = new Set();
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      currentBasis: 0,
      currentBasisPct: 0,
      basisVelocity: 0,
      basisAcceleration: 0,
      previousBasis: 0,
      previousBasisVelocity: 0,
      lastUpdateTime: 0,
      basisHistory: [],
      futuresPrice: 0,
      spotPrice: 0,
      oi: 0,
      oiChange: 0,
      oiChangePct: 0,
      volume: 0,
      priceChange: 0,
      priceChangePct: 0,
      oiState: 'NEUTRAL',
      isConfirmed: false,
    };
  }

  // ─── Subscribe ──────────────────────────────────────────────────────
  subscribe(callback: (futures: FuturesSnapshot) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(): void {
    const futures = this.getFuturesSnapshot();
    this.callbacks.forEach(cb => cb(futures));
  }

  // ─── Set CAS Dislocation Engine Reference ───────────────────────────
  setCASDislocationEngine(engine: ReturnType<typeof import('./cas-dislocation-engine').getCASDislocationEngine>): void {
    this.casDislocationEngine = engine;
  }

  // ─── Process Futures Update ─────────────────────────────────────────
  processFuturesUpdate(
    futuresPrice: number,
    spotPrice: number,
    oi: number,
    oiChange: number,
    volume: number,
    prevClose: number,
    timestamp: number = Date.now()
  ): void {
    const now = timestamp;
    const basis = futuresPrice - spotPrice;
    const basisPct = spotPrice > 0 ? (basis / spotPrice) * 100 : 0;
    const priceChange = futuresPrice - prevClose;
    const priceChangePct = prevClose > 0 ? (priceChange / prevClose) * 100 : 0;
    const oiChangePct = oi > 0 ? (oiChange / oi) * 100 : 0;

    // Calculate velocity & acceleration
    let basisVelocity = 0;
    let basisAcceleration = 0;

    if (this.state.lastUpdateTime > 0) {
      const timeDiffMinutes = (now - this.state.lastUpdateTime) / (1000 * 60);
      if (timeDiffMinutes > 0) {
        basisVelocity = (basis - this.state.previousBasis) / timeDiffMinutes;
        basisAcceleration = (basisVelocity - this.state.previousBasisVelocity) / timeDiffMinutes;
      }
    }

    // Update state
    this.state.previousBasis = this.state.currentBasis;
    this.state.previousBasisVelocity = this.state.basisVelocity;
    this.state.currentBasis = basis;
    this.state.currentBasisPct = basisPct;
    this.state.basisVelocity = basisVelocity;
    this.state.basisAcceleration = basisAcceleration;
    this.state.futuresPrice = futuresPrice;
    this.state.spotPrice = spotPrice;
    this.state.oi = oi;
    this.state.oiChange = oiChange;
    this.state.oiChangePct = oiChangePct;
    this.state.volume = volume;
    this.state.priceChange = priceChange;
    this.state.priceChangePct = priceChangePct;
    this.state.lastUpdateTime = now;

    // Classify OI State
    this.state.oiState = this.classifyOIState(priceChange, oiChange);

    // Add to history
    this.state.basisHistory.push({
      time: now,
      basis,
      basisPct,
      futuresPrice,
      spotPrice,
    });

    // Trim history
    if (this.state.basisHistory.length > 100) {
      this.state.basisHistory.shift();
    }

    // Update smoothed velocity from history
    this.updateSmoothedVelocity();

    // Check confirmation with CAS dislocation
    this.checkConfirmation();

    this.notify();
  }

  private updateSmoothedVelocity(): void {
    const history = this.state.basisHistory;
    if (history.length < 3) return;

    const recent = history.slice(-3);
    const timeSpan = (recent[recent.length - 1].time - recent[0].time) / (1000 * 60);
    if (timeSpan > 0) {
      const basisChange = recent[recent.length - 1].basis - recent[0].basis;
      this.state.basisVelocity = basisChange / timeSpan;
    }
  }

  private classifyOIState(
    priceChange: number,
    oiChange: number
  ): FuturesSnapshot['oiState'] {
    if (priceChange > 0 && oiChange > 0) return 'LONG_BUILDUP';
    if (priceChange < 0 && oiChange > 0) return 'SHORT_BUILDUP';
    if (priceChange < 0 && oiChange < 0) return 'LONG_UNWINDING';
    if (priceChange > 0 && oiChange < 0) return 'SHORT_COVERING';
    return 'NEUTRAL';
  }

  private checkConfirmation(): void {
    if (!this.casDislocationEngine) return;

    const casDislocation = this.casDislocationEngine.getDislocation();
    const casDirection = casDislocation.isAboveReference ? 'BULLISH' : 'BEARISH';
    const futuresDirection = this.state.currentBasisPct > 0 ? 'BULLISH' : 'BEARISH';
    const priceDirection = this.state.priceChange > 0 ? 'BULLISH' : 'BEARISH';

    // Confirmation: CAS dislocation direction matches futures basis direction
    // and price direction
    const casMatchesFutures = casDirection === futuresDirection;
    const futuresMatchesPrice = futuresDirection === priceDirection;

    // Also check OI state confirmation
    const oiConfirms = this.oiConfirmsDirection();

    this.state.isConfirmed = casMatchesFutures && futuresMatchesPrice && oiConfirms;
  }

  private oiConfirmsDirection(): boolean {
    const { oiState, priceChange } = this.state;

    if (priceChange > 0) {
      // Price up: bullish if LONG_BUILDUP or SHORT_COVERING
      return oiState === 'LONG_BUILDUP' || oiState === 'SHORT_COVERING';
    } else if (priceChange < 0) {
      // Price down: bearish if SHORT_BUILDUP or LONG_UNWINDING
      return oiState === 'SHORT_BUILDUP' || oiState === 'LONG_UNWINDING';
    }
    return false;
  }

  // ─── Get Futures Snapshot ───────────────────────────────────────────
  getFuturesSnapshot(): FuturesSnapshot {
    return {
      symbol: '',
      spot: this.state.spotPrice,
      futures: this.state.futuresPrice,
      basis: Math.round(this.state.currentBasis * 100) / 100,
      basisPct: Math.round(this.state.currentBasisPct * 100) / 100,
      basisVelocity: Math.round(this.state.basisVelocity * 100) / 100,
      basisAcceleration: Math.round(this.state.basisAcceleration * 10000) / 10000,
      basisChange: Math.round((this.state.currentBasis - this.state.previousBasis) * 100) / 100,
      oi: this.state.oi,
      oiChange: this.state.oiChange,
      oiChangePct: Math.round(this.state.oiChangePct * 100) / 100,
      volume: this.state.volume,
      priceChange: Math.round(this.state.priceChange * 100) / 100,
      priceChangePct: Math.round(this.state.priceChangePct * 100) / 100,
      oiState: this.state.oiState,
    };
  }

  // ─── Get Basis Velocity & Acceleration ──────────────────────────────
  getBasisVelocity(): number {
    return this.state.basisVelocity;
  }

  getBasisAcceleration(): number {
    return this.state.basisAcceleration;
  }

  // ─── Get Confirmation Status ────────────────────────────────────────
  isConfirmed(): boolean {
    return this.state.isConfirmed;
  }

  // ─── Get Basis History ──────────────────────────────────────────────
  getBasisHistory(): { time: number; basis: number; basisPct: number; futuresPrice: number; spotPrice: number }[] {
    return [...this.state.basisHistory];
  }

  // ─── Check if Futures are Bullish/Bearish ───────────────────────────
  getDirection(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (this.state.currentBasisPct > 0.1) return 'BULLISH';
    if (this.state.currentBasisPct < -0.1) return 'BEARISH';
    return 'NEUTRAL';
  }

  // ─── Get Basis Strength ─────────────────────────────────────────────
  getBasisStrength(): 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME' {
    const absPct = Math.abs(this.state.currentBasisPct);
    if (absPct < 0.1) return 'NONE';
    if (absPct < 0.3) return 'WEAK';
    if (absPct < 0.6) return 'MODERATE';
    if (absPct < 1.0) return 'STRONG';
    return 'EXTREME';
  }

  // ─── Check for Abnormal Basis Movement ──────────────────────────────
  isAbnormalBasis(): boolean {
    const absBasisPct = Math.abs(this.state.currentBasisPct);
    const absVelocity = Math.abs(this.state.basisVelocity);

    // Abnormal if basis > 1% or velocity > 5 points/min
    return absBasisPct > 1.0 || absVelocity > 5;
  }

  // ─── Get Basis Divergence from CAS ──────────────────────────────────
  getCASDivergence(casDislocationPct: number): number {
    // Divergence = futures basis direction vs CAS dislocation direction
    const casDirection = casDislocationPct > 0 ? 1 : -1;
    const basisDirection = this.state.currentBasisPct > 0 ? 1 : -1;

    return casDirection * basisDirection; // 1 = aligned, -1 = divergent
  }

  // ─── Reset ──────────────────────────────────────────────────────────
  reset(): void {
    this.resetState();
  }

  // ─── Check if Futures Confirm CAS Direction ─────────────────────────
  confirmsCAS(casDislocationPct: number): boolean {
    const divergence = this.getCASDivergence(casDislocationPct);
    return divergence > 0; // aligned
  }

  // ─── Get OI State ───────────────────────────────────────────────────
  getOIState(): FuturesSnapshot['oiState'] {
    return this.state.oiState;
  }

  // ─── Get Current Basis ──────────────────────────────────────────────
  getCurrentBasis(): number {
    return this.state.currentBasis;
  }

  getCurrentBasisPct(): number {
    return this.state.currentBasisPct;
  }

  // ─── Reset ──────────────────────────────────────────────────────────
  reset(): void {
    this.resetState();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let futuresDislocationEngineInstance: FuturesDislocationEngine | null = null;

export function getFuturesDislocationEngine(): FuturesDislocationEngine {
  if (!futuresDislocationEngineInstance) {
    futuresDislocationEngineInstance = new FuturesDislocationEngine();
  }
  return futuresDislocationEngineInstance;
}

// ─── Export Types ─────────────────────────────────────────────────────
export type { FuturesState };