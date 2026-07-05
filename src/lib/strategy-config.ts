// ═══════════════════════════════════════════════════════════════════
// Strategy Configuration — All tunable parameters for ORCA Engine
// Admin panel can modify these, ORCA engine reads from here
// Persisted to localStorage + can be exported/imported as JSON
// ═══════════════════════════════════════════════════════════════════

// ─── Confidence Thresholds ──────────────────────────────────────
export interface ConfidenceConfig {
  /** Minimum confidence to trigger BUY_CALL or BUY_PUT (0-100) */
  entryThreshold: number;
  /** Minimum confidence for 0DTE trades (higher than normal) */
  zeroDteThreshold: number;
  /** Cancel recommendation if confidence drops below this */
  cancelThreshold: number;
  /** Weights for confidence scoring (must sum to 100) */
  weights: {
    trend: number;
    oi: number;
    greeks: number;
    liquidity: number;
    volume: number;
    priceAction: number;
    institutionalFlow: number;
  };
}

// ─── Entry Conditions ───────────────────────────────────────────
export interface EntryConfig {
  /** CALL: Spot must be above VWAP */
  callRequireAboveVwap: boolean;
  /** PUT: Spot must be below VWAP */
  putRequireBelowVwap: boolean;
  /** Minimum volume increase required (%) */
  minVolumeIncrease: number;
  /** Maximum spread allowed (% of premium) */
  maxSpreadPct: number;
  /** Minimum OI change for "long buildup" detection */
  minOIChangeForBuildup: number;
  /** Fresh writing threshold (OI change) */
  freshWritingThreshold: number;
  /** Fresh writing max premium (CE/PE written if premium below this) */
  freshWritingMaxPremium: number;
  /** Require institutional flow for entry */
  requireInstitutionalFlow: boolean;
  /** Require volume spike for entry */
  requireVolumeSpike: boolean;
}

// ─── Greeks Thresholds ──────────────────────────────────────────
export interface GreeksConfig {
  /** Gamma flip detection sensitivity (distance from spot %) */
  gammaFlipSensitivity: number;
  /** IV percentile above this = "IV expansion" */
  ivExpansionThreshold: number;
  /** IV percentile below this = "IV crush" */
  ivCrushThreshold: number;
  /** Theta decay rate above this = "rapid burn" */
  rapidThetaBurnThreshold: number;
  /** Delta acceleration threshold */
  deltaAccelerationThreshold: number;
  /** Gamma squeeze: max distance from gamma flip (%) */
  gammaSqueezeMaxDistance: number;
  /** Gamma squeeze: minimum ATM gamma */
  gammaSqueezeMinGamma: number;
}

// ─── OI Analysis Thresholds ─────────────────────────────────────
export interface OIConfig {
  /** PCR above this = bullish (put writing = support) */
  pcrBullishThreshold: number;
  /** PCR below this = bearish (call writing = resistance) */
  pcrBearishThreshold: number;
  /** OI change threshold for "long buildup" detection */
  buildupThreshold: number;
  /** OI change threshold for "unwinding" detection */
  unwindingThreshold: number;
  /** Large order threshold (volume) */
  largeOrderThreshold: number;
  /** Unusual volume threshold (multiple of average) */
  unusualVolumeMultiplier: number;
}

// ─── Smart Money Thresholds ─────────────────────────────────────
export interface SmartMoneyConfig {
  /** Liquidity sweep: % of range to detect sweep */
  sweepRangePercent: number;
  /** Fake breakout: range expansion multiplier */
  fakeoutExpansionMultiplier: number;
  /** Stop hunt detection sensitivity */
  stopHuntSensitivity: number;
}

// ─── Risk Management ────────────────────────────────────────────
export interface RiskConfig {
  /** Stop loss as % of premium */
  slPercent: number;
  /** Target 1 as multiplier of premium */
  tp1Multiplier: number;
  /** Target 2 as multiplier of premium */
  tp2Multiplier: number;
  /** Target 3 as multiplier of premium */
  tp3Multiplier: number;
  /** Maximum risk per trade (% of capital) */
  maxRiskPerTrade: number;
  /** Maximum concurrent positions */
  maxPositions: number;
  /** Maximum daily loss (% of capital) */
  maxDailyLoss: number;
  /** Trailing stop activation (% profit) */
  trailingStopActivation: number;
  /** Move SL to cost after (% profit) */
  moveToCostAfter: number;
  /** Book 25% at (% profit) */
  bookPartialAt1: number;
  /** Book another 25% at (% profit) */
  bookPartialAt2: number;
}

// ─── Strike Selection ───────────────────────────────────────────
export interface StrikeConfig {
  /** How far OTM to go for low confidence (1 = 1 strike, 2 = 2 strikes) */
  otmForLowConfidence: number;
  /** How far ITM to go for high confidence */
  itmForHighConfidence: number;
  /** Preferred strike type: ATM, ITM, OTM */
  preferredStrikeType: "ATM" | "ITM" | "OTM" | "AUTO";
}

// ─── Market Hours / Session ─────────────────────────────────────
export interface SessionConfig {
  /** Avoid trading in first N minutes after open */
  avoidFirstMinutes: number;
  /** Avoid trading in last N minutes before close */
  avoidLastMinutes: number;
  /** Lunch session: avoid trading between these times */
  lunchStart: string;
  lunchEnd: string;
  /** Best trading windows (start, end) */
  bestWindows: { start: string; end: string }[];
}

