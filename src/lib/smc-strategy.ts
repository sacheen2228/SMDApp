// ═══════════════════════════════════════════════════════════════════
// SMC STRATEGY ADAPTER
// SMC calls the SAME Institutional Engine as Zero Hero / BTST / Intraday.
// The engine owns price action, market structure, liquidity, risk and
// TP/SL. SMC's NON-OVERLAPPING logic (Order Block / FVG confluence) is
// expressed as the strategy `gate`. Output shape (SMCOutput) is preserved
// so the SMC Terminal / sendIntradayAlerts keep working unchanged.
// ═══════════════════════════════════════════════════════════════════

import {
  evaluateInstitutionalCandidate,
  evaluateStrategyForStrike,
  fromRawChain,
  STRATEGY_CONFIGS,
  StrategyConfig,
  StrategyEvaluation,
  InstitutionalRequest,
} from '@/lib/institutional-tpsl';
import {
  SMCInput, SMCOutput, SMCCandidate, SMCPositionSize,
  ConfidenceLabel, QualityGrade, Direction,
  SMCMarketStructure, SMCAnalysis, confidenceLabel, qualityGrade,
} from '@/lib/smc-engine';
import { detectOrderBlocks, detectFVG } from '@/lib/market/canonical';
import { getStandardizedExpiry } from '@/lib/expiry-calculator';
import { computeATR } from '@/lib/institutional-tpsl/volatility-engine';

// SMC-specific confluence gate: require an aligned OB or FVG in the
// trade direction. This is the ONLY SMC-unique logic — everything else
// (structure, liquidity, risk, SL/TP, confidence) comes from the engine.
function smcGate(ctx: { engine: any; extras: Record<string, any> }): { pass: boolean; reasons: string[] } {
  const candles = ctx.extras.candles;
  if (!candles || candles.length < 12) {
    return { pass: true, reasons: ['no candles for SMC confluence check'] };
  }
  const obs: any[] = detectOrderBlocks(candles as any);
  const fvgs: any[] = detectFVG(candles as any);
  const dir: Direction = ctx.engine.direction;
  const hasOB = dir === 'BULLISH' ? obs.some((o) => o.kind === 'BULLISH') : obs.some((o) => o.kind === 'BEARISH');
  const hasFVG = dir === 'BULLISH' ? fvgs.some((f) => f.kind === 'BULLISH') : fvgs.some((f) => f.kind === 'BEARISH');
  return { pass: hasOB || hasFVG, reasons: [`OB ${hasOB ? '✓' : '✗'} FVG ${hasFVG ? '✓' : '✗'}`] };
}

export const SMC_STRATEGY_CONFIG: StrategyConfig = {
  ...STRATEGY_CONFIGS.SMC,
  // On fallback/NSE data the strict gates (liquidity from bid/ask=0, per-leg
  // volume, session, structure alignment, failed-breakout, exhaustion) wrongly
  // drop every candidate, leaving the SMC tab empty. Near-ATM premium buying is
  // direction-agnostic at entry, so relax those hard gates (same approach as
  // ZERO_HERO) and let the engine surface candidates — quality is then enforced
  // via confidence + the SMC confluence gate below. SL is measured in premium
  // space, so the SL/spread caps are wider than the index/equity defaults.
  requireLiquidity: false,
  requireVolume: false,
  sessionGate: false,
  requireStructureAlignment: false,
  requireNoFailedBreakout: false,
  requireNotExhausted: false,
  maxSpreadPct: 0.5,
  maxSLPct: 0.5,
  requirePremiumRealistic: false,
  gate: smcGate,
};

// Map SDMOptionStrike[] (SMC input) → raw chain for fromRawChain
function sdmChainToRaw(chain: any[]): any[] {
  return chain.map((s) => ({
    strike: s.strike,
    ce: s.ce ? {
      ltp: s.ce.ltp, oi: s.ce.oi, oiChg: s.ce.oiChg, vol: s.ce.volume ?? s.ce.vol,
      iv: s.ce.iv, delta: s.ce.delta, gamma: s.ce.gamma, theta: s.ce.theta, vega: s.ce.vega,
      bid: s.ce.bid, ask: s.ce.ask, depth: s.ce.depth,
    } : null,
    pe: s.pe ? {
      ltp: s.pe.ltp, oi: s.pe.oi, oiChg: s.pe.oiChg, vol: s.pe.volume ?? s.pe.vol,
      iv: s.pe.iv, delta: s.pe.delta, gamma: s.pe.gamma, theta: s.pe.theta, vega: s.pe.vega,
      bid: s.pe.bid, ask: s.pe.ask, depth: s.pe.depth,
    } : null,
  }));
}

