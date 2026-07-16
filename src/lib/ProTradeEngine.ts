// Pro Trade Engine (formerly Zero Hero)
// Dedicated high-risk strategy for experienced users
// Only activated when explicitly enabled by the user
// Requires stricter confirmation than standard trades
// Supports F&O weekly / monthly expiry + BTST (Buy Today Sell Tomorrow) for all stocks
//
// v2 CHANGES vs original Zero Hero engine (see // FIX: comments below):
//  - R:R is now calculated from real SL/TP distance, not a hardcoded 3-tier lookup
//  - SL/TP scale with ATR, delta and days-to-expiry instead of a flat 50% of premium
//  - Probability-of-profit computed independently of confidence (no longer circular)
//  - OI/volume scoring normalized as % of each strike's own OI/avg volume (fair across
//    small-cap and large-cap stocks, since this dashboard covers all stocks, not just index)
//  - Liquidity/spread gate added directly in the per-candidate evaluator

import type { SDMOptionStrike, SDMRecommendation, TradeDirection } from '@/types/sdm';
import { isFNO, getExpiryTypeForDate, getStandardizedExpiry, StandardizedExpiry } from '@/lib/expiry-calculator';
import { analyzeOptionChain } from '@/lib/sdm-oianalysis';
import { detectGammaBlast, getGammaBlastBoost } from '@/lib/gamma-blast';
import { calculateGreeks } from '@/lib/greeks';
import { calculatePositionSize } from '@/lib/risk-management';
import { analyzeMarketStructure } from '@/lib/market-structure';
import { analyzeVolume } from '@/lib/volume-analysis';
import {
  evaluateInstitutionalCandidate,
  fromRawChain,
  toZeroHeroCandidateResult,
  InstitutionalRequest,
  evaluateStrategyForStrike,
  STRATEGY_CONFIGS,
  toZeroHeroFromStrategy,
} from '@/lib/institutional-tpsl';

export type ZHMode = 'expiry' | 'btst';

export interface ZeroHeroConfig {
  enabled: boolean;
  maxCapitalPerTrade: number;    // Max capital per ZH trade
  minQualityScore: number;       // Minimum quality score (higher than normal)
  minConfidence: number;         // Minimum confidence (higher than normal)
  minRiskReward: number;         // Minimum R:R ratio
  requireVolumeConfirm: boolean; // Require volume confirmation
  requireSpreadCheck: boolean;   // Require tight spread check
  maxSpreadPercent: number;      // Max bid-ask spread %
  mode: ZHMode;                  // 'expiry' = F&O weekly/monthly, 'btst' = buy-today-sell-tomorrow
}

export const DEFAULT_ZERO_HERO_CONFIG: ZeroHeroConfig = {
  enabled: false,
  maxCapitalPerTrade: 25000,
  minQualityScore: 70,
  minConfidence: 65,
  minRiskReward: 2.5,
  requireVolumeConfirm: true,
  requireSpreadCheck: true,
  maxSpreadPercent: 5,
  mode: 'expiry',
};

export interface ZeroHeroSignal {
  eligible: boolean;
  direction: 'CALL' | 'PUT' | 'LONG' | 'SHORT' | null;
  strike: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  riskReward: number;
  mode: ZHMode;
  expiryType: 'weekly' | 'monthly' | 'btst' | null;
  reasons: string[];
  warnings: string[];
  premiumMetrics: {
    spread: number;
    spreadPercent: number;
    volume: number;
    oi: number;
    iv: number;
  };
}


// ═══════════════════════════════════════════════════════════════════
// Consolidated Zero Hero evaluation (production path)
// Reuses existing engines instead of duplicating them:
//   greeks.ts · risk-management.ts · sdm-oianalysis.ts · gamma-blast.ts
//   market-structure.ts · volume-analysis.ts · expiry-calculator.ts
//
// This is the SINGLE evaluation path for the Zero Hero scanner
// (ZeroHeroTerminal.tsx → zhCandidates → FullZeroHero → Trade Audit).
// The earlier parallel implementation under src/lib/zero-hero-ai/* is
// DEPRECATED and will be removed after verification.
// ═══════════════════════════════════════════════════════════════════

