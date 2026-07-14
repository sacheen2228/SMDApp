// Zero Hero — Option Risk Engine V1
//
// Consumes a single SMC candidate + the surrounding market context
// (canonical snapshot, full option chain, India VIX, ATR, days-to-expiry)
// and produces a deterministic, replayable risk assessment of the specific
// option being traded.
//
// Architecture rules honoured:
//   • Reuses greeks/IV/ATR — they arrive pre-computed (the canonical
//     snapshot and option chain already carry greeks from the greeks module).
//     This engine NEVER recomputes Black-Scholes greeks.
//   • Does NOT touch the Recorder, Replay engine, Trade Audit, Evaluation
//     framework or Canonical Snapshot builders. It only READS them.
//   • Zero Hero consumes SMC candidates and filters them — this engine is
//     the risk gate applied per candidate.
//   • All maths are pure functions of the inputs → deterministic + replayable.

import type { SMCCandidate } from "@/lib/smc-engine";
import type { CanonicalMarketSnapshot, OptionLeg } from "@/lib/market/canonical";
import type { SDMOptionStrike } from "@/types/sdm";

// ── Output unions ────────────────────────────────────────────────
export type BurnLabel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type DealerGamma = "LONG" | "SHORT" | "NEUTRAL";

export interface OptionRiskResult {
  optionHealth: number; // 0-100
  thetaScore: number; // 0-100
  gammaScore: number; // 0-100
  thetaBurn: BurnLabel;
  gammaBlast: BurnLabel;
  premiumSurvival: number; // 0-100
  ivCrushRisk: number; // 0-100 (higher = worse)
  dealerGammaState: DealerGamma;
  expectedMove: number; // index points
  rejectReason?: string; // present only when hard-rejected
}

export interface OptionRiskInput {
  candidate: SMCCandidate;
  snapshot: CanonicalMarketSnapshot;
  /** Option chain in either SDMOptionStrike[] or OptionLeg[] form. */
  optionChain?: SDMOptionStrike[] | OptionLeg[];
  /** Optional explicit greeks for the candidate leg (falls back to chain leg). */
  greeks?: { delta: number; theta: number; gamma: number; vega: number };
  /** India VIX as a percentage (e.g. 15). Falls back to snapshot.indiaVix. */
  indiaVix?: number;
  /** ATR (index points). Falls back to snapshot.atr. */
  atr?: number;
  daysToExpiry: number;
  // ── SMC structure confirmations (drive the gamma-blast hard-reject) ──
  trendConfirmed?: boolean;
  bosConfirmed?: boolean;
  chochConfirmed?: boolean;
  volumeConfirmed?: boolean;
  // ── Optional historical reliability feed ──
  historicalWinRate?: number; // 0-100
  config?: Partial<RiskEngineConfig>;
}

export interface RiskEngineConfig {
  thetaExcellentPct: number; // < this  => excellent
  thetaGoodPct: number; // < this  => good
  thetaRiskyPct: number; // < this  => risky
  thetaRejectPct: number; // >= this => reject
  gammaIntensityLow: number;
  gammaIntensityMedium: number;
  gammaIntensityHigh: number;
  targetMoveMultiple: number; // reject if TP1 underlying move > expectedMove * this
  minOptionHealth: number; // hard reject below this
  ivCrushThreshold: number; // IV % considered a crush risk
  ivCrushVixThreshold: number; // VIX % considered elevated
  dealerGammaRatio: number; // concentration ratio for LONG/SHORT call
}

export const DEFAULT_CONFIG: RiskEngineConfig = {
  thetaExcellentPct: 3,
  thetaGoodPct: 5,
  thetaRiskyPct: 8,
  thetaRejectPct: 8,
  gammaIntensityLow: 0.5,
  gammaIntensityMedium: 1.5,
  gammaIntensityHigh: 3.5,
  targetMoveMultiple: 1.5,
  minOptionHealth: 80,
  ivCrushThreshold: 25,
  ivCrushVixThreshold: 20,
  dealerGammaRatio: 1.2,
};

// ── Small deterministic helpers ───────────────────────────────────
function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

interface ResolvedLeg {
  premium: number;
  iv: number; // percent
  theta: number;
  gamma: number;
  delta: number;
  oi: number;
  volume: number;
  bid?: number;
  ask?: number;
}

