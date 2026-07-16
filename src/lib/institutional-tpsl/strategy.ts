// ═══════════════════════════════════════════════════════════════════
// STRATEGY LAYER — single source of truth for every strategy
// ───────────────────────────────────────────────────────────────────
// SMC · ZERO_HERO · BTST · INTRADAY all call evaluateWithStrategy()
// with their own StrategyConfig. The SHARED core (price action, market
// structure, liquidity, order flow, volatility, risk, dynamic SL/TP,
// confidence, validation) is computed ONCE by the Institutional Engine.
// Each strategy only supplies its NON-OVERLAPPING logic via `gate()`.
//
// EQUITY instruments (BTST / Intraday equities) are handled with a
// synthetic delta=1 leg so the same engine math yields PRICE levels.
// ═══════════════════════════════════════════════════════════════════

import { InstitutionalRequest, InstitutionalResult, StrikeEvaluation, evaluateInstitutionalCandidate, toZeroHeroCandidateResult } from './index';
import { ChainStrike, OptionLeg } from './chain';
import { Direction } from './risk';
import { ZeroHeroCandidateResult } from '@/lib/ProTradeEngine';

export type StrategyId = 'SMC' | 'ZERO_HERO' | 'BTST' | 'INTRADAY';
export type InstrumentType = 'OPTION' | 'EQUITY';
export type BiasSource = 'STRUCTURE' | 'SMC' | 'EQUITY_TA' | 'MOMENTUM';
export type SLStyle = 'STRUCTURE' | 'ATR' | 'FIXED_PCT';
export type TPStyle = 'STRUCTURE' | 'PREMIUM' | 'FIXED_RR';

export interface StrategyGateContext {
  engine: InstitutionalResult;
  extras: Record<string, any>;
}
export interface StrategyGateResult {
  pass: boolean;
  reasons: string[];
}

export interface StrategyConfig {
  id: StrategyId;
  label: string;
  instrumentType: InstrumentType;
  biasSource: BiasSource;
  minConfidence: number;
  minRR: number;
  targetRR: number;
  maxRiskPerTradePct: number;
  maxSLPct: number;             // max stop distance as % of entry
  slStyle: SLStyle;
  tpStyle: TPStyle;
  requireLiquidity: boolean;    // option liquidity gate
  requireVolume: boolean;       // volume confirmation gate
  sessionGate: boolean;         // reject when session CLOSED
  /** Validator gate enforcement (strategy-specific). When false, the gate is
   *  downgraded to informational so a strategy can trade its own style. */
  requireStructureAlignment?: boolean; // default true
  maxSpreadPct?: number;                  // default 0.15
  requirePremiumRealistic?: boolean;      // default true
  requireNoFailedBreakout?: boolean;      // default true
  requireNotExhausted?: boolean;          // default true
  /** Non-overlapping strategy logic (OB/FVG confluence, equity TA, momentum). */
  gate?: (ctx: StrategyGateContext) => StrategyGateResult;
}

// ─── Presets ─────────────────────────────────────────────────────
export const STRATEGY_CONFIGS: Record<StrategyId, StrategyConfig> = {
  SMC: {
    id: 'SMC', label: 'Smart Money (SMC)', instrumentType: 'OPTION',
    biasSource: 'SMC', minConfidence: 70, minRR: 2, targetRR: 3,
    maxRiskPerTradePct: 1, slStyle: 'STRUCTURE', tpStyle: 'STRUCTURE',
    requireLiquidity: true, requireVolume: true, sessionGate: true,
    requireStructureAlignment: true, maxSpreadPct: 0.15, maxSLPct: 0.4, requirePremiumRealistic: true,
    requireNoFailedBreakout: true, requireNotExhausted: true,
  },
  ZERO_HERO: {
    id: 'ZERO_HERO', label: 'Zero Hero', instrumentType: 'OPTION',
    biasSource: 'STRUCTURE', minConfidence: 60, minRR: 2.0, targetRR: 3.5,
    maxRiskPerTradePct: 1, slStyle: 'STRUCTURE', tpStyle: 'PREMIUM',
    requireLiquidity: false, requireVolume: true, sessionGate: false,
    // Near-ATM premium buying is direction-agnostic at entry: relax the
    // structure-alignment / tight-spread / premium-realism hard gates so the
    // engine can surface candidates; quality is then enforced via confidence.
    // SL is measured in PREMIUM space (option premiums routinely stop ~10-15%),
    // so the SL cap is wider than the equity/index 4% cap.
    requireStructureAlignment: false, maxSpreadPct: 0.5, maxSLPct: 0.5, requirePremiumRealistic: false,
    requireNoFailedBreakout: false, requireNotExhausted: false,
  },
  BTST: {
    id: 'BTST', label: 'BTST (Buy Today Sell Tomorrow)', instrumentType: 'EQUITY',
    biasSource: 'EQUITY_TA', minConfidence: 65, minRR: 1.2, targetRR: 2,
    maxRiskPerTradePct: 1, maxSLPct: 0.03, slStyle: 'ATR', tpStyle: 'FIXED_RR',
    requireLiquidity: false, requireVolume: true, sessionGate: true,
  },
  INTRADAY: {
    id: 'INTRADAY', label: 'Intraday', instrumentType: 'EQUITY',
    biasSource: 'MOMENTUM', minConfidence: 60, minRR: 1.5, targetRR: 2.5,
    maxRiskPerTradePct: 1, maxSLPct: 0.02, slStyle: 'ATR', tpStyle: 'FIXED_RR',
    requireLiquidity: false, requireVolume: true, sessionGate: true,
  },
};

