// Intraday Stock Scanner Engine
// Institutional-grade scanner for NSE India
// Based on 8-step methodology: Market, Sector, Fundamentals, Technicals, Options, News, Flow, Score

import type { SDMOptionStrike } from "@/types/sdm";
import { Candle, calculateRSI, calculateEMA, calculateADX } from "@/lib/ml-engine";
import { getNextMonthlyExpiry } from "./expiry-calculator";
import { recordScannerResult, type ScannerResultInput } from "./market/record-scanner";
import { recordSignal } from "./trade-audit-client";

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
  // Monthly option trade
  monthlyOptionTrade?: MonthlyOptionTrade;
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

// ─── Monthly Option Trade Generator ────────────────────────────────
function getStrikeStep(price: number): number {
  if (price < 250) return 5;
  if (price < 1000) return 10;
  if (price < 5000) return 50;
  if (price < 10000) return 100;
  return 500;
}

function generateMonthlyOptionTrade(
  symbol: string,
  price: number,
  direction: "BULLISH" | "BEARISH" | "NEUTRAL"
): MonthlyOptionTrade | undefined {
  if (direction === "NEUTRAL") return undefined;

  const monthly = getNextMonthlyExpiry(symbol);
  if (!monthly) return undefined;

  const step = getStrikeStep(price);
  let atmStrike = Math.round(price / step) * step;
  // Ensure strike is above 0
  if (atmStrike <= 0) atmStrike = step;

  const optionType: "CE" | "PE" = direction === "BULLISH" ? "CE" : "PE";
  const iv = 0.25; // 25% estimated IV for stock options
  const daysToExpiry = monthly.daysToExpiry || 14;
  const annualFactor = Math.sqrt(daysToExpiry / 365);
  const premium = Math.round(price * iv * annualFactor * 100) / 100;
  if (premium <= 0) return undefined;

  const sl = Math.round(premium * 0.85 * 100) / 100;
  const target1 = Math.round(premium * 1.15 * 100) / 100;
  const target2 = Math.round(premium * 1.25 * 100) / 100;
  const target3 = Math.round(premium * 1.35 * 100) / 100;

  const label = monthly.label || monthly.date;
  const summary = `${direction === "BULLISH" ? "Buy" : "Buy"} ${symbol} ${atmStrike} ${optionType} (${label}) @ ₹${premium} | SL ₹${sl} | T1 ₹${target1} | T2 ₹${target2} | T3 ₹${target3}+`;

  return {
    strike: atmStrike,
    optionType,
    expiry: monthly.date,
    expiryLabel: label,
    premium,
    stopLoss: sl,
    targets: [target1, target2, target3],
    direction: "BUY",
    summary,
  };
}

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
    else { strength = 50; change = 0; }

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

// ─── Yahoo Finance Price + Candle Fetcher ─────────────────────────
interface YahooData {
  quotes: Map<string, any>;
  candles: Map<string, Candle[]>;
}

// One chart call returns BOTH the live quote (meta) and 3 months of daily
// OHLC candles (indicators.quote) — so we fetch quote + candles together.
// Fetched in bounded-concurrency batches to keep latency reasonable.
// Results are cached 30s so re-visiting the Scanner tab is instant.

const yahooCache = new Map<string, { data: YahooData; ts: number }>();
const YAHOO_CACHE_TTL = 30_000;

