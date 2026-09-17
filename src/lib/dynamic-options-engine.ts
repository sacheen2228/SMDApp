// ─── Dynamic Options Greeks + Premium Melt Engine ─────────────────────
// Evaluates Delta, Gamma, Theta, Vega, IV and underlying movement to
// determine optimal strike (ITM/ATM/OTM), direction, and trade edge.
// Does NOT replace existing engines — extends analysis layer.
//
// V2 FIX: Added data validation, directional consistency, hard quality gates,
// and expiry/market-closed protection to prevent false signals.

import { calculateGreeks } from '@/lib/greeks';
import { isExpiryDay, getNearestExpiry } from '@/lib/expiry-calculator';

// ─── Data Validation ────────────────────────────────────────────────

export interface DataValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateOptionChainData(input: DynamicOptionsInput): DataValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.spot <= 0 || isNaN(input.spot)) errors.push('Invalid spot price');
  if (input.vix <= 0 || isNaN(input.vix)) errors.push('Invalid VIX');
  if (!input.strikes || input.strikes.length === 0) errors.push('No strikes provided');
  if (input.pcr < 0 || input.pcr > 5 || isNaN(input.pcr)) errors.push('Invalid PCR');
  if (input.atmStrike <= 0) errors.push('Invalid ATM strike');
  if (input.totalCallOI <= 0 && input.totalPutOI <= 0) errors.push('Total OI both zero');

  const atm = input.strikes.find(s => s.strike === input.atmStrike);
  if (!atm) {
    errors.push('ATM strike not found in chain');
  } else {
    if (atm.ce.ltp <= 0 && atm.pe.ltp <= 0) errors.push('ATM CE and PE premiums both zero — no tradeable data');
    if (Math.abs(atm.ce.delta) < 0.01 && Math.abs(atm.pe.delta) < 0.01) warnings.push('ATM Greeks near zero — data may be stale');
    if (atm.ce.iv <= 0 && atm.pe.iv <= 0) warnings.push('ATM IV both zero — using fallback');
  }

  const strikesWithPremium = input.strikes.filter(s => s.ce.ltp > 0 || s.pe.ltp > 0);
  if (strikesWithPremium.length < 3) errors.push(`Only ${strikesWithPremium.length} strikes with valid premiums (need ≥3)`);

  return { valid: errors.length === 0, errors, warnings };
}

function isMarketOpenNow(): boolean {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hhmm = ist.getUTCHours() * 100 + ist.getUTCMinutes();
  return hhmm >= 915 && hhmm <= 1530;
}

function isMCXOpenNow(): boolean {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const day = ist.getUTCDay();
  if (day === 0) return false;
  if (day === 6 && ist.getUTCHours() < 1) return true;
  const hhmm = ist.getUTCHours() * 100 + ist.getUTCMinutes();
  return hhmm >= 900 && hhmm <= 2330;
}

// ─── Types ────────────────────────────────────────────────────────────

export interface DynamicOptionsInput {
  symbol: string;
  spot: number;
  vix: number;
  pcr: number;
  maxPain: number;
  atmStrike: number;
  strikes: StrikeInput[];
  totalCallOI: number;
  totalPutOI: number;
  callOiChg: number;
  putOiChg: number;
  expiryDate?: string;
  lotSize?: number;
}

export interface StrikeInput {
  strike: number;
  ce: LegInput;
  pe: LegInput;
}