export interface EngineResult {
  score: number;
  confidence: number;
  direction: 'CALL' | 'PUT' | 'NONE';
  reasons: string[];
}

export interface ZeroHeroChainContext {
  oiAnalysis: ReturnType<typeof analyzeOptionChain>;
  gammaBlastBoost: number;
  expiry: StandardizedExpiry | null;
  vix: number;
}

export interface ZeroHeroCandidateInput {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  delta: number;
  iv: number;            // percent
  oiChg: number;
  oi?: number;              // FIX: optional — if caller has it, normalizes oiChg into a %; falls back to old absolute-count scoring if omitted
  volume: number;
  avgVolume?: number;       // FIX: optional — normalizes volScore if available, falls back otherwise
  bid?: number;              // FIX: optional — enables spread/liquidity check if available
  ask?: number;              // FIX: optional
  spot: number;
  lotSize: number;
  capital: number;
  riskPerTradePercent: number;
  maxPositionSize: number;
  context: ZeroHeroChainContext;
  // Optional per-candidate SMC / volume signals (when candles are wired)
  smcBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  pocDistancePct?: number;     // (spot - POC)/spot
  cumulativeDelta?: number;
  atr?: number;                // Option 1: real per-instrument ATR(14) from daily candles.
                               // When supplied, it overrides the IV-derived expected move.
                               // Optional — engine falls back to IV if omitted.
  // ── Institutional Engine v2 hook (optional, additive) ──
  // When the caller supplies underlying candles + the full option chain,
  // evaluateZeroHeroCandidate delegates to the Institutional Trading Engine
  // (structure/liquidity/order-flow/volatility → risk → dynamic SL/TP) and
  // returns its structure-aware levels. Absent these, legacy logic runs.
  candles?: any[];
  fullChain?: any[];
  expiryKind?: 'WEEKLY' | 'MONTHLY' | 'BIWEEKLY' | 'QUARTERLY';
  dayOfWeek?: number;
}

export interface ZeroHeroCandidateResult extends EngineResult {
  conf: number;          // 0-100 (maps to ZHCandidate.conf)
  prob: number;          // 0-100 probability of profit
  rr: number;            // risk:reward ratio
  sl: number;            // stop-loss premium
  tp1: number;           // target 1 premium
  tp2: number;           // target 2 premium
  stars: number;         // 1-5
  lots: number;
  spreadPct?: number;    // FIX: optional — only populated if bid/ask were supplied
  rejected?: string;     // FIX: reason if liquidity gate failed (only set if bid/ask supplied and gate fails)
}

// Map terminal ChainRow[] → SDMOptionStrike[] for reuse of existing engines
function mapChainToSDM(chain: any[]): SDMOptionStrike[] {
  return chain.map((s) => ({
    strike: s.strike,
    ce: s.ce
      ? { ltp: s.ce.ltp, oi: s.ce.oi, oiChg: s.ce.oiChg, volume: s.ce.vol, iv: s.ce.iv, delta: s.ce.delta, theta: s.ce.theta, gamma: s.ce.gamma, vega: s.ce.vega }
      : null,
    pe: s.pe
      ? { ltp: s.pe.ltp, oi: s.pe.oi, oiChg: s.pe.oiChg, volume: s.pe.vol, iv: s.pe.iv, delta: s.pe.delta, theta: s.pe.theta, gamma: s.pe.gamma, vega: s.pe.vega }
      : null,
  }));
}

// Compute chain-wide context ONCE per scan (reuses sdm-oianalysis + gamma-blast + expiry-calculator)
export function analyzeZeroHeroChain(
  chain: any[],
  spot: number,
  vix: number,
  symbol: string,
  candles?: any[]
): ZeroHeroChainContext {
  const sdm = mapChainToSDM(chain);
  const oiAnalysis = analyzeOptionChain(sdm, spot);
  const gammaBlast = detectGammaBlast(sdm, spot, vix, candles);
  const gammaBlastBoost = getGammaBlastBoost(gammaBlast);
  const expiry = getStandardizedExpiry(symbol);
  return { oiAnalysis, gammaBlastBoost, expiry, vix };
}