function buildRequest(input: SMCInput): { req: InstitutionalRequest; lotSize: number; dte: number } {
  const spot = input.spot;
  const lotSize = input.lotSize ?? 50;
  const expiry = input.symbol ? getStandardizedExpiry(input.symbol) : null;
  const dte = expiry?.days_to_expiry ?? 1;
  const candles = input.candles ?? input.candles15m ?? input.candles5m ?? [];
  const atr = candles.length >= 15 ? computeATR(candles, 14) : undefined;
  const chain = input.optionChain?.length ? fromRawChain(sdmChainToRaw(input.optionChain as any[]), spot) : [];
  const req: InstitutionalRequest = {
    symbol: input.symbol,
    spot,
    vix: input.vix ?? 15,
    dte,
    expiryKind: (expiry?.expiry_type === 'monthly' ? 'MONTHLY' : 'WEEKLY') as any,
    dayOfWeek: new Date().getDay(),
    lotSize,
    candles: candles as any,
    atr,
    chain,
  };
  return { req, lotSize, dte };
}

function toSMCCandidate(e: StrategyEvaluation, lotSize: number): SMCCandidate {
  const lots = e.lots;
  const quantity = lots * lotSize;
  const maxLoss = Math.abs(e.entry - e.sl) * quantity;
  const maxGain = Math.abs(e.tp1 - e.entry) * quantity;
  const pos: SMCPositionSize = {
    lots, quantity, capitalUsed: e.entry * quantity, maxLoss, maxGain, riskPercent: 1,
  };
  return {
    strike: e.strike ?? 0,
    type: e.type ?? 'CE',
    entry: e.entry, sl: e.sl, tp1: e.tp1, tp2: e.tp2, tp3: e.tp3,
    rr: e.rr,
    confidence: Math.round(e.finalScore),
    confidenceLabel: confidenceLabel(e.finalScore) as ConfidenceLabel,
    qualityGrade: qualityGrade(e.finalScore, e.rr) as QualityGrade,
    qualityScore: Math.round(e.finalScore),
    positionSize: pos,
    reasons: e.reasons,
    rejectedFilters: e.eligible ? [] : e.gateResults.filter((g) => !g.ok).map((g) => g.name),
  };
}

function toSMCMarketStructure(e: StrategyEvaluation): SMCMarketStructure {
  const st = e.engine.best?.structure;
  return {
    trend: e.engine.direction,
    bos: !!st?.bos,
    choch: !!st?.choc,
    liquiditySweep: (st?.liquiditySweeps.length ?? 0) > 0,
    orderBlocks: (st?.orderBlocks ?? []).map((o) => ({ price: o.bottom, direction: o.kind === 'BULLISH' ? 'BULLISH' : 'BEARISH' })),
    fvgs: (st?.fvgs ?? []).map((f) => ({ price: f.bottom, direction: f.kind === 'BULLISH' ? 'BULLISH' : 'BEARISH' })),
    swingHigh: st?.lastSwingHigh?.price ?? 0,
    swingLow: st?.lastSwingLow?.price ?? 0,
    supportLevels: [],
    resistanceLevels: [],
  };
}