// ─── Symbol-Specific Overrides ──────────────────────────────────
export interface SymbolOverride {
  symbol: string;
  /** Override lot size */
  lotSize?: number;
  /** Override typical premium */
  typicalPremium?: number;
  /** Override max lots */
  maxLots?: number;
  /** Symbol-specific confidence override */
  confidenceOverride?: number;
  /** Enable/disable trading for this symbol */
  enabled: boolean;
}

// ─── Master Strategy Config ─────────────────────────────────────
export interface StrategyConfig {
  /** Config version for migrations */
  version: number;
  /** Config name */
  name: string;
  /** Last modified */
  lastModified: string;
  /** Module toggles — enable/disable individual modules */
  modules: {
    marketStructure: boolean;
    greeks: boolean;
    openInterest: boolean;
    smartMoney: boolean;
    optionFlow: boolean;
    entryConditions: boolean;
    riskEngine: boolean;
    confidenceEngine: boolean;
    zeroDte: boolean;
    alerts: boolean;
  };
  /** Sub-configs */
  confidence: ConfidenceConfig;
  entry: EntryConfig;
  greeks: GreeksConfig;
  oi: OIConfig;
  smartMoney: SmartMoneyConfig;
  risk: RiskConfig;
  strike: StrikeConfig;
  session: SessionConfig;
  /** Symbol-specific overrides */
  symbolOverrides: SymbolOverride[];
}

// ─── Default Configuration ──────────────────────────────────────
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  version: 1,
  name: "Default ORCA Strategy",
  lastModified: new Date().toISOString(),
  modules: {
    marketStructure: true,
    greeks: true,
    openInterest: true,
    smartMoney: true,
    optionFlow: true,
    entryConditions: true,
    riskEngine: true,
    confidenceEngine: true,
    zeroDte: true,
    alerts: true,
  },
  confidence: {
    entryThreshold: 85,
    zeroDteThreshold: 92,
    cancelThreshold: 70,
    weights: {
      trend: 20,
      oi: 20,
      greeks: 20,
      liquidity: 15,
      volume: 10,
      priceAction: 10,
      institutionalFlow: 5,
    },
  },
  entry: {
    callRequireAboveVwap: true,
    putRequireBelowVwap: true,
    minVolumeIncrease: 10,
    maxSpreadPct: 5,
    minOIChangeForBuildup: 50000,
    freshWritingThreshold: 100000,
    freshWritingMaxPremium: 5,
    requireInstitutionalFlow: false,
    requireVolumeSpike: false,
  },
  greeks: {
    gammaFlipSensitivity: 0.3,
    ivExpansionThreshold: 70,
    ivCrushThreshold: 30,
    rapidThetaBurnThreshold: 2,
    deltaAccelerationThreshold: 0.1,
    gammaSqueezeMaxDistance: 0.2,
    gammaSqueezeMinGamma: 0.001,
  },
  oi: {
    pcrBullishThreshold: 1.2,
    pcrBearishThreshold: 0.8,
    buildupThreshold: 50000,
    unwindingThreshold: 50000,
    largeOrderThreshold: 100000,
    unusualVolumeMultiplier: 3,
  },
  smartMoney: {
    sweepRangePercent: 15,
    fakeoutExpansionMultiplier: 1.5,
    stopHuntSensitivity: 0.5,
  },
  risk: {
    slPercent: 35,
    tp1Multiplier: 1.5,
    tp2Multiplier: 2.2,
    tp3Multiplier: 3.5,
    maxRiskPerTrade: 1,
    maxPositions: 3,
    maxDailyLoss: 3,
    trailingStopActivation: 40,
    moveToCostAfter: 20,
    bookPartialAt1: 50,
    bookPartialAt2: 100,
  },
  strike: {
    otmForLowConfidence: 2,
    itmForHighConfidence: 1,
    preferredStrikeType: "AUTO",
  },
  session: {
    avoidFirstMinutes: 15,
    avoidLastMinutes: 15,
    lunchStart: "12:30",
    lunchEnd: "13:30",
    bestWindows: [
      { start: "09:30", end: "12:30" },
      { start: "14:30", end: "15:15" },
    ],
  },
  symbolOverrides: [
    { symbol: "NIFTY", enabled: true },
    { symbol: "BANKNIFTY", enabled: true },
    { symbol: "FINNIFTY", enabled: true },
    { symbol: "MIDCPNIFTY", enabled: true },
    { symbol: "SENSEX", enabled: true },
  ],
};

// ─── Config Store (localStorage) ────────────────────────────────
const CONFIG_KEY = "orca_strategy_config";

export function loadStrategyConfig(): StrategyConfig {
  if (typeof window === "undefined") return DEFAULT_STRATEGY_CONFIG;
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge with defaults to handle new fields
      return { ...DEFAULT_STRATEGY_CONFIG, ...parsed, lastModified: new Date().toISOString() };
    }
  } catch {}
  return { ...DEFAULT_STRATEGY_CONFIG, lastModified: new Date().toISOString() };
}

export function saveStrategyConfig(config: StrategyConfig): void {
  if (typeof window === "undefined") return;
  config.lastModified = new Date().toISOString();
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function resetStrategyConfig(): StrategyConfig {
  const config = { ...DEFAULT_STRATEGY_CONFIG, lastModified: new Date().toISOString() };
  if (typeof window !== "undefined") {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }
  return config;
}

export function exportStrategyConfig(config: StrategyConfig): string {
  return JSON.stringify(config, null, 2);
}

export function importStrategyConfig(json: string): StrategyConfig {
  const parsed = JSON.parse(json);
  return { ...DEFAULT_STRATEGY_CONFIG, ...parsed, lastModified: new Date().toISOString() };
}
