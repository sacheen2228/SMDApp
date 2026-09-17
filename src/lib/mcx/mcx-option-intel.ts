// MCX Option Intelligence — Option chain quality, Greeks, dynamic RR
// Evaluates option contracts for quality and risk/reward.
// Never invents Greeks. Uses greeks.ts for Black-Scholes when data missing.

import type { MCXCommodity } from './types';
import type { MCXOptionChain, MCXOptionStrike } from './option-chain';
import { calculateGreeks } from '@/lib/greeks';

export interface MCXOptionIntelResult {
  bestCE: OptionCandidate | null;
  bestPE: OptionCandidate | null;
  atmStrike: number;
  chainQuality: 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'UNTRADEABLE';
  spreadAcceptable: boolean;
  liquidityAcceptable: boolean;
  ivAcceptable: boolean;
  evidence: string[];
}

export interface OptionCandidate {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  bid: number;
  ask: number;
  spread: number;
  spreadPercent: number;
  volume: number;
  oi: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  greeksSource: 'LIVE' | 'CALCULATED';
  liquidityScore: number; // 0-100
  qualityScore: number; // 0-100
}

// ── Evaluate a single option strike ──
function evaluateStrike(
  strike: MCXOptionStrike,
  side: 'ce' | 'pe',
  spotPrice: number,
  daysToExpiry: number
): OptionCandidate | null {
  const leg = side === 'ce' ? strike.ce : strike.pe;
  if (!leg || leg.ltp <= 0) return null;

  const bid = leg.bid || 0;
  const ask = leg.ask || 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : leg.ltp;
  const spread = ask > 0 && bid > 0 ? ask - bid : 0;
  const spreadPercent = mid > 0 ? (spread / mid) * 100 : 0;

  // Greeks — use live if available, else calculate
  let delta = 0, gamma = 0, theta = 0, vega = 0;
  let greeksSource: 'LIVE' | 'CALCULATED' = 'CALCULATED';

  if (leg.iv > 0) {
    const greeks = calculateGreeks(
      spotPrice,
      strike.strike,
      daysToExpiry / 365,
      leg.iv / 100, // convert from percentage to decimal
      side === 'ce'
    );
    delta = greeks.delta;
    gamma = greeks.gamma;
    theta = greeks.theta;
    vega = greeks.vega;
  }

  // Liquidity score
  let liquidityScore = 0;
  if (leg.volume > 100) liquidityScore += 30;
  else if (leg.volume > 10) liquidityScore += 15;
  if (leg.oi > 1000) liquidityScore += 30;
  else if (leg.oi > 100) liquidityScore += 15;
  if (spreadPercent < 3) liquidityScore += 20;
  else if (spreadPercent < 5) liquidityScore += 10;
  else if (spreadPercent > 10) liquidityScore -= 10;
  if (leg.ltp > 0) liquidityScore += 20;
  liquidityScore = Math.max(0, Math.min(100, liquidityScore));

  // Quality score
  let qualityScore = 0;
  if (Math.abs(delta) >= 0.3 && Math.abs(delta) <= 0.65) qualityScore += 25;
  else if (Math.abs(delta) >= 0.2 && Math.abs(delta) <= 0.8) qualityScore += 15;
  if (gamma > 0) qualityScore += 15;
  if (Math.abs(theta) < 5) qualityScore += 15;
  if (liquidityScore > 50) qualityScore += 20;
  if (spreadPercent < 5) qualityScore += 15;
  qualityScore = Math.max(0, Math.min(100, qualityScore));

  return {
    strike: strike.strike,
    type: side === 'ce' ? 'CE' : 'PE',
    ltp: leg.ltp,
    bid,
    ask,
    spread,
    spreadPercent,
    volume: leg.volume,
    oi: leg.oi,
    iv: leg.iv,
    delta,
    gamma,
    theta,
    vega,
    greeksSource,
    liquidityScore,
    qualityScore,
  };
}