export interface LegInput {
  ltp: number;
  bid: number;
  ask: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface DynamicStrikeAnalysis {
  strike: number;
  distanceFromATM: number;
  moneyness: 'DEEP_ITM' | 'ITM' | 'ATM' | 'OTM' | 'FAR_OTM';
  ce: DynamicLegAnalysis;
  pe: DynamicLegAnalysis;
}

export interface DynamicLegAnalysis {
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  oi: number;
  oiChg: number;
  volume: number;
  spread: number;
  spreadPct: number;
  intrinsicValue: number;
  timeValue: number;
  deltaBand: 'DEEP_ITM' | 'ITM' | 'ATM' | 'OTM' | 'FAR_OTM';
  premiumMeltScore: PremiumMeltScore;
  dynamicDeltaImpact: DeltaImpact[];
  gammaProjection: GammaProjection[];
  expectedPremiumMove: number;
  ivState: IVState;
  premiumVelocity: PremiumVelocityData;
}

export interface DeltaImpact {
  spotMove: number;
  spotMovePct: number;
  premiumImpact: number;
  newPremiumEstimate: number;
}

export interface GammaProjection {
  spotMove: number;
  deltaChange: number;
  projectedDelta: number;
  firstOrderPremium: number;
  secondOrderPremium: number;
  totalPremiumChange: number;
}

export interface PremiumMeltScore {
  score: number;
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  thetaDecay1Day: number;
  thetaDecayToExpiry: number;
  ivRisk: number;
  liquidityRisk: number;
  strikeDistanceRisk: number;
  timeDecayPct: number;
  meltDescription: string;
}

export interface IVState {
  currentIV: number;
  ivChange: number;
  state: 'EXPANSION' | 'CONTRACTION' | 'CRUSH' | 'STABLE';
  crushRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  ivSkew: number;
  ivRank: string;
}

export interface PremiumVelocityData {
  velocity: number;
  acceleration: number;
  classification: 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME';
  expectedDirection: 'EXPANDING' | 'MELTING' | 'REVERSING' | 'STABLE';
}

export interface StrikeComparison {
  itm: StrikeCandidate;
  atm: StrikeCandidate;
  otm: StrikeCandidate;
}

export interface StrikeCandidate {
  strike: number;
  type: 'ITM' | 'ATM' | 'OTM';
  optionType: 'CE' | 'PE';
  premium: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  meltRisk: string;
  expectedMove: number;
  spread: number;
  capitalRequired: number;
  maxLoss: number;
  breakevenMove: number;
  edgeScore: number;
  rank: number;
}

export interface CEDirectionResult {
  callScore: number;
  putScore: number;
  callExpectedPremiumMove: number;
  putExpectedPremiumMove: number;
  recommendedDirection: 'CE' | 'PE' | 'BOTH' | 'NO_TRADE';
  reasoning: string[];
}

export interface HeroZeroFilter {
  qualifies: boolean;
  reasons: string[];
  rejectionReasons: string[];
  momentumStrength: number;
  gammaStrength: number;
  deltaAdequacy: boolean;
  volumeConfirmation: boolean;
  oiConfirmation: boolean;
  ivConfirmation: boolean;
  liquidityOk: boolean;
  spreadOk: boolean;
}

export interface StraddleStrangleAnalysis {
  strategy: 'STRADDLE' | 'STRANGLE' | 'NO_TRADE';
  ceStrike: number;
  cePremium: number;
  peStrike: number;
  pePremium: number;
  totalPremium: number;
  upperBreakeven: number;
  lowerBreakeven: number;
  maxLoss: number;
  requiredMove: number;
  expectedMove: number;
  moveRealistic: boolean;
  capitalRequired: number;
  edgeScore: number;
}

export interface TradeDecision {
  action: 'BUY_CE' | 'BUY_PE' | 'BUY_BOTH' | 'NO_TRADE';
  symbol: string;
  strike: number;
  strikeType: 'ITM' | 'ATM' | 'OTM';
  optionType: 'CE' | 'PE' | 'BOTH';
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  premiumMelt: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  expectedPremiumMove: number;
  expectedUnderlyingMove: number;
  riskReward: number;
  maxLoss: number;
  capitalRequired: number;
  optionsEdgeScore: number;
  expiryMode: boolean;
  reasoning: string[];
  strikeComparison: StrikeComparison;
  heroZero: HeroZeroFilter;
  straddleAnalysis: StraddleStrangleAnalysis | null;
}

export interface DynamicOptionsResult {
  symbol: string;
  spot: number;
  expiryMode: boolean;
  strikeAnalyses: DynamicStrikeAnalysis[];
  strikeComparison: StrikeComparison;
  directionResult: CEDirectionResult;
  heroZero: HeroZeroFilter;
  straddleAnalysis: StraddleStrangleAnalysis | null;
  tradeDecision: TradeDecision;
  premiumMeltAlert: PremiumMeltAlert | null;
  gammaAlert: GammaAlert | null;
  timestamp: string;
}

export interface PremiumMeltAlert {
  active: boolean;
  level: 'WARNING' | 'EXTREME';
  message: string;
  underlyingInsufficient: boolean;
  thetaHigh: boolean;
  ivFalling: boolean;
  premiumDeclining: boolean;
}

export interface GammaAlert {
  active: boolean;
  message: string;
  gammaExpansion: boolean;
  deltaAcceleration: boolean;
  premiumAcceleration: boolean;
}

// ─── Moneyness Classification ─────────────────────────────────────────

function classifyMoneyness(strike: number, atmStrike: number, spot: number): 'DEEP_ITM' | 'ITM' | 'ATM' | 'OTM' | 'FAR_OTM' {
  const diff = Math.abs(strike - spot);
  const pctDiff = (diff / spot) * 100;

  if (strike === atmStrike || diff <= 50) return 'ATM';
  if (pctDiff < 0.5) return strike < spot ? 'ITM' : 'OTM';
  if (pctDiff < 1.0) return strike < spot ? 'ITM' : 'OTM';
  if (pctDiff < 2.0) return strike < spot ? 'DEEP_ITM' : 'FAR_OTM';
  return strike < spot ? 'DEEP_ITM' : 'FAR_OTM';
}

function classifyDeltaBand(delta: number, isCall: boolean): 'DEEP_ITM' | 'ITM' | 'ATM' | 'OTM' | 'FAR_OTM' {
  const absDelta = Math.abs(delta);
  if (isCall) {
    if (absDelta >= 0.70) return 'DEEP_ITM';
    if (absDelta >= 0.55) return 'ITM';
    if (absDelta >= 0.45) return 'ATM';
    if (absDelta >= 0.30) return 'OTM';
    return 'FAR_OTM';
  } else {
    if (absDelta >= 0.70) return 'DEEP_ITM';
    if (absDelta >= 0.55) return 'ITM';
    if (absDelta >= 0.45) return 'ATM';
    if (absDelta >= 0.30) return 'OTM';
    return 'FAR_OTM';
  }
}

// ─── 1. Dynamic Delta Impact ──────────────────────────────────────────

function computeDeltaImpact(
  spot: number,
  strike: number,
  iv: number,
  timeToExpiry: number,
  isCall: boolean,
  currentPremium: number,
  delta: number
): DeltaImpact[] {
  const moves = [-100, -50, -30, -20, -10, 10, 20, 30, 50, 100];
  return moves.map(spotMove => {
    const newSpot = spot + spotMove;
    const newGreeks = calculateGreeks(newSpot, strike, timeToExpiry, iv, isCall);
    const premiumImpact = newGreeks.delta * spotMove;
    return {
      spotMove,
      spotMovePct: (spotMove / spot) * 100,
      premiumImpact: Math.round(premiumImpact * 100) / 100,
      newPremiumEstimate: Math.round((currentPremium + premiumImpact) * 100) / 100,
    };
  });
}

// ─── 2. Gamma Projection (Second-Order) ───────────────────────────────

function computeGammaProjection(
  spot: number,
  strike: number,
  iv: number,
  timeToExpiry: number,
  isCall: boolean,
  delta: number,
  gamma: number,
  currentPremium: number
): GammaProjection[] {
  const moves = [-50, -30, -20, -10, 10, 20, 30, 50];
  return moves.map(spotMove => {
    const deltaChange = gamma * spotMove;
    const projectedDelta = delta + deltaChange;
    const firstOrder = delta * spotMove;
    const secondOrder = 0.5 * gamma * spotMove * spotMove;
    const totalPremiumChange = firstOrder + secondOrder;
    return {
      spotMove,
      deltaChange: Math.round(deltaChange * 10000) / 10000,
      projectedDelta: Math.round(projectedDelta * 100) / 100,
      firstOrderPremium: Math.round(firstOrder * 100) / 100,
      secondOrderPremium: Math.round(secondOrder * 100) / 100,
      totalPremiumChange: Math.round(totalPremiumChange * 100) / 100,
    };
  });
}

// ─── 3. Premium Melt Score ────────────────────────────────────────────

function computePremiumMeltScore(
  theta: number,
  iv: number,
  spot: number,
  strike: number,
  daysToExpiry: number,
  volume: number,
  oi: number,
  bid: number,
  ask: number,
  ltp: number,
  premium: number,
  spotMovement24h: number
): PremiumMeltScore {
  const absTheta = Math.abs(theta);

  const thetaDecay1Day = absTheta;
  const thetaDecayToExpiry = absTheta * daysToExpiry;

  const ivRisk = iv > 0.30 ? 0.8 : iv > 0.20 ? 0.5 : iv > 0.15 ? 0.3 : 0.1;

  const spread = ask - bid;
  const spreadPct = ltp > 0 ? (spread / ltp) * 100 : 100;
  const liquidityRisk = spreadPct > 2 ? 0.8 : spreadPct > 1 ? 0.5 : spreadPct > 0.5 ? 0.3 : 0.1;

  const strikeDistance = Math.abs(strike - spot);
  const strikeDistancePct = (strikeDistance / spot) * 100;
  const strikeDistanceRisk = strikeDistancePct > 2 ? 0.9 : strikeDistancePct > 1 ? 0.6 : strikeDistancePct > 0.5 ? 0.3 : 0.1;

  const timeDecayPct = premium > 0 ? (thetaDecay1Day / premium) * 100 : 0;

  const underlyingInsufficient = Math.abs(spotMovement24h) < absTheta * 0.5;

  const meltScore = (
    (absTheta > 5 ? 30 : absTheta > 2 ? 20 : absTheta > 1 ? 10 : 0) +
    (ivRisk * 20) +
    (liquidityRisk * 15) +
    (strikeDistanceRisk * 15) +
    (daysToExpiry <= 1 ? 20 : daysToExpiry <= 2 ? 10 : 0) +
    (underlyingInsufficient ? 10 : 0) +
    (timeDecayPct > 10 ? 10 : timeDecayPct > 5 ? 5 : 0)
  );

  const clampedScore = Math.min(100, Math.max(0, meltScore));

  let level: PremiumMeltScore['level'] = 'LOW';
  if (clampedScore >= 70) level = 'EXTREME';
  else if (clampedScore >= 50) level = 'HIGH';
  else if (clampedScore >= 30) level = 'MEDIUM';

  let meltDescription = '';
  if (level === 'EXTREME') meltDescription = 'Severe theta decay + IV decline. Premium will melt fast.';
  else if (level === 'HIGH') meltDescription = 'Significant time decay risk. Underlying must move to offset.';
  else if (level === 'MEDIUM') meltDescription = 'Moderate decay. Acceptable if directional conviction is high.';
  else meltDescription = 'Minimal decay risk. Time decay well-contained.';

  return {
    score: clampedScore,
    level,
    thetaDecay1Day: Math.round(thetaDecay1Day * 100) / 100,
    thetaDecayToExpiry: Math.round(thetaDecayToExpiry * 100) / 100,
    ivRisk: Math.round(ivRisk * 100) / 100,
    liquidityRisk: Math.round(liquidityRisk * 100) / 100,
    strikeDistanceRisk: Math.round(strikeDistanceRisk * 100) / 100,
    timeDecayPct: Math.round(timeDecayPct * 100) / 100,
    meltDescription,
  };
}

// ─── 4. IV State ──────────────────────────────────────────────────────

function computeIVState(
  currentIV: number,
  previousIV: number,
  ivHistory: number[],
  vix: number
): IVState {
  const ivChange = currentIV - previousIV;
  const avgIV = ivHistory.length > 0 ? ivHistory.reduce((a, b) => a + b, 0) / ivHistory.length : currentIV;
  const ivSkew = currentIV - vix / 100;

  let state: IVState['state'] = 'STABLE';
  if (ivChange > 0.02) state = 'EXPANSION';
  else if (ivChange < -0.02) state = 'CONTRACTION';

  if (currentIV < avgIV * 0.7 && ivChange < -0.01) state = 'CRUSH';

  let crushRisk: IVState['crushRisk'] = 'LOW';
  if (state === 'CRUSH' || (state === 'CONTRACTION' && currentIV > 0.25)) crushRisk = 'HIGH';
  else if (state === 'CONTRACTION' || currentIV > 0.20) crushRisk = 'MEDIUM';

  const percentile = ivHistory.length > 0
    ? ivHistory.filter(v => v <= currentIV).length / ivHistory.length * 100
    : 50;
  let ivRank = 'MEDIAN';
  if (percentile > 80) ivRank = 'HIGH';
  else if (percentile > 60) ivRank = 'ABOVE_MEDIAN';
  else if (percentile < 20) ivRank = 'LOW';
  else if (percentile < 40) ivRank = 'BELOW_MEDIAN';

  return {
    currentIV: Math.round(currentIV * 10000) / 100,
    ivChange: Math.round(ivChange * 10000) / 100,
    state,
    crushRisk,
    ivSkew: Math.round(ivSkew * 10000) / 100,
    ivRank,
  };
}

// ─── 5. Premium Velocity ──────────────────────────────────────────────

function computePremiumVelocity(
  currentPremium: number,
  previousPremium: number,
  timeDeltaMinutes: number,
  volume: number,
  oi: number
): PremiumVelocityData {
  const velocity = timeDeltaMinutes > 0 ? (currentPremium - previousPremium) / timeDeltaMinutes : 0;
  const acceleration = 0;

  let classification: PremiumVelocityData['classification'] = 'NONE';
  const absVel = Math.abs(velocity);
  if (absVel > 5) classification = 'EXTREME';
  else if (absVel > 2) classification = 'STRONG';
  else if (absVel > 0.5) classification = 'MODERATE';
  else if (absVel > 0.1) classification = 'WEAK';

  let expectedDirection: PremiumVelocityData['expectedDirection'] = 'STABLE';
  if (velocity > 0.5) expectedDirection = 'EXPANDING';
  else if (velocity < -0.5) expectedDirection = 'MELTING';

  return {
    velocity: Math.round(velocity * 100) / 100,
    acceleration: Math.round(acceleration * 100) / 100,
    classification,
    expectedDirection,
  };
}

// ─── 6. Strike Migration ──────────────────────────────────────────────

function findATMStrike(strikes: number[], spot: number): number {
  let closest = strikes[0];
  let minDiff = Math.abs(strikes[0] - spot);
  for (const s of strikes) {
    const diff = Math.abs(s - spot);
    if (diff < minDiff) {
      minDiff = diff;
      closest = s;
    }
  }
  return closest;
}

// ─── 7. Straddle/Strangle Analysis ────────────────────────────────────

function analyzeStraddleStrangle(
  symbol: string,
  spot: number,
  strikes: StrikeInput[],
  atmStrike: number,
  expectedMove: number,
  lotSize: number,
  vix: number
): StraddleStrangleAnalysis {
  const atmData = strikes.find(s => s.strike === atmStrike);
  if (!atmData) {
    return {
      strategy: 'NO_TRADE', ceStrike: 0, cePremium: 0, peStrike: 0, pePremium: 0,
      totalPremium: 0, upperBreakeven: 0, lowerBreakeven: 0, maxLoss: 0,
      requiredMove: 0, expectedMove, moveRealistic: false, capitalRequired: 0, edgeScore: 0,
    };
  }

  const cePremium = atmData.ce.ltp;
  const pePremium = atmData.pe.ltp;
  const totalPremium = cePremium + pePremium;
  const charges = totalPremium * 0.03;
  const slippage = totalPremium * 0.02;
  const totalCost = totalPremium + charges + slippage;

  const upperBreakeven = atmStrike + totalCost;
  const lowerBreakeven = atmStrike - totalCost;
  const requiredMove = totalCost;

  const moveRealistic = expectedMove > requiredMove * 1.2;

  const capitalRequired = totalPremium * lotSize;

  let edgeScore = 50;
  if (moveRealistic) edgeScore += 20;
  if (vix > 20) edgeScore += 10;
  if (totalPremium < expectedMove * 0.7) edgeScore += 10;
  if (totalPremium > expectedMove * 1.5) edgeScore -= 20;

  edgeScore = Math.min(100, Math.max(0, edgeScore));

  let strategy: StraddleStrangleAnalysis['strategy'] = 'STRADDLE';
  if (!moveRealistic) strategy = 'NO_TRADE';

  return {
    strategy,
    ceStrike: atmStrike,
    cePremium,
    peStrike: atmStrike,
    pePremium,
    totalPremium: Math.round(totalPremium * 100) / 100,
    upperBreakeven: Math.round(upperBreakeven * 100) / 100,
    lowerBreakeven: Math.round(lowerBreakeven * 100) / 100,
    maxLoss: Math.round(totalCost * lotSize),
    requiredMove: Math.round(requiredMove * 100) / 100,
    expectedMove: Math.round(expectedMove * 100) / 100,
    moveRealistic,
    capitalRequired: Math.round(capitalRequired),
    edgeScore,
  };
}

// ─── 8. Hero-Zero Filter ──────────────────────────────────────────────

function evaluateHeroZero(
  strike: number,
  spot: number,
  optionType: 'CE' | 'PE',
  delta: number,
  gamma: number,
  iv: number,
  volume: number,
  oi: number,
  oiChg: number,
  bid: number,
  ask: number,
  ltp: number,
  vix: number,
  trend: 'bullish' | 'bearish' | 'neutral',
  isExpiry: boolean
): HeroZeroFilter {
  const reasons: string[] = [];
  const rejectionReasons: string[] = [];

  const momentumStrength = trend === 'neutral' ? 20
    : ((optionType === 'CE' && trend === 'bullish') || (optionType === 'PE' && trend === 'bearish'))
      ? 80 : 10;

  const gammaStrength = gamma * 1000;
  const deltaAdequacy = Math.abs(delta) >= 0.15;
  const volumeConfirmation = volume > 10000;
  const oiConfirmation = Math.abs(oiChg) > oi * 0.05;
  const ivConfirmation = iv > 0.12 && iv < 0.50;

  const spread = ask - bid;
  const spreadPct = ltp > 0 ? (spread / ltp) * 100 : 100;
  const liquidityOk = oi > 5000 && volume > 5000;
  const spreadOk = spreadPct < 3;

  if (momentumStrength > 50) reasons.push('Strong momentum alignment');
  else rejectionReasons.push('Weak momentum');

  if (gammaStrength > 50) reasons.push('High gamma for explosive move');
  else rejectionReasons.push('Low gamma');

  if (deltaAdequacy) reasons.push('Adequate delta exposure');
  else rejectionReasons.push('Delta too low');

  if (volumeConfirmation) reasons.push('Volume confirmation present');
  else rejectionReasons.push('Low volume');

  if (oiConfirmation) reasons.push('OI confirms fresh positioning');
  else rejectionReasons.push('OI not confirming');

  if (ivConfirmation) reasons.push('IV in tradeable range');
  else rejectionReasons.push('IV extreme');

  if (liquidityOk) reasons.push('Sufficient liquidity');
  else rejectionReasons.push('Insufficient liquidity');

  if (spreadOk) reasons.push('Tight spread');
  else rejectionReasons.push('Wide spread');

  const qualifies = rejectionReasons.length <= 3 && deltaAdequacy && (volumeConfirmation || oiConfirmation);

  return {
    qualifies,
    reasons,
    rejectionReasons,
    momentumStrength,
    gammaStrength: Math.round(gammaStrength),
    deltaAdequacy,
    volumeConfirmation,
    oiConfirmation,
    ivConfirmation,
    liquidityOk,
    spreadOk,
  };
}

// ─── Directional Consistency Enforcement ────────────────────────────

function enforceDirectionalConsistency(
  trend: 'bullish' | 'bearish' | 'neutral',
  recommendedDirection: 'CE' | 'PE' | 'BOTH' | 'NO_TRADE',
  pcr: number,
  spot: number,
  atmStrike: number
): 'CE' | 'PE' | 'BOTH' | 'NO_TRADE' {
  if (trend === 'bullish' && recommendedDirection === 'PE') {
    return 'CE';
  }
  if (trend === 'bearish' && recommendedDirection === 'CE') {
    return 'PE';
  }
  if (trend === 'neutral') {
    if (pcr > 1.3) return 'PE';
    if (pcr < 0.7) return 'CE';
  }
  return recommendedDirection;
}

// ─── Hard Data Quality Gates ────────────────────────────────────────

function passesQualityGates(
  candidate: StrikeCandidate,
  trend: 'bullish' | 'bearish' | 'neutral',
  expiryMode: boolean,
  marketOpen: boolean
): { passes: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!marketOpen) reasons.push('Market is closed');
  if (candidate.premium < 1) reasons.push('Premium < ₹1');
  if (Math.abs(candidate.delta) < 0.05) reasons.push('Delta too low (<0.05)');
  if (candidate.premium > 0 && candidate.spread > candidate.premium * 0.5) reasons.push('Spread >50% of premium');
  if (candidate.theta < -5) reasons.push('Theta decay too high');
  if (candidate.iv > 60) reasons.push('IV too high (>60%)');
  if (candidate.iv < 1 && candidate.iv > 0) reasons.push('IV too low (<1%)');
  if (candidate.volume <= 0 && candidate.oi <= 0) reasons.push('Zero volume and OI');
  if (expiryMode && Math.abs(candidate.delta) < 0.3) reasons.push('Expiry day + low delta');