/**
 * Resolve the candidate's specific option leg from the supplied chain.
 * Handles both SDMOptionStrike[] (ce/pe sub-objects) and
 * OptionLeg[] (flat strike+type+greeks) forms. The greeks/IV read
 * here were produced by the greeks module upstream — we reuse them, never
 * recompute Black-Scholes.
 */
function resolveLeg(
  chain: SDMOptionStrike[] | OptionLeg[] | undefined,
  strike: number,
  type: "CE" | "PE"
): ResolvedLeg | null {
  if (!chain || chain.length === 0) return null;
  const first: any = chain[0];
  const isSdmForm = first && (first.ce !== undefined || first.pe !== undefined);

  if (isSdmForm) {
    const s: any = (chain as any[]).find((x) => x.strike === strike);
    if (!s) return null;
    const o: any = type === "CE" ? s.ce : s.pe;
    if (!o) return null;
    return {
      premium: o.ltp ?? 0,
      iv: o.iv ?? 0,
      theta: o.theta ?? 0,
      gamma: o.gamma ?? 0,
      delta: o.delta ?? 0,
      oi: o.oi ?? 0,
      volume: o.volume ?? 0,
      bid: o.bid,
      ask: o.ask,
    };
  }

  const l: any = (chain as any[]).find(
    (x) => x.strike === strike && x.type === type
  );
  if (!l) return null;
  return {
    premium: l.ltp ?? 0,
    iv: l.iv ?? 0,
    theta: l.greeks?.theta ?? 0,
    gamma: l.greeks?.gamma ?? 0,
    delta: l.greeks?.delta ?? 0,
    oi: l.oi ?? 0,
    volume: l.volume ?? 0,
    bid: l.bid,
    ask: l.ask,
  };
}

// ── 1. Theta Decay Engine ───────────────────────────────────────
interface ThetaOut {
  thetaPct: number;
  thetaBurn: BurnLabel;
  thetaScore: number;
}
function thetaEngine(theta: number, premium: number, cfg: RiskEngineConfig): ThetaOut {
  const thetaPct = premium > 0 ? (Math.abs(theta) / premium) * 100 : 0;
  let thetaBurn: BurnLabel;
  let thetaScore: number;
  if (thetaPct < cfg.thetaExcellentPct) {
    thetaBurn = "LOW";
    thetaScore = 100;
  } else if (thetaPct < cfg.thetaGoodPct) {
    thetaBurn = "MEDIUM";
    thetaScore = 80;
  } else if (thetaPct < cfg.thetaRiskyPct) {
    thetaBurn = "HIGH";
    thetaScore = 50;
  } else {
    thetaBurn = "EXTREME";
    thetaScore = 10;
  }
  return { thetaPct, thetaBurn, thetaScore };
}

// ── 2. Gamma Blast Engine ─────────────────────────────────────
interface GammaOut {
  gammaBlast: BurnLabel;
  gammaScore: number;
  intensity: number;
}
function gammaBlastEngine(
  gamma: number,
  daysToExpiry: number,
  atr: number,
  spot: number,
  strike: number,
  cfg: RiskEngineConfig
): GammaOut {
  const atmDist = spot > 0 ? Math.abs(strike - spot) / spot : 1;
  // Higher proximity to expiry => bigger blast.
  const expiryProx =
    daysToExpiry <= 1 ? 1 : daysToExpiry <= 2 ? 0.7 : daysToExpiry <= 5 ? 0.4 : 0.15;
  // Tighter distance to ATM => bigger blast.
  const atmProx =
    atmDist < 0.003 ? 1 : atmDist < 0.01 ? 0.6 : atmDist < 0.02 ? 0.3 : 0.1;
  // Smaller ATR (tight range) => gamma pinning more violent.
  const atrProx = atr > 0 ? 1 / (1 + atmDist / (atr / (spot || 1))) : 0.5;

  const intensity = gamma * 1000 * expiryProx * atmProx * atrProx;

  let gammaBlast: BurnLabel;
  let gammaScore: number;
  if (intensity < cfg.gammaIntensityLow) {
    gammaBlast = "LOW";
    gammaScore = 100;
  } else if (intensity < cfg.gammaIntensityMedium) {
    gammaBlast = "MEDIUM";
    gammaScore = 75;
  } else if (intensity < cfg.gammaIntensityHigh) {
    gammaBlast = "HIGH";
    gammaScore = 45;
  } else {
    gammaBlast = "EXTREME";
    gammaScore = 15;
  }
  return { gammaBlast, gammaScore, intensity };
}

