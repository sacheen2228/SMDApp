// Intraday Stock Scanner Engine
// Institutional-grade scanner for NSE India
// Based on 8-step methodology: Market, Sector, Fundamentals, Technicals, Options, News, Flow, Score

import type { SDMOptionStrike } from "@/types/sdm";

// ─── Types ────────────────────────────────────────────────────────
export interface ScannerConfig {
  symbol: string;
  spotPrice: number;
  optionChain: SDMOptionStrike[];
  vix: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
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
  // Technicals
  ema9: number;
  ema21: number;
  ema50: number;
  rsi: number;
  macd: number;
  macdSignal: number;
  adx: number;
  atr: number;
  // Options (if F&O)
  pcr: number;
  totalOI: number;
  oiChange: number;
  iv: number;
  // Scores
  marketScore: number;
  sectorScore: number;
  technicalScore: number;
  optionsScore: number;
  volumeScore: number;
  fundamentalScore: number;
  newsScore: number;
  totalScore: number;
  // Trade setup
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

// ─── NIFTY 50 + F&O Universe ──────────────────────────────────────
const NIFTY50_STOCKS: { symbol: string; name: string; sector: string }[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy" },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT" },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking" },
  { symbol: "INFY", name: "Infosys", sector: "IT" },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking" },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG" },
  { symbol: "ITC", name: "ITC Limited", sector: "FMCG" },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom" },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking" },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure" },
  { symbol: "AXISBANK", name: "Axis Bank", sector: "Banking" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "NBFC" },
  { symbol: "ASIANPAINT", name: "Asian Paints", sector: "Consumer" },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Auto" },
  { symbol: "SUNPHARMA", name: "Sun Pharma", sector: "Pharma" },
  { symbol: "TITAN", name: "Titan Company", sector: "Consumer" },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", sector: "Cement" },
  { symbol: "NESTLEIND", name: "Nestle India", sector: "FMCG" },
  { symbol: "TATAMOTORS", name: "Tata Motors", sector: "Auto" },
  { symbol: "WIPRO", name: "Wipro", sector: "IT" },
  { symbol: "M&M", name: "Mahindra & Mahindra", sector: "Auto" },
  { symbol: "HCLTECH", name: "HCL Technologies", sector: "IT" },
  { symbol: "POWERGRID", name: "Power Grid Corp", sector: "Power" },
  { symbol: "NTPC", name: "NTPC Limited", sector: "Power" },
  { symbol: "ONGC", name: "Oil & Natural Gas Corp", sector: "Energy" },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metal" },
  { symbol: "JSWSTEEL", name: "JSW Steel", sector: "Metal" },
  { symbol: "ADANIENT", name: "Adani Enterprises", sector: "Conglomerate" },
  { symbol: "ADANIPORTS", name: "Adani Ports", sector: "Infrastructure" },
  { symbol: "TECHM", name: "Tech Mahindra", sector: "IT" },
  { symbol: "HDFCLIFE", name: "HDFC Life Insurance", sector: "Insurance" },
  { symbol: "SBILIFE", name: "SBI Life Insurance", sector: "Insurance" },
  { symbol: "BRITANNIA", name: "Britannia Industries", sector: "FMCG" },
  { symbol: "CIPLA", name: "Cipla", sector: "Pharma" },
  { symbol: "DRREDDY", name: "Dr. Reddy's Labs", sector: "Pharma" },
  { symbol: "DIVISLAB", name: "Divi's Labs", sector: "Pharma" },
  { symbol: "EICHERMOT", name: "Eicher Motors", sector: "Auto" },
  { symbol: "GRASIM", name: "Grasim Industries", sector: "Cement" },
  { symbol: "HEROMOTOCO", name: "Hero MotoCorp", sector: "Auto" },
  { symbol: "HINDALCO", name: "Hindalco Industries", sector: "Metal" },
  { symbol: "INDUSINDBK", name: "IndusInd Bank", sector: "Banking" },
  { symbol: "BAJAJFINSV", name: "Bajaj Finserv", sector: "NBFC" },
  { symbol: "COALINDIA", name: "Coal India", sector: "Mining" },
  { symbol: "BPCL", name: "Bharat Petroleum", sector: "Energy" },
  { symbol: "TRENT", name: "Trent Limited", sector: "Retail" },
  { symbol: "APOLLOHOSP", name: "Apollo Hospitals", sector: "Healthcare" },
  { symbol: "LTIM", name: "LTIMindtree", sector: "IT" },
  { symbol: "HDFCAMC", name: "HDFC AMC", sector: "Finance" },
  { symbol: "PIDILITIND", name: "Pidilite Industries", sector: "Chemical" },
];

