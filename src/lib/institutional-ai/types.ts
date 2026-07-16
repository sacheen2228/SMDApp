// ─── OptionChainInstitutionalAI — Type Definitions ─────────────────
// All interfaces for the institutional breakout prediction engine.

/** OHLCV candle data */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Option chain data for a single strike */
export interface OptionData {
  strike: number;
  callOI: number;
  putOI: number;
  callOIChange: number;
  putOIChange: number;
  callVolume: number;
  putVolume: number;
  callIV: number;
  putIV: number;
}

/** Main input to the AI engine */
export interface Input {
  candles: Candle[];
  optionChain: OptionData[];
  spotPrice: number;
}

/** Detected support/resistance level */
export interface PriceLevel {
  price: number;
  strength: number;
  touches: number;
  isBreakout: boolean;
  direction: "ABOVE" | "BELOW";
}

/** Breakout detection result */
export interface BreakoutResult {
  detected: boolean;
  direction: "BULLISH" | "BEARISH" | "NONE";
  breakoutPrice: number;
  supportLevels: PriceLevel[];
  resistanceLevels: PriceLevel[];
  nearestSupport: number;
  nearestResistance: number;
  candleConfirmation: boolean;
  score: number;
}

/** Option chain activity classification */
export type OptionActivity =
  | "CALL_WRITING"
  | "PUT_WRITING"
  | "CALL_SHORT_COVERING"
  | "PUT_SHORT_COVERING"
  | "CALL_UNWINDING"
  | "PUT_UNWINDING"
  | "FRESH_LONG"
  | "FRESH_SHORT"
  | "NEUTRAL";

/** Detected option activity at a strike */
export interface OptionActivityResult {
  strike: number;
  activity: OptionActivity;
  confidence: number;
  details: string;
}

/** Full option chain analysis */
export interface OptionAnalysisResult {
  activities: OptionActivityResult[];
  callWritingScore: number;
  putWritingScore: number;
  shortCoveringScore: number;
  unwindingScore: number;
  freshLongScore: number;
  freshShortScore: number;
  overallBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  biasStrength: number;
}

/** PCR analysis result */
export interface PCRResult {
  value: number;
  classification: "BULLISH" | "BEARISH" | "NEUTRAL";
  score: number;
  details: string;
}

/** Max OI analysis result */
export interface MaxOIResult {
  highestCallOI: { strike: number; oi: number };
  highestPutOI: { strike: number; oi: number };
  nearestResistance: number;
  nearestSupport: number;
  maxPain: number;
  score: number;
}

/** OI shift / migration detection */
export interface OIShiftResult {
  detected: boolean;
  direction: "BULLISH" | "BEARISH" | "NONE";
  fromStrike: number;
  toStrike: number;
  magnitude: number;
  score: number;
  details: string;
}

/** Volume analysis result */
export interface VolumeResult {
  totalCallVolume: number;
  totalPutVolume: number;
  relativeVolume: number;
  institutionalVolume: boolean;
  volumeSpike: boolean;
  score: number;
  details: string;
}

/** IV analysis result */
export interface IVResult {
  averageCallIV: number;
  averagePutIV: number;
  ivExpansion: boolean;
  ivCrush: boolean;
  ivSkew: number;
  score: number;
  details: string;
}

/** Individual confidence component scores */
export interface ConfidenceScores {
  breakoutScore: number;
  trendScore: number;
  liquidityScore: number;
  volumeScore: number;
  callWritingScore: number;
  putWritingScore: number;
  pcrScore: number;
  ivScore: number;
  oiShiftScore: number;
  maxOIScore: number;
  total: number;
}

/** Final trade signal output */
export interface TradeSignal {
  direction: "BUY" | "SELL" | "NO_TRADE";
  confidence: number;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  breakoutScore: number;
  trendScore: number;
  volumeScore: number;
  optionScore: number;
  liquidityScore: number;
  probability: number;
  reasons: string[];
  warnings: string[];
}

/** Internal analysis context passed between modules */
export interface AnalysisContext {
  input: Input;
  breakout: BreakoutResult;
  optionAnalysis: OptionAnalysisResult;
  pcr: PCRResult;
  maxOI: MaxOIResult;
  oiShift: OIShiftResult;
  volume: VolumeResult;
  iv: IVResult;
  trendScore: number;
}
