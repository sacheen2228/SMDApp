// MCX Commodity Module — Scanner v2
// Fetches Yahoo candles, computes ATR/trend/SR, generates Entry/SL/TP
// Uses real data only. Never fabricates signals.

import type { MCXCommodity, MCXQuote, MCXScannerResult, MCXDataStatus } from './types';
import { MCX_APPROVED_CONTRACTS } from './types';
import { MCX_CONTRACT_SPECS, isMCXHigherRisk, isMCXLowerLiquidity } from './instrument-master';
import { fetchAllMCXQuotes } from './market-data';
import { getMCXSession } from './session';
import { scoreTrade, type MarketDataInput } from '@/lib/unified-scoring-engine';

// ── Yahoo ticker mapping ──
const MCX_TO_YAHOO: Record<MCXCommodity, string> = {
  CRUDEOIL: 'CL=F', CRUDEOILM: 'CL=F',
  NATURALGAS: 'NG=F', NATGASMINI: 'NG=F',
  GOLD: 'GC=F', GOLDM: 'GC=F', GOLDGUINEA: 'GC=F',
  SILVER: 'SI=F', SILVERM: 'SI=F', SILVERMIC: 'SI=F',
};

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Cache ──
let scannerCache: { results: MCXScannerResult[]; ts: number } | null = null;
const SCANNER_CACHE_TTL = 30000;
const candleCache = new Map<string, { candles: Candle[]; ts: number }>();
const CANDLE_CACHE_TTL = 300000; // 5 min

