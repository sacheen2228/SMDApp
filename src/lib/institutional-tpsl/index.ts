// ═══════════════════════════════════════════════════════════════════
// INSTITUTIONAL TRADING ENGINE v2 — ORCHESTRATOR
// Wires all 20 modules into a single evaluation pipeline that reads the
// REAL option-chain Greeks / OI / depth + underlying candles:
//
//   1 MarketData  2 Session       3 PriceAction   4 Structure
//   5 Liquidity    6 OrderFlow     7 Volume        8 OptionAnalytics
//   9 Expiry      10 Risk         11 DynamicSL    12 DynamicTP
//  13 Confidence  14 Validator    15 StrikeSelection  (+ Premium Projection)
//  + Dashboard & Audit integration points (consumers of the result).
//
// Single entry points:
//   evaluateInstitutionalCandidate(req) → best single idea (full result)
//   institutionalScan(req)              → ranked candidates (ZeroHeroResult[])
//   toZeroHeroCandidateResult(...)      → maps to existing production shape
// ═══════════════════════════════════════════════════════════════════

import { Candle, OptionType, ExpiryKind } from './types';
import {
  ChainStrike, ChainStats, OptionLeg,
  computeChainStats, finalizeChainStats,
} from './chain';
import { summarizeMarketData, MarketDataReport } from './market-data';
import { classifySession, SessionReport } from './session';
import { analyzePriceAction, PriceActionReport } from './price-action';
import {
  analyzeStructure, StructureReport,
} from './structure-analyzer';
import { analyzeLiquidity, LiquidityReport } from './liquidity';
import { analyzeOrderFlow, OrderFlowReport } from './order-flow';
import { analyzeVolume, VolumeReport } from './volume';
import { analyzeOption, OptionAnalytics } from './option-analytics';
import { analyzeVolatility, VolatilityReport } from './volatility-engine';
import { projectPremium, PremiumReport } from './premium-projection';
import { analyzeExpiry, ExpiryReport } from './expiry-model';
import { computeRisk, RiskReport, Direction } from './risk';
import { computeDynamicSL, DynamicSLReport } from './sl-engine';
import { computeDynamicTP, DynamicTPReport } from './tp-engine';
import { computeConfidence, ConfidenceReport } from './confidence';
import { validateTrade, ValidationResult } from './validator';
import { selectStrike } from './strike-selection';
import { ZeroHeroCandidateResult } from '@/lib/ProTradeEngine';

// ─── Request / result types ───────────────────────────────────────
export interface InstitutionalRequest {
  symbol: string;
  spot: number;
  vix: number;
  dte: number;
  expiryKind: ExpiryKind;
  dayOfWeek: number;
  hour?: number;
  lotSize: number;
  candles: Candle[];          // underlying OHLC
  atr?: number;               // precomputed underlying ATR(14)
  chain: ChainStrike[];       // REAL CE/PE legs (greeks/OI/depth)
  forceType?: OptionType;     // 'CE' | 'PE' (else inferred from structure)
  capital?: number;
  prevLtp?: (strike: number) => number | undefined;
  // Strategy-configurable validator gates (set by evaluateWithStrategy from config)
  requireStructureAlignment?: boolean;
  maxSpreadPct?: number;
  maxSLPct?: number;
  requirePremiumRealistic?: boolean;
  requireNoFailedBreakout?: boolean;
  requireNotExhausted?: boolean;
}

export interface StrikeEvaluation {
  strike: number;
  type: OptionType;
  leg: OptionLeg;
  option: OptionAnalytics;
  liquidity: LiquidityReport;
  orderFlow: OrderFlowReport;
  volume: VolumeReport;
  structure: StructureReport;
  vol: VolatilityReport;
  premium: PremiumReport;
  expiry: ExpiryReport;
  risk: RiskReport;
  sl: DynamicSLReport;
  tp: DynamicTPReport;
  confidence: ConfidenceReport;
  validation: ValidationResult;
  entryPremium: number;
  slPremium: number;
  tp1Premium: number;
  tp2Premium: number;
  rr: number;
  passed: boolean;
}

export interface InstitutionalResult {
  direction: Direction;
  type: OptionType;
  selectedStrike: number | null;
  selectedLeg: OptionLeg | null;
  market: MarketDataReport;
  session: SessionReport;
  priceAction: PriceActionReport;
  chainStats: ChainStats;
  best: StrikeEvaluation | null;
  all: StrikeEvaluation[];
}