  if (trend === 'bearish' && candidate.optionType === 'CE') reasons.push('CE rejected in bearish market');
  if (trend === 'bullish' && candidate.optionType === 'PE') reasons.push('PE rejected in bullish market');

  return { passes: reasons.length === 0, reasons };
}

// ─── 9. CE/PE Direction Engine ────────────────────────────────────────

function evaluateDirection(
  strikes: StrikeInput[],
  spot: number,
  atmStrike: number,
  vix: number,
  pcr: number,
  iv: number,
  trend: 'bullish' | 'bearish' | 'neutral',
  timeToExpiry: number
): CEDirectionResult {
  const atmData = strikes.find(s => s.strike === atmStrike);
  if (!atmData) {
    return {
      callScore: 0, putScore: 0, callExpectedPremiumMove: 0, putExpectedPremiumMove: 0,
      recommendedDirection: 'NO_TRADE', reasoning: ['No ATM data'],
    };
  }

  const callDelta = Math.abs(atmData.ce.delta);
  const putDelta = Math.abs(atmData.pe.delta);
  const callGamma = atmData.ce.gamma;
  const putGamma = atmData.pe.gamma;
  const callTheta = Math.abs(atmData.ce.theta);
  const putTheta = Math.abs(atmData.pe.theta);

  const expectedMove = spot * (vix / 100) * Math.sqrt(1 / 365);

  const callPremiumMove = callDelta * expectedMove + 0.5 * callGamma * expectedMove * expectedMove;
  const putPremiumMove = putDelta * expectedMove + 0.5 * putGamma * expectedMove * expectedMove;

  let callScore = 50;
  let putScore = 50;

  if (trend === 'bullish') { callScore += 25; putScore -= 15; }
  else if (trend === 'bearish') { putScore += 25; callScore -= 15; }

  if (pcr > 1.2) { putScore += 10; callScore -= 5; }
  else if (pcr < 0.8) { callScore += 10; putScore -= 5; }

  if (atmData.ce.iv < atmData.pe.iv) { callScore += 5; putScore -= 5; }
  else { putScore += 5; callScore -= 5; }

  if (callPremiumMove > putPremiumMove) callScore += 10;
  else putScore += 10;

  callScore = Math.min(100, Math.max(0, callScore));
  putScore = Math.min(100, Math.max(0, putScore));

  const diff = callScore - putScore;
  let recommendedDirection: CEDirectionResult['recommendedDirection'] = 'NO_TRADE';
  if (diff > 20) recommendedDirection = 'CE';
  else if (diff < -20) recommendedDirection = 'PE';
  else if (Math.abs(diff) <= 10 && vix > 18) recommendedDirection = 'BOTH';

  const reasoning: string[] = [];
  if (trend !== 'neutral') reasoning.push(`Trend: ${trend}`);
  if (pcr > 1.2) reasoning.push('PCR indicates put writing (bullish)');
  else if (pcr < 0.8) reasoning.push('PCR indicates call writing (bearish)');
  reasoning.push(`Call expected move: ₹${callPremiumMove.toFixed(1)}`);
  reasoning.push(`Put expected move: ₹${putPremiumMove.toFixed(1)}`);

  return {
    callScore,
    putScore,
    callExpectedPremiumMove: Math.round(callPremiumMove * 100) / 100,
    putExpectedPremiumMove: Math.round(putPremiumMove * 100) / 100,
    recommendedDirection,
    reasoning,
  };
}

