// ─── Heatmap Confirmation Engine ─────────────────────────────────────────
// Uses heatmap sector/stock data to confirm or diverge from expiry signals

import { HeatmapConfirmation } from './types';

interface HeatmapConfirmationConfig {
  sectorThreshold: number;      // % change for sector leader/laggard
  stockThreshold: number;       // % change for stock leader/laggard
  leadershipThreshold: number;  // % of sectors moving together
}

class HeatmapConfirmationEngine {
  private config: HeatmapConfirmationConfig = {
    sectorThreshold: 1.0,
    stockThreshold: 1.5,
    leadershipThreshold: 0.6, // 60% of sectors same direction
  };

  // ─── Analyze Heatmap for Confirmation ────────────────────────────────
  analyze(context: {
    sectors: Array<{
      name: string;
      changePct: number;
      stocks: Array<{
        symbol: string;
        changePct: number;
        volume: number;
        ltp: number;
      }>;
      avgChangePct: number;
      advanceCount: number;
      declineCount: number;
    }>;
    niftyChangePct: number;
    bankNiftyChangePct: number;
  }): HeatmapConfirmation {
    const { sectors, niftyChangePct, bankNiftyChangePct } = context;

    // Sector strength map
    const sectorStrength = new Map<string, number>();
    for (const s of sectors) {
      sectorStrength.set(s.name, s.avgChangePct);
    }

    // Sector leaders/laggards
    const sortedSectors = [...context.sectors].sort((a, b) => b.avgChangePct - a.avgChangePct);
    const sectorLeaders = sortedSectors
      .filter(s => s.avgChangePct > this.config.sectorThreshold)
      .slice(0, 5)
      .map(s => s.name);
    const sectorLaggards = sortedSectors
      .filter(s => s.avgChangePct < -this.config.sectorThreshold)
      .slice(0, 5)
      .map(s => s.name);

    // Breadth expansion/contraction
    const totalSectors = sectors.length;
    const advancingSectors = sectors.filter(s => s.avgChangePct > 0).length;
    const decliningSectors = sectors.filter(s => s.avgChangePct < 0).length;

    const breadthExpansion = advancingSectors > decliningSectors * 1.5;
    const breadthContraction = decliningSectors > advancingSectors * 1.5;

    // Leadership style
    const advancingPct = sectors.length > 0 ? advancingSectors / sectors.length : 0;
    const decliningPct = sectors.length > 0 ? decliningSectors / sectors.length : 0;

    let leadership: 'ROTATING' | 'CONCENTRATED' | 'BROAD' | 'NARROW' = 'ROTATING';
    if (advancingPct > this.config.leadershipThreshold && decliningSectors === 0) {
      leadership = 'BROAD';
    } else if (advancingPct > this.config.leadershipThreshold) {
      leadership = 'CONCENTRATED';
    } else if (decliningSectors > this.config.leadershipThreshold) {
      leadership = 'NARROW';
    }

    // Heatmap alignment with index
    const niftyDirection = niftyChangePct > 0 ? 'UP' : niftyChangePct < 0 ? 'DOWN' : 'FLAT';
    const sectorDirection = advancingSectors > decliningSectors ? 'UP' :
      decliningSectors > advancingSectors ? 'DOWN' : 'FLAT';

    let heatmapAlignment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'DIVERGING' = 'NEUTRAL';
    if (niftyDirection === 'UP' && sectorDirection === 'UP') heatmapAlignment = 'BULLISH';
    else if (niftyDirection === 'DOWN' && sectorDirection === 'DOWN') heatmapAlignment = 'BEARISH';
    else if (niftyDirection !== 'FLAT' && sectorDirection !== 'FLAT' && niftyDirection !== sectorDirection) {
      heatmapAlignment = 'DIVERGING';
    }

    // Bank Nifty alignment (key for NIFTY)
    const bankAlignment = (bankNiftyChangePct > 0 && niftyChangePct > 0) ||
      (bankNiftyChangePct < 0 && niftyChangePct < 0);

    return {
      sectorStrength,
      sectorLeaders,
      sectorLaggards,
      breadthExpansion,
      breadthContraction,
      leadership,
      heatmapAlignment,
      bankAlignment,
      sectorBreadth: {
        advancing: advancingSectors,
        declining: decliningSectors,
        total: sectors.length,
      },
    };
  }

  // ─── Get Stock-Level Confirmation ────────────────────────────────────
  getStockConfirmation(context: {
    symbol: string;
    changePct: number;
    volume: number;
    sector: string;
    sectorChangePct: number;
    sectorAdvanceCount: number;
    sectorDeclineCount: number;
    sectorTotal: number;
  }): {
    aligned: boolean;
    relativeStrength: number; // stock vs sector
    sectorLeadership: 'LEADER' | 'LAGGARD' | 'NEUTRAL';
    volumeConfirmation: boolean;
  } {
    const { changePct, sectorChangePct, sectorAdvanceCount, sectorDeclineCount, sectorTotal } = context;

    const relativeStrength = changePct - sectorChangePct;
    const sectorBreadth = sectorTotal > 0 ? (sectorAdvanceCount - sectorDeclineCount) / sectorTotal : 0;

    const aligned = (changePct > 0 && sectorChangePct > 0) ||
      (changePct < 0 && sectorChangePct < 0);

    let sectorLeadership: 'LEADER' | 'LAGGARD' | 'NEUTRAL' = 'NEUTRAL';
    if (relativeStrength > 1) sectorLeadership = 'LEADER';
    else if (relativeStrength < -1) sectorLeadership = 'LAGGARD';

    return {
      aligned,
      relativeStrength: Math.round(relativeStrength * 100) / 100,
      sectorLeadership,
      volumeConfirmation: false, // would need volume data
    };
  }

  // ─── Configure ───────────────────────────────────────────────────────
  configure(config: Partial<{ sectorThreshold: number; stockThreshold: number; leadershipThreshold: number }>): void {
    if (config.sectorThreshold) this.config.sectorThreshold = config.sectorThreshold;
    if (config.stockThreshold) this.config.stockThreshold = config.stockThreshold;
    if (config.leadershipThreshold) this.config.leadershipThreshold = config.leadershipThreshold;
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────
let heatmapConfirmationEngineInstance: HeatmapConfirmationEngine | null = null;

export function getHeatmapConfirmationEngine(): HeatmapConfirmationEngine {
  if (!heatmapConfirmationEngineInstance) {
    heatmapConfirmationEngineInstance = new HeatmapConfirmationEngine();
  }
  return heatmapConfirmationEngineInstance;
}