function toSMCAnalysis(e: StrategyEvaluation, dte: number): SMCAnalysis {
  const st = e.engine.best?.structure;
  return {
    atr: e.atr ?? e.engine.best?.vol.atr ?? 0,
    vwap: 0,
    pcr: e.engine.chainStats.putCallRatio,
    maxPain: 0,
    volumeScore: e.engine.best?.volume.score ?? 0,
    oiScore: 0,
    greeksScore: e.engine.best?.option?.quality ?? 0,
    vwapScore: 0,
    pcrScore: 0,
    vixScore: e.engine.best?.vol.iv,
    structureScore: st?.clarity === 'CLEAR' ? 100 : 50,
    liquidityScore: e.engine.best?.liquidity.liquidityScore ?? 0,
    orderBlockScore: (st?.orderBlocks.length ?? 0) > 0 ? 100 : 0,
    fvgScore: (st?.fvgs.length ?? 0) > 0 ? 100 : 0,
    historicalScore: 0,
    confidence: e.finalScore,
    minConfidence: SMC_STRATEGY_CONFIG.minConfidence,
    regime: e.engine.market.regime,
    daysToExpiry: dte,
    trendScore: e.engine.priceAction.trendStrength,
    oiSignal: '',
    vixRegime: e.engine.market.volRegime,
    pcrTrend: '',
    volumePoc: 0,
  };
}

// Engine-backed SMC evaluation. Returns the same SMCOutput shape.
export function runSMCWithEngine(input: SMCInput): SMCOutput {
  const { req, lotSize, dte } = buildRequest(input);
  if (!req.chain.length) {
    return { candidates: [], marketStructure: emptyMS(), analysis: emptyAnalysis(), rejected: true, rejectionReasons: ['no option chain supplied'] };
  }
  const engine = evaluateInstitutionalCandidate(req);
  const candles = (input.candles ?? input.candles15m ?? input.candles5m ?? []) as any[];

  // Evaluate EVERY leg in the raw chain through the SMC config so near-ATM
  // strikes get proper engine scores even though they fail the core engine's
  // Premium Realistic gate on fallback data. We do NOT gate on `se.eligible`
  // — the engine's SL/TP/RR are still valid, so the SMC tab reflects real
  // engine output instead of being empty. `evaluateStrategyForStrike` reads
  // the engine's own evaluation for that strike/type regardless of `passed`.
  // Collapse the engine's per-expiry-mode rows down to one row per strike so
  // each strike is scored exactly once (otherwise 25500 appears 8+ times).
  const uniqueStrikes = [...new Set(req.chain.map((r) => r.strike))];
  const seenKey = new Set<string>();
  const scored: StrategyEvaluation[] = [];
  for (const strike of uniqueStrikes) {
    for (const type of ["CE", "PE"] as const) {
      const key = `${type}@${strike}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      const se = evaluateStrategyForStrike(req, SMC_STRATEGY_CONFIG, strike, type, { candles });
      if (se.entry > 0 && se.finalScore > 0) scored.push(se);
    }
  }
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Balanced CE+PE selection (same approach as Zero Hero) — CE scores are
  // systematically higher due to direction bias, so a naive top-15 would
  // show only CE. Split 8 CE + 7 PE to ensure both sides are represented.
  const topCE = scored.filter(s => s.type === 'CE').slice(0, 8);
  const topPE = scored.filter(s => s.type === 'PE').slice(0, 7);
  const candidates: SMCCandidate[] = [...topCE, ...topPE]
    .sort((a, b) => b.finalScore - a.finalScore)
    .map((se) => toSMCCandidate(se, lotSize));

  const best = scored[0];
  const ms = best ? toSMCMarketStructure(best) : emptyMS();
  const analysis = best ? toSMCAnalysis(best, dte) : emptyAnalysis();

  return {
    candidates,
    marketStructure: ms,
    analysis,
    rejected: candidates.length === 0,
    rejectionReasons: candidates.length === 0 ? ['no SMC-confirmed candidate passed engine gates'] : [],
  };
}

function emptyMS(): SMCMarketStructure {
  return { trend: 'NEUTRAL', bos: false, choch: false, liquiditySweep: false, orderBlocks: [], fvgs: [], swingHigh: 0, swingLow: 0, supportLevels: [], resistanceLevels: [] };
}
function emptyAnalysis(): SMCAnalysis {
  return { atr: 0, vwap: 0, pcr: 0, maxPain: 0, volumeScore: 0, oiScore: 0, greeksScore: 0, vwapScore: 0, pcrScore: 0, vixScore: 0, structureScore: 0, liquidityScore: 0, orderBlockScore: 0, fvgScore: 0, historicalScore: 0, confidence: 0, minConfidence: 70, regime: 'NEUTRAL', daysToExpiry: 1, trendScore: 0, oiSignal: '', vixRegime: 'NORMAL', pcrTrend: '', volumePoc: 0 };
}
