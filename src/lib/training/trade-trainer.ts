// Training Engine — records trade snapshots + outcomes, learns winning patterns
// Works for ALL trade types: options (CE/PE), equity, futures
// Stores data in JSON files for portability (same pattern as agent-memory)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TRAINING_DIR = join(process.cwd(), "data", "training");

function ensureDir() {
  if (!existsSync(TRAINING_DIR)) mkdirSync(TRAINING_DIR, { recursive: true });
}

function loadJson<T>(file: string): T[] {
  ensureDir();
  const path = join(TRAINING_DIR, file);
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, "utf-8")) as T[]; } catch { return []; }
}

function saveJson<T>(file: string, data: T[]) {
  ensureDir();
  writeFileSync(join(TRAINING_DIR, file), JSON.stringify(data, null, 2));
}

// ─── Types ───────────────────────────────────────────────────────

export interface MarketSnapshot {
  // Price context
  spot: number;
  spotChange: number;
  spotChangePct: number;
  prevClose: number;

  // Option chain (if options trade)
  atmStrike?: number;
  maxPain?: number;
  pcr?: number;
  totalCallOI?: number;
  totalPutOI?: number;
  callOiChange?: number;
  putOiChange?: number;
  vix?: number;
  futuresPrice?: number;
  futuresBasis?: number;

  // Strike-level data (selected strike)
  strikeData?: {
    strike: number;
    ceOi: number;
    ceOiChg: number;
    ceVolume: number;
    ceLtp: number;
    ceIV?: number;
    ceDelta?: number;
    ceGamma?: number;
    ceTheta?: number;
    peOi: number;
    peOiChg: number;
    peVolume: number;
    peLtp: number;
    peIV?: number;
    peDelta?: number;
    peGamma?: number;
    peTheta?: number;
  };

  // Support/Resistance from OI
  supportLevels?: { strike: number; peOi: number }[];
  resistanceLevels?: { strike: number; ceOi: number }[];
  topOiMovers?: { strike: number; type: string; oiChg: number; classification: string }[];

  // Institutional
  fiiNet?: number;
  diiNet?: number;
  fiiBias?: string;
  participantOI?: {
    fiiLong: number; fiiShort: number;
    diiLong: number; diiShort: number;
    clientLong: number; clientShort: number;
  };

  // Market regime
  regime?: string;
  regimeBias?: string;
  regimeConfidence?: number;

  // News
  newsSentiment?: string;
  newsScore?: number;

  // Breadth
  breadth?: {
    advances: number;
    declines: number;
    unchanged: number;
    adRatio: number;
  };

  // Volume context
  mostActiveSentiment?: string;
  topVolumeLeaders?: string[];

  // Technical
  rsi?: number;
  vwap?: number;
  ema20?: number;
  ema50?: number;
  supertrend?: string;

  // Session
  marketStatus: string;
  sessionTime: string;
  isExpiryDay: boolean;
  daysToExpiry: number;

  // Data quality
  dataSources: string[];
  dataFreshness: string;
}

export interface TradeRecord {
  // Trade identity
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  instrumentType: "CE" | "PE" | "FUT" | "EQ";
  strike?: number;
  entryPrice: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3?: number;

  // Context at entry
  source: string;
  confidence: number;
  qualityScore?: number;
  qualityGrade?: string;
  strategy?: string;

  // Snapshot at entry
  snapshot: MarketSnapshot;

  // Outcome
  outcome?: "WIN" | "LOSS" | "BREAKEVEN" | "EXPIRED" | "TIMEOUT";
  exitPrice?: number;
  exitTime?: string;
  exitReason?: string;
  pnl?: number;
  pnlPct?: number;
  rMultiple?: number;
  holdingTimeMin?: number;

  // Max excursion (for analysis)
  mfe?: number;  // Max Favorable Excursion
  mae?: number;  // Max Adverse Excursion

  // Metadata
  createdAt: string;
  resolvedAt?: string;
  regime?: string;
  tags?: string[];
}

export interface TrainingInsight {
  factor: string;
  winRate: number;
  avgPnl: number;
  sampleSize: number;
  confidence: number; // statistical confidence (0-1)
  direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
}

