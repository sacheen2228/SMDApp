// ─── OptionChainInstitutionalAI — Barrel Export ────────────────────
export { OptionChainInstitutionalAI } from "./OptionChainInstitutionalAI";
export { detectBreakout } from "./BreakoutDetector";
export { analyzeOptionChain } from "./OptionAnalyzer";
export { calculatePCR } from "./PCR";
export { analyzeMaxOI } from "./MaxOI";
export { detectOIShift } from "./OIShift";
export { analyzeVolume } from "./VolumeAnalyzer";
export { analyzeIV } from "./IVAnalyzer";
export { analyzeTrend } from "./TrendAnalyzer";
export { calculateConfidence, resolveDirection, isTradeable } from "./ConfidenceEngine";
export { generateTrade } from "./TradeGenerator";

export type {
  Candle,
  OptionData,
  Input,
  TradeSignal,
  BreakoutResult,
  OptionAnalysisResult,
  OptionActivityResult,
  PCRResult,
  MaxOIResult,
  OIShiftResult,
  VolumeResult,
  IVResult,
  ConfidenceScores,
  AnalysisContext,
  PriceLevel,
  OptionActivity,
} from "./types";

export { CONFIDENCE_WEIGHTS, MIN_CONFIDENCE, BREAKOUT_CONFIG, OPTION_CONFIG, IV_CONFIG, VOLUME_CONFIG, TRADE_CONFIG, TREND_CONFIG } from "./config";