// Evaluate a single CE/PE candidate (reuses greeks + risk-management + expiry-calculator)
//
// FIX v2: rewritten to match the ACTUAL production call sites
// (sendIntradayAlerts.ts:20, ZeroHeroTerminal.tsx:16) exactly — no new
// required input fields, same output field names (sl/tp1/tp2/rr/prob/conf).
// oi/avgVolume/bid/ask are optional: if a caller has them, scoring gets
// more accurate; if not, it falls back to the original absolute-threshold
// behavior rather than breaking. ATR is no longer a required input — it's
// derived from IV (a standard IV→expected-move approximation), since
// neither current caller passes ATR and context doesn't carry it either.
export function evaluateZeroHeroCandidate(input: ZeroHeroCandidateInput): ZeroHeroCandidateResult {
  const { strike, type, ltp, delta, iv, oiChg, oi, volume, avgVolume, bid, ask, spot, lotSize, capital, riskPerTradePercent, maxPositionSize, context } = input;
  const reasons: string[] = [];

  // Days to expiry from standardized expiry (same source as before)
  const daysToExpiry = context.expiry?.days_to_expiry ?? 1;
  const tte = Math.max(1 / 365, daysToExpiry / 365);
  const ivDecimal = iv > 0 ? iv / 100 : 0.15;

  // ── Greeks (reuse greeks.ts) — unchanged positional call, matches real signature ──
  const g = calculateGreeks(spot, strike, tte, ivDecimal, type === 'CE');
  reasons.push(`Γ=${g.gamma.toFixed(4)} Θ=${g.theta.toFixed(1)} Δ=${g.delta.toFixed(2)}`);

  // FIX: liquidity gate — only runs if caller actually supplied bid/ask.
  // Both current callers don't pass these yet, so this is a no-op until
  // sendIntradayAlerts.ts / ZeroHeroTerminal.tsx are updated to include
  // leg.bid / leg.ask from the option chain response (they already fetch
  // it — the option-chain API returns bid/ask, it's just not destructured
  // into the evaluate() call yet).
  let spreadPct: number | undefined;
  if (bid !== undefined && ask !== undefined && bid > 0 && ask > 0) {
    const mid = (bid + ask) / 2;
    spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : 100;
    const MAX_SPREAD_PCT = 8;
    const MIN_VOLUME = 50;
    if (spreadPct > MAX_SPREAD_PCT || volume < MIN_VOLUME) {
      return {
        score: 0, confidence: 0, direction: 'NONE', reasons: ['Rejected: illiquid (spread/volume)'],
        conf: 0, prob: 0, rr: 0, sl: 0, tp1: 0, tp2: 0, stars: 0, lots: 0,
        spreadPct, rejected: `spread ${spreadPct.toFixed(1)}% or volume ${volume} fails liquidity gate`,
      };
    }
  }

  // ── Confidence from existing engines (0-100) ──
  let conf = 0;

  const absDelta = Math.abs(g.delta);
  if (absDelta >= 0.40 && absDelta <= 0.60) conf += 25;
  else if (absDelta >= 0.30 && absDelta <= 0.70) conf += 15;
  else conf += 5;

  // FIX: if `oi` is supplied, normalize OI change as a % of this leg's own
  // OI (fair across small-cap/large-cap). If not supplied (neither current
  // caller passes it yet), fall back to the original absolute-count scoring
  // so behavior doesn't silently change until callers are updated.
  let oiScore: number;
  if (oi !== undefined && oi > 0) {
    const oiChgPct = Math.abs(oiChg) / oi;
    oiScore = Math.min(25, oiChgPct * 100);
    if (oiChgPct > 0.15) reasons.push('Strong OI change (%)');
  } else {
    oiScore = Math.min(25, (Math.abs(oiChg) / 50000) * 25);
    if (Math.abs(oiChg) > 20000) reasons.push('Strong OI change');
  }
  conf += oiScore;

  // FIX: same fallback pattern for volume — normalized if avgVolume is
  // supplied, original absolute-threshold behavior otherwise.
  let volScore: number;
  if (avgVolume !== undefined && avgVolume > 0) {
    const volRatio = volume / avgVolume;
    volScore = Math.min(15, Math.max(0, (volRatio - 1) * 15));
    if (volRatio > 1.5) reasons.push('Volume above average');
  } else {
    volScore = Math.min(15, (volume / 100000) * 15);
  }
  conf += volScore;

  if (iv > 0 && iv < 60) conf += 10;

  if (context.gammaBlastBoost > 0) {
    conf += context.gammaBlastBoost;
    reasons.push(`Gamma Blast +${context.gammaBlastBoost}`);
  }

  if (input.smcBias === 'BULLISH' && type === 'CE') { conf += 10; reasons.push('SMC bullish'); }
  if (input.smcBias === 'BEARISH' && type === 'PE') { conf += 10; reasons.push('SMC bearish'); }

  if (input.pocDistancePct !== undefined) {
    if (Math.abs(input.pocDistancePct) < 0.005) { conf += 5; reasons.push('Near POC'); }
  }

  conf = Math.max(0, Math.min(100, Math.round(conf)));

  // ── Position sizing (reuse risk-management.ts) ──
  // FIX v3 (Option 2 — formula rescale, no new data source):
  // Previous formula overstated expectedUnderlyingMove by multiplying
  // sqrt(days/365) by an extra sqrt(365), then applied an arbitrary *0.1
  // fudge on top — net effect: expectedPremiumMove landed in a narrow band
  // that made slDistance clamp to the same ceiling/floor for nearly every
  // strike, which is why verify-zh.ts showed SL pinned at exactly 40% of
  // ltp regardless of delta/DTE/strike.
  //
  // Real fix: annualize properly (spot × iv × sqrt(days/365), no extra
  // sqrt(365)), and drop the arbitrary *0.1 fudge — delta already tells us
  // how much of the underlying move passes through to premium, that's its
  // definition, no additional scaling needed. Also widen the floor/ceiling
  // band so it stops acting as a de facto fixed percentage.
  // Option 1: prefer real per-instrument ATR(14) (daily sigma) scaled to the
  // trade horizon with sqrt(daysToExpiry) — equivalent time-scaling to the IV
  // formula below. Falls back to the IV→expected-move approximation when ATR
  // is not supplied (e.g. old callers / non-stock symbols).
  const realAtr = input.atr && input.atr > 0 ? input.atr : null;
  const expectedUnderlyingMove = realAtr
    ? realAtr * Math.sqrt(Math.max(1, daysToExpiry))
    : spot * ivDecimal * Math.sqrt(Math.max(1, daysToExpiry) / 365);
  // FIX: ground the premium-move estimate — cap it as a direct fraction of
  // entry premium (not purely delta × underlying move, which overstates via
  // ignored gamma). A weekly option rarely gains >~2.5x entry even in a
  // strong directional week.
  const expectedPremiumMove = Math.min(
    ltp * 2.5, // hard ceiling: premium move capped at 2.5x entry
    Math.max(0.05 * ltp, absDelta * expectedUnderlyingMove)
  );

  const slDistance = Math.min(ltp * 0.70, Math.max(ltp * 0.15, expectedPremiumMove * 0.6));
  const sl = Math.max(0.05, ltp - slDistance);

  // Dampened confidence multiplier — nudges TP1 only, never TP2 (TP2 derives
  // from the R:R cap below so it can't be over-multiplied by confidence).
  const confMultiplier = 1 + (conf - 50) / 200; // ~0.75x–1.25x across conf 0-100
  const tp1Distance = expectedPremiumMove * 0.6 * confMultiplier;
  const tp2Distance = expectedPremiumMove * 1.2; // no confMultiplier stacking
  const tp1 = ltp + Math.max(tp1Distance, slDistance * 0.75);
  const tp2Raw = ltp + Math.max(tp2Distance, slDistance * 1.5);

  // Hard R:R sanity ceiling as a backstop. Recompute tp2 FROM the capped RR so
  // the displayed TP2 and R:R always agree — a trader must never see a TP2 that
  // implies a higher R:R than what's shown.
  const rawRR = slDistance > 0 ? (tp2Raw - ltp) / slDistance : 0;
  const cappedRR = Math.min(rawRR, 4.5);
  const tp2 = ltp + slDistance * cappedRR;
  const rr = Math.round(cappedRR * 10) / 10;

  // FIX: probability computed independently of conf (previously circular)
  const prob = Math.min(95, Math.max(5, Math.round(
    45 + absDelta * 40 + (iv > 0 && iv < 40 ? 5 : 0) + (context.gammaBlastBoost > 0 ? 5 : 0)
  )));

  const stars = Math.max(1, Math.min(5, Math.round(conf / 20)));
  const direction: 'CALL' | 'PUT' | 'NONE' = type === 'CE' ? 'CALL' : 'PUT';

  // FIX: position sizing now uses the real computed SL distance instead of
  // a separately hardcoded ltp*0.5 guess that ignored the SL below it.
  const pos = calculatePositionSize({
    capital,
    riskPerTradePercent,
    entryPremium: ltp,
    stopLossPremium: sl,
    lotSize,
    maxPositionSize,
  });

  // ── Institutional Engine v2 delegation (single source of truth) ──
  // All option strategies (Zero Hero, SMC) route their shared core
  // (structure/liquidity/risk/SL/TP/confidence) through evaluateWithStrategy
  // with the ZERO_HERO config. Legacy logic below remains the fallback when
  // the caller doesn't supply underlying candles + the full chain.
  if (input.candles && input.candles.length >= 12 && input.fullChain && input.fullChain.length) {
    try {
      const mappedChain = fromRawChain(input.fullChain, spot);
      const req: InstitutionalRequest = {
        symbol: 'IDX',
        spot,
        vix: context.vix,
        dte: daysToExpiry,
        expiryKind: (input.expiryKind ?? (context.expiry?.expiry_type === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY')) as any,
        dayOfWeek: input.dayOfWeek ?? new Date().getDay(),
        lotSize,
        candles: input.candles,
        atr: input.atr,
        chain: mappedChain,
        forceType: type,
        capital,
      };
      const strat = evaluateStrategyForStrike(
        req,
        STRATEGY_CONFIGS.ZERO_HERO,
        input.strike,
        type,
        { volume, avgVolume },
      );
      // Use the engine's SL/TP/confidence for THIS strike/type whenever the
      // engine evaluated it (strat.type is set, regardless of ZERO_HERO's strict
      // 60/2.0 eligibility gate). Falling through to legacy hardcoded math
      // otherwise yields stale, decoupled levels. Legacy fallback stays only
      // when the engine couldn't evaluate the strike at all (type is null) or
      // candles + chain are absent.
      if (strat.type) {
        // Engine produces direction + confidence, but the SL engine's premium
        // ref is wrong for index options (maps huge index-distance → premium →
        // clamped to 0). Compute premium-space SL/TP from ATR × delta
        // (expected premium move) for dynamic R:R that varies per candidate.
        const atrVal = input.atr || ltp * 0.35;
        const absDelta = Math.abs(delta);
        const atrPct = ltp > 0 ? atrVal / ltp : 0.35;
        const slPct = Math.max(0.2, Math.min(0.5, 0.35 - atrPct * 2));
        // Dynamic TP: expected premium move = ATR × delta
        // TP1/TP2 target fractions of the expected move (not multiples of SL)
        const expectedMove = atrVal * absDelta;
        const engineSl = ltp * (1 - slPct);
        const engineTp1 = ltp + expectedMove * 0.8;
        const engineTp2 = ltp + expectedMove * 1.3;
        const engineRr = Math.abs(engineTp1 - ltp) / Math.abs(ltp - engineSl);
        const mapped = toZeroHeroFromStrategy(strat);
        return {
          score: mapped.score,
          confidence: mapped.confidence,
          direction,
          reasons: [...reasons, ...mapped.reasons],
          conf: mapped.conf,
          prob: mapped.prob,
          rr: Math.round(engineRr * 10) / 10,
          sl: Math.round(engineSl * 100) / 100,
          tp1: Math.round(engineTp1 * 100) / 100,
          tp2: Math.round(engineTp2 * 100) / 100,
          stars: mapped.stars,
          lots: mapped.lots,
          spreadPct: mapped.spreadPct,
        };
      }
    } catch (e: any) {
      // Fall back to legacy levels below on any error
      console.error('[ZH-ENGINE] fallback:', e?.message);
    }
  }

  return {
    score: conf,
    confidence: conf,
    direction,
    reasons,
    conf,
    prob,
    rr,
    sl,
    tp1,
    tp2,
    stars,
    lots: pos.lots,
    spreadPct,
  };
}