export interface StrategyEvaluation {
  strategy: StrategyId;
  instrumentType: InstrumentType;
  eligible: boolean;
  grade: string;                 // A+ / A / B / C / F
  finalScore: number;            // 0..100
  reasons: string[];
  direction: Direction;
  type: 'CE' | 'PE' | null;
  strike: number;
  entry: number;                 // premium (option) or price (equity)
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr: number;
  confidence: number;
  lots: number;
  spreadPct?: number;
  atr?: number;                   // ATR from the evaluated strike's vol report
  engine: InstitutionalResult;
  gateResults: { name: string; ok: boolean; detail: string }[];
}

function gradeFromScore(s: number): string {
  if (s >= 95) return 'A+';
  if (s >= 90) return 'A';
  if (s >= 80) return 'B';
  if (s >= 70) return 'C';
  return 'F';
}

// Build a synthetic equity leg (delta=1) so the engine runs in PRICE space.
function syntheticEquityChain(spot: number, volume: number): ChainStrike[] {
  const leg: OptionLeg = {
    type: 'CE', ltp: spot, oi: 0, oiChg: 0, volume, iv: 0,
    delta: 1, gamma: 0, theta: 0, vega: 0, bid: spot, ask: spot,
  };
  return [{ strike: spot, ce: leg, pe: null }];
}

export function evaluateWithStrategy(
  req: InstitutionalRequest,
  config: StrategyConfig,
  extras: Record<string, any> = {},
): StrategyEvaluation {
  // EQUITY path: run engine on a synthetic delta=1 chain → price-space SL/TP
  let request: InstitutionalRequest = req;
  if (config.instrumentType === 'EQUITY') {
    request = {
      ...req,
      chain: syntheticEquityChain(req.spot, extras.volume ?? 0),
      forceType: 'CE',
    };
  }
  // Thread strategy-specific validator gates onto the request so the engine's
  // hard gates honour the strategy's trading style.
  request = {
    ...request,
    requireStructureAlignment: config.requireStructureAlignment ?? true,
    maxSpreadPct: config.maxSpreadPct ?? 0.15,
    maxSLPct: config.maxSLPct ?? 0.04,
    requirePremiumRealistic: config.requirePremiumRealistic ?? true,
    requireNoFailedBreakout: config.requireNoFailedBreakout ?? true,
    requireNotExhausted: config.requireNotExhausted ?? true,
  };

  const engine = evaluateInstitutionalCandidate(request);
  return scoreCandidate(engine, engine.best, config, extras, req.spot);
}

