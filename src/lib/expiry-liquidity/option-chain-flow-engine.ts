// ─── Option Chain Flow Engine ─────────────────────────────────────────
// Real-time tracking of OI, volume, premium, IV per strike.
// Calculates velocities, accelerations, and classifications.

import {
  OptionChainSnapshot,
  OptionChainStrike,
  OptionLegMetrics,
  OptionLegFlow,
  OIFlowAnalysis,
  PremiumVelocityAnalysis,
  IVVelocityAnalysis,
  VolumeVelocityAnalysis,
  OIClassification,
} from './types';

interface StrikeFlowState {
  strike: number;
  ce: OptionLegFlowState;
  pe: OptionLegFlowState;
  lastUpdateTime: number;
  premiumVelocityHistory: { time: number; ceVelocity: number; peVelocity: number }[];
  ivVelocityHistory: { time: number; ceIVVelocity: number; peIVVelocity: number }[];
  volumeVelocityHistory: { time: number; ceVolumeVelocity: number; peVolumeVelocity: number }[];
  oiVelocityHistory: { time: number; ceOIVelocity: number; peOIVelocity: number }[];
}

interface OptionLegFlowState {
  ltp: number;
  prevLtp: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  volume: number;
  prevVolume: number;
  oi: number;
  prevOi: number;
  oiChange: number;
  oiChangePct: number;
  iv: number;
  prevIv: number;
  ivChange: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  spread: number;
  spreadPct: number;
  // Computed velocities
  premiumVelocity: number;     // LTP change per minute
  premiumAcceleration: number; // velocity change per minute
  ivVelocity: number;          // IV change per minute
  ivAcceleration: number;
  volumeVelocity: number;      // volume change per minute
  oiVelocity: number;          // OI change per minute
  // Classification
  oiClassification: OIClassification;
  premiumVelocityAnalysis: {
    velocity: number;
    acceleration: number;
    isAbnormal: boolean;
    strength: 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME';
    direction: 'UP' | 'DOWN' | 'FLAT';
  };
  ivVelocityAnalysis: {
    velocity: number;
    acceleration: number;
    state: 'IV_EXPANSION' | 'IV_CONTRACTION' | 'IV_SHOCK' | 'NORMAL';
    isExtreme: boolean;
  };
  volumeVelocityAnalysis: {
    volumeRatio: number;
    velocity: number;
    state: 'NORMAL' | 'HIGH_VOLUME' | 'ABNORMAL_VOLUME' | 'EXTREME_VOLUME';
    isConfirming: boolean;
  };
  oiClassification: OIClassification;
  oiVelocity: number;
  isRapidOIChange: boolean;
}

interface StrikeFlowStateMap {
  [strike: number]: StrikeFlowState;
}

class OptionChainFlowEngine {
  private strikeStates: StrikeFlowStateMap = {};
  private config = {
    velocityWindowMinutes: 5,
    historySize: 200,
    abnormalThresholdZScore: 2.5,
    rapidOIThresholdPct: 0.1, // 10% in 5 min
  };
  private callbacks: Set<(strikes: Map<number, StrikeFlowState>) => void> = new Set();
  private previousSnapshot: OptionChainSnapshot | null = null;
  private expectedVolumeBaseline: Map<number, { ce: number; pe: number }> = new Map();

  constructor() {}