// ─── 10. Premium Melt Alert ───────────────────────────────────────────

function detectPremiumMeltAlert(
  theta: number,
  iv: number,
  ivState: IVState['state'],
  premiumVelocity: PremiumVelocityData,
  expectedMove: number,
  spotMovement: number
): PremiumMeltAlert | null {
  const thetaHigh = Math.abs(theta) > 3;
  const ivFalling = ivState === 'CONTRACTION' || ivState === 'CRUSH';
  const premiumDeclining = premiumVelocity.expectedDirection === 'MELTING';
  const underlyingInsufficient = Math.abs(spotMovement) < Math.abs(theta) * 0.3;

  const conditions = [thetaHigh, ivFalling, premiumDeclining, underlyingInsufficient];
  const activeConditions = conditions.filter(Boolean).length;

  if (activeConditions < 3) return null;

  const level = activeConditions >= 4 ? 'EXTREME' : 'WARNING';

  return {
    active: true,
    level,
    message: level === 'EXTREME'
      ? '\u26a0\ufe0f EXTREME PREMIUM MELT RISK'
      : '\u26a0\ufe0f Premium Melt Warning',
    underlyingInsufficient,
    thetaHigh,
    ivFalling,
    premiumDeclining,
  };
}

// ─── 11. Gamma Alert ──────────────────────────────────────────────────