// Shared gating: applies the strategy config's thresholds/overrides to ONE
// engine candidate and returns a unified StrategyEvaluation. Used by both the
// auto-pick path (evaluateWithStrategy) and the per-strike path (SMC scan).
function scoreCandidate(
  engine: InstitutionalResult,
  best: StrikeEvaluation | null,
  config: StrategyConfig,
  extras: Record<string, any>,
  spot: number,
): StrategyEvaluation {
  const gateResults: { name: string; ok: boolean; detail: string }[] = [];
  const push = (name: string, ok: boolean, detail: string) => gateResults.push({ name, ok, detail });
  let eligible = true;
  const reasons: string[] = [];

  // 1) Core engine validity
  if (!best) {
    push('Engine Candidate', false, 'no valid candidate from engine');
    eligible = false;
    reasons.push('Engine produced no candidate');
  } else {
    push('Engine Candidate', best.passed, best.passed ? 'passed core gates' : `failed: ${best.validation.failures.join(', ')}`);
    if (!best.passed) { eligible = false; reasons.push(`Engine: ${best.validation.failures.join(', ')}`); }

    // 2) Confidence threshold
    const confOk = best.confidence.score >= config.minConfidence;
    push('Min Confidence', confOk, `${best.confidence.score} >= ${config.minConfidence}`);
    if (!confOk) { eligible = false; reasons.push(`Confidence ${best.confidence.score} < ${config.minConfidence}`); }

    // 3) Reward:Risk
    const rrOk = best.rr >= config.minRR;
    push('Min R:R', rrOk, `RR ${best.rr.toFixed(2)} >= ${config.minRR}`);
    if (!rrOk) { eligible = false; reasons.push(`R:R ${best.rr.toFixed(2)} < ${config.minRR}`); }

    // 4) Stop distance cap — measured in PREMIUM space for options
    // (the engine's index SL is the underlying stop; the premium SL is the
    // tradeable risk). For equities the entry IS price, so use the index SL.
    const entryRef = config.instrumentType === 'EQUITY' ? spot : best.entryPremium;
    const slRef = config.instrumentType === 'EQUITY' ? best.sl.slIndex : best.slPremium;
    const slPct = entryRef > 0 ? Math.abs(entryRef - slRef) / entryRef : 1;
    const slOk = slPct <= config.maxSLPct;
    push('Max SL %', slOk, `${(slPct * 100).toFixed(2)}% <= ${(config.maxSLPct * 100).toFixed(2)}%`);
    if (!slOk) { eligible = false; reasons.push(`SL ${(slPct * 100).toFixed(2)}% exceeds cap`); }

    // 5) Liquidity gate (options)
    if (config.requireLiquidity) {
      const liqOk = best.liquidity.liquidityScore >= 30 && best.liquidity.spreadPct < 0.2;
      push('Liquidity', liqOk, `score ${best.liquidity.liquidityScore.toFixed(0)}, spread ${(best.liquidity.spreadPct * 100).toFixed(1)}%`);
      if (!liqOk) { eligible = false; reasons.push('Illiquid (liquidity gate)'); }
    }

    // 6) Volume gate — degrade gracefully when per-leg volume is absent
    // (some feeds omit leg volume; fall back to chain-average presence).
    if (config.requireVolume) {
      const v = config.instrumentType === 'EQUITY' ? (extras.volume ?? 0) : (best.leg.volume || 0);
      const avg = config.instrumentType === 'EQUITY' ? (extras.avgVolume ?? 1) : (engine.chainStats.avgVolume || 1);
      const volPresent = config.instrumentType === 'EQUITY' ? v > 0 : (best.leg.volume > 0);
      const volOk = !volPresent ? true : v >= Math.max(50, avg * 0.3);
      push('Volume', volOk, `vol ${v} vs avg ${avg.toFixed(0)}${volPresent ? '' : ' (no leg vol — waived)'}`);
      if (!volOk) { eligible = false; reasons.push('Volume too low'); }
    }

    // 7) Session gate
    if (config.sessionGate) {
      const sessOk = engine.session.isActive;
      push('Session', sessOk, engine.session.phase);
      if (!sessOk) { eligible = false; reasons.push(`Session ${engine.session.phase}`); }
    }

    // 8) Strategy-specific gate (non-overlapping logic)
    if (config.gate) {
      const g = config.gate({ engine, extras });
      push(`${config.label} Gate`, g.pass, g.reasons.join('; '));
      if (!g.pass) { eligible = false; reasons.push(...g.reasons); }
    }
  }

  const finalScore = best ? best.confidence.score : 0;
  const grade = gradeFromScore(finalScore);
  if (best && !eligible) reasons.push(`Grade ${grade} but gated → ineligible`);

  // Resolve output levels (price space for equity, premium space for options)
  let direction: Direction = 'BULLISH';
  let type: 'CE' | 'PE' | null = null;
  let strike = 0;
  let entry = 0, sl = 0, tp1 = 0, tp2 = 0, tp3 = 0, rr = 0, confidence = 0, lots = 0, spreadPct: number | undefined, atr: number | undefined;

  if (best) {
    direction = engine.direction;
    type = best.type;
    strike = best.strike;
    if (config.instrumentType === 'EQUITY') {
      entry = spot;
      sl = best.sl.slIndex;
      tp1 = best.tp.tp1; tp2 = best.tp.tp2; tp3 = best.tp.tp3;
    } else {
      entry = best.entryPremium;
      // The engine's slPremiumRef uses delta*indexDistance which produces
      // negative values for index options (hundreds of index points × delta
      // exceeds ltp), then clamps to 0. When sl is 0 or >= entry (degenerate),
      // override with ATR-based % in premium space — same approach as Zero Hero.
      const engineSl = best.slPremium;
      const slBroken = engineSl <= 0 || engineSl >= entry;
      if (slBroken && entry > 0) {
        const atrVal = best.vol?.atr ?? 0;
        const absDelta = Math.abs(best.leg.delta);
        const atrPct = atrVal > 0 && entry > 0 ? atrVal / entry : 0.35;
        const slPct = Math.max(0.2, Math.min(0.5, 0.35 - atrPct * 2));
        // Dynamic TP: expected premium move = ATR × delta
        const expectedMove = atrVal * absDelta;
        sl = entry * (1 - slPct);
        tp1 = entry + expectedMove * 0.8;
        tp2 = entry + expectedMove * 1.3;
        tp3 = entry + expectedMove * 1.8;
        const denom = Math.abs(entry - sl);
        rr = denom > 0 ? Math.abs(tp1 - entry) / denom : 0;
      } else {
        sl = engineSl;
        tp1 = best.tp1Premium; tp2 = best.tp2Premium; tp3 = best.tp.runnerPremium;
        rr = best.rr;
      }
    }
    confidence = best.confidence.score;
    lots = best.risk.suggestedLots;
    spreadPct = best.liquidity.spreadPct * 100;
    atr = best.vol?.atr;
  }

  return {
    strategy: config.id, instrumentType: config.instrumentType,
    eligible, grade: eligible ? grade : 'F', finalScore,
    reasons, direction, type, strike, entry, sl, tp1, tp2, tp3, rr, confidence, lots, spreadPct, atr,
    engine, gateResults,
  };
}

