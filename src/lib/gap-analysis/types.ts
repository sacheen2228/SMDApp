export type GapDirection = "UP" | "FLAT" | "DOWN";

export type DataAvailability = "AVAILABLE" | "ESTIMATED" | "MISSING";

export interface FactorContribution {
  name: string;
  score: number;
  weight: number;
  weightedScore: number;
  explanation: string;
  dataStatus: DataAvailability;
}

export interface GapInput {
  prevClose: number | null;
  currentSpot: number | null;
  currentFutures: number | null;
  giftNiftyPrice: number | null;
  giftNiftyPrevClose: number | null;
  indiaVIX: number | null;
  pcrOI: number | null;
  pcrVolume: number | null;
  maxPain: number | null;
  ceOIChange: number | null;
  peOIChange: number | null;
  optionIV: number | null;
  futuresPremium: number | null;
  breadth: number | null;
  atr: number | null;
  vwapDistance: number | null;

  fiiNet: number | null;
  diiNet: number | null;
  usMarketChange: number | null;
  asianMarketChange: number | null;
  usdinr: number | null;
  crudeChange: number | null;
  newsRiskScore: number | null;
  economicCalendarRisk: number | null;

  historicalGapUpPct: number | null;
  historicalGapDownPct: number | null;
  historicalGapStats: HistoricalGapStats | null;

  timestamp: string;
  symbol: string;
}

export interface HistoricalGapStats {
  meanGap: number;
  stdGap: number;
  gapUpProb: number;
  gapDownProb: number;
  medianGapUp: number;
  medianGapDown: number;
  last20Accuracy: number;
  totalSamples: number;
}

export interface GapWeights {
  giftNifty: number;
  futuresPremium: number;
  pcrOI: number;
  oiBuildup: number;
  maxPainDistance: number;
  vwapDistance: number;
  atr: number;
  vix: number;
  breadth: number;
  globalCues: number;
  expectedMove: number;
  historicalStats: number;
}

export const DEFAULT_WEIGHTS: GapWeights = {
  giftNifty: 0.18,
  futuresPremium: 0.12,
  pcrOI: 0.10,
  oiBuildup: 0.10,
  maxPainDistance: 0.08,
  vwapDistance: 0.06,
  atr: 0.05,
  vix: 0.07,
  breadth: 0.05,
  globalCues: 0.07,
  expectedMove: 0.06,
  historicalStats: 0.06,
};

export interface GapPrediction {
  prediction: GapDirection;
  probability: number;
  confidence: number;
  maxConfidence: number;
  confidenceCapped: boolean;
  insufficientData: boolean;
  missingFields: string[];
  score: number;
  factors: FactorContribution[];
  bullScore: number;
  bearScore: number;
  neutralScore: number;
}

export interface HistoricalRecord {
  date: string;
  prevClose: number;
  openPrice: number;
  actualGap: number;
  actualGapPct: number;
  actualDirection: GapDirection;
  predictedDirection: GapDirection | null;
  predictedProbability: number | null;
  correct: boolean | null;
  factors: FactorContribution[] | null;
}

export interface ValidationResult {
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  confusionMatrix: {
    upTP: number; upFP: number; upFN: number;
    downTP: number; downFP: number; downFN: number;
    flatTP: number; flatFP: number; flatFN: number;
  };
  avgError: number;
  maxError: number;
  worstPredictions: HistoricalRecord[];
  bestPredictions: HistoricalRecord[];
  byDirection: Record<GapDirection, { total: number; correct: number; accuracy: number }>;
}
