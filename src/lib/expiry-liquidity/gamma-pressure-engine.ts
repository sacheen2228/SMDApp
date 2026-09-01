// ─── Gamma Pressure Engine ──────────────────────────────────────────────
// Calculates gamma pressure per strike, expiry boost, dealer hedging pressure

import { GammaPressureAnalysis } from './types';

interface GammaPressureConfig {
  atmThreshold: number;     // strikes from ATM to consider "ATM"
  nearATMThreshold: number; // strikes from ATM to consider "near ATM"
  gammaWallMultiplier: number; // gamma > avg * multiplier = wall
}

class GammaPressureEngine {
  private config: GammaPressureConfig = {
    atmThreshold: 50,      // ±50 points = ATM
    nearATMThreshold: 200, // ±200 points = near ATM
    gammaWallMultiplier: 2, // 2x average gamma = wall
  };

  // ─── Calculate Gamma Pressure for Strike ─────────────────────────────
  calculate(
    leg: {
      gamma: number;
      strike: number;
      type: 'CE' | 'PE';
      delta: number;
    },
    context: {
      spot: number;
      atmStrike: number;
      minutesToExpiry: number;
      isExpiryDay: boolean;
      allLegs: Array<{ gamma: number; strike: number; type: 'CE' | 'PE' }>;
      totalCallOI: number;
      totalPutOI: number;
      vix: number;
    }
  ): GammaPressureAnalysis {
    const { strike, gamma, type, delta } = leg;
    const { spot, atmStrike, minutesToExpiry, isExpiryDay, allLegs, totalCallOI, totalPutOI, vix } = context;

    const distanceFromATM = Math.abs(strike - atmStrike);
    const isATM = distanceFromATM <= this.config.atmThreshold;
    const nearATM = distanceFromATM <= this.config.nearATMThreshold;

    // Gamma efficiency: higher for ATM, decays with distance
    const gammaEfficiency = isATM ? gamma * 1000 : nearATM ? gamma * 500 : gamma * 100;

    // Expiry boost: gamma explodes near expiry
    const daysToExpiry = minutesToExpiry / (60 * 6.5); // ~6.5 hrs trading day
    let expiryBoost = 1.0;
    if (isExpiryDay) expiryBoost = 2.5;
    else if (daysToExpiry <= 1) expiryBoost = 2.0;
    else if (daysToExpiry <= 2) expiryBoost = 1.5;
    else if (daysToExpiry <= 5) expiryBoost = 1.2;

    // Base score
    let score = gammaEfficiency * expiryBoost;
    if (isATM) score *= 1.8;
    else if (nearATM) score *= 1.3;
    else score *= 0.4;

    // VIX adjustment: higher VIX = higher gamma sensitivity
    if (vix > 25) score *= 1.3;
    else if (vix > 18) score *= 1.15;

    score = Math.min(100, score);

    // Dealer hedging pressure
    // High gamma near ATM = dealers must hedge aggressively
    let dealerHedgingPressure: 'HIGH' | 'MODERATE' | 'LOW' = 'LOW';
    if (isATM && gamma > 0.001) dealerHedgingPressure = 'HIGH';
    else if (nearATM && gamma > 0.0005) dealerHedgingPressure = 'MODERATE';

    // Gamma wall detection
    const avgGamma = allLegs.reduce((s, l) => s + l.gamma, 0) / Math.max(allLegs.length, 1);
    const gammaWall = gamma > avgGamma * this.config.gammaWallMultiplier;

    // Expected dealer flow
    // Short gamma = dealers sell when price rises, buy when price falls
    // Long gamma = dealers buy when price rises, sell when price falls
    let expectedDealerFlow: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    const netGamma = context.totalCallOI > context.totalPutOI ? 'POSITIVE' : 'NEGATIVE';
    // Simplified: high gamma near spot = dealers defend the level
    if (isATM && gamma > 0.001) {
      expectedDealerFlow = 'NEUTRAL'; // dealers defend ATM
    }

    return {
      strike: context.spot, // placeholder, would be passed
      type: 'CE', // placeholder
      gamma,
      gammaEfficiency,
      distanceFromATM: distanceFromATM,
      isATM,
      nearATM,
      expiryBoost,
      gammaPressureScore: Math.round(score),
      dealerHedgingPressure,
      gammaWall,
      expectedDealerFlow,
    };
  }