function detectGammaAlert(
  strikes: StrikeInput[],
  atmStrike: number,
  isExpiry: boolean,
  spot: number
): GammaAlert | null {
  const atmData = strikes.find(s => s.strike === atmStrike);
  if (!atmData) return null;

  const avgGamma = strikes.reduce((sum, s) => sum + (s.ce.gamma + s.pe.gamma) / 2, 0) / strikes.length;
  const atmGamma = (atmData.ce.gamma + atmData.pe.gamma) / 2;
  const gammaRatio = avgGamma > 0 ? atmGamma / avgGamma : 1;

  const gammaExpansion = gammaRatio > 2 || (isExpiry && atmGamma > 0.001);
  if (!gammaExpansion) return null;

  return {
    active: true,
    message: '\u26a1 GAMMA EXPANSION',
    gammaExpansion: true,
    deltaAcceleration: isExpiry,
    premiumAcceleration: atmGamma > 0.002,
  };
}

// ─── 12. Options Edge Score ───────────────────────────────────────────

function computeOptionsEdgeScore(
  delta: number,
  gamma: number,
  theta: number,
  vega: number,
  iv: number,
  meltScore: number,
  heroZero: HeroZeroFilter,
  momentumStrength: number,
  volume: number,
  oi: number,
  spread: number,
  expectedMove: number,
  premium: number,
  daysToExpiry: number,
  ivState: IVState['state']
): number {
  let score = 50;

  const absDelta = Math.abs(delta);
  if (absDelta >= 0.40 && absDelta <= 0.65) score += 12;
  else if (absDelta >= 0.30 && absDelta <= 0.75) score += 8;
  else score += 2;

  if (gamma > 0.0005) score += 8;
  else if (gamma > 0.0002) score += 5;
  else score += 1;

  if (meltScore < 30) score += 10;
  else if (meltScore < 50) score += 5;
  else if (meltScore > 70) score -= 10;

  if (heroZero.reasons.length > heroZero.rejectionReasons.length) score += 5;

  if (momentumStrength > 60) score += 5;

  if (volume > 50000) score += 3;
  else if (volume > 10000) score += 1;

  if (spread < 1) score += 3;
  else if (spread > 3) score -= 5;

  if (expectedMove > 0 && premium > 0) {
    const moveRatio = expectedMove / premium;
    if (moveRatio > 1.2) score += 5;
    else if (moveRatio < 0.5) score -= 5;
  }

  if (ivState === 'CRUSH') score -= 8;
  else if (ivState === 'EXPANSION') score += 3;

  if (daysToExpiry <= 1) score += 2;

  return Math.min(100, Math.max(0, Math.round(score)));
}

