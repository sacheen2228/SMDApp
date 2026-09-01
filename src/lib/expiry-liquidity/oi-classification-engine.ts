// ─── OI Classification Engine ──────────────────────────────────────────
// Classifies OI changes into: Long Buildup, Short Buildup, Short Covering,
// Long Unwinding, OI Accumulation, OI Distribution, Neutral
// Uses price change + OI change + volume confirmation

import { OIClassification, OIFlowAnalysis, OILegFlow, OILegFlowState } from './types';

interface OIClassificationConfig {
  velocityWindowMinutes: number;
  rapidChangeThreshold: number; // % OI change per window
  volumeConfirmationThreshold: number; // volume/OI ratio
}

class OIClassificationEngine {
  private config: OIClassificationConfig;
  private previousOIMap: Map<string, { oi: number; timestamp: number }> = new Map();
  private callbacks: Set<(analysis: OIFlowAnalysis) => void> = new Set();

  constructor(config: Partial<OIClassificationConfig> = {}) {
    this.config = {
      velocityWindowMinutes: 5,
      rapidChangeThreshold: 10, // 10% in 5 min
      volumeConfirmationThreshold: 0.1, // volume/OI > 10%
      ...config,
    };
  }

  // ─── Subscribe ──────────────────────────────────────────────────────
  subscribe(callback: (analysis: OIFlowAnalysis) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(analysis: OIFlowAnalysis): void {
    this.callbacks.forEach(cb => cb(analysis));
  }

  // ─── Process OI Update ──────────────────────────────────────────────
  // Call this for each strike/leg update
  processOIUpdate(
    symbol: string,
    strike: number,
    type: 'CE' | 'PE',
    oi: number,
    price: number,
    volume: number,
    timestamp: number = Date.now()
  ): OIClassification {
    const key = `${symbol}_${strike}_${type}`;
    const prev = this.previousOIMap.get(key);

    let classification: OIClassification = 'NEUTRAL';
    let oiChange = 0;
    let oiChangePct = 0;
    let priceChange = 0;

    if (prev) {
      oiChange = oi - prev.oi;
      oiChangePct = prev.oi > 0 ? ((oi - prev.oi) / prev.oi) * 100 : 0;
      priceChange = price - prev.price;

      // Classify based on OI change + price change
      classification = this.classifyOI(oiChange, priceChange);

      // Check for rapid change
      const timeDiffMinutes = (timestamp - prev.timestamp) / (1000 * 60);
      const velocity = timeDiffMinutes > 0 ? oiChangePct / timeDiffMinutes : 0;
      const isRapid = Math.abs(velocity) > this.config.rapidChangeThreshold;
    }

    // Update stored OI
    this.previousOIMap.set(key, { oi, timestamp });

    // Generate analysis if we have previous data
    if (prev) {
      const analysis = this.generateAnalysis(key, oi, price, volume, timestamp, classification, oiChange, oiChangePct, priceChange);
      this.notify(analysis);
    }

    return classification;
  }

  private classifyOI(oiChange: number, priceChange: number): OIClassification {
    // Core classification logic
    if (oiChange > 0 && priceChange > 0) return 'LONG_BUILDUP';
    if (oiChange < 0 && priceChange < 0) return 'LONG_UNWINDING';
    if (oiChange > 0 && priceChange < 0) return 'SHORT_BUILDUP';
    if (oiChange < 0 && priceChange > 0) return 'SHORT_COVERING';
    if (oiChange > 0) return 'OI_ACCUMULATION';
    if (oiChange < 0) return 'OI_DISTRIBUTION';
    return 'NEUTRAL';
  }

  private generateAnalysis(
    key: string,
    oi: number,
    price: number,
    volume: number,
    timestamp: number,
    classification: OIClassification,
    oiChange: number,
    oiChangePct: number,
    priceChange: number
  ): OIFlowAnalysis {
    // Volume confirmation: volume/OI ratio
    const volumeOIRatio = oi > 0 ? volume / oi : 0;
    const volumeConfirms = volumeOIRatio > this.config.volumeConfirmationThreshold;

    // Velocity (per minute) - would need previous timestamp
    const velocity = 0; // placeholder

    // Generate signal description
    const signal = this.getSignalDescription(classification);

    // Strength based on OI change magnitude and volume confirmation
    const strength = Math.min(100, Math.abs(oiChangePct) * 5 + (volumeConfirms ? 20 : 0));

    return {
      classification,
      signal,
      strength,
      oiChange,
      oiChangePct,
      priceChange,
      priceChangePct: 0, // would need previous price
      volumeSupport: volumeConfirms,
      velocity,
      isRapid: Math.abs(oiChangePct) > this.config.rapidChangeThreshold,
      callOIFlow: { classification: 'NEUTRAL', oiChange: 0, oiChangePct: 0, volume: 0, premiumChange: 0, velocity: 0 },
      putOIFlow: { classification: 'NEUTRAL', oiChange: 0, oiChangePct: 0, volume: 0, premiumChange: 0, velocity: 0 },
      netOIFlow: 0,
    };
  }

  private getSignalDescription(classification: OIClassification): string {
    const signals: Record<string, string> = {
      LONG_BUILDUP: 'Fresh Long Buildup — Price ↑ + OI ↑',
      SHORT_BUILDUP: 'Fresh Short Buildup — Price ↓ + OI ↑',
      SHORT_COVERING: 'Short Covering — Price ↑ + OI ↓',
      LONG_UNWINDING: 'Long Unwinding — Price ↓ + OI ↓',
      OI_ACCUMULATION: 'OI Accumulation — OI ↑, Price flat',
      OI_DISTRIBUTION: 'OI Distribution — OI ↓, Price flat',
      NEUTRAL: 'No Clear OI Signal',
    };
    return signals[classification] || 'Unknown';
  }

  // ─── Batch Process Multiple Strikes ─────────────────────────────────
  processBatch(
    updates: Array<{
      symbol: string;
      strike: number;
      type: 'CE' | 'PE';
      oi: number;
      price: number;
      volume: number;
      timestamp?: number;
    }>
  ): OIFlowAnalysis {
    const timestamp = Date.now();
    let netOIChange = 0;
    let totalVolume = 0;

    // Process all updates first
    for (const update of updates) {
      const prev = this.previousOIMap.get(`${update.symbol}_${update.strike}_${update.type}`);
      if (prev) {
        const oiChange = update.oi - prev.oi;
        netOIChange += oiChange;
        totalVolume += update.volume;
      }
      this.previousOIMap.set(
        `${update.symbol}_${update.strike}_${update.type}`,
        { oi: update.oi, timestamp: update.timestamp || timestamp }
      );
    }

    // Determine overall classification
    const avgPriceChange = 0; // would need price data
    let classification: OIClassification = 'NEUTRAL';
    if (netOIChange > 0 && avgPriceChange > 0) classification = 'LONG_BUILDUP';
    else if (netOIChange < 0 && avgPriceChange < 0) classification = 'LONG_UNWINDING';
    else if (netOIChange > 0 && avgPriceChange < 0) classification = 'SHORT_BUILDUP';
    else if (netOIChange < 0 && avgPriceChange > 0) classification = 'SHORT_COVERING';
    else if (netOIChange > 0) classification = 'OI_ACCUMULATION';
    else if (netOIChange < 0) classification = 'OI_DISTRIBUTION';

    const analysis: OIFlowAnalysis = {
      classification,
      signal: this.getSignalDescription(classification),
      strength: Math.min(100, Math.abs(netOIChange) / 1000 * 10),
      oiChange: netOIChange,
      oiChangePct: 0,
      priceChange: 0,
      priceChangePct: 0,
      volumeSupport: true,
      velocity: 0,
      isRapid: false,
      callOIFlow: { classification: 'NEUTRAL', oiChange: 0, oiChangePct: 0, volume: 0, premiumChange: 0, velocity: 0 },
      putOIFlow: { classification: 'NEUTRAL', oiChange: 0, oiChangePct: 0, volume: 0, premiumChange: 0, velocity: 0 },
      netOIFlow: netOIChange,
    };

    return analysis;
  }

  // ─── Classify from Leg Flow State ───────────────────────────────────
  classifyFromLegState(leg: OILegFlowState): OIClassification {
    const oiChange = leg.oiChange;
    const priceChange = leg.ltp - leg.prevLtp;
    return this.classifyOI(oiChange, priceChange);
  }

  // ─── Get Signal Description ─────────────────────────────────────────
  private getSignalDescription(classification: OIClassification): string {
    const signals: Record<OIClassification, string> = {
      LONG_BUILDUP: 'Fresh Long Buildup — Price ↑ + OI ↑',
      SHORT_BUILDUP: 'Fresh Short Buildup — Price ↓ + OI ↑',
      SHORT_COVERING: 'Short Covering — Price ↑ + OI ↓',
      LONG_UNWINDING: 'Long Unwinding — Price ↓ + OI ↓',
      OI_ACCUMULATION: 'OI Accumulation — OI ↑, Price flat',
      OI_DISTRIBUTION: 'OI Distribution — OI ↓, Price flat',
      NEUTRAL: 'No Clear OI Signal',
    };
    return signals[classification] || 'Unknown';
  }

  // ─── Getters ────────────────────────────────────────────────────────
  getPreviousOI(symbol: string, strike: number, type: 'CE' | 'PE'): number | null {
    const key = `${symbol}_${strike}_${type}`;
    return this.previousOIMap.get(key)?.oi || null;
  }

  // ─── Reset ──────────────────────────────────────────────────────────
  reset(): void {
    this.previousOIMap.clear();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let oiClassificationEngineInstance: OIClassificationEngine | null = null;

export function getOIClassificationEngine(): OIClassificationEngine {
  if (!oiClassificationEngineInstance) {
    oiClassificationEngineInstance = new OIClassificationEngine();
  }
  return oiClassificationEngineInstance;
}

// ─── Helper: Classify OI from Price + OI Change ───────────────────────
export function classifyOIFromChange(oiChange: number, priceChange: number): OIClassification {
  if (oiChange > 0 && priceChange > 0) return 'LONG_BUILDUP';
  if (oiChange < 0 && priceChange < 0) return 'LONG_UNWINDING';
  if (oiChange > 0 && priceChange < 0) return 'SHORT_BUILDUP';
  if (oiChange < 0 && priceChange > 0) return 'SHORT_COVERING';
  if (oiChange > 0) return 'OI_ACCUMULATION';
  if (oiChange < 0) return 'OI_DISTRIBUTION';
  return 'NEUTRAL';
}

// ─── Get Signal Description ───────────────────────────────────────────
export function getOISignalDescription(classification: OIClassification): string {
  const signals: Record<OIClassification, string> = {
    LONG_BUILDUP: 'Fresh Long Buildup — Price ↑ + OI ↑',
    SHORT_BUILDUP: 'Fresh Short Buildup — Price ↓ + OI ↑',
    SHORT_COVERING: 'Short Covering — Price ↑ + OI ↓',
    LONG_UNWINDING: 'Long Unwinding — Price ↓ + OI ↓',
    OI_ACCUMULATION: 'OI Accumulation — OI ↑, Price flat',
    OI_DISTRIBUTION: 'OI Distribution — OI ↓, Price flat',
    NEUTRAL: 'No Clear OI Signal',
  };
  return signals[classification] || 'Unknown';
}

// ─── Get Classification Color ─────────────────────────────────────────
export function getOIClassificationColor(classification: OIClassification): string {
  const colors: Record<OIClassification, string> = {
    LONG_BUILDUP: 'text-emerald-400',
    SHORT_BUILDUP: 'text-red-400',
    SHORT_COVERING: 'text-emerald-300',
    LONG_UNWINDING: 'text-red-300',
    OI_ACCUMULATION: 'text-blue-400',
    OI_DISTRIBUTION: 'text-orange-400',
    NEUTRAL: 'text-zinc-400',
  };
  return colors[classification] || 'text-zinc-400';
}