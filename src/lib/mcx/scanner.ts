// MCX Commodity Module — Scanner
// Price structure, volume, OI analysis for 10 approved contracts
// Uses real data only. Never fabricates signals.

import type { MCXCommodity, MCXQuote, MCXScannerResult, MCXDataStatus } from './types';
import { MCX_APPROVED_CONTRACTS, MCX_ENERGY, MCX_PRECIOUS_METALS } from './types';
import { MCX_CONTRACT_SPECS, getMCXContractSpec, isMCXHigherRisk, isMCXLowerLiquidity } from './instrument-master';
import { fetchAllMCXQuotes, fetchMCXQuote } from './market-data';
import { getMCXSession, isMCXActive } from './session';
import { scoreTrade, type MarketDataInput, type TradeDecision } from '@/lib/unified-scoring-engine';

// ── Scanner result cache ──
let scannerCache: { results: MCXScannerResult[]; ts: number } | null = null;
const SCANNER_CACHE_TTL = 30000; // 30 seconds

// ── Main: Run MCX scanner on all 10 approved contracts ──
export async function runMCXScanner(): Promise<MCXScannerResult[]> {
  const now = Date.now();
  if (scannerCache && now - scannerCache.ts < SCANNER_CACHE_TTL) {
    return scannerCache.results;
  }

  const [quotes, session] = await Promise.all([
    fetchAllMCXQuotes(),
    Promise.resolve(getMCXSession()),
  ]);

  const results: MCXScannerResult[] = [];

  for (const symbol of MCX_APPROVED_CONTRACTS) {
    const quote = quotes.get(symbol);
    const spec = MCX_CONTRACT_SPECS[symbol];

    const result = analyzeMCXCommodity(symbol, quote, spec, session.isActive);
    results.push(result);
  }

  // Sort by score descending (best first)
  results.sort((a, b) => {
    //优先级: valid setups first, then by score
    if (a.grade === 'NO_TRADE' && b.grade !== 'NO_TRADE') return 1;
    if (a.grade !== 'NO_TRADE' && b.grade === 'NO_TRADE') return -1;
    return b.score - a.score;
  });

  scannerCache = { results, ts: now };
  return results;
}

// ── Analyze single MCX commodity ──
function analyzeMCXCommodity(
  symbol: MCXCommodity,
  quote: MCXQuote | undefined,
  spec: ReturnType<typeof getMCXContractSpec>,
  sessionActive: boolean
): MCXScannerResult {
  const dataStatus: MCXDataStatus = quote?.dataStatus || 'DATA_UNAVAILABLE';
  const hasData = quote && quote.ltp !== null && quote.ltp > 0;

  // Determine direction first (needed for scoring)
  const direction = determineDirection(quote, null, hasData);

  // Build scoring input
  const input: MarketDataInput = {
    symbol,
    strategy: 'MCX_COMMODITY',
    direction: direction === 'LONG' ? 'BULLISH' : direction === 'SHORT' ? 'BEARISH' : 'NEUTRAL',
    spot: hasData ? quote.ltp! : 0,
    candles: [],
    optionChain: null,
    vix: null,
  };

  // Run unified scoring
  const decision = hasData ? scoreTrade(input) : null;

  // Analyze price structure
  const priceStructure = analyzePriceStructure(quote, hasData);

  // Analyze volume
  const volumeSignal = analyzeVolume(quote, hasData);

  // Analyze OI
  const oiSignal = analyzeOI(quote, hasData);

  // Check liquidity
  const liquidityStatus = checkLiquidity(symbol, quote, hasData);

  // Check risk flags
  const riskFlags = checkRiskFlags(symbol, quote, spec, hasData);

  // Calculate entry/SL/target from structure
  const levels = calculateLevels(symbol, quote, direction, hasData);

  // Build reasons
  const reasons = buildReasons(symbol, decision, priceStructure, volumeSignal, oiSignal, liquidityStatus, riskFlags);

  // Use decision direction if available (overrides initial direction)
  const finalDirection = decision?.direction === 'BUY' ? 'LONG' : decision?.direction === 'SELL' ? 'SHORT' : direction;

  // Check if should be NO_TRADE
  const shouldNoTrade = !hasData || !sessionActive || liquidityStatus === 'INSUFFICIENT' ||
    riskFlags.length > 0 || decision?.decision === 'NO_TRADE';

  return {
    symbol,
    category: spec.category,
    direction: shouldNoTrade ? 'NEUTRAL' : finalDirection,
    score: decision?.score || 0,
    grade: shouldNoTrade ? 'NO_TRADE' : (decision?.grade || 'NO_TRADE'),
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    target: levels.target,
    riskReward: levels.riskReward,
    maxLoss: levels.maxLoss,
    lotSize: spec.lotSize,
    quantity: spec.lotSize,
    capitalRequired: levels.entry * spec.lotSize,
    liquidityStatus,
    dataStatus,
    priceStructure,
    volumeSignal,
    oiSignal,
    reasons,
    riskFlags,
    timestamp: new Date().toISOString(),
  };
}