const SECTOR_ORDER = [
  "IT", "Banking", "Auto", "Pharma", "FMCG", "NBFC", "Energy",
  "Metal", "Infrastructure", "Power", "Consumer", "Insurance",
  "Telecom", "Cement", "Healthcare", "Mining", "Retail", "Chemical",
  "Finance", "Conglomerate"
];

// ─── Market Direction Analysis ────────────────────────────────────
export function analyzeMarketDirection(config: ScannerConfig): MarketDirection {
  const { spotPrice, vix, pcr, maxPain, totalCallOI, totalPutOI } = config;

  let trend: MarketDirection["trend"] = "SIDEWAYS";
  let score = 50;
  let details = "";

  // PCR Analysis
  if (pcr > 1.3) {
    trend = "BULLISH";
    score += 15;
    details = `Strong put writing (PCR ${pcr.toFixed(2)}) indicates bullish sentiment`;
  } else if (pcr > 1.1) {
    trend = "BULLISH";
    score += 8;
    details = `Mildly bullish PCR ${pcr.toFixed(2)} — put writers active`;
  } else if (pcr < 0.7) {
    trend = "BEARISH";
    score -= 15;
    details = `Strong call writing (PCR ${pcr.toFixed(2)}) indicates bearish sentiment`;
  } else if (pcr < 0.9) {
    trend = "BEARISH";
    score -= 8;
    details = `Mildly bearish PCR ${pcr.toFixed(2)} — call writers active`;
  } else {
    details = `Neutral PCR ${pcr.toFixed(2)} — balanced market`;
  }

  // VIX Analysis
  if (vix > 25) {
    trend = "VOLATILE";
    score -= 10;
    details += `. High VIX (${vix.toFixed(1)}) — expect big moves, wider stops needed`;
  } else if (vix > 18) {
    details += `. Elevated VIX (${vix.toFixed(1)}) — moderate volatility`;
  } else if (vix < 12) {
    score += 5;
    details += `. Low VIX (${vix.toFixed(1)}) — calm market, good for momentum`;
  }

  // Max Pain Proximity
  const distToMP = Math.abs(spotPrice - maxPain) / spotPrice * 100;
  if (distToMP < 0.5) {
    details += `. Spot very close to Max Pain — expect breakout`;
    score += 5;
  } else if (distToMP > 2) {
    details += `. Spot ${distToMP.toFixed(1)}% from Max Pain — mean reversion likely`;
  }

  // Nifty Trend (simulated based on spot vs max pain)
  const niftyTrend = spotPrice > maxPain ? "Bullish" : spotPrice < maxPain ? "Bearish" : "Neutral";

  // Bank Nifty (correlated with Nifty)
  const bankNiftyTrend = niftyTrend;

  // Breadth (simulated)
  const breadth = pcr > 1.1 ? "Advancing (60%+ stocks up)" : pcr < 0.9 ? "Declining (60%+ stocks down)" : "Mixed";

  // Global Cues
  const globalCues = vix > 20 ? "Global uncertainty elevated" : "Global markets supportive";

  // Cap score
  score = Math.max(0, Math.min(100, score));

  // Final trend classification
  if (score >= 75) trend = "STRONG_BULLISH";
  else if (score >= 60) trend = "BULLISH";
  else if (score >= 45) trend = "SIDEWAYS";
  else if (score >= 30) trend = "BEARISH";
  else trend = "STRONG_BEARISH";

  return {
    trend,
    score,
    details,
    niftyTrend,
    bankNiftyTrend,
    vixLevel: vix > 20 ? "High" : vix > 14 ? "Moderate" : "Low",
    breadth,
    globalCues,
  };
}