  // ─── Calculate Aggregate Gamma Pressure ──────────────────────────────
  calculateAggregate(context: {
    strikes: Array<{
      strike: number;
      ce: { gamma: number; delta: number; oi: number; volume: number };
      pe: { gamma: number; delta: number; oi: number; volume: number };
    }>;
    spot: number;
    atmStrike: number;
    minutesToExpiry: number;
    isExpiryDay: boolean;
    totalCallOI: number;
    totalPutOI: number;
    vix: number;
  }): {
    totalGammaPressure: number;
    maxGammaStrike: number;
    maxGammaType: 'CE' | 'PE';
    dealerNetPosition: 'LONG_GAMMA' | 'SHORT_GAMMA' | 'NEUTRAL';
    gammaWallStrikes: number[];
    expiryBoost: number;
  } {
    let totalGamma = 0;
    let maxGamma = 0;
    let maxGammaStrike = 0;
    let maxGammaType: 'CE' | 'PE' = 'CE';
    const gammaWallStrikes: number[] = [];

    const allLegs: Array<{ gamma: number; strike: number; type: 'CE' | 'PE' }> = [];

    for (const s of context.strikes) {
      allLegs.push({ gamma: s.ce.gamma, strike: s.strike, type: 'CE' });
      allLegs.push({ gamma: s.pe.gamma, strike: s.strike, type: 'PE' });

      totalGamma += s.ce.gamma + s.pe.gamma;

      if (s.ce.gamma > maxGamma) {
        maxGamma = s.ce.gamma;
        maxGammaStrike = s.strike;
        maxGammaType = 'CE';
      }
      if (s.pe.gamma > maxGamma) {
        maxGamma = s.pe.gamma;
        maxGammaStrike = s.strike;
        maxGammaType = 'PE';
      }
    }

    const avgGamma = allLegs.reduce((s, l) => s + l.gamma, 0) / Math.max(allLegs.length, 1);

    // Gamma walls: strikes with gamma > 2x average
    for (const leg of allLegs) {
      if (leg.gamma > avgGamma * 2) {
        gammaWallStrikes.push(leg.strike);
      }
    }

    // Expiry boost
    const daysToExpiry = context.minutesToExpiry / (60 * 6.5);
    let expiryBoost = 1.0;
    if (context.isExpiryDay) expiryBoost = 2.5;
    else if (daysToExpiry <= 1) expiryBoost = 2.0;
    else if (daysToExpiry <= 2) expiryBoost = 1.5;
    else if (daysToExpiry <= 5) expiryBoost = 1.2;

    // Dealer net position: call gamma vs put gamma
    const totalCallGamma = context.strikes.reduce((acc, strike) => acc + strike.ce.gamma * strike.ce.oi, 0);
    const totalPutGamma = context.strikes.reduce((acc, strike) => acc + strike.pe.gamma * strike.pe.oi, 0);

    let dealerNetPosition: 'LONG_GAMMA' | 'SHORT_GAMMA' | 'NEUTRAL' = 'NEUTRAL';
    if (totalCallGamma > totalPutGamma * 1.2) dealerNetPosition = 'LONG_GAMMA';
    else if (totalPutGamma > totalCallGamma * 1.2) dealerNetPosition = 'SHORT_GAMMA';

    return {
      totalGammaPressure: Math.round(totalGamma * 10000) / 10000,
      maxGammaStrike,
      maxGammaType,
      dealerNetPosition,
      gammaWallStrikes,
      expiryBoost,
    };
  }

