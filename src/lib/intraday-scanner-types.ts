// ─── Scanner Types & Pure Helpers (Client-safe) ────────────────────
// Extracted from intraday-scanner.ts to avoid bundling server-only
// modules (nse-bse-api → adm-zip → fs) into the client bundle.

export interface ScannerConfig {
  symbol: string;
  spotPrice: number;
  optionChain: any[];
  vix: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
}

export interface MonthlyOptionTrade {
  strike: number;
  optionType: "CE" | "PE";
  expiry: string;
  expiryLabel: string;
  premium: number;
  stopLoss: number;
  targets: number[];
  direction: "BUY" | "SELL";
  summary: string;
}

export interface StockCandidate {
  symbol: string;
  name: string;
  sector: string;
  currentPrice: number;
  change: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  rvol: number;
  marketCap: number;
  ema9: number;
  ema21: number;
  ema50: number;
  rsi: number;
  macd: number;
  macdSignal: number;
  adx: number;
  atr: number;
  pcr: number;
  totalOI: number;
  oiChange: number;
  iv: number;
  monthlyOptionTrade?: MonthlyOptionTrade;
  marketScore: number;
  sectorScore: number;
  technicalScore: number;
  optionsScore: number;
  volumeScore: number;
  fundamentalScore: number;
  newsScore: number;
  totalScore: number;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  holdingTime: string;
  grade: "A+" | "A" | "B+" | "B" | "C" | "D";
  conviction: "HIGH" | "MEDIUM" | "LOW";
  reasons: string[];
  technicalSummary: string;
  optionsSummary: string;
  volumeSummary: string;
  fundamentalNote: string;
  institutionalActivity: string;
  supportLevels: number[];
  resistanceLevels: number[];
  aiScore: number;
  aiDirection: "BUY" | "SELL" | "NO_TRADE";
  aiReasons: string[];
}

export interface MarketDirection {
  trend: "STRONG_BULLISH" | "BULLISH" | "SIDEWAYS" | "VOLATILE" | "BEARISH" | "STRONG_BEARISH";
  score: number;
  details: string;
  niftyTrend: string;
  bankNiftyTrend: string;
  vixLevel: string;
  breadth: string;
  globalCues: string;
}

export interface SectorStrength {
  sector: string;
  strength: number;
  change: number;
  leadingStocks: string[];
  laggards: string[];
}

export interface ScanResult {
  timestamp: string;
  marketDirection: MarketDirection;
  sectors: SectorStrength[];
  candidates: StockCandidate[];
  bestBullish: StockCandidate | null;
  bestBearish: StockCandidate | null;
  stocksToAvoid: string[];
  overallBias: string;
  keyRisks: string[];
  dataQuality: "LIVE" | "SIMULATED" | "PARTIAL";
  marketSentiment?: {
    overall: number;
    label: string;
    topBullish: any[];
    topBearish: any[];
  } | null;
}

// ─── Pure Helpers (no server deps) ─────────────────────────────────
export function getGradeColor(grade: string): string {
  switch (grade) {
    case "A+": return "bg-emerald-500 text-white";
    case "A": return "bg-emerald-600 text-white";
    case "B+": return "bg-yellow-500 text-white";
    case "B": return "bg-yellow-600 text-white";
    case "C": return "bg-orange-500 text-white";
    case "D": return "bg-red-500 text-white";
    default: return "bg-muted";
  }
}

export function getDirectionColor(direction: string): string {
  switch (direction) {
    case "BULLISH": return "text-emerald-500";
    case "BEARISH": return "text-red-500";
    default: return "text-muted-foreground";
  }
}

export function getConvictionColor(conviction: string): string {
  switch (conviction) {
    case "HIGH": return "bg-emerald-600 text-white";
    case "MEDIUM": return "bg-yellow-600 text-white";
    case "LOW": return "bg-orange-500 text-white";
    default: return "bg-muted";
  }
}