// ── Fetch daily candles from Yahoo for a commodity ──
async function fetchMCXCandles(symbol: MCXCommodity): Promise<Candle[]> {
  const yahooSym = MCX_TO_YAHOO[symbol];
  if (!yahooSym) return [];

  const cacheKey = yahooSym;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CANDLE_CACHE_TTL) return cached.candles;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=3mo&interval=1d`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const candles: Candle[] = [];

    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (close == null) continue;
      candles.push({
        time: ts[i],
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        volume: q.volume?.[i] || 0,
      });
    }

    if (candles.length > 0) {
      candleCache.set(cacheKey, { candles, ts: Date.now() });
    }
    return candles;
  } catch {
    return [];
  }
}

// ── Technical Analysis from Candles ──
function computeTechnicals(candles: Candle[]): {
  atr: number;
  atrPercent: number;
  ema9: number;
  ema21: number;
  trend: 'UP' | 'DOWN' | 'FLAT';
  support: number;
  resistance: number;
  avgVolume: number;
  lastClose: number;
  range20d: number;
} {
  if (candles.length < 5) {
    return { atr: 0, atrPercent: 0, ema9: 0, ema21: 0, trend: 'FLAT', support: 0, resistance: 0, avgVolume: 0, lastClose: 0, range20d: 0 };
  }

  const last = candles[candles.length - 1];
  const lastClose = last.close;

  // ATR (14-period)
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr14 = trs.length >= 14
    ? trs.slice(-14).reduce((s, v) => s + v, 0) / 14
    : trs.reduce((s, v) => s + v, 0) / trs.length;
  const atrPercent = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;

  // EMA 9 and 21
  const ema9 = computeEMA(candles.map(c => c.close), 9);
  const ema21 = computeEMA(candles.map(c => c.close), 21);

  // Trend
  let trend: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
  if (ema9 > ema21 * 1.002) trend = 'UP';
  else if (ema9 < ema21 * 0.998) trend = 'DOWN';

  // Support/Resistance (20-day low/high)
  const recent20 = candles.slice(-20);
  const support = Math.min(...recent20.map(c => c.low));
  const resistance = Math.max(...recent20.map(c => c.high));
  const range20d = resistance - support;

  // Average volume
  const avgVolume = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, candles.length);

  return { atr: atr14, atrPercent, ema9, ema21, trend, support, resistance, avgVolume, lastClose, range20d };
}

function computeEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Main Scanner ──
export async function runMCXScanner(): Promise<MCXScannerResult[]> {
  const now = Date.now();
  if (scannerCache && now - scannerCache.ts < SCANNER_CACHE_TTL) return scannerCache.results;

  const [quotes, session] = await Promise.all([
    fetchAllMCXQuotes(),
    Promise.resolve(getMCXSession()),
  ]);

  // Fetch candles for all commodities in parallel (4 unique Yahoo tickers)
  const uniqueTickers = [...new Set(Object.values(MCX_TO_YAHOO))];
  const tickerCandles = new Map<string, Candle[]>();
  await Promise.all(uniqueTickers.map(async (ticker) => {
    const sym = Object.entries(MCX_TO_YAHOO).find(([, v]) => v === ticker)?.[0] as MCXCommodity;
    if (sym) tickerCandles.set(ticker, await fetchMCXCandles(sym));
  }));

  const results: MCXScannerResult[] = [];

  for (const symbol of MCX_APPROVED_CONTRACTS) {
    const quote = quotes.get(symbol);
    const spec = MCX_CONTRACT_SPECS[symbol];
    const yahooSym = MCX_TO_YAHOO[symbol];
    const candles = tickerCandles.get(yahooSym) || [];

    results.push(analyzeMCXCommodity(symbol, quote, spec, candles, session.isActive));
  }

  // Sort: tradeable first, then by score
  results.sort((a, b) => {
    if (a.grade === 'NO_TRADE' && b.grade !== 'NO_TRADE') return 1;
    if (a.grade !== 'NO_TRADE' && b.grade === 'NO_TRADE') return -1;
    return b.score - a.score;
  });

  scannerCache = { results, ts: now };
  return results;
}

// ── Analyze single commodity ──
function analyzeMCXCommodity(
  symbol: MCXCommodity,
  quote: MCXQuote | undefined,
  spec: ReturnType<typeof MCX_CONTRACT_SPECS extends Record<any, infer V> ? () => V : never>,
  candles: Candle[],
  sessionActive: boolean
): MCXScannerResult {
  const hasData = quote && quote.ltp !== null && quote.ltp > 0;
  const hasCandles = candles.length >= 10;

  if (!hasData) {
    return noTradeResult(symbol, spec, 'DATA_UNAVAILABLE', sessionActive);
  }

  const ltp = quote.ltp!;
  const technicals = hasCandles ? computeTechnicals(candles) : null;

  // Direction from trend
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (technicals) {
    if (technicals.trend === 'UP' && ltp > technicals.ema21) direction = 'LONG';
    else if (technicals.trend === 'DOWN' && ltp < technicals.ema21) direction = 'SHORT';
    else if (quote.changePercent !== null) {
      if (quote.changePercent > 0.3) direction = 'LONG';
      else if (quote.changePercent < -0.3) direction = 'SHORT';
    }
  } else if (quote.changePercent !== null) {
    if (quote.changePercent > 0.5) direction = 'LONG';
    else if (quote.changePercent < -0.5) direction = 'SHORT';
  }

  if (direction === 'NEUTRAL') {
    return noTradeResult(symbol, spec, 'NO_SIGNAL', sessionActive);
  }

  // Entry/SL/Target from structure
  const levels = computeStructureLevels(ltp, direction, technicals, spec);

  // Score via unified engine
  const input: MarketDataInput = {
    symbol,
    strategy: 'MCX_COMMODITY',
    direction: direction === 'LONG' ? 'BULLISH' : 'BEARISH',
    spot: ltp,
    candles: hasCandles ? candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })) : [],
    prevClose: quote.previousClose || undefined,
    dayHigh: quote.high || undefined,
    dayLow: quote.low || undefined,
    atr: technicals?.atr,
    atrPercent: technicals?.atrPercent,
    avgVolume: technicals?.avgVolume || undefined,
    currentVolume: quote.volume || undefined,
  };

  const decision = scoreTrade(input);

  // Risk flags
  const riskFlags: string[] = [];
  if (isMCXHigherRisk(symbol) && technicals && technicals.atrPercent > 4) {
    riskFlags.push('HIGH_VOLATILITY');
  }
  if (quote.timestamp) {
    const age = (Date.now() - new Date(quote.timestamp).getTime()) / 1000;
    if (age > 300) riskFlags.push('STALE_DATA');
  }

  // Liquidity
  const liquidityStatus = checkLiquidity(symbol, quote, technicals);

  // Reasons
  const reasons: string[] = [];
  if (technicals) {
    reasons.push(`Trend: ${technicals.trend}`);
    if (direction === 'LONG') reasons.push(`Above EMA21 (${technicals.ema21.toFixed(1)})`);
    else reasons.push(`Below EMA21 (${technicals.ema21.toFixed(1)})`);
    reasons.push(`ATR: ${technicals.atr.toFixed(1)} (${technicals.atrPercent.toFixed(1)}%)`);
  }
  if (decision.reasons?.length) reasons.push(...decision.reasons.slice(0, 2));

  // Grade
  let grade: MCXScannerResult['grade'] = 'NO_TRADE';
  if (decision.score >= 90) grade = 'A+';
  else if (decision.score >= 80) grade = 'A';
  else if (decision.score >= 70) grade = 'B';
  else if (decision.score >= 60) grade = 'WATCH';

  // Block trade only for risk flags or insufficient liquidity
  // Session closed: show signal but mark as WATCH (not actionable yet)
  if (riskFlags.length > 0 || liquidityStatus === 'INSUFFICIENT') {
    grade = 'NO_TRADE';
    direction = 'NEUTRAL';
  } else if (!sessionActive && grade !== 'NO_TRADE') {
    // Market closed — downgrade to WATCH but keep the signal visible
    grade = 'WATCH';
  }

  return {
    symbol,
    category: spec.category,
    direction,
    score: decision.score,
    grade,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    target: levels.target,
    riskReward: levels.riskReward,
    maxLoss: levels.maxLoss,
    lotSize: spec.lotSize,
    quantity: spec.lotSize,
    capitalRequired: levels.entry * spec.lotSize,
    liquidityStatus,
    dataStatus: quote.dataStatus,
    priceStructure: technicals ? [technicals.trend, `ATR ${technicals.atrPercent.toFixed(1)}%`] : ['NO_CANDLES'],
    volumeSignal: quote.volume ? [`Vol ${quote.volume.toLocaleString()}`] : ['NO_VOLUME'],
    oiSignal: quote.openInterest ? [`OI ${quote.openInterest.toLocaleString()}`] : ['NO_OI'],
    reasons,
    riskFlags,
    timestamp: new Date().toISOString(),
  };
}

// ── Structure-based Entry/SL/Target ──
function computeStructureLevels(
  ltp: number,
  direction: 'LONG' | 'SHORT',
  technicals: ReturnType<typeof computeTechnicals> | null,
  spec: any
): { entry: number; stopLoss: number; target: number; riskReward: number; maxLoss: number } {
  const entry = ltp;

  if (!technicals || technicals.atr === 0) {
    // Fallback: 2% SL, 3% target
    const sl = direction === 'LONG' ? entry * 0.98 : entry * 1.02;
    const tp = direction === 'LONG' ? entry * 1.03 : entry * 0.97;
    const risk = Math.abs(entry - sl);
    return {
      entry,
      stopLoss: sl,
      target: tp,
      riskReward: risk > 0 ? Math.abs(tp - entry) / risk : 0,
      maxLoss: risk * spec.lotSize,
    };
  }

  let stopLoss: number;
  let target: number;

  if (direction === 'LONG') {
    // SL: below recent support or 1.5x ATR below entry
    const slAtr = entry - technicals.atr * 1.5;
    const slSupport = technicals.support * 0.995;
    stopLoss = Math.max(slAtr, slSupport);

    // Target: next resistance or 2x ATR above entry
    const tpAtr = entry + technicals.atr * 2.5;
    const tpResistance = technicals.resistance;
    target = tpResistance > entry ? Math.min(tpAtr, tpResistance * 1.01) : tpAtr;
  } else {
    // SL: above recent resistance or 1.5x ATR above entry
    const slAtr = entry + technicals.atr * 1.5;
    const slResistance = technicals.resistance * 1.005;
    stopLoss = Math.min(slAtr, slResistance);

    // Target: next support or 2x ATR below entry
    const tpAtr = entry - technicals.atr * 2.5;
    const tpSupport = technicals.support;
    target = tpSupport < entry ? Math.max(tpAtr, tpSupport * 0.995) : tpAtr;
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(target - entry);
  const riskReward = risk > 0 ? reward / risk : 0;

  return {
    entry,
    stopLoss,
    target,
    riskReward,
    maxLoss: risk * spec.lotSize,
  };
}

// ── Liquidity check ──
function checkLiquidity(
  symbol: MCXCommodity,
  quote: MCXQuote | undefined,
  technicals: ReturnType<typeof computeTechnicals> | null
): 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT' {
  if (!quote || quote.ltp === null) return 'INSUFFICIENT';

  let score = 0;

  // Volume vs average
  if (quote.volume && technicals && technicals.avgVolume > 0) {
    const relVol = quote.volume / technicals.avgVolume;
    if (relVol > 2) score += 3;
    else if (relVol > 1) score += 2;
    else if (relVol > 0.5) score += 1;
  } else if (quote.volume && quote.volume > 1000) {
    score += 2;
  }

  // OI
  if (quote.openInterest && quote.openInterest > 10000) score += 2;
  else if (quote.openInterest && quote.openInterest > 1000) score += 1;

  // Lower liquidity commodities
  if (isMCXLowerLiquidity(symbol)) score -= 1;

  if (score >= 4) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  if (score >= 1) return 'LOW';
  return 'INSUFFICIENT';
}

// ── No-trade result ──
function noTradeResult(
  symbol: MCXCommodity,
  spec: any,
  reason: string,
  sessionActive: boolean
): MCXScannerResult {
  return {
    symbol,
    category: spec.category,
    direction: 'NEUTRAL',
    score: 0,
    grade: 'NO_TRADE',
    entry: 0,
    stopLoss: 0,
    target: 0,
    riskReward: 0,
    maxLoss: 0,
    lotSize: spec.lotSize,
    quantity: spec.lotSize,
    capitalRequired: 0,
    liquidityStatus: 'INSUFFICIENT',
    dataStatus: reason === 'DATA_UNAVAILABLE' ? 'DATA_UNAVAILABLE' : 'LIVE',
    priceStructure: [reason],
    volumeSignal: [],
    oiSignal: [],
    reasons: [reason],
    riskFlags: [],
    timestamp: new Date().toISOString(),
  };
}

// ── Best trade ──
export async function getBestMCXTrade(): Promise<MCXScannerResult | null> {
  const results = await runMCXScanner();
  const valid = results.filter(r => r.grade !== 'NO_TRADE' && r.score > 0);
  return valid.length > 0 ? valid[0] : null;
}

// ── Summary ──
export async function getMCXScannerSummary() {
  const results = await runMCXScanner();
  const tradeable = results.filter(r => r.grade !== 'NO_TRADE');
  const session = getMCXSession();
  return {
    total: results.length,
    tradeable: tradeable.length,
    bestTrade: tradeable.length > 0 ? tradeable[0] : null,
    sessionActive: session.isActive,
    dataHealth: session.description,
  };
}