// ─── Build chain from raw terminal/API rows ───────────────────────
// The option-chain API returns ce/pe without a `type` tag — attach it.
export function fromRawChain(raw: any[], spot: number): ChainStrike[] {
  return raw.map((s) => ({
    strike: s.strike,
    ce: s.ce
      ? {
          type: 'CE' as OptionType, ltp: s.ce.ltp, oi: s.ce.oi, oiChg: s.ce.oiChg,
          volume: s.ce.vol, iv: s.ce.iv, delta: s.ce.delta, gamma: s.ce.gamma,
          theta: s.ce.theta, vega: s.ce.vega, bid: s.ce.bid, ask: s.ce.ask,
          depth: s.ce.depth,
        }
      : null,
    pe: s.pe
      ? {
          type: 'PE' as OptionType, ltp: s.pe.ltp, oi: s.pe.oi, oiChg: s.pe.oiChg,
          volume: s.pe.vol, iv: s.pe.iv, delta: s.pe.delta, gamma: s.pe.gamma,
          theta: s.pe.theta, vega: s.pe.vega, bid: s.pe.bid, ask: s.pe.ask,
          depth: s.pe.depth,
        }
      : null,
  }));
}

// ─── Shared upstream analysis (once per request) ──────────────────
function analyzeShared(req: InstitutionalRequest) {
  let stats = computeChainStats(req.chain);
  stats = finalizeChainStats(stats, req.chain, req.spot);
  const market = summarizeMarketData(req.spot, req.vix, stats);
  const session = classifySession(req.dayOfWeek, req.hour ?? 12);
  const priceAction = analyzePriceAction({ candles: req.candles, spot: req.spot, atr: req.atr });
  return { stats, market, session, priceAction };
}

// ─── Per-strike evaluation (core engine) ─────────────────────────
export function evaluateInstitutionalStrike(
  req: InstitutionalRequest,
  shared: ReturnType<typeof analyzeShared>,
  strike: number,
  type: OptionType,
): StrikeEvaluation | null {
  const leg = type === 'CE'
    ? req.chain.find((s) => s.strike === strike)?.ce
    : req.chain.find((s) => s.strike === strike)?.pe;
  if (!leg || leg.ltp <= 0) return null;

  const direction: Direction = type === 'CE' ? 'BULLISH' : 'BEARISH';

  const option = analyzeOption({ leg, strike, spot: req.spot, dte: req.dte, vix: req.vix });
  const liquidity = analyzeLiquidity({ leg, strike, spot: req.spot, stats: shared.stats });
  const orderFlow = analyzeOrderFlow({ leg, prevLtp: req.prevLtp?.(strike), stats: shared.stats, direction });
  const volume = analyzeVolume(leg, shared.stats);
  const structure = analyzeStructure(req.candles, req.spot, type);
  const vol = analyzeVolatility({ spot: req.spot, dte: req.dte, iv: leg.iv, vix: req.vix, atr: req.atr });
  const premium = projectPremium({
    ltp: leg.ltp, type, delta: leg.delta, gamma: leg.gamma, iv: leg.iv, dte: req.dte,
    expectedIndexMove: vol.expectedIndexMove, ivRegime: vol.ivRegime,
  });
  const expiry = analyzeExpiry({ kind: req.expiryKind, dayOfWeek: req.dayOfWeek, dte: req.dte });
  const risk = computeRisk({
    direction, entry: req.spot, structure, vol, expiry,
    liquidityScore: liquidity.liquidityScore, lotSize: req.lotSize, capital: req.capital,
  });
  const sl = computeDynamicSL({ risk, structure, vol, expiry, delta: leg.delta, ltp: leg.ltp });
  const tp = computeDynamicTP({ direction, entry: req.spot, structure, vol, expiry, risk, stats: shared.stats, delta: leg.delta, ltp: leg.ltp });
  const confidence = computeConfidence({ structure, priceAction: shared.priceAction, liquidity, orderFlow, volume, premiumRealistic: premium.realistic, rr: risk.dynamicRR });
  const validation = validateTrade(
    { structure, liquidity, risk, tp, orderFlow, priceAction: shared.priceAction, premiumRealistic: premium.realistic, entry: req.spot, slIndex: sl.slIndex },
    {
      requireStructureAlignment: req.requireStructureAlignment,
      maxSpreadPct: req.maxSpreadPct,
      maxSLPct: req.maxSLPct,
      requirePremiumRealistic: req.requirePremiumRealistic,
      requireNoFailedBreakout: req.requireNoFailedBreakout,
      requireNotExhausted: req.requireNotExhausted,
    },
  );

  const entryPremium = leg.ltp;
  const slPremium = sl.slPremiumRef;
  const tp1Premium = tp.tp1Premium;
  const tp2Premium = tp.tp2Premium;
  const denom = Math.abs(entryPremium - slPremium);
  const rr = denom > 0 ? Math.abs(tp1Premium - entryPremium) / denom : 0;

  return {
    strike, type, leg, option, liquidity, orderFlow, volume, structure,
    vol, premium, expiry, risk, sl, tp, confidence, validation,
    entryPremium, slPremium, tp1Premium, tp2Premium, rr,
    passed: validation.passed,
  };
}