// ── 3. Gamma / Theta Ratio (normalised 0-100) ─────────────
function gammaThetaRatio(gamma: number, theta: number): number {
  const ratio = Math.abs(theta) > 0 ? gamma / Math.abs(theta) : 0;
  // atan saturates; maps ratio -> 0..100 smoothly.
  const norm = (Math.atan(ratio * 500) / (Math.PI / 2)) * 100;
  return clamp(Math.round(norm), 0, 100);
}

// ── 4. Expiry Risk Engine ────────────────────────────────────
interface ExpiryOut {
  label: BurnLabel;
  score: number; // 0-100, higher = safer
}
function expiryRiskEngine(daysToExpiry: number): ExpiryOut {
  if (daysToExpiry <= 0) return { label: "EXTREME", score: 5 };
  if (daysToExpiry <= 1) return { label: "HIGH", score: 30 };
  if (daysToExpiry <= 3) return { label: "MEDIUM", score: 60 };
  return { label: "LOW", score: 100 };
}

// ── 5. Expected Move Calculator ────────────────────────────────
function expectedMoveCalc(spot: number, ivPct: number, daysToExpiry: number): number {
  if (spot <= 0) return 0;
  const iv = ivPct / 100;
  return spot * iv * Math.sqrt(Math.max(daysToExpiry, 0) / 365);
}

// ── 6. IV Crush Detector ─────────────────────────────────────
/**
 * High IV + a known event window (expiry day) + no directional edge
 * => elevated crush risk. Returns 0-100 (higher = worse).
 */
function ivCrushDetector(
  ivPct: number,
  vixPct: number,
  daysToExpiry: number,
  hasDirectionalEdge: boolean,
  cfg: RiskEngineConfig
): number {
  let risk = 0;
  const ivHigh = ivPct >= cfg.ivCrushThreshold;
  const vixHigh = vixPct >= cfg.ivCrushVixThreshold;
  const eventWindow = daysToExpiry <= 1;
  if (ivHigh) risk += 45;
  if (vixHigh) risk += 20;
  if (eventWindow) risk += 30;
  if (!hasDirectionalEdge) risk += 25;
  return clamp(Math.round(risk), 0, 100);
}

// ── Liquidity score (0-100) from OI + volume ──────────────────
function liquidityScore(oi: number, volume: number): number {
  // Scale against typical NIFTY index-option magnitudes.
  const oiScore = oi >= 5_000_000 ? 100 : oi >= 1_000_000 ? 75 : oi >= 250_000 ? 50 : oi >= 50_000 ? 25 : 10;
  const volScore = volume >= 5_000_000 ? 100 : volume >= 1_000_000 ? 75 : volume >= 200_000 ? 50 : volume >= 50_000 ? 25 : 10;
  return Math.round((oiScore + volScore) / 2);
}

// ── Spread score (0-100) — real bid/ask when present, else OI proxy ──
function spreadScore(leg: ResolvedLeg | null): number {
  if (leg && leg.bid && leg.ask && leg.bid > 0 && leg.ask > leg.bid) {
    const mid = (leg.bid + leg.ask) / 2;
    const spreadPct = ((leg.ask - leg.bid) / mid) * 100;
    return clamp(Math.round(100 - spreadPct * 20), 0, 100);
  }
  // No book data: wide spreads correlate with thin OI → proxy.
  const oi = leg?.oi ?? 0;
  if (oi >= 1_000_000) return 80;
  if (oi >= 250_000) return 60;
  if (oi >= 50_000) return 40;
  return 20;
}

// ── Greeks balance score (0-100) — delta proximity to ~0.5 (ATM) ──
function greeksBalanceScore(delta: number): number {
  // 0.5 is ideal for a tradable ATM/near-ATM option.
  const dist = Math.abs(delta - 0.5);
  if (dist < 0.1) return 100;
  if (dist < 0.2) return 80;
  if (dist < 0.35) return 55;
  if (dist < 0.5) return 30;
  return 10;
}