export interface CalibrationBucket {
  range: string;
  minScore: number;
  maxScore: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnl: number;
  avgRMultiple: number;
}

export interface FactorWeight {
  factor: string;
  weight: number;
  winRateContribution: number;
  sampleSize: number;
}

// ─── Snapshot Collection ─────────────────────────────────────────

export async function collectMarketSnapshot(
  symbol: string,
  strike?: number,
  optionType?: string
): Promise<MarketSnapshot> {
  const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";
  const snapshot: MarketSnapshot = {
    spot: 0, spotChange: 0, spotChangePct: 0, prevClose: 0,
    marketStatus: "UNKNOWN", sessionTime: "", isExpiryDay: false, daysToExpiry: 0,
    dataSources: [], dataFreshness: "UNKNOWN",
  };

  const fetchJSON = async (path: string, timeout = 8000) => {
    try {
      const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  };

  // Parallel fetch all data sources
  const [chainRes, fiiRes, regimeRes, newsRes, mostActiveRes] = await Promise.allSettled([
    fetchJSON(`/api/option-chain?symbol=${symbol}`, 10000),
    fetchJSON("/api/fii-dii", 6000),
    fetchJSON("/api/market/regime", 8000),
    fetchJSON("/api/news", 6000),
    fetchJSON("/api/market/most-active", 6000),
  ]);

  // Parse option chain
  if (chainRes.status === "fulfilled" && chainRes.value?.success) {
    const data = chainRes.value.data;
    const summary = data?.summary || {};
    const strikes = data?.strikes || data?.optionChainStrikes || [];

    snapshot.spot = summary.spotPrice || data?.spotPrice || 0;
    snapshot.prevClose = summary.prevClose || 0;
    snapshot.spotChange = snapshot.spot - snapshot.prevClose;
    snapshot.spotChangePct = snapshot.prevClose > 0 ? (snapshot.spotChange / snapshot.prevClose) * 100 : 0;

    snapshot.atmStrike = summary.atmStrike || 0;
    snapshot.maxPain = summary.maxPain || 0;
    snapshot.pcr = summary.pcr || 0;
    snapshot.totalCallOI = summary.totalCallOI || 0;
    snapshot.totalPutOI = summary.totalPutOI || 0;
    snapshot.callOiChange = summary.callOiChange || 0;
    snapshot.putOiChange = summary.putOiChange || 0;
    snapshot.vix = summary.indiaVIX || 0;
    snapshot.futuresPrice = summary.futuresPrice || 0;
    snapshot.futuresBasis = snapshot.futuresPrice > 0 ? snapshot.futuresPrice - snapshot.spot : 0;

    // Strike-level data
    if (strike && strikes.length > 0) {
      const row = strikes.find((s: any) => s.strike === strike || s.strikePrice === strike);
      if (row) {
        snapshot.strikeData = {
          strike,
          ceOi: row.ce?.oi || 0,
          ceOiChg: row.ce?.oiChg || row.ce?.oiChange || 0,
          ceVolume: row.ce?.volume || 0,
          ceLtp: row.ce?.ltp || 0,
          ceIV: row.ce?.iv || row.ce?.impliedVolatility || undefined,
          ceDelta: row.ce?.delta || undefined,
          ceGamma: row.ce?.gamma || undefined,
          ceTheta: row.ce?.theta || undefined,
          peOi: row.pe?.oi || 0,
          peOiChg: row.pe?.oiChg || row.pe?.oiChange || 0,
          peVolume: row.pe?.volume || 0,
          peLtp: row.pe?.ltp || 0,
          peIV: row.pe?.iv || row.pe?.impliedVolatility || undefined,
          peDelta: row.pe?.delta || undefined,
          peGamma: row.pe?.gamma || undefined,
          peTheta: row.pe?.theta || undefined,
        };
      }
    }

    // Support/Resistance
    const strikeData = strikes.map((s: any) => ({
      strike: s.strike || s.strikePrice || 0,
      peOi: s.pe?.oi || 0,
      ceOi: s.ce?.oi || 0,
    }));
    snapshot.supportLevels = strikeData
      .filter((s: any) => s.peOi > 0)
      .sort((a: any, b: any) => b.peOi - a.peOi)
      .slice(0, 5)
      .map((s: any) => ({ strike: s.strike, peOi: s.peOi }));
    snapshot.resistanceLevels = strikeData
      .filter((s: any) => s.ceOi > 0)
      .sort((a: any, b: any) => b.ceOi - a.ceOi)
      .slice(0, 5)
      .map((s: any) => ({ strike: s.strike, ceOi: s.ceOi }));

    snapshot.dataSources.push("option-chain");
  }

  // Parse FII/DII
  if (fiiRes.status === "fulfilled" && fiiRes.value?.success) {
    const d = fiiRes.value;
    snapshot.fiiNet = d.fiiNet ?? d.latest?.fiiNet ?? 0;
    snapshot.diiNet = d.diiNet ?? d.latest?.diiNet ?? 0;
    snapshot.fiiBias = snapshot.fiiNet > 0 ? "BUYING" : snapshot.fiiNet < 0 ? "SELLING" : "NEUTRAL";
    if (d.participantOI) {
      const poi = d.participantOI;
      snapshot.participantOI = {
        fiiLong: (poi.fii?.totalLong || 0),
        fiiShort: (poi.fii?.totalShort || 0),
        diiLong: (poi.dii?.totalLong || 0),
        diiShort: (poi.dii?.totalShort || 0),
        clientLong: (poi.client?.totalLong || 0),
        clientShort: (poi.client?.totalShort || 0),
      };
    }
    snapshot.dataSources.push("fii-dii");
  }

  // Parse regime
  if (regimeRes.status === "fulfilled" && regimeRes.value?.success) {
    snapshot.regime = regimeRes.value.regime || "UNKNOWN";
    snapshot.regimeBias = regimeRes.value.bias || "NEUTRAL";
    snapshot.regimeConfidence = regimeRes.value.confidence || 0;
    snapshot.dataSources.push("regime");
  }

  // Parse news
  if (newsRes.status === "fulfilled" && newsRes.value?.success) {
    const d = newsRes.value.data;
    snapshot.newsSentiment = d?.market?.sentiment || "NEUTRAL";
    snapshot.newsScore = d?.market?.score || 0;
    snapshot.dataSources.push("news");
  }

  // Parse most active
  if (mostActiveRes.status === "fulfilled" && mostActiveRes.value?.success) {
    snapshot.mostActiveSentiment = mostActiveRes.value.data?.sentiment || "Neutral";
    snapshot.dataSources.push("most-active");
  }

  // Session info
  try {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const day = ist.getDay();
    snapshot.sessionTime = `${ist.getHours()}:${String(ist.getMinutes()).padStart(2, "0")} IST`;
    if (day === 0 || day === 6) snapshot.marketStatus = "CLOSED";
    else if (mins < 555) snapshot.marketStatus = "PRE_OPEN";
    else if (mins <= 570) snapshot.marketStatus = "OPENING";
    else if (mins <= 930) snapshot.marketStatus = "OPEN";
    else snapshot.marketStatus = "CLOSED";
  } catch {}

  snapshot.dataFreshness = new Date().toISOString();
  return snapshot;
}

// ─── Trade Recording ─────────────────────────────────────────────

const TRADES_FILE = "trades.json";

export function recordTrade(trade: TradeRecord): void {
  const trades = loadJson<TradeRecord>(TRADES_FILE);
  const existing = trades.findIndex(t => t.id === trade.id);
  if (existing >= 0) {
    trades[existing] = trade;
  } else {
    trades.push(trade);
  }
  saveJson(TRADES_FILE, trades);
}

export function resolveTrade(
  id: string,
  outcome: TradeRecord["outcome"],
  exitPrice: number,
  exitReason: string,
  mfe?: number,
  mae?: number
): TradeRecord | null {
  const trades = loadJson<TradeRecord>(TRADES_FILE);
  const trade = trades.find(t => t.id === id);
  if (!trade) return null;

  trade.outcome = outcome;
  trade.exitPrice = exitPrice;
  trade.exitTime = new Date().toISOString();
  trade.exitReason = exitReason;
  trade.resolvedAt = new Date().toISOString();

  // Calculate P&L
  if (trade.side === "BUY") {
    trade.pnl = exitPrice - trade.entryPrice;
    trade.pnlPct = trade.entryPrice > 0 ? (trade.pnl / trade.entryPrice) * 100 : 0;
  } else {
    trade.pnl = trade.entryPrice - exitPrice;
    trade.pnlPct = trade.entryPrice > 0 ? (trade.pnl / trade.entryPrice) * 100 : 0;
  }

  // R-multiple
  const riskPerUnit = Math.abs(trade.entryPrice - trade.sl);
  trade.rMultiple = riskPerUnit > 0 ? trade.pnl / riskPerUnit : 0;

  // Holding time
  if (trade.createdAt && trade.exitTime) {
    trade.holdingTimeMin = Math.round(
      (new Date(trade.exitTime).getTime() - new Date(trade.createdAt).getTime()) / 60000
    );
  }

  trade.mfe = mfe;
  trade.mae = mae;

  // Regime tag
  if (trade.snapshot?.regime) {
    trade.regime = trade.snapshot.regime;
  }

  saveJson(TRADES_FILE, trades);
  return trade;
}

export function getAllTrades(): TradeRecord[] {
  return loadJson<TradeRecord>(TRADES_FILE);
}

export function getResolvedTrades(): TradeRecord[] {
  return getAllTrades().filter(t => t.outcome && t.outcome !== "TIMEOUT");
}

export function getTradesBySymbol(symbol: string): TradeRecord[] {
  return getAllTrades().filter(t => t.symbol === symbol);
}

export function getTradesBySource(source: string): TradeRecord[] {
  return getAllTrades().filter(t => t.source === source);
}

export function getTradesByRegime(regime: string): TradeRecord[] {
  return getAllTrades().filter(t => t.regime === regime);
}

// ─── Statistics ──────────────────────────────────────────────────

export interface TrainingStats {
  totalTrades: number;
  resolvedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnl: number;
  avgRMultiple: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio: number;
  bySource: Record<string, { total: number; wins: number; winRate: number; avgPnl: number }>;
  byRegime: Record<string, { total: number; wins: number; winRate: number; avgPnl: number }>;
  byInstrumentType: Record<string, { total: number; wins: number; winRate: number; avgPnl: number }>;
  byConfidenceBucket: CalibrationBucket[];
}

export function computeTrainingStats(): TrainingStats {
  const trades = getResolvedTrades();
  const total = trades.length;
  const wins = trades.filter(t => t.outcome === "WIN").length;
  const losses = trades.filter(t => t.outcome === "LOSS").length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  const pnls = trades.map(t => t.pnl || 0);
  const avgPnl = total > 0 ? pnls.reduce((a, b) => a + b, 0) / total : 0;
  const rMultiples = trades.map(t => t.rMultiple || 0);
  const avgRMultiple = total > 0 ? rMultiples.reduce((a, b) => a + b, 0) / total : 0;

  // Profit factor
  const grossProfit = trades.filter(t => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(trades.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Max drawdown
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    equity += t.pnl || 0;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  // By source
  const bySource: Record<string, any> = {};
  for (const t of trades) {
    const src = t.source || "unknown";
    if (!bySource[src]) bySource[src] = { total: 0, wins: 0, pnlSum: 0 };
    bySource[src].total++;
    if (t.outcome === "WIN") bySource[src].wins++;
    bySource[src].pnlSum += t.pnl || 0;
  }
  for (const [k, v] of Object.entries(bySource)) {
    bySource[k] = { total: v.total, wins: v.wins, winRate: v.total > 0 ? (v.wins / v.total) * 100 : 0, avgPnl: v.total > 0 ? v.pnlSum / v.total : 0 };
  }

  // By regime
  const byRegime: Record<string, any> = {};
  for (const t of trades) {
    const r = t.regime || "UNKNOWN";
    if (!byRegime[r]) byRegime[r] = { total: 0, wins: 0, pnlSum: 0 };
    byRegime[r].total++;
    if (t.outcome === "WIN") byRegime[r].wins++;
    byRegime[r].pnlSum += t.pnl || 0;
  }
  for (const [k, v] of Object.entries(byRegime)) {
    byRegime[k] = { total: v.total, wins: v.wins, winRate: v.total > 0 ? (v.wins / v.total) * 100 : 0, avgPnl: v.total > 0 ? v.pnlSum / v.total : 0 };
  }

  // By instrument type
  const byInstrumentType: Record<string, any> = {};
  for (const t of trades) {
    const it = t.instrumentType || "EQ";
    if (!byInstrumentType[it]) byInstrumentType[it] = { total: 0, wins: 0, pnlSum: 0 };
    byInstrumentType[it].total++;
    if (t.outcome === "WIN") byInstrumentType[it].wins++;
    byInstrumentType[it].pnlSum += t.pnl || 0;
  }
  for (const [k, v] of Object.entries(byInstrumentType)) {
    byInstrumentType[k] = { total: v.total, wins: v.wins, winRate: v.total > 0 ? (v.wins / v.total) * 100 : 0, avgPnl: v.total > 0 ? v.pnlSum / v.total : 0 };
  }

  // Confidence calibration buckets
  const buckets = calibrateConfidence(trades);

  return {
    totalTrades: total,
    resolvedTrades: total,
    wins,
    losses,
    winRate,
    avgPnl,
    avgRMultiple,
    profitFactor,
    maxDrawdown: maxDD,
    sharpeRatio: 0, // simplified
    bySource,
    byRegime,
    byInstrumentType,
    byConfidenceBucket: buckets,
  };
}

// ─── Confidence Calibration ──────────────────────────────────────

function calibrateConfidence(trades: TradeRecord[]): CalibrationBucket[] {
  const ranges = [
    { label: "0-20%", min: 0, max: 20 },
    { label: "20-40%", min: 20, max: 40 },
    { label: "40-50%", min: 40, max: 50 },
    { label: "50-60%", min: 50, max: 60 },
    { label: "60-70%", min: 60, max: 70 },
    { label: "70-80%", min: 70, max: 80 },
    { label: "80-90%", min: 80, max: 90 },
    { label: "90-100%", min: 90, max: 100 },
  ];

  return ranges.map(r => {
    const inBucket = trades.filter(t => t.confidence >= r.min && t.confidence < r.max);
    const wins = inBucket.filter(t => t.outcome === "WIN").length;
    const losses = inBucket.filter(t => t.outcome === "LOSS").length;
    const total = inBucket.length;
    const pnls = inBucket.map(t => t.pnl || 0);
    const rMults = inBucket.map(t => t.rMultiple || 0);

    return {
      range: r.label,
      minScore: r.min,
      maxScore: r.max,
      totalTrades: total,
      wins,
      losses,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      avgPnl: total > 0 ? pnls.reduce((a, b) => a + b, 0) / total : 0,
      avgRMultiple: total > 0 ? rMults.reduce((a, b) => a + b, 0) / total : 0,
    };
  });
}

// ─── Factor Analysis ─────────────────────────────────────────────

export function analyzeFactors(): TrainingInsight[] {
  const trades = getResolvedTrades();
  if (trades.length < 10) return []; // Need minimum data

  const insights: TrainingInsight[] = [];

  // Helper: analyze a binary factor
  function analyzeBinaryFactor(
    name: string,
    extractor: (t: TradeRecord) => boolean | null
  ): void {
    const withFactor = trades.filter(t => extractor(t) === true);
    const withoutFactor = trades.filter(t => extractor(t) === false);
    if (withFactor.length < 5 || withoutFactor.length < 5) return;

    const wrWith = withFactor.filter(t => t.outcome === "WIN").length / withFactor.length;
    const wrWithout = withoutFactor.filter(t => t.outcome === "WIN").length / withoutFactor.length;
    const pnlWith = withFactor.reduce((s, t) => s + (t.pnl || 0), 0) / withFactor.length;
    const pnlWithout = withoutFactor.reduce((s, t) => s + (t.pnl || 0), 0) / withoutFactor.length;

    const diff = wrWith - wrWithout;
    insights.push({
      factor: name,
      winRate: wrWith * 100,
      avgPnl: pnlWith,
      sampleSize: withFactor.length,
      confidence: Math.min(1, withFactor.length / 30), // more samples = more confident
      direction: diff > 0.05 ? "POSITIVE" : diff < -0.05 ? "NEGATIVE" : "NEUTRAL",
    });
  }

  // Helper: analyze numeric factor
  function analyzeNumericFactor(
    name: string,
    extractor: (t: TradeRecord) => number | null,
    threshold: number,
    higherIsBetter?: boolean
  ): void {
    const above = trades.filter(t => { const v = extractor(t); return v !== null && v > threshold; });
    const below = trades.filter(t => { const v = extractor(t); return v !== null && v <= threshold; });
    if (above.length < 5 || below.length < 5) return;

    const wrAbove = above.filter(t => t.outcome === "WIN").length / above.length;
    const wrBelow = below.filter(t => t.outcome === "WIN").length / below.length;
    const pnlAbove = above.reduce((s, t) => s + (t.pnl || 0), 0) / above.length;
    const diff = wrAbove - wrBelow;

    insights.push({
      factor: name,
      winRate: wrAbove * 100,
      avgPnl: pnlAbove,
      sampleSize: above.length,
      confidence: Math.min(1, above.length / 30),
      direction: (higherIsBetter !== false ? diff > 0.05 : diff < -0.05) ? "POSITIVE" :
                 (higherIsBetter !== false ? diff < -0.05 : diff > 0.05) ? "NEGATIVE" : "NEUTRAL",
    });
  }

  // === OPTION-SPECIFIC FACTORS ===
  analyzeBinaryFactor("PCR_BULLISH", t => (t.snapshot?.pcr || 0) > 1.2);
  analyzeBinaryFactor("PCR_BEARISH", t => (t.snapshot?.pcr || 0) < 0.8);
  analyzeBinaryFactor("HIGH_VIX", t => (t.snapshot?.vix || 0) > 20);
  analyzeBinaryFactor("LOW_VIX", t => (t.snapshot?.vix || 0) < 12);
  analyzeBinaryFactor("FUTURES_CONTANGO", t => (t.snapshot?.futuresBasis || 0) > 0);
  analyzeBinaryFactor("FUTURES_BACKWARDATION", t => (t.snapshot?.futuresBasis || 0) < 0);
  analyzeNumericFactor("CE_OI_HIGH", t => t.snapshot?.strikeData?.ceOi, 100000);
  analyzeNumericFactor("PE_OI_HIGH", t => t.snapshot?.strikeData?.peOi, 100000);
  analyzeNumericFactor("CE_VOLUME_HIGH", t => t.snapshot?.strikeData?.ceVolume, 50000);
  analyzeNumericFactor("PE_VOLUME_HIGH", t => t.snapshot?.strikeData?.peVolume, 50000);

  // === INSTITUTIONAL FACTORS ===
  analyzeBinaryFactor("FII_BUYING", t => (t.snapshot?.fiiNet || 0) > 500);
  analyzeBinaryFactor("FII_SELLING", t => (t.snapshot?.fiiNet || 0) < -500);
  analyzeBinaryFactor("DII_BUYING", t => (t.snapshot?.diiNet || 0) > 500);
  analyzeBinaryFactor("FII_LONG_MORE_THAN_SHORT", t => {
    const poi = t.snapshot?.participantOI;
    return poi ? poi.fiiLong > poi.fiiShort : null;
  });
  analyzeBinaryFactor("CLIENT_LONG_MORE_THAN_SHORT", t => {
    const poi = t.snapshot?.participantOI;
    return poi ? poi.clientLong > poi.clientShort : null;
  });

  // === REGIME FACTORS ===
  analyzeBinaryFactor("REGIME_TRENDING", t => (t.snapshot?.regime || "").includes("TREND"));
  analyzeBinaryFactor("REGIME_RANGE", t => (t.snapshot?.regime || "").includes("RANGE"));
  analyzeBinaryFactor("REGIME_VOLATILE", t => (t.snapshot?.regime || "").includes("VOLATIL"));

  // === NEWS FACTOR ===
  analyzeBinaryFactor("NEWS_BULLISH", t => (t.snapshot?.newsScore || 0) > 20);
  analyzeBinaryFactor("NEWS_BEARISH", t => (t.snapshot?.newsScore || 0) < -20);

  // === CONFIDENCE FACTOR ===
  analyzeNumericFactor("HIGH_CONFIDENCE", t => t.confidence, 75);
  analyzeNumericFactor("VERY_HIGH_CONFIDENCE", t => t.confidence, 85);

  // === SPOT MOMENTUM ===
  analyzeBinaryFactor("SPOT_UP_TODAY", t => (t.snapshot?.spotChangePct || 0) > 0.2);
  analyzeBinaryFactor("SPOT_DOWN_TODAY", t => (t.snapshot?.spotChangePct || 0) < -0.2);

  // === SUPPORT/RESISTANCE PROXIMITY ===
  analyzeBinaryFactor("NEAR_SUPPORT", t => {
    if (!t.snapshot?.supportLevels || !t.snapshot?.spot) return null;
    return t.snapshot.supportLevels.some(s => Math.abs(s.strike - t.snapshot.spot) / t.snapshot.spot < 0.01);
  });
  analyzeBinaryFactor("NEAR_RESISTANCE", t => {
    if (!t.snapshot?.resistanceLevels || !t.snapshot?.spot) return null;
    return t.snapshot.resistanceLevels.some(s => Math.abs(s.strike - t.snapshot.spot) / t.snapshot.spot < 0.01);
  });

  // Sort by win rate contribution
  insights.sort((a, b) => b.winRate - a.winRate);
  return insights;
}

// ─── Weight Learning ─────────────────────────────────────────────

export function computeOptimalWeights(): FactorWeight[] {
  const insights = analyzeFactors();
  if (insights.length === 0) return [];

  // Normalize win rates to weights
  const maxWR = Math.max(...insights.map(i => i.winRate));
  const minWR = Math.min(...insights.map(i => i.winRate));
  const range = maxWR - minWR || 1;

  return insights
    .filter(i => i.sampleSize >= 5)
    .map(i => ({
      factor: i.factor,
      weight: ((i.winRate - minWR) / range) * 100, // 0-100 scale
      winRateContribution: i.winRate,
      sampleSize: i.sampleSize,
    }))
    .sort((a, b) => b.weight - a.weight);
}

// ─── Regime-Specific Learning ────────────────────────────────────

export interface RegimeProfile {
  regime: string;
  totalTrades: number;
  winRate: number;
  avgPnl: number;
  bestFactors: string[];
  worstFactors: string[];
  optimalConfidenceMin: number;
}

export function computeRegimeProfiles(): RegimeProfile[] {
  const trades = getResolvedTrades();
  const regimes = [...new Set(trades.map(t => t.regime || "UNKNOWN"))];

  return regimes.map(regime => {
    const regimeTrades = trades.filter(t => (t.regime || "UNKNOWN") === regime);
    const wins = regimeTrades.filter(t => t.outcome === "WIN").length;
    const winRate = regimeTrades.length > 0 ? (wins / regimeTrades.length) * 100 : 0;
    const avgPnl = regimeTrades.length > 0
      ? regimeTrades.reduce((s, t) => s + (t.pnl || 0), 0) / regimeTrades.length
      : 0;

    // Find best/worst factors for this regime
    const factorWR: Record<string, { with: number; without: number }> = {};
    for (const t of regimeTrades) {
      if (t.snapshot?.pcr) {
        const key = "PCR_HIGH";
        if (!factorWR[key]) factorWR[key] = { with: 0, without: 0 };
        if (t.snapshot.pcr > 1.2) factorWR[key].with++;
        else factorWR[key].without++;
      }
      // Add more factor analysis as needed
    }

    const bestFactors = Object.entries(factorWR)
      .filter(([_, v]) => v.with >= 3 && v.with > v.without)
      .map(([k]) => k);

    const worstFactors = Object.entries(factorWR)
      .filter(([_, v]) => v.with >= 3 && v.with < v.without)
      .map(([k]) => k);

    // Optimal confidence threshold
    const sorted = [...regimeTrades].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const top20pct = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2)));
    const optimalConfidenceMin = top20pct.length > 0
      ? Math.min(...top20pct.map(t => t.confidence || 0))
      : 60;

    return {
      regime,
      totalTrades: regimeTrades.length,
      winRate,
      avgPnl,
      bestFactors,
      worstFactors,
      optimalConfidenceMin,
    };
  });
}