// Evaluate a SPECIFIC strike/type through the strategy config. Used by
// per-strike scanners (e.g. SMC) that emit a ranked candidate list rather
// than a single auto-picked idea.
export function evaluateStrategyForStrike(
  req: InstitutionalRequest,
  config: StrategyConfig,
  strike: number,
  type: 'CE' | 'PE',
  extras: Record<string, any> = {},
): StrategyEvaluation {
  let request = req;
  if (config.instrumentType === 'EQUITY') {
    request = { ...req, chain: syntheticEquityChain(req.spot, extras.volume ?? 0), forceType: 'CE' };
  }
  const engine = evaluateInstitutionalCandidate(request);
  const best = engine.all.find((e) => e.strike === strike && e.type === type) ?? null;
  return scoreCandidate(engine, best, config, extras, req.spot);
}

// Map a StrategyEvaluation (option path) to the existing ZeroHero shape.
export function toZeroHeroFromStrategy(e: StrategyEvaluation): ZeroHeroCandidateResult {
  const dir = e.type === 'PE' ? 'PUT' : 'CALL';
  const stars = e.finalScore >= 90 ? 5 : e.finalScore >= 80 ? 4 : e.finalScore >= 70 ? 3 : e.finalScore >= 55 ? 2 : 1;
  return {
    score: Math.round(e.finalScore),
    confidence: Math.round(e.confidence),
    direction: dir,
    reasons: e.reasons,
    conf: Math.round(e.confidence),
    prob: Math.min(95, Math.max(5, Math.round(e.confidence * 0.95))),
    rr: Math.round(e.rr * 10) / 10,
    sl: Math.round(e.sl * 100) / 100,
    tp1: Math.round(e.tp1 * 100) / 100,
    tp2: Math.round(e.tp2 * 100) / 100,
    stars,
    lots: e.lots,
    spreadPct: e.spreadPct,
    rejected: e.eligible ? undefined : e.reasons.filter((r) => r.includes('Gate') || r.includes('failed') || r.includes('low') || r.includes('cap') || r.includes('Illiquid')).join('; '),
  };
}

export { toZeroHeroCandidateResult };