// ─── Sector Strength Analysis ─────────────────────────────────────
export function analyzeSectors(marketDirection: MarketDirection): SectorStrength[] {
  const isBullish = marketDirection.trend.includes("BULLISH");
  const isBearish = marketDirection.trend.includes("BEARISH");

  // Sector performance simulation based on market direction
  const sectorData: SectorStrength[] = SECTOR_ORDER.map((sector, idx) => {
    let strength = 50;
    let change = 0;

    // Sector rotation logic
    if (sector === "IT" && isBullish) { strength = 75; change = 1.5; }
    else if (sector === "IT" && isBearish) { strength = 35; change = -1.2; }
    else if (sector === "Banking" && isBullish) { strength = 80; change = 2.0; }
    else if (sector === "Banking" && isBearish) { strength = 30; change = -1.8; }
    else if (sector === "Auto" && isBullish) { strength = 70; change = 1.2; }
    else if (sector === "Pharma" && isBearish) { strength = 65; change = 0.8; }
    else if (sector === "FMCG" && isBearish) { strength = 70; change = 0.5; }
    else if (sector === "Metal" && isBullish) { strength = 72; change = 1.8; }
    else if (sector === "Energy") { strength = 55; change = 0.3; }
    else { strength = 45 + Math.random() * 20; change = (Math.random() - 0.5) * 2; }

    return {
      sector,
      strength: Math.round(strength),
      change: Math.round(change * 100) / 100,
      leadingStocks: [],
      laggards: [],
    };
  });

  // Sort by strength descending
  return sectorData.sort((a, b) => b.strength - a.strength);
}