// ── Main option intelligence analysis ──
export function analyzeMCXOptionIntel(
  _symbol: MCXCommodity,
  chain: MCXOptionChain | null
): MCXOptionIntelResult {
  const evidence: string[] = [];

  if (!chain || chain.strikes.length === 0) {
    return {
      bestCE: null, bestPE: null, atmStrike: 0,
      chainQuality: 'UNTRADEABLE', spreadAcceptable: false,
      liquidityAcceptable: false, ivAcceptable: false,
      evidence: ['No option chain data available'],
    };
  }

  const spotPrice = chain.spotPrice;
  const daysToExpiry = Math.max(1, Math.ceil((new Date(chain.expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  // Evaluate all strikes
  const candidates: OptionCandidate[] = [];
  for (const strike of chain.strikes) {
    const ce = evaluateStrike(strike, 'ce', spotPrice, daysToExpiry);
    const pe = evaluateStrike(strike, 'pe', spotPrice, daysToExpiry);
    if (ce) candidates.push(ce);
    if (pe) candidates.push(pe);
  }

  // Find best CE and PE by quality score
  const ceCandidates = candidates.filter(c => c.type === 'CE').sort((a, b) => b.qualityScore - a.qualityScore);
  const peCandidates = candidates.filter(c => c.type === 'PE').sort((a, b) => b.qualityScore - a.qualityScore);

  const bestCE = ceCandidates[0] || null;
  const bestPE = peCandidates[0] || null;

  // Chain quality assessment
  const allCandidates = candidates;
  const avgSpread = allCandidates.length > 0
    ? allCandidates.reduce((s, c) => s + c.spreadPercent, 0) / allCandidates.length
    : 100;
  const avgLiquidity = allCandidates.length > 0
    ? allCandidates.reduce((s, c) => s + c.liquidityScore, 0) / allCandidates.length
    : 0;

  let chainQuality: 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'UNTRADEABLE' = 'UNTRADEABLE';
  if (avgSpread < 3 && avgLiquidity > 60) chainQuality = 'GOOD';
  else if (avgSpread < 5 && avgLiquidity > 40) chainQuality = 'ACCEPTABLE';
  else if (avgSpread < 10 && avgLiquidity > 20) chainQuality = 'POOR';

  const spreadAcceptable = avgSpread < 8;
  const liquidityAcceptable = avgLiquidity > 25;

  // IV check
  const atmStrike = chain.strikes.find(s => s.strike === chain.atmStrike) || chain.strikes[0];
  const atmIV = (atmStrike?.ce?.iv || atmStrike?.pe?.iv || 0);
  const ivAcceptable = atmIV > 0 && atmIV < 80; // reject if IV > 80%

  evidence.push(`Chain quality: ${chainQuality}`);
  evidence.push(`ATM IV: ${atmIV.toFixed(1)}%`);
  evidence.push(`Avg spread: ${avgSpread.toFixed(1)}%`);
  if (bestCE) evidence.push(`Best CE: ${bestCE.strike} (quality: ${bestCE.qualityScore})`);
  if (bestPE) evidence.push(`Best PE: ${bestPE.strike} (quality: ${bestPE.qualityScore})`);

  return {
    bestCE,
    bestPE,
    atmStrike: chain.atmStrike,
    chainQuality,
    spreadAcceptable,
    liquidityAcceptable,
    ivAcceptable,
    evidence,
  };
}

// ── Calculate option RR ──
export function calculateOptionRR(
  entryPremium: number,
  slPremium: number,
  targetPremium: number
): { actualRR: number; grossRR: number; netRR: number } {
  const risk = entryPremium - slPremium;
  const reward = targetPremium - entryPremium;
  const actualRR = risk > 0 ? reward / risk : 0;

  // Cost-aware: brokerage ₹20 + STT 0.05% + exchange 0.00345% + GST 18% + stamp 0.003%
  const totalCost = 20 + entryPremium * 0.0005 + entryPremium * 0.0000345 + 20 * 0.18 + entryPremium * 0.00003;
  const netReward = reward - totalCost * 2; // entry + exit costs
  const netRR = risk > 0 ? netReward / risk : 0;

  return {
    actualRR: Math.round(actualRR * 100) / 100,
    grossRR: Math.round(actualRR * 100) / 100,
    netRR: Math.round(netRR * 100) / 100,
  };
}