// ─── MAIN ENGINE ──────────────────────────────────────────────────────

export function runDynamicOptionsEngine(input: DynamicOptionsInput): DynamicOptionsResult {
  const { symbol, spot, vix, pcr, maxPain, atmStrike, strikes, totalCallOI, totalPutOI, callOiChg, putOiChg, expiryDate, lotSize = 50 } = input;

  // ── V2: Data validation ──
  const dataValidation = validateOptionChainData(input);

  const today = new Date();
  let daysToExpiry = 7;
  if (expiryDate) {
    const exp = new Date(expiryDate);
    daysToExpiry = Math.max(0, Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));
  }
  const timeToExpiry = daysToExpiry / 365;
  const expiryMode = isExpiryDay(symbol, today);
  const marketOpen = isMarketOpenNow();

  // ── V2: Enhanced trend detection with spot-to-ATM relationship ──
  const trend: 'bullish' | 'bearish' | 'neutral' =
    pcr < 0.85 && spot >= atmStrike ? 'bullish'
    : pcr > 1.2 && spot <= atmStrike ? 'bearish'
    : 'neutral';

  const expectedMove = spot * (vix / 100) * Math.sqrt(daysToExpiry / 365);

  const spotMovement24h = expectedMove * 0.3;

  const currentATM = findATMStrike(strikes.map(s => s.strike), spot);

  const strikeAnalyses: DynamicStrikeAnalysis[] = strikes.map(s => {
    const moneyness = classifyMoneyness(s.strike, currentATM, spot);
    const distanceFromATM = Math.abs(s.strike - spot);

    const ceIntrinsic = Math.max(0, spot - s.strike);
    const peIntrinsic = Math.max(0, s.strike - spot);
    const ceTimeValue = Math.max(0, s.ce.ltp - ceIntrinsic);
    const peTimeValue = Math.max(0, s.pe.ltp - peIntrinsic);

    const ceSpread = s.ce.ask - s.ce.bid;
    const ceSpreadPct = s.ce.ltp > 0 ? (ceSpread / s.ce.ltp) * 100 : 0;
    const peSpread = s.pe.ask - s.pe.bid;
    const peSpreadPct = s.pe.ltp > 0 ? (peSpread / s.pe.ltp) * 100 : 0;

    const ceMelt = computePremiumMeltScore(
      s.ce.theta, s.ce.iv, spot, s.strike, daysToExpiry,
      s.ce.volume, s.ce.oi, s.ce.bid, s.ce.ask, s.ce.ltp,
      s.ce.ltp, spotMovement24h
    );
    const peMelt = computePremiumMeltScore(
      s.pe.theta, s.pe.iv, spot, s.strike, daysToExpiry,
      s.pe.volume, s.pe.oi, s.pe.bid, s.pe.ask, s.pe.ltp,
      s.pe.ltp, spotMovement24h
    );

    const ceIVState = computeIVState(s.ce.iv, s.ce.iv, [s.ce.iv], vix / 100);
    const peIVState = computeIVState(s.pe.iv, s.pe.iv, [s.pe.iv], vix / 100);

    const ceExpectedMove = Math.abs(s.ce.delta) * expectedMove + 0.5 * s.ce.gamma * expectedMove * expectedMove;
    const peExpectedMove = Math.abs(s.pe.delta) * expectedMove + 0.5 * s.pe.gamma * expectedMove * expectedMove;

    const ce: DynamicLegAnalysis = {
      ltp: s.ce.ltp,
      delta: s.ce.delta,
      gamma: s.ce.gamma,
      theta: s.ce.theta,
      vega: s.ce.vega,
      iv: s.ce.iv,
      oi: s.ce.oi,
      oiChg: s.ce.oiChg,
      volume: s.ce.volume,
      spread: ceSpread,
      spreadPct: Math.round(ceSpreadPct * 100) / 100,
      intrinsicValue: ceIntrinsic,
      timeValue: ceTimeValue,
      deltaBand: classifyDeltaBand(s.ce.delta, true),
      premiumMeltScore: ceMelt,
      dynamicDeltaImpact: computeDeltaImpact(spot, s.strike, s.ce.iv, timeToExpiry, true, s.ce.ltp, s.ce.delta),
      gammaProjection: computeGammaProjection(spot, s.strike, s.ce.iv, timeToExpiry, true, s.ce.delta, s.ce.gamma, s.ce.ltp),
      expectedPremiumMove: Math.round(ceExpectedMove * 100) / 100,
      ivState: ceIVState,
      premiumVelocity: computePremiumVelocity(s.ce.ltp, s.ce.ltp, 1, s.ce.volume, s.ce.oi),
    };

    const pe: DynamicLegAnalysis = {
      ltp: s.pe.ltp,
      delta: s.pe.delta,
      gamma: s.pe.gamma,
      theta: s.pe.theta,
      vega: s.pe.vega,
      iv: s.pe.iv,
      oi: s.pe.oi,
      oiChg: s.pe.oiChg,
      volume: s.pe.volume,
      spread: peSpread,
      spreadPct: Math.round(peSpreadPct * 100) / 100,
      intrinsicValue: peIntrinsic,
      timeValue: peTimeValue,
      deltaBand: classifyDeltaBand(s.pe.delta, false),
      premiumMeltScore: peMelt,
      dynamicDeltaImpact: computeDeltaImpact(spot, s.strike, s.pe.iv, timeToExpiry, false, s.pe.ltp, s.pe.delta),
      gammaProjection: computeGammaProjection(spot, s.strike, s.pe.iv, timeToExpiry, false, s.pe.delta, s.pe.gamma, s.pe.ltp),
      expectedPremiumMove: Math.round(peExpectedMove * 100) / 100,
      ivState: peIVState,
      premiumVelocity: computePremiumVelocity(s.pe.ltp, s.pe.ltp, 1, s.pe.volume, s.pe.oi),
    };

    return { strike: s.strike, distanceFromATM, moneyness, ce, pe };
  });

  const buildCandidate = (
    analysis: DynamicStrikeAnalysis,
    type: 'ITM' | 'ATM' | 'OTM',
    optionType: 'CE' | 'PE'
  ): StrikeCandidate => {
    const leg = optionType === 'CE' ? analysis.ce : analysis.pe;
    const capitalRequired = leg.ltp * lotSize;
    const charges = capitalRequired * 0.03;
    const slippage = capitalRequired * 0.01;
    const maxLoss = capitalRequired + charges + slippage;
    const breakevenMove = leg.ltp + charges / lotSize + slippage / lotSize;
    const edgeScore = computeOptionsEdgeScore(
      leg.delta, leg.gamma, leg.theta, leg.vega, leg.iv,
      leg.premiumMeltScore.score, evaluateHeroZero(analysis.strike, spot, optionType, leg.delta, leg.gamma, leg.iv, leg.volume, leg.oi, leg.oiChg, leg.ltp, leg.ltp, leg.ltp, vix, trend, expiryMode),
      trend === 'neutral' ? 20 : ((optionType === 'CE' && trend === 'bullish') || (optionType === 'PE' && trend === 'bearish')) ? 80 : 10,
      leg.volume, leg.oi, leg.spread, expectedMove, leg.ltp, daysToExpiry, leg.ivState.state
    );

    return {
      strike: analysis.strike,
      type,
      optionType,
      premium: leg.ltp,
      delta: leg.delta,
      gamma: leg.gamma,
      theta: leg.theta,
      vega: leg.vega,
      iv: leg.iv,
      meltRisk: leg.premiumMeltScore.level,
      expectedMove: leg.expectedPremiumMove,
      spread: leg.spread,
      capitalRequired,
      maxLoss,
      breakevenMove,
      edgeScore,
      rank: edgeScore,
    };
  };

  const findStrikeByType = (type: 'ITM' | 'ATM' | 'OTM', optType: 'CE' | 'PE'): StrikeCandidate | null => {
    const candidates = strikeAnalyses.filter(a => a.moneyness === type || (type === 'ATM' && a.strike === currentATM));
    if (candidates.length === 0) return null;
    const target = candidates[0];
    return buildCandidate(target, type, optType);
  };

  const atmCandidate = findStrikeByType('ATM', 'CE');
  const itmCandidate = findStrikeByType('ITM', 'CE');
  const otmCandidate = findStrikeByType('OTM', 'CE');

  const strikeComparison: StrikeComparison = {
    itm: itmCandidate || atmCandidate || { strike: currentATM - 100, type: 'ITM', optionType: 'CE', premium: 0, delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0, meltRisk: 'LOW', expectedMove: 0, spread: 0, capitalRequired: 0, maxLoss: 0, breakevenMove: 0, edgeScore: 0, rank: 0 },
    atm: atmCandidate || { strike: currentATM, type: 'ATM', optionType: 'CE', premium: 0, delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0, meltRisk: 'LOW', expectedMove: 0, spread: 0, capitalRequired: 0, maxLoss: 0, breakevenMove: 0, edgeScore: 0, rank: 0 },
    otm: otmCandidate || { strike: currentATM + 100, type: 'OTM', optionType: 'CE', premium: 0, delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0, meltRisk: 'LOW', expectedMove: 0, spread: 0, capitalRequired: 0, maxLoss: 0, breakevenMove: 0, edgeScore: 0, rank: 0 },
  };

  const directionResult = evaluateDirection(strikes, spot, currentATM, vix, pcr, vix / 100, trend, timeToExpiry);

  // ── V2: Enforce directional consistency ──
  directionResult.recommendedDirection = enforceDirectionalConsistency(
    trend, directionResult.recommendedDirection, pcr, spot, atmStrike
  );

  const heroZeroAnalysis = otmCandidate
    ? evaluateHeroZero(otmCandidate.strike, spot, 'CE', otmCandidate.delta, otmCandidate.gamma, otmCandidate.iv, otmCandidate.premium, otmCandidate.premium, 0, otmCandidate.premium, otmCandidate.premium, otmCandidate.premium, vix, trend, expiryMode)
    : { qualifies: false, reasons: [], rejectionReasons: ['No OTM candidate'], momentumStrength: 0, gammaStrength: 0, deltaAdequacy: false, volumeConfirmation: false, oiConfirmation: false, ivConfirmation: false, liquidityOk: false, spreadOk: false };

  const straddleAnalysis = analyzeStraddleStrangle(symbol, spot, strikes, currentATM, expectedMove, lotSize, vix);

  let bestStrike = currentATM;
  let bestEdge = 0;
  let bestType: 'CE' | 'PE' = 'CE';
  let bestStrikeType: 'ITM' | 'ATM' | 'OTM' = 'ATM';

  const allCandidates: StrikeCandidate[] = [];
  for (const a of strikeAnalyses) {
    allCandidates.push(buildCandidate(a, a.moneyness === 'ATM' ? 'ATM' : a.moneyness.includes('ITM') ? 'ITM' : 'OTM', 'CE'));
    allCandidates.push(buildCandidate(a, a.moneyness === 'ATM' ? 'ATM' : a.moneyness.includes('ITM') ? 'ITM' : 'OTM', 'PE'));
  }

  // ── V2: Filter candidates by direction and quality gates ──
  const directionFiltered = allCandidates.filter(c => {
    if (directionResult.recommendedDirection === 'CE') return c.optionType === 'CE';
    if (directionResult.recommendedDirection === 'PE') return c.optionType === 'PE';
    return true;
  });

  for (const c of directionFiltered) {
    if (c.edgeScore > bestEdge) {
      bestEdge = c.edgeScore;
      bestStrike = c.strike;
      bestType = c.optionType;
      bestStrikeType = c.type;
    }
  }

  const bestLeg = allCandidates.find(c => c.strike === bestStrike && c.optionType === bestType);

  // ── V2: Apply quality gates ──
  const qualityResult = bestLeg
    ? passesQualityGates(bestLeg, trend, expiryMode, marketOpen)
    : { passes: false, reasons: ['No candidate found'] };

  // ── V2: Fixed action decision — NO fallback to bestType when NO_TRADE ──
  let action: TradeDecision['action'] = 'NO_TRADE';
  const actionReasons: string[] = [];

  if (!dataValidation.valid) {
    action = 'NO_TRADE';
    actionReasons.push(...dataValidation.errors);
  } else if (!qualityResult.passes) {
    action = 'NO_TRADE';
    actionReasons.push(...qualityResult.reasons);
  } else if (bestEdge < 40) {
    action = 'NO_TRADE';
    actionReasons.push(`Edge too low: ${bestEdge}/100`);
  } else if (directionResult.recommendedDirection === 'BOTH') {
    action = 'BUY_BOTH';
  } else if (directionResult.recommendedDirection === 'CE') {
    action = 'BUY_CE';
  } else if (directionResult.recommendedDirection === 'PE') {
    action = 'BUY_PE';
  } else {
    action = 'NO_TRADE';
    actionReasons.push('No clear directional signal');
  }

  const reasoning: string[] = [];
  if (!marketOpen) reasoning.push('Market closed — signal blocked');
  if (expiryMode) reasoning.push('Expiry day mode active');
  if (!dataValidation.valid) reasoning.push(...dataValidation.errors);
  if (!qualityResult.passes) reasoning.push(...qualityResult.reasons);
  if (trend !== 'neutral') reasoning.push(`Market trend: ${trend}`);
  if (directionResult.recommendedDirection !== 'NO_TRADE') reasoning.push(`Direction: ${directionResult.recommendedDirection}`);
  reasoning.push(`Best edge: ${bestEdge}/100 at ${bestStrike} ${bestType}`);
  if (heroZeroAnalysis.qualifies) reasoning.push('Hero-Zero qualifies');
  reasoning.push(...directionResult.reasoning);
  if (actionReasons.length > 0) reasoning.push(`Block reasons: ${actionReasons.join('; ')}`);

  const premiumMeltAlert = detectPremiumMeltAlert(
    bestLeg ? bestLeg.theta : 0,
    bestLeg ? bestLeg.iv : 0,
    bestLeg ? (bestLeg as any).ivState?.state || 'STABLE' : 'STABLE',
    bestLeg ? computePremiumVelocity(bestLeg.premium, bestLeg.premium, 1, 0, 0) : { velocity: 0, acceleration: 0, classification: 'NONE' as const, expectedDirection: 'STABLE' as const },
    expectedMove,
    spotMovement24h
  );

  const gammaAlert = detectGammaAlert(strikes, currentATM, expiryMode, spot);

  const finalEntry = bestLeg ? bestLeg.premium : 0;
  const finalSL = bestLeg ? finalEntry * 0.5 : 0;
  const finalTP1 = bestLeg ? finalEntry * 1.5 : 0;
  const finalTP2 = bestLeg ? finalEntry * 2.0 : 0;
  const finalTP3 = bestLeg ? finalEntry * 3.0 : 0;

  const tradeDecision: TradeDecision = {
    action,
    symbol,
    strike: bestStrike,
    strikeType: bestStrikeType,
    optionType: bestType,
    entry: Math.round(finalEntry * 100) / 100,
    stopLoss: Math.round(finalSL * 100) / 100,
    target1: Math.round(finalTP1 * 100) / 100,
    target2: Math.round(finalTP2 * 100) / 100,
    target3: Math.round(finalTP3 * 100) / 100,
    delta: bestLeg ? bestLeg.delta : 0,
    gamma: bestLeg ? bestLeg.gamma : 0,
    theta: bestLeg ? bestLeg.theta : 0,
    vega: bestLeg ? bestLeg.vega : 0,
    iv: bestLeg ? bestLeg.iv : 0,
    premiumMelt: bestLeg ? (bestLeg as any).meltRisk || 'LOW' : 'LOW',
    expectedPremiumMove: bestLeg ? bestLeg.expectedMove : 0,
    expectedUnderlyingMove: Math.round(expectedMove * 100) / 100,
    riskReward: finalTP1 > 0 && finalSL > 0 ? Math.round((finalTP1 / finalSL) * 100) / 100 : 0,
    maxLoss: bestLeg ? bestLeg.maxLoss : 0,
    capitalRequired: bestLeg ? bestLeg.capitalRequired : 0,
    optionsEdgeScore: bestEdge,
    expiryMode,
    reasoning,
    strikeComparison,
    heroZero: heroZeroAnalysis,
    straddleAnalysis,
  };

  return {
    symbol,
    spot,
    expiryMode,
    strikeAnalyses,
    strikeComparison,
    directionResult,
    heroZero: heroZeroAnalysis,
    straddleAnalysis,
    tradeDecision,
    premiumMeltAlert,
    gammaAlert,
    timestamp: new Date().toISOString(),
  };
}