  // ─── Subscribe ──────────────────────────────────────────────────────
  subscribe(callback: (strikes: Map<number, StrikeFlowState>) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(): void {
    const strikeMap = new Map<number, StrikeFlowState>();
    for (const [strike, state] of Object.entries(this.strikeStates)) {
      strikeMap.set(Number(strike), state);
    }
    this.callbacks.forEach(cb => cb(strikeMap));
  }

  // ─── Process Option Chain Snapshot ──────────────────────────────────
  processOptionChain(snapshot: OptionChainSnapshot): void {
    const now = Date.now();

    // Initialize baseline if first snapshot
    if (!this.previousSnapshot) {
      this.initializeBaseline(snapshot);
      this.previousSnapshot = snapshot;
      return;
    }

    // Process each strike
    for (const strikeData of snapshot.strikes) {
      this.processStrike(strikeData.strike, strikeData, now);
    }

    // Update previous snapshot
    this.previousSnapshot = snapshot;

    // Notify subscribers
    this.notify();
  }

  private initializeBaseline(snapshot: OptionChainSnapshot): void {
    for (const strikeData of snapshot.strikes) {
      const strike = strikeData.strike;

      // Calculate expected volume baseline (simple average for now)
      const expectedCeVol = Math.max(strikeData.ce.volume, 100);
      const expectedPeVol = Math.max(strikeData.pe.volume, 100);

      this.expectedVolumeBaseline.set(strike, {
        ce: expectedCeVol,
        pe: expectedPeVol,
      });

      // Initialize strike state
      this.strikeStates[strike] = {
        strike: strikeData.strike,
        ce: this.createLegState(strikeData.ce, null),
        pe: this.createLegState(strikeData.pe, null),
        lastUpdateTime: Date.now(),
        premiumVelocityHistory: [],
        ivVelocityHistory: [],
        volumeVelocityHistory: [],
        oiVelocityHistory: [],
      };
    }
  }

  private createLegState(leg: OptionLegMetrics, prevLeg: OptionLegMetrics | null): OptionLegFlowState {
    const oiChange = prevLeg ? leg.oi - prevLeg.oi : 0;
    const oiChangePct = prevLeg && prevLeg.oi > 0 ? ((leg.oi - prevLeg.oi) / prevLeg.oi) * 100 : 0;
    const priceChange = prevLeg ? leg.ltp - prevLeg.ltp : 0;
    const priceChangePct = prevLeg && prevLeg.ltp > 0 ? ((leg.ltp - prevLeg.ltp) / prevLeg.ltp) * 100 : 0;
    const ivChange = prevLeg ? leg.iv - prevLeg.iv : 0;

    return {
      ltp: leg.ltp,
      prevLtp: prevLeg?.ltp || leg.ltp,
      bid: leg.bid,
      ask: leg.ask,
      bidQty: leg.bidQty,
      askQty: leg.askQty,
      volume: leg.volume,
      prevVolume: prevLeg?.volume || leg.volume,
      oi: leg.oi,
      prevOi: prevLeg?.oi || leg.oi,
      oiChange,
      oiChangePct,
      iv: leg.iv,
      prevIv: prevLeg?.iv || leg.iv,
      ivChange,
      delta: leg.delta,
      gamma: leg.gamma,
      theta: leg.theta,
      vega: leg.vega,
      spread: leg.spread,
      spreadPct: leg.spreadPct,
      // Computed
      premiumVelocity: 0,
      premiumAcceleration: 0,
      ivVelocity: 0,
      ivAcceleration: 0,
      volumeVelocity: 0,
      oiVelocity: 0,
      oiClassification: 'NEUTRAL',
      premiumVelocityAnalysis: {
        velocity: 0,
        acceleration: 0,
        isAbnormal: false,
        strength: 'NONE',
        direction: 'FLAT',
      },
      ivVelocityAnalysis: {
        velocity: 0,
        acceleration: 0,
        state: 'NORMAL',
        isExtreme: false,
      },
      volumeVelocityAnalysis: {
        volumeRatio: 1,
        velocity: 0,
        state: 'NORMAL',
        isConfirming: false,
      },
      oiClassification: 'NEUTRAL',
      oiVelocity: 0,
      isRapidOIChange: false,
    };
  }

  // ─── Process Individual Strike ──────────────────────────────────────
  private processStrike(strike: number, strikeData: OptionChainStrike, now: number): void {
    if (!this.strikeStates[strike]) {
      // First time seeing this strike
      this.strikeStates[strike] = {
        strike,
        ce: this.createLegState(strikeData.ce, null),
        pe: this.createLegState(strikeData.pe, null),
        lastUpdateTime: Date.now(),
        premiumVelocityHistory: [],
        ivVelocityHistory: [],
        volumeVelocityHistory: [],
        oiVelocityHistory: [],
      };
      return;
    }

    const state = this.strikeStates[strike];
    const prevCe = { ...state.ce };
    const prevPe = { ...state.pe };

    // Process CE leg
    state.ce = this.updateLeg(prevCe, strikeData.ce, 'CE', strike, now);

    // Process PE leg
    state.pe = this.updateLeg(prevPe, strikeData.pe, 'PE', strike, now);

    state.lastUpdateTime = now;
  }

  private updateLeg(
    prev: OptionLegFlowState,
    current: OptionLegMetrics,
    type: 'CE' | 'PE',
    strike: number,
    now: number
  ): OptionLegFlowState {
    // Calculate changes
    const oiChange = current.oi - prev.oi;
    const oiChangePct = prev.oi > 0 ? ((current.oi - prev.oi) / prev.oi) * 100 : 0;
    const priceChange = current.ltp - prev.ltp;
    const priceChangePct = prev.ltp > 0 ? ((current.ltp - prev.ltp) / prev.ltp) * 100 : 0;
    const volumeChange = current.volume - prev.volume;
    const ivChange = current.iv - prev.iv;

    // Calculate velocities (per minute)
    const timeDiffMinutes = 1; // Assuming 1-minute updates; adjust if needed
    const premiumVelocity = priceChange / timeDiffMinutes;
    const ivVelocity = ivChange / timeDiffMinutes;
    const volumeVelocity = volumeChange / timeDiffMinutes;
    const oiVelocity = oiChange / timeDiffMinutes;

    // Calculate accelerations
    const premiumAcceleration = (premiumVelocity - prev.premiumVelocity) / timeDiffMinutes;
    const ivAcceleration = (ivVelocity - prev.ivVelocity) / timeDiffMinutes;

    // Classify OI
    const oiClassification = this.classifyOI(oiChange, priceChange, current.volume);

    // Classify premium velocity
    const premiumVelocityAnalysis = this.classifyPremiumVelocity(
      premiumVelocity,
      premiumAcceleration,
      prev.ltp
    );

    // Classify IV velocity
    const ivVelocityAnalysis = this.classifyIVVelocity(ivVelocity, ivAcceleration, current.iv);

    // Classify volume velocity
    const baseline = this.expectedVolumeBaseline.get(strike);
    const expectedVol = baseline ? (type === 'CE' ? baseline.ce : baseline.pe) : 100;
    const volumeRatio = expectedVol > 0 ? current.volume / expectedVol : 1;
    const volumeVelocityAnalysis = this.classifyVolumeVelocity(
      volumeRatio,
      volumeVelocity,
      priceChange
    );

    // Check for rapid OI change
    const isRapidOIChange = Math.abs(oiChangePct) > this.config.rapidOIThresholdPct * 100;

    // Add to history
    this.addToHistory(strike, now, {
      cePremiumVelocity: type === 'CE' ? premiumVelocity : prev.premiumVelocity,
      pePremiumVelocity: type === 'PE' ? premiumVelocity : prev.premiumVelocity,
      ceIVVelocity: type === 'CE' ? ivVelocity : prev.ivVelocity,
      peIVVelocity: type === 'PE' ? ivVelocity : prev.ivVelocity,
      ceVolumeVelocity: type === 'CE' ? volumeVelocity : prev.volumeVelocity,
      peVolumeVelocity: type === 'PE' ? volumeVelocity : prev.volumeVelocity,
      ceOIVelocity: type === 'CE' ? oiVelocity : prev.oiVelocity,
      peOIVelocity: type === 'PE' ? oiVelocity : prev.oiVelocity,
    });

    return {
      ...current,
      prevLtp: prev.ltp,
      prevVolume: prev.volume,
      prevOi: prev.oi,
      prevIv: prev.iv,
      oiChange: current.oi - prev.oi,
      oiChangePct: prev.oi > 0 ? ((current.oi - prev.oi) / prev.oi) * 100 : 0,
      ivChange,
      premiumVelocity,
      premiumAcceleration,
      ivVelocity,
      ivAcceleration,
      volumeVelocity,
      oiVelocity,
      oiClassification,
      premiumVelocityAnalysis,
      ivVelocityAnalysis,
      volumeVelocityAnalysis,
      oiClassification,
      oiVelocity,
      isRapidOIChange,
    };
  }

  private classifyOI(oiChange: number, priceChange: number): OIClassification {
    if (oiChange > 0 && priceChange > 0) return 'LONG_BUILDUP';
    if (oiChange > 0 && priceChange < 0) return 'SHORT_BUILDUP';
    if (oiChange < 0 && priceChange > 0) return 'SHORT_COVERING';
    if (oiChange < 0 && priceChange < 0) return 'LONG_UNWINDING';
    if (oiChange > 0) return 'OI_ACCUMULATION';
    if (oiChange < 0) return 'OI_DISTRIBUTION';
    return 'NEUTRAL';
  }

  private classifyPremiumVelocity(
    velocity: number,
    acceleration: number,
    ltp: number
  ): OptionLegFlowState['premiumVelocityAnalysis'] {
    const velocityPct = ltp > 0 ? (velocity / ltp) * 100 : 0;
    const absVelocityPct = Math.abs(velocityPct);

    let strength: OptionLegFlowState['premiumVelocityAnalysis']['strength'] = 'NONE';
    if (absVelocityPct > 5) strength = 'EXTREME';
    else if (absVelocityPct > 2) strength = 'STRONG';
    else if (absVelocityPct > 1) strength = 'MODERATE';
    else if (absVelocityPct > 0.5) strength = 'WEAK';

    const isAbnormal = Math.abs(acceleration) > 0.5 || absVelocityPct > 2;

    let direction: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
    if (velocity > 0.01) direction = 'UP';
    else if (velocity < -0.01) direction = 'DOWN';

    return {
      velocity,
      acceleration,
      isAbnormal,
      strength,
      direction,
    };
  }

  private classifyIVVelocity(
    velocity: number,
    acceleration: number,
    iv: number
  ): OptionLegFlowState['ivVelocityAnalysis'] {
    const velocityPct = iv > 0 ? (velocity / iv) * 100 : 0;
    const absVelocityPct = Math.abs(velocityPct);

    let state: 'IV_EXPANSION' | 'IV_CONTRACTION' | 'IV_SHOCK' | 'NORMAL' = 'NORMAL';
    if (absVelocityPct > 2) state = 'IV_SHOCK';
    else if (velocity > 0.5) state = 'IV_EXPANSION';
    else if (velocity < -0.5) state = 'IV_CONTRACTION';

    const isExtreme = absVelocityPct > 3;

    return {
      velocity,
      acceleration,
      state,
      isExtreme,
    };
  }

  private classifyVolumeVelocity(
    volumeRatio: number,
    velocity: number,
    priceChange: number
  ): OptionLegFlowState['volumeVelocityAnalysis'] {
    let state: 'NORMAL' | 'HIGH_VOLUME' | 'ABNORMAL_VOLUME' | 'EXTREME_VOLUME' = 'NORMAL';
    if (volumeRatio > 5) state = 'EXTREME_VOLUME';
    else if (volumeRatio > 3) state = 'ABNORMAL_VOLUME';
    else if (volumeRatio > 1.5) state = 'HIGH_VOLUME';

    const isConfirming = (priceChange > 0 && velocity > 0) || (priceChange < 0 && velocity < 0);

    return {
      volumeRatio,
      velocity,
      state,
      isConfirming,
    };
  }

  private addToHistory(strike: number, now: number, velocities: {
    cePremiumVelocity: number;
    pePremiumVelocity: number;
    ceIVVelocity: number;
    peIVVelocity: number;
    ceVolumeVelocity: number;
    peVolumeVelocity: number;
    ceOIVelocity: number;
    peOIVelocity: number;
  }): void {
    const state = this.strikeStates[strike];
    if (!state) return;

    state.premiumVelocityHistory.push({
      time: now,
      ceVelocity: velocities.cePremiumVelocity,
      peVelocity: velocities.pePremiumVelocity,
    });
    state.ivVelocityHistory.push({
      time: now,
      ceIVVelocity: velocities.ceIVVelocity,
      peIVVelocity: velocities.peIVVelocity,
    });
    state.volumeVelocityHistory.push({
      time: now,
      ceVolumeVelocity: velocities.ceVolumeVelocity,
      peVolumeVelocity: velocities.peVolumeVelocity,
    });
    state.oiVelocityHistory.push({
      time: now,
      ceOIVelocity: velocities.ceOIVelocity,
      peOIVelocity: velocities.peOIVelocity,
    });

    // Trim history
    const maxSize = this.config.historySize;
    if (state.premiumVelocityHistory.length > maxSize) state.premiumVelocityHistory.shift();
    if (state.ivVelocityHistory.length > maxSize) state.ivVelocityHistory.shift();
    if (state.volumeVelocityHistory.length > maxSize) state.volumeVelocityHistory.shift();
    if (state.oiVelocityHistory.length > maxSize) state.oiVelocityHistory.shift();
  }

  // ─── Getters ────────────────────────────────────────────────────────

  getStrikeState(strike: number): StrikeFlowState | null {
    return this.strikeStates[strike] || null;
  }

  getAllStrikeStates(): Record<number, StrikeFlowState> {
    return { ...this.strikeStates };
  }

  getStrikeMap(): Map<number, StrikeFlowState> {
    const map = new Map<number, StrikeFlowState>();
    for (const [strike, state] of Object.entries(this.strikeStates)) {
      map.set(Number(strike), state);
    }
    return map;
  }

  // ─── Get Aggregate Flow ─────────────────────────────────────────────
  getAggregateFlow(): OIFlowAnalysis {
    let totalCallOIChange = 0;
    let totalPutOIChange = 0;
    let totalCallVolume = 0;
    let totalPutVolume = 0;
    let callPremiumChange = 0;
    let putPremiumChange = 0;

    for (const state of Object.values(this.strikeStates)) {
      totalCallOIChange += state.ce.oiChange;
      totalPutOIChange += state.pe.oiChange;
      totalCallVolume += state.ce.volume;
      totalPutVolume += state.pe.volume;
      callPremiumChange += state.ce.premiumVelocity;
      putPremiumChange += state.pe.premiumVelocity;
    }

    // Classify net flow
    const netOIFlow = totalCallOIChange - totalPutOIChange;
    const avgPriceChange = (callPremiumChange + putPremiumChange) / 2;

    let classification: OIClassification = 'NEUTRAL';
    if (netOIFlow > 0 && avgPriceChange > 0) classification = 'LONG_BUILDUP';
    else if (netOIFlow > 0 && avgPriceChange < 0) classification = 'SHORT_BUILDUP';
    else if (netOIFlow < 0 && avgPriceChange > 0) classification = 'SHORT_COVERING';
    else if (netOIFlow < 0 && avgPriceChange < 0) classification = 'LONG_UNWINDING';
    else if (netOIFlow > 0) classification = 'OI_ACCUMULATION';
    else if (netOIFlow < 0) classification = 'OI_DISTRIBUTION';

    return {
      classification,
      signal: this.getClassificationSignal(classification),
      strength: Math.min(100, Math.abs(netOIFlow) / 10000 * 100),
      oiChange: netOIFlow,
      oiChangePct: 0, // would need total OI
      priceChange: avgPriceChange,
      priceChangePct: 0,
      volumeSupport: true,
      velocity: 0,
      isRapid: false,
      callOIFlow: this.getLegFlow('CE'),
      putOIFlow: this.getLegFlow('PE'),
      netOIFlow,
    };
  }

  private getClassificationSignal(classification: OIClassification): string {
    const signals: Record<OIClassification, string> = {
      LONG_BUILDUP: 'Fresh Long Buildup',
      SHORT_BUILDUP: 'Fresh Short Buildup',
      SHORT_COVERING: 'Short Covering',
      LONG_UNWINDING: 'Long Unwinding',
      OI_ACCUMULATION: 'OI Accumulation',
      OI_DISTRIBUTION: 'OI Distribution',
      NEUTRAL: 'Neutral',
    };
    return signals[classification] || 'Neutral';
  }

  private getLegFlow(type: 'CE' | 'PE'): OILegFlow {
    let totalOIChange = 0;
    let totalVolume = 0;
    let totalPremiumChange = 0;
    let totalOI = 0;

    for (const state of Object.values(this.strikeStates)) {
      const leg = type === 'CE' ? state.ce : state.pe;
      totalOIChange += leg.oiChange;
      totalVolume += leg.volume;
      totalPremiumChange += leg.premiumVelocity;
      totalOI += leg.oi;
    }

    return {
      classification: 'NEUTRAL', // would need per-leg classification
      oiChange: totalOIChange,
      oiChangePct: 0,
      volume: totalVolume,
      premiumChange: totalPremiumChange,
      velocity: 0,
    };
  }

  // ─── Get Premium Velocity for Strike ────────────────────────────────
  getPremiumVelocity(strike: number, type: 'CE' | 'PE'): number {
    const state = this.strikeStates[strike];
    return state ? (type === 'CE' ? state.ce.premiumVelocity : state.pe.premiumVelocity) : 0;
  }

  // ─── Get IV Velocity for Strike ────────────────────────────────────
  getIVVelocity(strike: number, type: 'CE' | 'PE'): number {
    const state = this.strikeStates[strike];
    return state ? (type === 'CE' ? state.ce.ivVelocity : state.pe.ivVelocity) : 0;
  }

  // ─── Get Volume Velocity for Strike ────────────────────────────────
  getVolumeVelocity(strike: number, type: 'CE' | 'PE'): number {
    const state = this.strikeStates[strike];
    return state ? (type === 'CE' ? state.ce.volumeVelocity : state.pe.volumeVelocity) : 0;
  }

  // ─── Get OI Velocity for Strike ────────────────────────────────────
  getOIVelocity(strike: number, type: 'CE' | 'PE'): number {
    const state = this.strikeStates[strike];
    return state ? (type === 'CE' ? state.ce.oiVelocity : state.pe.oiVelocity) : 0;
  }

  // ─── Get OI Classification for Strike ──────────────────────────────
  getOIClassification(strike: number, type: 'CE' | 'PE'): OIClassification {
    const state = this.strikeStates[strike];
    return state ? (type === 'CE' ? state.ce.oiClassification : state.pe.oiClassification) : 'NEUTRAL';
  }

  // ─── Get Rapid OI Change Flag ──────────────────────────────────────
  hasRapidOIChange(strike: number, type: 'CE' | 'PE'): boolean {
    const state = this.strikeStates[strike];
    return state ? (type === 'CE' ? state.ce.isRapidOIChange : state.pe.isRapidOIChange) : false;
  }

  // ─── Reset ──────────────────────────────────────────────────────────
  reset(): void {
    this.strikeStates = {};
    this.previousSnapshot = null;
    this.expectedVolumeBaseline.clear();
  }

  // ─── Export State for Persistence ──────────────────────────────────
  exportState(): string {
    return JSON.stringify({
      strikeStates: this.strikeStates,
      expectedVolumeBaseline: Array.from(this.expectedVolumeBaseline.entries()),
    });
  }

  // ─── Import State ───────────────────────────────────────────────────
  importState(json: string): void {
    const data = JSON.parse(json);
    this.strikeStates = data.strikeStates || {};
    this.expectedVolumeBaseline = new Map(data.expectedVolumeBaseline || []);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let optionChainFlowEngineInstance: OptionChainFlowEngine | null = null;

export function getOptionChainFlowEngine(): OptionChainFlowEngine {
  if (!optionChainFlowEngineInstance) {
    optionChainFlowEngineInstance = new OptionChainFlowEngine();
  }
  return optionChainFlowEngineInstance;
}

// ─── Export Types ─────────────────────────────────────────────────────
export type { StrikeFlowState, OptionLegFlowState, StrikeFlowStateMap };