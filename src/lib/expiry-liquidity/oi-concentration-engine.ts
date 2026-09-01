// ─── OI Concentration Engine ────────────────────────────────────────────
// Analyzes OI concentration at strikes, identifies major support/resistance

import { OIConcentrationAnalysis } from './types';

interface OIConcentrationConfig {
  concentrationWindow: number; // top N strikes to consider
  majorWallThreshold: number;   // % of total OI for "major" wall
}

class OIConcentrationEngine {
  private config: OIConcentrationConfig = {
    concentrationWindow: 3,
    majorWallThreshold: 0.15, // 15% of total OI
  };

  // ─── Calculate OI Concentration ──────────────────────────────────────
  calculate(context: {
    strikes: Array<{
      strike: number;
      ce: { oi: number; oiChange: number; volume: number };
      pe: { oi: number; oiChange: number; volume: number };
    }>;
    spot: number;
    atmStrike: number;
  }): OIConcentrationAnalysis {
    const { strikes, spot, atmStrike } = context;

    // Total OI
    const totalCallOI = strikes.reduce((acc, strike) => acc + strike.ce.oi, 0);
    const totalPutOI = strikes.reduce((acc, strike) => acc + strike.pe.oi, 0);
    const totalOI = totalCallOI + totalPutOI;

    // Find highest OI strikes
    const sortedCallOI = [...strikes].sort((a, b) => b.ce.oi - a.ce.oi);
    const sortedPutOI = [...strikes].sort((a, b) => b.pe.oi - a.pe.oi);

    const highestCallOIStrike = sortedCallOI[0]?.strike || spot;
    const highestCallOI = sortedCallOI[0]?.ce.oi || 0;
    const highestPutOIStrike = sortedPutOI[0]?.strike || spot;
    const highestPutOI = sortedPutOI[0]?.pe.oi || 0;

    // OI Concentration
    const topCallOI = sortedCallOI.slice(0, this.config.concentrationWindow)
      .reduce((acc, strike) => acc + strike.ce.oi, 0);
    const topPutOI = sortedPutOI.slice(0, this.config.concentrationWindow)
      .reduce((acc, strike) => acc + strike.pe.oi, 0);

    const callOIConcentration = totalCallOI > 0 ? topCallOI / totalCallOI : 0;
    const putOIConcentration = totalPutOI > 0 ? topPutOI / totalPutOI : 0;

    // ATM OI Concentration
    const atmStrikes = strikes.filter(s =>
      Math.abs(s.strike - atmStrike) <= 100
    );
    const atmCallOI = atmStrikes.reduce((acc, strike) => acc + strike.ce.oi, 0);
    const atmPutOI = atmStrikes.reduce((acc, strike) => acc + strike.pe.oi, 0);
    const atmOIConcentration = totalOI > 0 ? (atmCallOI + atmPutOI) / totalOI : 0;

    // Major resistance/support from OI walls
    const resistanceStrikes: number[] = [];
    const supportStrikes: number[] = [];

    for (const s of context.strikes) {
      // Major call OI wall = resistance
      if (totalCallOI > 0 && s.ce.oi / totalCallOI > 0.1) {
        resistanceStrikes.push(s.strike);
      }
      // Major put OI wall = support
      if (totalPutOI > 0 && s.pe.oi / totalPutOI > 0.1) {
        supportStrikes.push(s.strike);
      }
    }

    // Strength maps
    const resistanceStrength = new Map<number, number>();
    const supportStrength = new Map<number, number>();

    for (const s of context.strikes) {
      if (totalCallOI > 0) {
        resistanceStrength.set(s.strike, Math.round((s.ce.oi / totalCallOI) * 10000) / 100);
      }
      if (totalPutOI > 0) {
        supportStrength.set(s.strike, Math.round((s.pe.oi / totalPutOI) * 10000) / 100);
      }
    }

    // Rapid unwinding detection
    let rapidUnwinding = false;
    const unwindingStrikes: number[] = [];

    for (const s of context.strikes) {
      const callUnwinding = s.ce.oiChange < -s.ce.oi * 0.05; // >5% drop
      const putUnwinding = s.pe.oiChange < -s.pe.oi * 0.05;

      if (callUnwinding || putUnwinding) {
        rapidUnwinding = true;
        unwindingStrikes.push(s.strike);
      }
    }

    // Major resistance/support (top 3)
    const majorResistanceStrikes = [...context.strikes]
      .filter(s => totalCallOI > 0 && s.ce.oi / totalCallOI > 0.05)
      .sort((a, b) => b.ce.oi - a.ce.oi)
      .slice(0, 3)
      .map(s => s.strike);

    const majorSupportStrikes = [...context.strikes]
      .filter(s => totalPutOI > 0 && s.pe.oi / totalPutOI > 0.05)
      .sort((a, b) => b.pe.oi - a.pe.oi)
      .slice(0, 3)
      .map(s => s.strike);

    return {
      highestCallOIStrike,
      highestCallOI,
      highestPutOIStrike,
      highestPutOI,
      callOIConcentration: Math.round(callOIConcentration * 10000) / 100,
      putOIConcentration: Math.round(putOIConcentration * 10000) / 100,
      atmOIConcentration: Math.round(atmOIConcentration * 10000) / 100,
      resistanceStrength,
      supportStrength,
      rapidUnwinding,
      unwindingStrikes,
      majorResistanceStrikes,
      majorSupportStrikes,
    };
  }