// ─── Full scan: rank every valid strike on both sides ────────────
export function institutionalScan(req: InstitutionalRequest): InstitutionalResult {
  const shared = analyzeShared(req);
  const all: StrikeEvaluation[] = [];
  for (const s of req.chain) {
    if (s.ce && s.ce.ltp > 0) {
      const e = evaluateInstitutionalStrike(req, shared, s.strike, 'CE');
      if (e) all.push(e);
    }
    if (s.pe && s.pe.ltp > 0) {
      const e = evaluateInstitutionalStrike(req, shared, s.strike, 'PE');
      if (e) all.push(e);
    }
  }
  all.sort((a, b) => b.confidence.score - a.confidence.score);

  // Selection: among PASSED candidates, prefer a tradeable near-ATM strike
  // (meaningful premium + acceptable R:R) rather than the bare highest
  // confidence score — the highest-confidence leg is often a far-OTM cheap
  // premium with a degenerate R:R. Filter to quality strikes first, then
  // pick the best by confidence.
  const tradeable = all.filter(
    (e) => e.passed && e.rr >= 1.5 &&
      // realistic premium: meaningful vs spot (far-OTM ₹1-30 legs have
      // degenerate R:R/SL math and aren't tradeable Zero Hero entries).
      // Use an absolute floor (₹5) rather than spot-relative which breaks
      // for high-spot indices like SENSEX (spot*0.002 = ₹154 > ATM premium).
      e.entryPremium > 5 &&
      // sane premium SL distance (2%..40%)
      e.entryPremium > 0 &&
      Math.abs(e.entryPremium - e.slPremium) / e.entryPremium > 0.02 &&
      Math.abs(e.entryPremium - e.slPremium) / e.entryPremium < 0.4 &&
      // near the underlying
      Math.abs(e.strike - req.spot) / req.spot < 0.05,
  );
  const pool = tradeable.length ? tradeable : all.filter(
    (e) => e.passed &&
      e.entryPremium > 5 &&
      Math.abs(e.strike - req.spot) / req.spot < 0.05,
  );

  // Selection respects directional bias when forced
  let best: StrikeEvaluation | null = null;
  if (req.forceType) {
    best = pool.find((e) => e.type === req.forceType) ?? null;
  } else {
    best = pool[0] ?? null;
  }

  const direction: Direction = best ? (best.type === 'CE' ? 'BULLISH' : 'BEARISH') : 'BULLISH';
  return {
    direction,
    type: best?.type ?? 'CE',
    selectedStrike: best?.strike ?? null,
    selectedLeg: best?.leg ?? null,
    market: shared.market,
    session: shared.session,
    priceAction: shared.priceAction,
    chainStats: shared.stats,
    best,
    all,
  };
}

// ─── Evaluate a single best idea (forceType aware) ───────────────
export function evaluateInstitutionalCandidate(req: InstitutionalRequest): InstitutionalResult {
  return institutionalScan(req);
}

// ─── Map to the existing production ZeroHeroCandidateResult ──────
export function toZeroHeroCandidateResult(e: StrikeEvaluation): ZeroHeroCandidateResult {
  const stars = e.confidence.score >= 90 ? 5 : e.confidence.score >= 80 ? 4 : e.confidence.score >= 70 ? 3 : e.confidence.score >= 55 ? 2 : 1;
  const reasons = [
    e.structure.reason,
    ...e.risk.reasons,
    e.sl.rationale,
    e.tp.rationale,
    ...e.confidence.reasons,
  ];
  if (!e.passed) reasons.push(`REJECTED: ${e.validation.failures.join(', ')}`);
  return {
    score: e.confidence.score,
    confidence: e.confidence.score,
    direction: e.type === 'CE' ? 'CALL' : 'PUT',
    reasons,
    conf: e.confidence.score,
    prob: Math.min(95, Math.max(5, Math.round(e.confidence.score * 0.95))),
    rr: Math.round(e.rr * 10) / 10,
    sl: Math.round(e.slPremium * 100) / 100,
    tp1: Math.round(e.tp1Premium * 100) / 100,
    tp2: Math.round(e.tp2Premium * 100) / 100,
    stars,
    lots: e.risk.suggestedLots,
    spreadPct: Math.round(e.liquidity.spreadPct * 1000) / 10,
    rejected: e.passed ? undefined : e.validation.failures.join('; '),
  };
}

// ─── Strategy layer: single source of truth for all 4 strategies ──
export * from './strategy';
