export interface LiquidityTarget {
  price: number;
  type: TargetType;
  score: number;
  strength: number;
  source: string;
}

export type TargetType =
  | 'EQH'
  | 'EQL'
  | 'PREV_HIGH'
  | 'PREV_LOW'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  | 'DAILY_HIGH'
  | 'DAILY_LOW'
  | 'WEEKLY_HIGH'
  | 'WEEKLY_LOW'
  | 'MONTHLY_HIGH'
  | 'MONTHLY_LOW'
  | 'FVG'
  | 'ORDER_BLOCK'
  | 'BREAKER_BLOCK'
  | 'MITIGATION_BLOCK'
  | 'POC'
  | 'VAH'
  | 'VAL'
  | 'VWAP'
  | 'VWAP_WEEKLY'
  | 'VWAP_MONTHLY'
  | 'LIQUIDATION_CLUSTER'
  | 'OI_CLUSTER'
  | 'BID_WALL'
  | 'ASK_WALL';

export interface TargetSelection {
  tp1: LiquidityTarget | null;
  tp2: LiquidityTarget | null;
  tp3: LiquidityTarget | null;
  entry: number;
  stop: number;
  riskReward: number;
  expectedWinRate: number;
  explanation: string;
}

export interface StopLossCandidate {
  price: number;
  type: string;
  strength: number;
  source: string;
}

export interface TradeValidation {
  passed: boolean;
  score: number;
  confidence: number;
  dataQuality: number;
  warnings: string[];
}

export interface ScoringWeights {
  liquidityStrength: number;
  volumeProfile: number;
  smartMoney: number;
  openInterest: number;
  expectedMove: number;
  riskReward: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  liquidityStrength: 25,
  volumeProfile: 15,
  smartMoney: 20,
  openInterest: 15,
  expectedMove: 15,
  riskReward: 10,
};