// ─── Stock Candidate Generation ───────────────────────────────────
export function generateCandidates(
  config: ScannerConfig,
  marketDirection: MarketDirection,
  sectors: SectorStrength[]
): StockCandidate[] {
  const candidates: StockCandidate[] = [];
  const isBullish = marketDirection.trend.includes("BULLISH");
  const isBearish = marketDirection.trend.includes("BEARISH");

  // Scan ALL stocks (sector filter applied in UI)
  const universe = NIFTY50_STOCKS;

  for (const stock of universe) {
    // Simulate stock data
    const basePrice = 500 + Math.random() * 4500;
    const volatility = config.vix / 100;
    const change = (Math.random() - 0.45) * basePrice * volatility;
    const changePct = (change / basePrice) * 100;
    const volume = 500000 + Math.random() * 5000000;
    const avgVolume = 400000 + Math.random() * 3000000;
    const rvol = volume / avgVolume;

    // Simulate technicals
    const ema9 = basePrice * (1 + (Math.random() - 0.5) * 0.02);
    const ema21 = basePrice * (1 + (Math.random() - 0.5) * 0.03);
    const ema50 = basePrice * (1 + (Math.random() - 0.5) * 0.05);
    const rsi = 30 + Math.random() * 40;
    const macd = (Math.random() - 0.5) * 10;
    const macdSignal = (Math.random() - 0.5) * 8;
    const adx = 15 + Math.random() * 35;
    const atr = basePrice * 0.015;

    // Score calculation
    let technicalScore = 0;
    let optionsScore = 0;
    let volumeScore = 0;
    let fundamentalScore = 50;
    let newsScore = 50;
    const reasons: string[] = [];

    // Technical scoring
    if (isBullish) {
      if (ema9 > ema21) { technicalScore += 15; reasons.push("EMA9 > EMA21 (bullish crossover)"); }
      if (ema21 > ema50) { technicalScore += 10; reasons.push("EMA21 > EMA50 (uptrend)"); }
      if (rsi > 50 && rsi < 70) { technicalScore += 10; reasons.push(`RSI ${rsi.toFixed(0)} — bullish momentum`); }
      if (macd > macdSignal) { technicalScore += 10; reasons.push("MACD above signal"); }
      if (adx > 25) { technicalScore += 5; reasons.push(`ADX ${adx.toFixed(0)} — trending`); }
    } else if (isBearish) {
      if (ema9 < ema21) { technicalScore += 15; reasons.push("EMA9 < EMA21 (bearish crossover)"); }
      if (ema21 < ema50) { technicalScore += 10; reasons.push("EMA21 < EMA50 (downtrend)"); }
      if (rsi < 50 && rsi > 30) { technicalScore += 10; reasons.push(`RSI ${rsi.toFixed(0)} — bearish momentum`); }
      if (macd < macdSignal) { technicalScore += 10; reasons.push("MACD below signal"); }
      if (adx > 25) { technicalScore += 5; reasons.push(`ADX ${adx.toFixed(0)} — trending`); }
    } else {
      technicalScore = 20 + Math.random() * 20;
    }

    // Volume scoring
    if (rvol > 1.5) { volumeScore = 80; reasons.push(`RVOL ${rvol.toFixed(1)}x — high volume`); }
    else if (rvol > 1.2) { volumeScore = 60; reasons.push(`RVOL ${rvol.toFixed(1)}x — above average`); }
    else { volumeScore = 30; }

    // Options scoring (simulated)
    const stockPCR = 0.8 + Math.random() * 0.6;
    const stockOI = Math.floor(Math.random() * 1000000);
    const stockOIChange = Math.floor((Math.random() - 0.5) * 200000);
    const stockIV = 15 + Math.random() * 25;

    if (isBullish && stockPCR > 1.1) { optionsScore = 70; reasons.push("PCR > 1.1 — put writing (bullish)"); }
    else if (isBearish && stockPCR < 0.9) { optionsScore = 70; reasons.push("PCR < 0.9 — call writing (bearish)"); }
    else { optionsScore = 30 + Math.random() * 20; }

    // Fundamental score (simplified)
    if (stock.sector === "IT" || stock.sector === "Banking") { fundamentalScore = 65; }
    else if (stock.sector === "Pharma" || stock.sector === "FMCG") { fundamentalScore = 70; }
    else { fundamentalScore = 50 + Math.random() * 20; }

    // News score (simulated — would need real news API)
    newsScore = 40 + Math.random() * 30;

    // Sector score
    const sectorData = sectors.find(s => s.sector === stock.sector);
    const sectorScore = sectorData?.strength || 50;

    // Market score
    const marketScore = marketDirection.score;

    // Total score calculation
    const totalScore = Math.round(
      (marketScore * 0.15) +
      (sectorScore * 0.10) +
      (technicalScore * 0.35) +
      (optionsScore * 0.15) +
      (volumeScore * 0.10) +
      (fundamentalScore * 0.05) +
      (newsScore * 0.10)
    );

    // Direction
    const direction = totalScore >= 70 ? (isBullish ? "BULLISH" : isBearish ? "BEARISH" : "NEUTRAL") :
                      totalScore <= 40 ? (isBullish ? "BEARISH" : isBearish ? "BULLISH" : "NEUTRAL") :
                      "NEUTRAL";

    // Trade setup
    const entry = direction === "BULLISH" ? basePrice * 1.005 :
                  direction === "BEARISH" ? basePrice * 0.995 : basePrice;
    const stopLoss = direction === "BULLISH" ? entry * 0.985 :
                     direction === "BEARISH" ? entry * 1.015 : entry;
    const target1 = direction === "BULLISH" ? entry * 1.02 :
                    direction === "BEARISH" ? entry * 0.98 : entry;
    const target2 = direction === "BULLISH" ? entry * 1.035 :
                    direction === "BEARISH" ? entry * 0.965 : entry;
    const riskReward = Math.abs(target1 - entry) / Math.abs(entry - stopLoss);

    // Grade
    let grade: StockCandidate["grade"] = "C";
    if (totalScore >= 85) grade = "A+";
    else if (totalScore >= 75) grade = "A";
    else if (totalScore >= 65) grade = "B+";
    else if (totalScore >= 55) grade = "B";
    else if (totalScore < 40) grade = "D";

    // Conviction
    const conviction: StockCandidate["conviction"] =
      totalScore >= 80 ? "HIGH" : totalScore >= 65 ? "MEDIUM" : "LOW";

    // Support/Resistance
    const supportLevels = [basePrice * 0.98, basePrice * 0.96, basePrice * 0.94];
    const resistanceLevels = [basePrice * 1.02, basePrice * 1.04, basePrice * 1.06];

    // Technical summary
    const technicalSummary = `${ema9 > ema21 ? "Bullish" : "Bearish"} EMA alignment | RSI ${rsi.toFixed(0)} | ADX ${adx.toFixed(0)} | MACD ${macd > macdSignal ? "Bullish" : "Bearish"}`;

    // Options summary
    const optionsSummary = `PCR ${stockPCR.toFixed(2)} | OI ${formatOI(stockOI)} | OI Chg ${stockOIChange >= 0 ? "+" : ""}${formatOI(stockOIChange)} | IV ${stockIV.toFixed(1)}%`;

    // Volume summary
    const volumeSummary = `Vol ${formatOI(volume)} | Avg ${formatOI(avgVolume)} | RVOL ${rvol.toFixed(1)}x`;

    // Holding time
    const holdingTime = adx > 30 ? "2-4 hours" : "1-2 hours";

    // Institutional activity (simulated)
    const institutionalActivity = Math.random() > 0.6 ? "FII buying detected" :
                                  Math.random() > 0.4 ? "DII accumulation" : "No significant activity";

    candidates.push({
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      currentPrice: Math.round(basePrice * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      volume: Math.round(volume),
      avgVolume: Math.round(avgVolume),
      rvol: Math.round(rvol * 100) / 100,
      marketCap: Math.round(basePrice * (10 + Math.random() * 90) * 100000),
      ema9: Math.round(ema9 * 100) / 100,
      ema21: Math.round(ema21 * 100) / 100,
      ema50: Math.round(ema50 * 100) / 100,
      rsi: Math.round(rsi * 10) / 10,
      macd: Math.round(macd * 100) / 100,
      macdSignal: Math.round(macdSignal * 100) / 100,
      adx: Math.round(adx * 10) / 10,
      atr: Math.round(atr * 100) / 100,
      pcr: Math.round(stockPCR * 100) / 100,
      totalOI: stockOI,
      oiChange: stockOIChange,
      iv: Math.round(stockIV * 10) / 10,
      marketScore,
      sectorScore,
      technicalScore,
      optionsScore,
      volumeScore,
      fundamentalScore,
      newsScore,
      totalScore,
      direction,
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(stopLoss * 100) / 100,
      target1: Math.round(target1 * 100) / 100,
      target2: Math.round(target2 * 100) / 100,
      riskReward: Math.round(riskReward * 100) / 100,
      holdingTime,
      grade,
      conviction,
      reasons,
      technicalSummary,
      optionsSummary,
      volumeSummary,
      fundamentalNote: stock.sector === "IT" ? "Strong sector tailwinds" :
                       stock.sector === "Banking" ? "Credit growth robust" :
                       "Sector neutral",
      institutionalActivity,
      supportLevels: supportLevels.map(l => Math.round(l * 100) / 100),
      resistanceLevels: resistanceLevels.map(l => Math.round(l * 100) / 100),
    });
  }

  // Sort by total score descending
  return candidates.sort((a, b) => b.totalScore - a.totalScore);
}

// ─── Main Scan Function ───────────────────────────────────────────
export function runIntradayScan(config: ScannerConfig): ScanResult {
  // Step 1: Market Direction
  const marketDirection = analyzeMarketDirection(config);

  // Step 2: Sector Strength
  const sectors = analyzeSectors(marketDirection);

  // Step 3-8: Generate and score candidates
  const candidates = generateCandidates(config, marketDirection, sectors);

  // Filter — show all candidates, sector filter applied in UI
  const highProbCandidates = candidates.filter(c => c.totalScore >= 20);

  // Get best picks
  const bestBullish = highProbCandidates.find(c => c.direction === "BULLISH") || null;
  const bestBearish = highProbCandidates.find(c => c.direction === "BEARISH") || null;

  // Stocks to avoid
  const stocksToAvoid = candidates
    .filter(c => c.grade === "D" || c.totalScore < 40)
    .slice(0, 5)
    .map(c => c.symbol);

  // Overall bias
  const bullishCount = highProbCandidates.filter(c => c.direction === "BULLISH").length;
  const bearishCount = highProbCandidates.filter(c => c.direction === "BEARISH").length;
  const overallBias = bullishCount > bearishCount ? "BULLISH" :
                      bearishCount > bullishCount ? "BEARISH" : "NEUTRAL";

  // Key risks
  const keyRisks: string[] = [];
  if (config.vix > 20) keyRisks.push("High VIX — expect volatile moves");
  if (config.pcr < 0.8) keyRisks.push("Low PCR — call writers dominating");
  if (config.pcr > 1.4) keyRisks.push("Extremely high PCR — contrarian risk");
  const distToMP = Math.abs(config.spotPrice - config.maxPain) / config.spotPrice * 100;
  if (distToMP > 2) keyRisks.push("Spot far from Max Pain — mean reversion risk");
  if (keyRisks.length === 0) keyRisks.push("Normal market conditions");

  return {
    timestamp: new Date().toISOString(),
    marketDirection,
    sectors,
    candidates: highProbCandidates.slice(0, 30),
    bestBullish,
    bestBearish,
    stocksToAvoid,
    overallBias,
    keyRisks,
    dataQuality: "SIMULATED",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────
function formatOI(oi: number): string {
  if (Math.abs(oi) >= 10000000) return (oi / 10000000).toFixed(1) + " Cr";
  if (Math.abs(oi) >= 100000) return (oi / 100000).toFixed(1) + " L";
  if (Math.abs(oi) >= 1000) return (oi / 1000).toFixed(1) + "K";
  return oi.toString();
}

// ─── Grade Colors ─────────────────────────────────────────────────
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
