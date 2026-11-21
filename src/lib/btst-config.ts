export const BTST_CONFIG = {
  scoring: {
    weights: {
      closeStrength: 15,
      breakout: 15,
      volumeVs20d: 15,
      deliveryPct: 10,
      fnoBuildup: 15,
      stockPcrOiChange: 5,
      sectorStrength: 10,
      relativeStrength: 10,
      institutionalAlignment: 5,
    },
    hardFilters: {
      minAvgTurnoverCr: 10,
      minRelativeVolume: 0.8,
      minDeliveryPct: 35,
      excludeBan: true,
      excludeCircuit: true,
      excludeResultsTomorrow: true,
    },
    marketGate: {
      niftyTrendMinScore: 55,
      maxIndiaVix: 22,
      globalCuesWeight: 0.2,
    },
    verdict: {
      buyThreshold: 75,
      watchMin: 60,
      maxGradeWhenConflict: "B",
      conflictAlignmentThreshold: 60,
    },
  },
  tradePlan: {
    slModel: "ATR",
    atrMultiplier: 1.2,
    slMinPct: 0.008,
    slMaxPct: 0.025,
    // The targets are R MULTIPLES of the stop distance (the plan's own risk),
    // so the R:R is exactly 1:2 / 1:3 by construction (user directive
    // 2026-11-21: minimum 1:2, 1:3/1:4 only on confirmation).
    tp1Mult: 2,
    tp2Mult: 3,
    expectedMoveFromATR: 1.4,
    minRR: 2,
    capitalPerTrade: 20000,
    riskPctOfDeployed: 0.20,
  },
  universe: {
    includeFNO: true,
    includeNifty500: true,
    avgTurnoverDays: 20,
  },
} as const;
