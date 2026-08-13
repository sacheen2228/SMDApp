export interface EngineScore {
  score: number;
  confidence: number;
  bullishProb: number;
  bearishProb: number;
  neutralProb: number;
  reasons: string[];
}

export interface TrendData {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  adx: number;
  plusDI: number;
  minusDI: number;
  trendStrength: number;
}

export interface OrderFlowData {
  cumDelta: number;
  deltaPercent: number;
  aggressiveBuys: number;
  aggressiveSells: number;
  bidAskRatio: number;
  stackedBids: number;
  stackedAsks: number;
  largeOrders: number;
  absorption: boolean;
  exhaustion: boolean;
}

export interface LiquidityData {
  domImbalance: number;
  bidWalls: number;
  askWalls: number;
  largestBid: number;
  largestAsk: number;
  sweepDetected: boolean;
  liquidityVoid: boolean;
}

export interface SmartMoneyData {
  bos: 'bullish' | 'bearish' | null;
  externalBos: boolean;
  internalBos: boolean;
  choch: 'bullish' | 'bearish' | null;
  liquiditySweep: boolean;
  equalHigh: boolean;
  equalLow: boolean;
  orderBlock: { price: number; type: 'bullish' | 'bearish' } | null;
  mitigationBlock: { price: number; type: 'bullish' | 'bearish' } | null;
  breakerBlock: { price: number; type: 'bullish' | 'bearish' } | null;
  fvg: { upper: number; lower: number; type: 'bullish' | 'bearish' } | null;
  premiumZone: { upper: number; lower: number } | null;
  discountZone: { upper: number; lower: number } | null;
  ote: { entry: number; stop: number; tp: number } | null;
  swingHigh: number[];
  swingLow: number[];
}

export interface OpenInterestData {
  currentOi: number | null;
  oi5m: number | null;
  oi15m: number | null;
  oi1h: number | null;
  oi4h: number | null;
  oi24h: number | null;
  oiChange: number | null;
  oiMomentum: number | null;
  longBuildUp: boolean;
  shortBuildUp: boolean;
  shortCovering: boolean;
  longUnwinding: boolean;
  oiTrend: 'rising' | 'falling' | 'neutral';
}

export interface FundingData {
  currentRate: number | null;
  predictedRate: number | null;
  fundingTrend: number | null;
  fundingBias: 'long' | 'short' | 'neutral';
  fundingHistory: number[];
  raw: {
    lastPrice: number | null;
    markPrice: number | null;
    volume: number | null;
    high24h: number | null;
    low24h: number | null;
    priceChange: number | null;
  };
}

export interface VolatilityData {
  atr: number;
  atrPercent: number;
  atrRegime: 'low' | 'normal' | 'high' | 'extreme';
  hv: number | null;
  realizedVol: number | null;
  volatilityExpansion: boolean;
  rangeCompression: boolean;
}

export interface CorrelationData {
  btcCorrelation: number | null;
  ethCorrelation: number | null;
  marketCorrelation: number | null;
  sectorCorrelation: number | null;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RegimeResult {
  regime: 'trending' | 'strong_trend' | 'range' | 'compression' | 'expansion' | 'accumulation' | 'distribution' | 'breakout' | 'fake_breakout' | 'reversal';
  confidence: number;
  adx: number;
  atrExpansion: boolean;
  rangeCompression: boolean;
  hv: number | null;
}

export interface AiFinalScore {
  overallScore: number;
  grade: string;
  tradeQuality: string;
  expectedWinRate: number;
  risk: 'low' | 'medium' | 'high';
  engines: Record<string, EngineScore>;
}

export interface Recommendation {
  direction: 'long' | 'short' | 'wait';
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;
  expectedWinRate: number;
  confidence: number;
  positionSize: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
  fundingImpact: number | null;
  reasons: string[];
  warnings: string[];
  marketStructureExplanation: string;
  expectedMoveExplanation: string;
  riskExplanation: string;
}

export interface Trade {
  price: number;
  size: number;
  isBuyerMaker: boolean;
  time: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
  isBid: boolean;
  isInstitutional: boolean;
}