// ── 7. Option Health Score (weighted → normalised to 100) ───────
/**
 * Weights (spec): Theta 20, Gamma 20, IV 15, Liquidity 10,
 * Expected Move 10, Expiry 10, Spread 5, Historical 10,
 * Greeks Balance 10  = 110. We normalise the weighted sum by
 * the total weight so the reported health is always 0-100.
 */
const HEALTH_WEIGHTS = {
  theta: 20,
  gamma: 20,
  iv: 15,
  liquidity: 10,
  expectedMove: 10,
  expiry: 10,
  spread: 5,
  historical: 10,
  greeksBalance: 10,
};
const HEALTH_TOTAL = Object.values(HEALTH_WEIGHTS).reduce((s, w) => s + w, 0); // 110

// ── 8. Dealer Gamma Estimate (from chain concentration) ─────────
/**
 * Customers are long the options dealers are short. We measure customer
 * gamma concentration (OI-weighted) on each side; the dealer state is
 * the inverse of whichever side dominates.
 */
function dealerGammaState(
  chain: SDMOptionStrike[] | OptionLeg[] | undefined,
  cfg: RiskEngineConfig
): DealerGamma {
  if (!chain || chain.length === 0) return "NEUTRAL";
  const first: any = chain[0];
  const isSdmForm = first && (first.ce !== undefined || first.pe !== undefined);

  let callGamma = 0;
  let putGamma = 0;
  for (const item of chain as any[]) {
    if (isSdmForm) {
      const ce = item.ce;
      const pe = item.pe;
      if (ce) callGamma += (ce.gamma ?? 0) * (ce.oi ?? 0);
      if (pe) putGamma += (pe.gamma ?? 0) * (pe.oi ?? 0);
    } else {
      const g = item.greeks?.gamma ?? 0;
      const oi = item.oi ?? 0;
      if (item.type === "CE") callGamma += g * oi;
      else putGamma += g * oi;
    }
  }

  // Dealers are short what customers are long.
  if (callGamma > putGamma * cfg.dealerGammaRatio) return "SHORT"; // customers long calls
  if (putGamma > callGamma * cfg.dealerGammaRatio) return "LONG"; // customers long puts
  return "NEUTRAL";
}

// ── Premium Survival (0-100) ──────────────────────────────────
function computePremiumSurvival(
  thetaPct: number,
  gammaIntensity: number,
  ivPct: number,
  daysToExpiry: number
): number {
  const thetaPenalty = clamp(thetaPct * 6, 0, 50);
  const gammaPenalty = clamp(gammaIntensity * 15, 0, 40);
  const timeBonus = clamp(daysToExpiry * 4, 0, 30);
  const ivPenalty = ivPct > 20 ? clamp((ivPct - 20) * 1, 0, 15) : 0;
  return clamp(Math.round(70 - thetaPenalty - gammaPenalty + timeBonus - ivPenalty), 0, 100);
}

