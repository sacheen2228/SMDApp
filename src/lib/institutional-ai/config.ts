// ─── OptionChainInstitutionalAI — Configuration ───────────────────
// All weights, thresholds, and tunable parameters in one place.

/** Confidence engine weights (must sum to 100) */
export const CONFIDENCE_WEIGHTS = {
  breakout: 20,
  trend: 15,
  liquidity: 15,
  volume: 10,
  callWriting: 10,
  putWriting: 10,
  pcr: 5,
  iv: 5,
  oiShift: 5,
  maxOI: 5,
} as const;

/** Minimum confidence to generate a trade signal */
export const MIN_CONFIDENCE = 70;

/** Breakout detection parameters */
export const BREAKOUT_CONFIG = {
  /** Number of candles to look back for S/R detection */
  lookbackPeriod: 20,
  /** Minimum touches to confirm a level */
  minTouches: 2,
  /** Price tolerance (%) for level proximity */
  levelTolerancePercent: 0.3,
  /** Required close beyond level for confirmation */
  confirmationBufferPercent: 0.1,
} as const;

/** Option chain analysis parameters */
export const OPTION_CONFIG = {
  /** OI change threshold (%) to classify as significant */
  oiChangeThresholdPercent: 5,
  /** Volume spike multiplier (vs average) */
  volumeSpikeMultiplier: 2.0,
  /** PCR ranges for classification */
  pcrBullish: 1.2,
  pcrBearish: 0.8,
  /** Fresh long/short OI change thresholds */
  freshLongThreshold: 10000,
  freshShortThreshold: 10000,
} as const;

/** IV analysis parameters */
export const IV_CONFIG = {
  /** IV expansion threshold (%) */
  expansionThresholdPercent: 10,
  /** IV crush threshold (%) */
  crushThresholdPercent: 10,
  /** Skew threshold for put/call IV difference */
  skewThreshold: 5,
} as const;

/** Volume analysis parameters */
export const VOLUME_CONFIG = {
  /** Periods to average for relative volume */
  averagePeriods: 20,
  /** Institutional volume threshold (absolute) */
  institutionalThreshold: 50000,
  /** Spike detection multiplier */
  spikeMultiplier: 2.0,
} as const;

/** Trade generation parameters — AI produces direction + confidence only.
 *  Actual option premium SL/TP is computed downstream in intraday-scanner
 *  (monthlyOptionTrade) since the engine receives a spot price, not a premium. */
export const TRADE_CONFIG = {
  /** Minimum confidence to flip a candidate into an AI-backed direction */
  minConfidence: 70,
  /** Below this, AI is treated as NO_TRADE (insufficient edge) */
  noTradeConfidence: 55,
} as const;

/** Trend detection parameters */
export const TREND_CONFIG = {
  /** EMA periods for trend */
  fastEMA: 9,
  slowEMA: 21,
  /** ADX threshold for trend strength */
  adxThreshold: 25,
  /** RSI overbought/oversold */
  rsiOverbought: 70,
  rsiOversold: 30,
} as const;