  // ─── Get OI Walls Near Spot ──────────────────────────────────────────
  getOIWallsNearSpot(context: {
    strikes: Array<{
      strike: number;
      ce: { oi: number; oiChange: number };
      pe: { oi: number; oiChange: number };
    }>;
    spot: number;
    range: number; // points around spot
  }): {
    resistance: Array<{ strike: number; oi: number; distance: number }>;
    support: Array<{ strike: number; oi: number; distance: number }>;
  } {
    const { strikes, spot, range } = context;

    const resistance = context.strikes
      .filter(s => s.strike > spot && s.strike <= spot + range)
      .filter(s => s.ce.oi > 0)
      .map(s => ({
        strike: s.strike,
        oi: s.ce.oi,
        distance: s.strike - spot,
      }))
      .sort((a, b) => b.oi - a.oi)
      .slice(0, 5);

    const support = context.strikes
      .filter(s => s.strike < spot && s.strike >= spot - range)
      .filter(s => s.pe.oi > 0)
      .map(s => ({
        strike: s.strike,
        oi: s.pe.oi,
        distance: spot - s.strike,
      }))
      .sort((a, b) => b.oi - a.oi)
      .slice(0, 5);

    return { resistance, support };
  }

  // ─── Detect Rapid Unwinding ──────────────────────────────────────────
  detectRapidUnwinding(context: {
    strikes: Array<{
      strike: number;
      ce: { oi: number; oiChange: number; oiChangePct: number };
      pe: { oi: number; oiChange: number; oiChangePct: number };
    }>;
    threshold: number; // % change threshold
  }): Array<{
    strike: number;
    type: 'CE' | 'PE';
    changePct: number;
    direction: 'UNWINDING';
  }> {
    const results: Array<{
      strike: number;
      type: 'CE' | 'PE';
      changePct: number;
      direction: 'UNWINDING';
    }> = [];

    for (const s of context.strikes) {
      if (s.ce.oiChangePct < -context.threshold) {
        results.push({
          strike: s.strike,
          type: 'CE',
          changePct: s.ce.oiChangePct,
          direction: 'UNWINDING',
        });
      }
      if (s.pe.oiChangePct < -context.threshold) {
        results.push({
          strike: s.strike,
          type: 'PE',
          changePct: s.pe.oiChangePct,
          direction: 'UNWINDING',
        });
      }
    }

    return results.sort((a, b) => a.changePct - b.changePct);
  }

  // ─── Configure ───────────────────────────────────────────────────────
  configure(config: Partial<{ concentrationWindow: number; majorWallThreshold: number }>): void {
    if (config.concentrationWindow) this.config.concentrationWindow = config.concentrationWindow;
    if (config.majorWallThreshold) this.config.majorWallThreshold = config.majorWallThreshold;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let oiConcentrationEngineInstance: OIConcentrationEngine | null = null;

export function getOIConcentrationEngine(): OIConcentrationEngine {
  if (!oiConcentrationEngineInstance) {
    oiConcentrationEngineInstance = new OIConcentrationEngine();
  }
  return oiConcentrationEngineInstance;
}