// ── Price Structure Analysis ──
function analyzePriceStructure(quote: MCXQuote | undefined, hasData: boolean): string[] {
  if (!hasData || !quote) return ['NO_DATA'];

  const signals: string[] = [];

  // Trend direction from price change
  if (quote.changePercent !== null) {
    if (quote.changePercent > 2) signals.push('STRONG_UPTREND');
    else if (quote.changePercent > 0.5) signals.push('UPTREND');
    else if (quote.changePercent < -2) signals.push('STRONG_DOWNTREND');
    else if (quote.changePercent < -0.5) signals.push('DOWNTREND');
    else signals.push('RANGE_BOUND');
  }

  // Intraday range expansion
  if (quote.high !== null && quote.low !== null && quote.ltp !== null) {
    const range = quote.high - quote.low;
    const midPrice = (quote.high + quote.low) / 2;
    const rangePercent = midPrice > 0 ? (range / midPrice) * 100 : 0;

    if (rangePercent > 3) signals.push('RANGE_EXPANSION');
    else if (rangePercent < 0.5) signals.push('CONSOLIDATION');
  }

  // Position within day's range
  if (quote.high !== null && quote.low !== null && quote.ltp !== null) {
    const range = quote.high - quote.low;
    if (range > 0) {
      const position = (quote.ltp - quote.low) / range;
      if (position > 0.8) signals.push('NEAR_HIGH');
      else if (position < 0.2) signals.push('NEAR_LOW');
    }
  }

  return signals.length > 0 ? signals : ['NEUTRAL'];
}

// ── Volume Analysis ──
function analyzeVolume(quote: MCXQuote | undefined, hasData: boolean): string[] {
  if (!hasData || !quote) return ['NO_DATA'];

  const signals: string[] = [];

  if (quote.volume !== null && quote.volume > 0) {
    signals.push('VOLUME_AVAILABLE');
    // Note: Without historical average, can't determine relative volume
    // This would need historical data integration
  } else {
    signals.push('VOLUME_UNAVAILABLE');
  }

  return signals;
}

// ── OI Analysis ──
function analyzeOI(quote: MCXQuote | undefined, hasData: boolean): string[] {
  if (!hasData || !quote) return ['NO_DATA'];

  const signals: string[] = [];

  if (quote.openInterest !== null && quote.openInterest > 0) {
    signals.push('OI_AVAILABLE');
    if (quote.changeInOI !== null) {
      if (quote.changeInOI > 0) signals.push('OI_INCREASE');
      else if (quote.changeInOI < 0) signals.push('OI_DECREASE');
    }
  } else {
    signals.push('OI_UNAVAILABLE');
  }

  return signals;
}

// ── Liquidity Check ──
function checkLiquidity(
  symbol: MCXCommodity,
  quote: MCXQuote | undefined,
  hasData: boolean
): 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT' {
  if (!hasData || !quote) return 'INSUFFICIENT';

  const spec = MCX_CONTRACT_SPECS[symbol];
  let score = 0;

  // Volume-based liquidity
  if (quote.volume !== null) {
    if (quote.volume > 10000) score += 3;
    else if (quote.volume > 1000) score += 2;
    else if (quote.volume > 100) score += 1;
  }

  // OI-based liquidity
  if (quote.openInterest !== null) {
    if (quote.openInterest > 50000) score += 3;
    else if (quote.openInterest > 10000) score += 2;
    else if (quote.openInterest > 1000) score += 1;
  }

  // Bid-ask spread (if available)
  if (quote.bid !== null && quote.ask !== null && quote.ltp !== null) {
    const spread = quote.ask - quote.bid;
    const spreadPercent = quote.ltp > 0 ? (spread / quote.ltp) * 100 : 0;
    if (spreadPercent < 0.1) score += 2;
    else if (spreadPercent < 0.5) score += 1;
    else if (spreadPercent > 2) score -= 1;
  }

  // Lower liquidity filter for specific commodities
  if (isMCXLowerLiquidity(symbol)) {
    score -= 1;
  }

  if (score >= 5) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  if (score >= 1) return 'LOW';
  return 'INSUFFICIENT';
}

