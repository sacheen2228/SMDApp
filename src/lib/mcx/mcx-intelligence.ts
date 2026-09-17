// MCX Intelligence — Master Orchestrator
// Collects all MCX intel, scores candidates, feeds into Hermes Pro.
// This is the entry point for MCX analysis.
// Does NOT replace Hermes Pro — provides commodity-specific intelligence.

import type { MCXCommodity } from './types';
import { MCX_APPROVED_CONTRACTS } from './types';
import { MCX_CONTRACT_SPECS, isMCXHigherRisk, isMCXLowerLiquidity } from './instrument-master';
import { getMCXSession, isMCXActive } from './session';
import { fetchAllMCXQuotes } from './market-data';
import { loadMCXOptionChain } from './option-chain';
import { analyzeMCXRegime, type MCXRegimeResult } from './mcx-regime';
import { analyzeMCXStructure, type MCXStructureResult } from './mcx-structure';
import { analyzeMCXVolumeOI, type MCXVolumeOIResult } from './mcx-volume-oi';
import { analyzeMCXVolatility, type MCXVolatilityResult } from './mcx-volatility';
import { analyzeMCXOptionIntel, calculateOptionRR, type MCXOptionIntelResult } from './mcx-option-intel';
import { scoreMCXCandidate, DEFAULT_MCX_WEIGHTS, type MCXScoreResult } from './mcx-scorer';

// ── Yahoo candle fetching (same as scanner) ──
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
const intelCache = new Map<string, { result: MCXInstrumentIntelligence; ts: number }>();
const INTEL_CACHE_TTL = 60_000; // 60s
const candleCache = new Map<string, { candles: Candle[]; ts: number }>();

// ── Fetch candles ──
async function fetchCandles(symbol: MCXCommodity): Promise<Candle[]> {
  const yahooSym = MCX_TO_YAHOO[symbol];
  if (!yahooSym) return [];
  const cached = candleCache.get(yahooSym);
  if (cached && Date.now() - cached.ts < 300_000) return cached.candles;

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
    if (candles.length > 0) candleCache.set(yahooSym, { candles, ts: Date.now() });
    return candles;
  } catch { return []; }
}

// ── Intelligence for a single instrument ──
export interface MCXInstrumentIntelligence {
  symbol: MCXCommodity;
  regime: MCXRegimeResult;
  structure: MCXStructureResult;
  volumeOI: MCXVolumeOIResult;
  volatility: MCXVolatilityResult;
  optionIntel: MCXOptionIntelResult;
  longScore: MCXScoreResult;
  shortScore: MCXScoreResult;
  bestCandidate: {
    direction: 'LONG' | 'SHORT';
    score: MCXScoreResult;
    entry: number;
    stopLoss: number;
    target1: number;
    target2: number;
    actualRR: number;
    netRR: number;
    optionCandidate: any;
  } | null;
  dataFreshness: {
    candlesAvailable: boolean;
    candleCount: number;
    optionChainAvailable: boolean;
    quoteAvailable: boolean;
  };
  timestamp: string;
}