async function fetchYahooData(symbols: string[]): Promise<YahooData> {
  const cacheKey = symbols.join(",");
  const cached = yahooCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < YAHOO_CACHE_TTL) return cached.data;

  const quotes = new Map<string, any>();
  const candles = new Map<string, Candle[]>();
  const CONCURRENCY = 10;
  const DEADLINE = Date.now() + 25_000;

  const fetchOne = async (sym: string) => {
    const yahooSym = `${sym}.NS`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=3mo&interval=1d`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) return;
      const meta = result.meta;
      const ts = result.timestamp;
      const q = result.indicators?.quote?.[0];

      if (meta?.regularMarketPrice) {
        const prevClose = meta.chartPreviousClose || meta.regularMarketPrice;
        quotes.set(sym, {
          last_price: String(meta.regularMarketPrice),
          change: String((meta.regularMarketPrice - prevClose).toFixed(2)),
          change_percent: String(((meta.regularMarketPrice - prevClose) / prevClose * 100).toFixed(2)),
          volume: String(meta.regularMarketVolume || 0),
        });
      }

      if (ts && q?.close) {
        const cs: Candle[] = [];
        for (let i = 0; i < ts.length; i++) {
          const close = q.close[i];
          if (close == null) continue;
          cs.push({
            time: ts[i],
            open: q.open?.[i] ?? close,
            high: q.high?.[i] ?? close,
            low: q.low?.[i] ?? close,
            close,
            volume: q.volume?.[i] || 0,
          });
        }
        if (cs.length >= 2) candles.set(sym, cs);
      }
    } catch (e) {
      // skip unavailable symbol rather than fabricate data
    }
  };

  for (let i = 0; i < symbols.length && Date.now() < DEADLINE; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchOne));
  }

  const data: YahooData = { quotes, candles };
  yahooCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// Average True Range from real OHLC candles.
function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const h = candles[i].high;
    const l = candles[i].low;
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    trs.push(tr);
  }
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

// ─── Stock Candidate Generation ───────────────────────────────────
export interface GeneratedCandidates {
  candidates: StockCandidate[];
  liveCount: number;
  total: number;
}

export async function generateCandidates(
  config: ScannerConfig,
  marketDirection: MarketDirection,
  sectors: SectorStrength[]
): Promise<GeneratedCandidates> {
  const candidates: StockCandidate[] = [];
  let liveCount = 0;
  const isBullish = marketDirection.trend.includes("BULLISH");
  const isBearish = marketDirection.trend.includes("BEARISH");

  // Fetch real prices + 3mo daily OHLC candles from Yahoo Finance
  const { quotes: realQuotes, candles: realCandles } = await fetchYahooData(NIFTY50_STOCKS.map(s => s.symbol));

  // Scan ALL stocks (sector filter applied in UI)
  const universe = NIFTY50_STOCKS;

  for (const stock of universe) {
    // Use real Yahoo Finance data only — never fabricate a price.
    const quote = realQuotes.get(stock.symbol);
    if (!quote) continue;
    liveCount++;
    const basePrice = parseFloat(quote.last_price);
    const change = parseFloat(quote.change);
    const changePct = parseFloat(quote.change_percent);
    const volume = parseInt(quote.volume || "0");
    // Real relative volume: current volume vs the trailing average from 3mo candles
    // (exclude the most recent bar — it may be a partial/intraday session).
    const candleVols = (realCandles.get(stock.symbol) || [])
      .map((c) => c.volume)
      .filter((v) => v > 0);
    const histVols = candleVols.slice(0, -1);
    const avgVolume = histVols.length
      ? Math.round(histVols.reduce((s, v) => s + v, 0) / histVols.length)
      : Math.round(volume * 0.8); // graceful fallback only
    const rvol = avgVolume > 0 ? volume / avgVolume : 1;

    // Technicals — computed from REAL 3mo daily OHLC candles via Yahoo Finance.
    // Neutral defaults only apply if candle history is unavailable for a symbol.
    let ema9 = basePrice * 1.001;
    let ema21 = basePrice * 0.999;
    let ema50 = basePrice * 0.997;
    let rsi = 50;
    let macd = 0;
    let macdSignal = 0;
    let adx = 20;
    let atr = basePrice * 0.015;

    const stockCandles = realCandles.get(stock.symbol);
    if (stockCandles && stockCandles.length >= 35) {
      const closes = stockCandles.map((c) => c.close);
      const e9 = calculateEMA(closes, 9);
      const e21 = calculateEMA(closes, 21);
      ema9 = e9[e9.length - 1];
      ema21 = e21[e21.length - 1];
      if (stockCandles.length >= 50) {
        const e50 = calculateEMA(closes, 50);
        ema50 = e50[e50.length - 1];
      }
      rsi = calculateRSI(stockCandles, 14);
      adx = calculateADX(stockCandles, 14);
      atr = calcATR(stockCandles, 14);
      const e12 = calculateEMA(closes, 12);
      const e26 = calculateEMA(closes, 26);
      const macdLine = e12[e12.length - 1] - e26[e26.length - 1];
      const macdSeries = closes.map((_, i) => (e12[i] ?? 0) - (e26[i] ?? 0));
      macd = macdLine;
      macdSignal = calculateEMA(macdSeries, 9).at(-1) ?? 0;
    }

    // Score calculation
    let technicalScore = 0;
    let optionsScore = 0;
    let volumeScore = 0;
    let fundamentalScore = 50;
    let newsScore = 50;
    const reasons: string[] = [];

    // Technical scoring — driven by PER-STOCK indicators, NOT the market-wide
    // trend (which is SIDEWAYS today while individual stocks still trend).
    // The market trend only modulates the final score, so sideways days keep
    // differentiating stocks instead of flattening everyone to 30.
    const techBull = [
      ema9 > ema21,
      ema21 > ema50,
      rsi > 50 && rsi < 70,
      macd > macdSignal,
      adx > 25,
    ].filter(Boolean).length;
    const techBear = [
      ema9 < ema21,
      ema21 < ema50,
      rsi < 50 && rsi > 30,
      macd < macdSignal,
      adx > 25,
    ].filter(Boolean).length;

    if (techBull > techBear) {
      if (ema9 > ema21) { technicalScore += 15; reasons.push("EMA9 > EMA21 (bullish crossover)"); }
      if (ema21 > ema50) { technicalScore += 10; reasons.push("EMA21 > EMA50 (uptrend)"); }
      if (rsi > 50 && rsi < 70) { technicalScore += 10; reasons.push(`RSI ${rsi.toFixed(0)} — bullish momentum`); }
      if (macd > macdSignal) { technicalScore += 10; reasons.push("MACD above signal"); }
      if (adx > 25) { technicalScore += 5; reasons.push(`ADX ${adx.toFixed(0)} — trending`); }
    } else if (techBear > techBull) {
      if (ema9 < ema21) { technicalScore += 15; reasons.push("EMA9 < EMA21 (bearish crossover)"); }
      if (ema21 < ema50) { technicalScore += 10; reasons.push("EMA21 < EMA50 (downtrend)"); }
      if (rsi < 50 && rsi > 30) { technicalScore += 10; reasons.push(`RSI ${rsi.toFixed(0)} — bearish momentum`); }
      if (macd < macdSignal) { technicalScore += 10; reasons.push("MACD below signal"); }
      if (adx > 25) { technicalScore += 5; reasons.push(`ADX ${adx.toFixed(0)} — trending`); }
    } else {
      // Balanced per-stock — mild baseline from RSI position (not a flat constant)
      technicalScore = 25;
      if (rsi >= 45 && rsi <= 55) reasons.push(`RSI ${rsi.toFixed(0)} — balanced momentum`);
    }

    // Volume scoring
    if (rvol > 1.5) { volumeScore = 80; reasons.push(`RVOL ${rvol.toFixed(1)}x — high volume`); }
    else if (rvol > 1.2) { volumeScore = 60; reasons.push(`RVOL ${rvol.toFixed(1)}x — above average`); }
    else { volumeScore = 30; }

    // Options scoring — neutral defaults (real data needs Breeze per-stock options)
    const stockPCR = 1.0;
    const stockOI = 0;
    const stockOIChange = 0;
    const stockIV = 20;

    if (isBullish && stockPCR > 1.1) { optionsScore = 70; reasons.push("PCR > 1.1 — put writing (bullish)"); }
    else if (isBearish && stockPCR < 0.9) { optionsScore = 70; reasons.push("PCR < 0.9 — call writing (bearish)"); }
    else { optionsScore = 50; }

    // Fundamental score (simplified)
    if (stock.sector === "IT" || stock.sector === "Banking") { fundamentalScore = 65; }
    else if (stock.sector === "Pharma" || stock.sector === "FMCG") { fundamentalScore = 70; }
    else { fundamentalScore = 50; }

    // News score (neutral — no news API integration yet)
    newsScore = 50;

    // Sector score
    const sectorData = sectors.find(s => s.sector === stock.sector);
    const sectorScore = sectorData?.strength || 50;

    // Market score
    const marketScore = marketDirection.score;

    // Total score calculation
    // Weights normalised to 1.00. Real, per-stock signals (technical,
    // volume, sector) dominate; market context + coarse fundamental add
    // modulation; options/news are neutral placeholders (no per-stock
    // options/PCR or news feed) at minimal weight so they don't flatten
    // the score for every stock.
    const totalScore = Math.round(
      (marketScore * 0.10) +
      (sectorScore * 0.15) +
      (technicalScore * 0.40) +
      (optionsScore * 0.05) +
      (volumeScore * 0.20) +
      (fundamentalScore * 0.05) +
      (newsScore * 0.05)
    );

    // Direction from technical indicators (not totalScore threshold)
    const bullSignals = (ema9 > ema21 ? 1 : 0) + (rsi > 50 ? 1 : 0) + (macd > macdSignal ? 1 : 0);
    const bearSignals = (ema9 < ema21 ? 1 : 0) + (rsi < 50 ? 1 : 0) + (macd < macdSignal ? 1 : 0);
    const direction = bullSignals >= 2 ? "BULLISH" : bearSignals >= 2 ? "BEARISH" : "NEUTRAL";

    // Trade setup using ATR (stock-specific volatility, minimum 1% of price floor)
    const atrFloor = Math.max(atr, basePrice * 0.01);
    let entry: number, stopLoss: number, target1: number, target2: number, riskReward: number;
    if (direction === "BULLISH") {
      entry = basePrice;
      stopLoss = basePrice - atrFloor * 1.5;
      target1 = basePrice + atrFloor * 2;
      target2 = basePrice + atrFloor * 3;
    } else if (direction === "BEARISH") {
      entry = basePrice;
      stopLoss = basePrice + atrFloor * 1.5;
      target1 = basePrice - atrFloor * 2;
      target2 = basePrice - atrFloor * 3;
    } else {
      // NEUTRAL: ATR-based bands with mild RSI bias so levels never collapse
      entry = basePrice;
      const slDist = atrFloor * (rsi > 55 ? 1.2 : rsi < 45 ? 1.2 : 0.8);
      const t1Dist = atrFloor * (rsi < 45 ? 1.2 : 1.5);
      const t2Dist = atrFloor * (rsi < 45 ? 2.0 : 2.5);
      stopLoss = basePrice - slDist;
      target1 = basePrice + t1Dist;
      target2 = basePrice + t2Dist;
    }
    riskReward = Math.abs(target1 - entry) / Math.abs(entry - stopLoss);

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

    // Monthly option trade recommendation
    const monthlyOptionTrade = generateMonthlyOptionTrade(stock.symbol, basePrice, direction);

    // Volume summary
    const volumeSummary = `Vol ${formatOI(volume)} | Avg ${formatOI(avgVolume)} | RVOL ${rvol.toFixed(1)}x`;

    // Holding time
    const holdingTime = adx > 30 ? "2-4 hours" : "1-2 hours";

    // Institutional activity (from real volume data)
    const institutionalActivity = rvol > 2.0 ? "High volume anomaly detected" :
                                  rvol > 1.5 ? "Above-average volume" : "Normal volume activity";

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
      marketCap: Math.round(basePrice * 50 * 100000),
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
      monthlyOptionTrade,
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
  return {
    candidates: candidates.sort((a, b) => b.totalScore - a.totalScore),
    liveCount,
    total: universe.length,
  };
}

// ─── Main Scan Function ───────────────────────────────────────────
export async function runIntradayScan(config: ScannerConfig): Promise<ScanResult> {
  // Step 1: Market Direction
  const marketDirection = analyzeMarketDirection(config);

  // Step 2: Sector Strength
  const sectors = analyzeSectors(marketDirection);

  // Step 3-8: Generate and score candidates (live Yahoo data only)
  const { candidates, liveCount, total } = await generateCandidates(config, marketDirection, sectors);

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
    dataQuality:
      total > 0 && liveCount >= total * 0.8
        ? "LIVE"
        : liveCount > 0
        ? "PARTIAL"
        : "SIMULATED",
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

// ─── Migration: Scanner Results persistence ───────────────────────
// Mirrors BTST (recordBTSTScannerResults) so the new Evaluation framework
// + Replay can grade Intraday the same way as Zero Hero / SMC / BTST.
export async function recordIntradayScannerResults(
  candidates: StockCandidate[],
  _config?: ScannerConfig
): Promise<number> {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const sessionId = `INTRADAY-${ymd}`;

  const results: ScannerResultInput[] = candidates.length
    ? candidates.map((c) => {
        const decision: "BUY" | "SELL" | "REJECT" =
          c.direction === "BULLISH" ? "BUY" : c.direction === "BEARISH" ? "SELL" : "REJECT";
        return {
          symbol: c.symbol,
          strategy: "INTRADAY",
          decision,
          confidence: c.totalScore,
          riskScore: Math.max(0, Math.min(100, 100 - c.totalScore)),
          perEngineConfidence: { INTRADAY: c.totalScore },
          triggeredEngines: decision === "REJECT" ? [] : ["INTRADAY"],
          rejectedConditions: decision === "REJECT" ? ["neutral_direction"] : [],
          reasons: c.reasons?.length ? c.reasons : [c.technicalSummary],
          selectedStrike: 0,
          entry: c.entry,
          sl: c.stopLoss,
          tp1: c.target1,
          tp2: c.target2,
          expectedRR: c.riskReward,
          snapshotId: null,
          sessionId,
        };
      })
    : [
        {
          symbol: "INTRADAY",
          strategy: "INTRADAY",
          decision: "NO_TRADE",
          confidence: 0,
          riskScore: 100,
          perEngineConfidence: {},
          triggeredEngines: [],
          rejectedConditions: ["no_candidates"],
          reasons: ["no eligible intraday stocks"],
          snapshotId: null,
          sessionId,
        },
      ];

  let recorded = 0;
  await Promise.all(
    results.map(async (r) => {
      try {
        recorded += await recordScannerResult(r);
      } catch {
        /* sidecar down — non-blocking */
      }
    })
  );
  return recorded;
}

// Record executed intraday trades into the Trade Audit sidecar so the
// strategy is evaluable alongside Zero Hero / SMC / BTST.
export async function recordIntradayTrade(input: {
  id: string;
  symbol: string;
  optionType: "CE" | "PE";
  strike: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  confidence: number;
  reason: string;
  source: string;
}): Promise<void> {
  try {
    await recordSignal({
      tradeId: input.id,
      strategyId: "INTRADAY",
      strategyVersion: "1.0",
      symbol: input.symbol,
      exchange: "NSE",
      instrumentType: "OPTIONS",
      spotPrice: input.entry,
      strikePrice: input.strike,
      optionType: input.optionType,
      entryPrice: input.entry,
      stopLoss: input.stopLoss,
      tp1: input.tp1,
      tp2: input.tp2,
      signalConfidence: input.confidence,
      trendDirection: input.optionType === "CE" ? "BULLISH" : "BEARISH",
      signalReason: input.reason,
      marketSession: "MORNING",
      marketContext: { source: input.source },
    });
  } catch {
    /* sidecar down — non-blocking */
  }
}