// ── Risk Flags ──
function checkRiskFlags(
  symbol: MCXCommodity,
  quote: MCXQuote | undefined,
  spec: ReturnType<typeof getMCXContractSpec>,
  hasData: boolean
): string[] {
  const flags: string[] = [];

  if (!hasData || !quote) {
    flags.push('NO_DATA');
    return flags;
  }

  // Higher risk filter for NATURALGAS, NATGASMINI
  if (isMCXHigherRisk(symbol)) {
    // Check for extreme price movement
    if (quote.changePercent !== null && Math.abs(quote.changePercent) > 5) {
      flags.push('EXTREME_VOLATILITY');
    }

    // Check for large range expansion
    if (quote.high !== null && quote.low !== null && quote.ltp !== null) {
      const range = quote.high - quote.low;
      const rangePercent = quote.ltp > 0 ? (range / quote.ltp) * 100 : 0;
      if (rangePercent > 5) {
        flags.push('RANGE_EXPANSION_WARNING');
      }
    }
  }

  // Check for stale data
  if (quote.timestamp) {
    const age = (Date.now() - new Date(quote.timestamp).getTime()) / 1000;
    if (age > 300) flags.push('STALE_DATA');
  }

  return flags;
}

// ── Determine Direction ──
function determineDirection(
  quote: MCXQuote | undefined,
  decision: TradeDecision | null,
  hasData: boolean
): 'LONG' | 'SHORT' | 'NEUTRAL' {
  if (!hasData || !quote) return 'NEUTRAL';

  if (decision?.decision === 'NO_TRADE') return 'NEUTRAL';

  // Use unified scoring direction
  if (decision?.direction) {
    return decision.direction === 'BUY' ? 'LONG' : 'SHORT';
  }

  // Fallback: price change direction
  if (quote.changePercent !== null) {
    if (quote.changePercent > 0.5) return 'LONG';
    if (quote.changePercent < -0.5) return 'SHORT';
  }

  return 'NEUTRAL';
}

// ── Calculate Entry/SL/Target from Structure ──
function calculateLevels(
  symbol: MCXCommodity,
  quote: MCXQuote | undefined,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
  hasData: boolean
): { entry: number; stopLoss: number; target: number; riskReward: number; maxLoss: number } {
  if (!hasData || !quote || !quote.ltp || direction === 'NEUTRAL') {
    return { entry: 0, stopLoss: 0, target: 0, riskReward: 0, maxLoss: 0 };
  }

  const entry = quote.ltp;
  const spec = MCX_CONTRACT_SPECS[symbol];

  // Structure-based SL: use day's low/high or ATR-based
  let stopLoss = 0;
  let target = 0;

  if (direction === 'LONG') {
    // SL below day's low (or 2% below entry if no low data)
    stopLoss = quote.low !== null ? quote.low * 0.99 : entry * 0.98;
    // Target: 1.5x risk from entry to SL
    const risk = entry - stopLoss;
    target = entry + risk * 1.5;
  } else if (direction === 'SHORT') {
    // SL above day's high (or 2% above entry if no high data)
    stopLoss = quote.high !== null ? quote.high * 1.01 : entry * 1.02;
    // Target: 1.5x risk from entry to SL
    const risk = stopLoss - entry;
    target = entry - risk * 1.5;
  }

  const riskPerUnit = Math.abs(entry - stopLoss);
  const rewardPerUnit = Math.abs(target - entry);
  const riskReward = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;
  const maxLoss = riskPerUnit * spec.lotSize;

  return { entry, stopLoss, target, riskReward, maxLoss };
}

// ── Build Reasons ──
function buildReasons(
  symbol: MCXCommodity,
  decision: TradeDecision | null,
  priceStructure: string[],
  volumeSignal: string[],
  oiSignal: string[],
  liquidityStatus: string,
  riskFlags: string[]
): string[] {
  const reasons: string[] = [];

  // Add decision reasons
  if (decision?.reasons) {
    reasons.push(...decision.reasons.slice(0, 3));
  }

  // Add structure signals
  if (priceStructure.length > 0 && !priceStructure.includes('NO_DATA')) {
    reasons.push(`Structure: ${priceStructure.join(', ')}`);
  }

  // Add volume/OI context
  if (volumeSignal.includes('VOLUME_AVAILABLE')) {
    reasons.push('Volume data available');
  }
  if (oiSignal.includes('OI_AVAILABLE')) {
    reasons.push('OI data available');
  }

  // Add liquidity context
  if (liquidityStatus === 'INSUFFICIENT') {
    reasons.push('Insufficient liquidity');
  }

  return reasons.slice(0, 5); // Max 5 reasons
}

// ── Get best MCX trade ──
export async function getBestMCXTrade(): Promise<MCXScannerResult | null> {
  const results = await runMCXScanner();
  const validTrades = results.filter(r => r.grade !== 'NO_TRADE' && r.score > 0);
  return validTrades.length > 0 ? validTrades[0] : null;
}

// ── Get MCX scanner summary ──
export async function getMCXScannerSummary(): Promise<{
  total: number;
  tradeable: number;
  bestTrade: MCXScannerResult | null;
  sessionActive: boolean;
  dataHealth: string;
}> {
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