// ── Analyze a single MCX instrument ──
export async function analyzeMCXInstrument(
  symbol: MCXCommodity
): Promise<MCXInstrumentIntelligence> {
  const cacheKey = symbol;
  const cached = intelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < INTEL_CACHE_TTL) return cached.result;

  const spec = MCX_CONTRACT_SPECS[symbol];

  // Fetch data in parallel
  const [candles, quoteMap, optionChain] = await Promise.all([
    fetchCandles(symbol),
    fetchAllMCXQuotes().catch(() => new Map()),
    loadMCXOptionChain(symbol).catch(() => null),
  ]);

  const quote = quoteMap.get(symbol);
  const currentPrice = quote?.ltp || optionChain?.spotPrice || (candles.length > 0 ? candles[candles.length - 1].close : 0);

  // Regime
  const regime = analyzeMCXRegime(symbol, candles, currentPrice);

  // Structure
  const structure = analyzeMCXStructure(symbol, candles, currentPrice);

  // Volume/OI
  const volOI = analyzeMCXVolumeOI(symbol, {
    price: currentPrice,
    prevPrice: candles.length > 1 ? candles[candles.length - 2].close : currentPrice,
    volume: quote?.volume || 0,
    avgVolume: candles.length > 20
      ? candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
      : 1000,
    oi: quote?.openInterest || 0,
    prevOI: (quote?.openInterest || 0) - (quote?.changeInOI || 0),
    ceVolume: optionChain?.totalCEVolume,
    peVolume: optionChain?.totalPEVolume,
    ceOI: optionChain?.totalCEOI,
    peOI: optionChain?.totalPEOI,
  });

  // Volatility
  const volatility = analyzeMCXVolatility(
    symbol, candles, currentPrice,
    optionChain?.ivix ? optionChain.ivix / 100 : undefined
  );

  // Option intel
  const optionIntel = analyzeMCXOptionIntel(symbol, optionChain);

  // Score both directions
  const longScore = scoreMCXCandidate('LONG', structure, regime, volOI, volatility, optionIntel);
  const shortScore = scoreMCXCandidate('SHORT', structure, regime, volOI, volatility, optionIntel);

  // Pick best candidate
  let bestCandidate: MCXInstrumentIntelligence['bestCandidate'] = null;
  const direction = longScore.total >= shortScore.total ? 'LONG' : 'SHORT';
  const score = direction === 'LONG' ? longScore : shortScore;
  const optionCandidate = direction === 'LONG' ? optionIntel.bestCE : optionIntel.bestPE;

  if (score.total >= 50 && optionCandidate && currentPrice > 0) {
    // Calculate entry/SL/Target from structure
    const atr = volatility.atr;
    let entry = currentPrice;
    let stopLoss: number;
    let target1: number;
    let target2: number;

    if (direction === 'LONG') {
      stopLoss = Math.max(
        structure.supportLevels[0] || currentPrice - atr * 1.5,
        currentPrice - atr * 1.5
      );
      target1 = currentPrice + atr * 2;
      target2 = structure.resistanceLevels[0] || currentPrice + atr * 3;
    } else {
      stopLoss = Math.min(
        structure.resistanceLevels[0] || currentPrice + atr * 1.5,
        currentPrice + atr * 1.5
      );
      target1 = currentPrice - atr * 2;
      target2 = structure.supportLevels[0] || currentPrice - atr * 3;
    }

    // Option RR
    const optionEntry = optionCandidate.ltp;
    const optionSL = optionEntry * 0.5; // 50% of premium as SL
    const optionTP1 = optionEntry + (direction === 'LONG' ? 1 : -1) * (target1 - currentPrice) * optionCandidate.delta;
    const optionTP2 = optionEntry + (direction === 'LONG' ? 1 : -1) * (target2 - currentPrice) * optionCandidate.delta;

    const { actualRR, netRR } = calculateOptionRR(optionEntry, optionSL, Math.max(optionTP1, optionEntry * 1.5));

    bestCandidate = {
      direction,
      score,
      entry,
      stopLoss,
      target1,
      target2,
      actualRR,
      netRR,
      optionCandidate,
    };
  }

  const result: MCXInstrumentIntelligence = {
    symbol,
    regime,
    structure,
    volumeOI: volOI,
    volatility,
    optionIntel,
    longScore,
    shortScore,
    bestCandidate,
    dataFreshness: {
      candlesAvailable: candles.length > 0,
      candleCount: candles.length,
      optionChainAvailable: !!optionChain,
      quoteAvailable: !!quote,
    },
    timestamp: new Date().toISOString(),
  };

  intelCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}

// ── Scan all MCX instruments ──
export async function scanAllMCX(): Promise<MCXInstrumentIntelligence[]> {
  const results = await Promise.all(
    MCX_APPROVED_CONTRACTS.map(sym => analyzeMCXInstrument(sym).catch(err => {
      console.error(`[MCX Intelligence] Failed for ${sym}:`, err);
      return null;
    }))
  );
  return results.filter((r): r is MCXInstrumentIntelligence => r !== null);
}

// ── Get best MCX opportunity across all instruments ──
export async function getBestMCXOpportunity(): Promise<{
  instrument: MCXCommodity;
  intelligence: MCXInstrumentIntelligence;
} | null> {
  const all = await scanAllMCX();
  const withCandidates = all
    .filter(i => i.bestCandidate !== null)
    .sort((a, b) => (b.bestCandidate?.score.total || 0) - (a.bestCandidate?.score.total || 0));

  return withCandidates.length > 0
    ? { instrument: withCandidates[0].symbol, intelligence: withCandidates[0] }
    : null;
}

// ── MCX system status ──
export async function getMCXSystemStatus() {
  const session = getMCXSession();
  const isActive = isMCXActive();

  // Check data freshness
  const freshnessChecks = await Promise.all(
    MCX_APPROVED_CONTRACTS.slice(0, 4).map(async (sym) => {
      const candles = await fetchCandles(sym);
      return { symbol: sym, candleCount: candles.length, hasData: candles.length > 0 };
    })
  );

  return {
    session: session.description,
    isActive,
    instrumentsMonitored: MCX_APPROVED_CONTRACTS.length,
    dataFreshness: freshnessChecks,
    timestamp: new Date().toISOString(),
  };
}