  // ─── Calculate Dealer Hedging Flow ───────────────────────────────────
  // Returns expected dealer buy/sell pressure at each strike
  calculateDealerHedgingFlow(context: {
    strikes: Array<{
      strike: number;
      ce: { gamma: number; delta: number; oi: number; oiChange: number };
      pe: { gamma: number; delta: number; oi: number; oiChange: number };
    }>;
    spot: number;
    priceChange: number; // spot price change
  }): Array<{
    strike: number;
    type: 'CE' | 'PE';
    expectedFlow: 'BUY' | 'SELL' | 'NEUTRAL';
    pressure: number; // 0-100
    reason: string;
  }> {
    const flows: Array<{
      strike: number;
      type: 'CE' | 'PE';
      expectedFlow: 'BUY' | 'SELL' | 'NEUTRAL';
      pressure: number;
      reason: string;
    }> = [];

    for (const s of context.strikes) {
      // CE leg
      const ceGamma = s.ce.gamma;
      const ceOIChange = s.ce.oiChange;
      const ceDelta = s.ce.delta;

      if (ceGamma > 0.0005) {
        // Dealer hedging: short gamma = sell when price up, buy when price down
        // But if OI increasing, someone is buying calls
        if (ceOIChange > 0 && context.priceChange > 0) {
          // Long buildup + price up = dealers likely short, hedging by selling
          flows.push({
            strike: s.strike,
            type: 'CE',
            expectedFlow: 'SELL',
            pressure: Math.min(100, ceGamma * 10000 * Math.abs(context.priceChange)),
            reason: 'Long call buildup + price up → dealer short gamma hedging',
          });
        } else if (ceOIChange < 0 && context.priceChange > 0) {
          flows.push({
            strike: s.strike,
            type: 'CE',
            expectedFlow: 'BUY',
            pressure: Math.min(100, ceGamma * 5000 * Math.abs(context.priceChange)),
            reason: 'Call OI decrease + price up → short covering / dealer buying back',
          });
        }
      }

      // PE leg
      const peGamma = s.pe.gamma;
      const peOIChange = s.pe.oiChange;

      if (peGamma > 0.0005) {
        if (peOIChange > 0 && context.priceChange < 0) {
          flows.push({
            strike: s.strike,
            type: 'PE',
            expectedFlow: 'SELL',
            pressure: Math.min(100, peGamma * 10000 * Math.abs(context.priceChange)),
            reason: 'Long put buildup + price down → dealer short gamma hedging',
          });
        } else if (peOIChange < 0 && context.priceChange < 0) {
          flows.push({
            strike: s.strike,
            type: 'PE',
            expectedFlow: 'BUY',
            pressure: Math.min(100, peGamma * 5000 * Math.abs(context.priceChange)),
            reason: 'Put OI decrease + price down → short covering / dealer buying back',
          });
        }
      }
    }

    return flows.sort((a, b) => b.pressure - a.pressure);
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<{ atmThreshold: number; nearATMThreshold: number; gammaWallMultiplier: number }>): void {
    if (config.atmThreshold) this.config.atmThreshold = config.atmThreshold;
    if (config.nearATMThreshold) this.config.nearATMThreshold = config.nearATMThreshold;
    if (config.gammaWallMultiplier) this.config.gammaWallMultiplier = config.gammaWallMultiplier;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let gammaPressureEngineInstance: GammaPressureEngine | null = null;

export function getGammaPressureEngine(): GammaPressureEngine {
  if (!gammaPressureEngineInstance) {
    gammaPressureEngineInstance = new GammaPressureEngine();
  }
  return gammaPressureEngineInstance;
}

// ─── Helper: Calculate Distance from ATM ──────────────────────────────
export function distanceFromATM(strike: number, atmStrike: number): number {
  return Math.abs(strike - atmStrike);
}

// ─── Helper: Is ATM ───────────────────────────────────────────────────
export function isATM(strike: number, atmStrike: number, threshold: number = 50): boolean {
  return Math.abs(strike - atmStrike) <= threshold;
}

// ─── Helper: Is Near ATM ──────────────────────────────────────────────
export function isNearATM(strike: number, atmStrike: number, threshold: number = 200): boolean {
  return Math.abs(strike - atmStrike) <= threshold;
}