// ── Main entry point ────────────────────────────────────────────
export function runOptionRiskEngine(input: OptionRiskInput): OptionRiskResult {
  const cfg: RiskEngineConfig = { ...DEFAULT_CONFIG, ...(input.config || {}) };
  const cand = input.candidate;
  const snap = input.snapshot;
  const spot = snap.spot || 0;
  const daysToExpiry = input.daysToExpiry;
  const atr = input.atr ?? snap.atr ?? 0;
  const vix = input.indiaVix ?? snap.indiaVix ?? 0;

  const leg = resolveLeg(input.optionChain, cand.strike, cand.type);
  const premium = leg?.premium ?? cand.entry ?? 0;
  const ivPct = leg?.iv ?? 0;
  const theta = input.greeks?.theta ?? leg?.theta ?? 0;
  const gamma = input.greeks?.gamma ?? leg?.gamma ?? 0;
  const delta = input.greeks?.delta ?? leg?.delta ?? 0;
  const oi = leg?.oi ?? 0;
  const volume = leg?.volume ?? 0;

  // ── 1. Theta ──
  const thetaOut = thetaEngine(theta, premium, cfg);

  // ── 2. Gamma blast ──
  const gammaOut = gammaBlastEngine(gamma, daysToExpiry, atr, spot, cand.strike, cfg);

  // ── 3. Gamma/Theta ratio ──
  const ratioNorm = gammaThetaRatio(gamma, theta);

  // ── 4. Expiry risk ──
  const expiryOut = expiryRiskEngine(daysToExpiry);

  // ── 5. Expected move + TP1 feasibility ──
  const expectedMove = expectedMoveCalc(spot, ivPct || vix, daysToExpiry);
  const d = delta > 0.05 ? delta : 0.5;
  const premiumMoveToTp1 = Math.abs(cand.tp1 - cand.entry);
  const underlyingMoveToTp1 = premiumMoveToTp1 / d;
  const tp1ExceedsMove = underlyingMoveToTp1 > expectedMove * cfg.targetMoveMultiple;

  // ── 6. IV crush ──
  const hasDirectionalEdge =
    cand.confidence >= 70 ||
    (input.trendConfirmed && input.bosConfirmed && input.chochConfirmed);
  const ivCrushRisk = ivCrushDetector(ivPct, vix, daysToExpiry, hasDirectionalEdge, cfg);

  // ── Liquidity / spread / greeks balance ──
  const liqScore = liquidityScore(oi, volume);
  const sprdScore = spreadScore(leg);
  const greeksBal = greeksBalanceScore(delta);

  // ── Historical reliability ──
  const historicalScore = clamp(
    Math.round(input.historicalWinRate ?? cand.qualityScore ?? cand.confidence ?? 0),
    0,
    100
  );

  // ── 7. Option Health (weighted, normalised to 100) ──
  const ivScore = clamp(100 - ivCrushRisk, 0, 100);
  const expectedMoveScore = tp1ExceedsMove
    ? 0
    : clamp(Math.round(100 - (underlyingMoveToTp1 / Math.max(expectedMove, 1)) * 50), 0, 100);

  const weighted =
    thetaOut.thetaScore * HEALTH_WEIGHTS.theta +
    gammaOut.gammaScore * HEALTH_WEIGHTS.gamma +
    ivScore * HEALTH_WEIGHTS.iv +
    liqScore * HEALTH_WEIGHTS.liquidity +
    expectedMoveScore * HEALTH_WEIGHTS.expectedMove +
    expiryOut.score * HEALTH_WEIGHTS.expiry +
    sprdScore * HEALTH_WEIGHTS.spread +
    historicalScore * HEALTH_WEIGHTS.historical +
    greeksBal * HEALTH_WEIGHTS.greeksBalance;

  const optionHealth = clamp(Math.round(weighted / HEALTH_TOTAL), 0, 100);

  // ── 8. Dealer gamma ──
  const dealerState = dealerGammaState(input.optionChain, cfg);

  // ── Premium survival ──
  const premiumSurvival = computePremiumSurvival(
    thetaOut.thetaPct,
    gammaOut.intensity,
    ivPct || vix,
    daysToExpiry
  );

  // ── Hard Reject Rules ──
  const reasons: string[] = [];
  if (optionHealth < cfg.minOptionHealth) {
    reasons.push(`option health ${optionHealth} below ${cfg.minOptionHealth}`);
  }
  if (thetaOut.thetaBurn === "EXTREME") {
    reasons.push(`theta decay ${thetaOut.thetaPct.toFixed(1)}% too high`);
  }
  if (
    (gammaOut.gammaBlast === "HIGH" || gammaOut.gammaBlast === "EXTREME") &&
    !(input.trendConfirmed && input.bosConfirmed && input.chochConfirmed && input.volumeConfirmed)
  ) {
    reasons.push("high gamma blast without structure confirmation (trend+BOS+CHoCH+volume)");
  }
  if (tp1ExceedsMove) {
    reasons.push(
      `target exceeds expected move (${underlyingMoveToTp1.toFixed(0)} > ${expectedMove.toFixed(0)}×${cfg.targetMoveMultiple})`
    );
  }

  const rejectReason = reasons.length > 0 ? reasons.join("; ") : undefined;

  return {
    optionHealth,
    thetaScore: thetaOut.thetaScore,
    gammaScore: gammaOut.gammaScore,
    thetaBurn: thetaOut.thetaBurn,
    gammaBlast: gammaOut.gammaBlast,
    premiumSurvival,
    ivCrushRisk,
    dealerGammaState: dealerState,
    expectedMove,
    rejectReason,
  };
}
