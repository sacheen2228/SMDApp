// Enhanced Seller Stop-Loss Engine
// Multi-signal weighted scoring to identify seller stop-loss levels.
// Never single-metric — every level is scored across 6 independent signals.

import type {
  SDMOptionStrike,
  GEXResult,
  MarketStructure,
  VolumeAnalysis,
  OIAnalysis,
  SellerSLLevel,
  SellerSLResult,
} from '@/types/sdm';

// ─── Scoring Weights ──────────────────────────────────────────────

const WEIGHTS = {
  oiConcentration: 0.25,
  oiVelocity: 0.20,
  gexAlignment: 0.20,
  ivSkew: 0.15,
  structureConfirmation: 0.10,
  volumeConfirmation: 0.10,
} as const;

// ─── Internal: Candidate Level ────────────────────────────────────

interface CandidateLevel {
  strike: number;
  sources: string[];
}

// ─── Step 1: Gather Candidate Levels ──────────────────────────────

function gatherCandidateLevels(
  optionChain: SDMOptionStrike[],
  spot: number,
  gexResult: GEXResult,
  marketStructure: MarketStructure,
  oiAnalysis: OIAnalysis
): CandidateLevel[] {
  const candidateMap = new Map<number, string[]>();

  const addCandidate = (strike: number, source: string) => {
    const existing = candidateMap.get(strike);
    if (existing) {
      existing.push(source);
    } else {
      candidateMap.set(strike, [source]);
    }
  };

  // 1. Gamma walls from GEX engine
  for (const wall of gexResult.gammaWalls) {
    addCandidate(wall.strike, 'Gamma Wall (GEX)');
  }

  // 2. OI concentration peaks: top 3 CE OI above spot, top 3 PE OI below spot
  const ceAboveSpot = optionChain
    .filter((s) => s.strike > spot && s.ce)
    .sort((a, b) => (b.ce?.oi ?? 0) - (a.ce?.oi ?? 0))
    .slice(0, 3);

  for (const strike of ceAboveSpot) {
    const oi = strike.ce?.oi ?? 0;
    addCandidate(strike.strike, `OI concentration ${oi} lots`);
  }

  const peBelowSpot = optionChain
    .filter((s) => s.strike < spot && s.pe)
    .sort((a, b) => (b.pe?.oi ?? 0) - (a.pe?.oi ?? 0))
    .slice(0, 3);

  for (const strike of peBelowSpot) {
    const oi = strike.pe?.oi ?? 0;
    addCandidate(strike.strike, `OI concentration ${oi} lots`);
  }

  // 3. Fresh writing levels from OI analysis
  for (const fw of oiAnalysis.freshWriting) {
    if (fw.side === 'CE') {
      addCandidate(fw.strike, 'Fresh call writing');
    } else {
      addCandidate(fw.strike, 'Fresh put writing');
    }
  }

  // 4. Structure support/resistance levels
  for (const level of marketStructure.resistanceLevels) {
    addCandidate(level, 'Structure resistance');
  }
  for (const level of marketStructure.supportLevels) {
    addCandidate(level, 'Structure support');
  }

  // Convert map to array, dedup sources per strike
  const candidates: CandidateLevel[] = [];
  candidateMap.forEach((sources, strike) => {
    candidates.push({ strike, sources: Array.from(new Set(sources)) });
  });

  return candidates;
}

// ─── Step 2: Score Each Candidate ─────────────────────────────────

function scoreOIConcentration(
  strike: number,
  spot: number,
  optionChain: SDMOptionStrike[],
  maxOI: number
): number {
  const match = optionChain.find((s) => s.strike === strike);
  if (!match) return 0;

  if (strike > spot) {
    // Call writer SL — score based on CE OI
    const oi = match.ce?.oi ?? 0;
    return maxOI > 0 ? Math.min(100, (oi / maxOI) * 100) : 0;
  } else {
    // Put writer SL — score based on PE OI
    const oi = match.pe?.oi ?? 0;
    return maxOI > 0 ? Math.min(100, (oi / maxOI) * 100) : 0;
  }
}

function scoreOIVelocity(
  strike: number,
  spot: number,
  oiAnalysis: OIAnalysis
): number {
  const fw = oiAnalysis.freshWriting.find((w) => w.strike === strike);
  if (!fw) return 0;

  // Higher percent change = stronger fresh writing = higher score
  const pctChange = fw.oiPercentChange;
  if (pctChange > 50) return 100;
  if (pctChange > 35) return 80;
  if (pctChange > 20) return 60;
  return 40;
}

function scoreGEXAlignment(
  strike: number,
  spot: number,
  gexResult: GEXResult
): number {
  // Check if this strike is a gamma wall
  const wall = gexResult.gammaWalls.find((w) => w.strike === strike);
  if (wall) {
    // Proportional to GEX magnitude among all walls
    const maxGEX = Math.max(...gexResult.gammaWalls.map((w) => w.gex), 1);
    return Math.min(100, (wall.gex / maxGEX) * 100);
  }

  // Check if strike is in the GEX profile with significant gamma
  const gexStrike = gexResult.gexProfile.find((g) => g.strike === strike);
  if (gexStrike) {
    const absNet = Math.abs(gexStrike.netGEX);
    const maxProfileGEX = Math.max(
      ...gexResult.gexProfile.map((g) => Math.abs(g.netGEX)),
      1
    );
    return Math.min(80, (absNet / maxProfileGEX) * 80);
  }

  return 0;
}

function scoreIVSkew(
  strike: number,
  spot: number,
  optionChain: SDMOptionStrike[]
): number {
  const match = optionChain.find((s) => s.strike === strike);
  if (!match) return 0;

  const ceIV = match.ce?.iv ?? 0;
  const peIV = match.pe?.iv ?? 0;

  if (ceIV === 0 && peIV === 0) return 0;

  // Higher IV = more stress = stronger wall
  const relevantIV = strike > spot ? ceIV : peIV;
  // Scale: IV 15-25 is normal range, >25 is high stress
  if (relevantIV > 30) return 100;
  if (relevantIV > 25) return 80;
  if (relevantIV > 20) return 60;
  if (relevantIV > 15) return 40;
  return 20;
}

function scoreStructureConfirmation(
  strike: number,
  spot: number,
  marketStructure: MarketStructure
): number {
  // Check resistance levels (for strikes above spot)
  if (strike > spot) {
    const isResistance = marketStructure.resistanceLevels.some(
      (r) => Math.abs(r - strike) < 50
    );
    if (isResistance) return 100;

    // Partial credit for proximity to a structure level
    const closestResistance = marketStructure.resistanceLevels.reduce(
      (best, r) => {
        const dist = Math.abs(r - strike);
        return dist < Math.abs(best - strike) ? r : best;
      },
      marketStructure.resistanceLevels[0] ?? strike
    );
    if (Math.abs(closestResistance - strike) < 100) return 50;
  }

  // Check support levels (for strikes below spot)
  if (strike < spot) {
    const isSupport = marketStructure.supportLevels.some(
      (s) => Math.abs(s - strike) < 50
    );
    if (isSupport) return 100;

    const closestSupport = marketStructure.supportLevels.reduce(
      (best, s) => {
        const dist = Math.abs(s - strike);
        return dist < Math.abs(best - strike) ? s : best;
      },
      marketStructure.supportLevels[0] ?? strike
    );
    if (Math.abs(closestSupport - strike) < 100) return 50;
  }

  return 0;
}

function scoreVolumeConfirmation(
  strike: number,
  spot: number,
  optionChain: SDMOptionStrike[],
  volumeAnalysis: VolumeAnalysis
): number {
  const match = optionChain.find((s) => s.strike === strike);
  if (!match) return 0;

  let score = 0;

  // 1. Volume at this strike's options
  const vol = strike > spot ? (match.ce?.volume ?? 0) : (match.pe?.volume ?? 0);
  if (vol > 0 && volumeAnalysis.avgVolume > 0) {
    const volRatio = vol / volumeAnalysis.avgVolume;
    if (volRatio > 2) score += 50;
    else if (volRatio > 1.5) score += 40;
    else if (volRatio > 1) score += 30;
  }

  // 2. Proximity to volume profile POC or VAH/VAL
  if (volumeAnalysis.poc > 0) {
    const distToPOC = Math.abs(strike - volumeAnalysis.poc);
    const range = volumeAnalysis.vah - volumeAnalysis.val || 1;
    const normalizedDist = distToPOC / range;
    if (normalizedDist < 0.1) score += 50;
    else if (normalizedDist < 0.3) score += 30;
  }

  return Math.min(100, score);
}

function computeCompositeScore(
  strike: number,
  spot: number,
  optionChain: SDMOptionStrike[],
  gexResult: GEXResult,
  marketStructure: MarketStructure,
  volumeAnalysis: VolumeAnalysis,
  oiAnalysis: OIAnalysis,
  maxOI: number
): { score: number; factors: string[] } {
  const factors: string[] = [];

  // OI concentration score
  const oiScore = scoreOIConcentration(strike, spot, optionChain, maxOI);
  if (oiScore > 0) {
    factors.push(`OI weight ${oiScore.toFixed(0)}`);
  }

  // OI velocity score
  const velocityScore = scoreOIVelocity(strike, spot, oiAnalysis);
  if (velocityScore > 0) {
    factors.push(`OI velocity ${velocityScore.toFixed(0)}`);
  }

  // GEX alignment score
  const gexScore = scoreGEXAlignment(strike, spot, gexResult);
  if (gexScore > 0) {
    const wall = gexResult.gammaWalls.find((w) => w.strike === strike);
    if (wall) {
      factors.push(`Gamma Wall (${wall.type})`);
    } else {
      factors.push(`GEX alignment ${gexScore.toFixed(0)}`);
    }
  }

  // IV skew score
  const ivScore = scoreIVSkew(strike, spot, optionChain);
  if (ivScore > 0) {
    const match = optionChain.find((s) => s.strike === strike);
    const iv = strike > spot ? (match?.ce?.iv ?? 0) : (match?.pe?.iv ?? 0);
    factors.push(`IV ${iv.toFixed(1)}pts`);
  }

  // Structure confirmation score
  const structScore = scoreStructureConfirmation(strike, spot, marketStructure);
  if (structScore > 0) {
    const label = strike > spot ? 'Structure resistance' : 'Structure support';
    factors.push(label);
  }

  // Volume confirmation score
  const volScore = scoreVolumeConfirmation(
    strike, spot, optionChain, volumeAnalysis
  );
  if (volScore > 0) {
    factors.push(`Volume confirm ${volScore.toFixed(0)}`);
  }

  const compositeScore =
    WEIGHTS.oiConcentration * oiScore +
    WEIGHTS.oiVelocity * velocityScore +
    WEIGHTS.gexAlignment * gexScore +
    WEIGHTS.ivSkew * ivScore +
    WEIGHTS.structureConfirmation * structScore +
    WEIGHTS.volumeConfirmation * volScore;

  return { score: Math.round(compositeScore * 100) / 100, factors };
}

// ─── Step 3: Classify Level ───────────────────────────────────────

function classifyLevel(
  strike: number,
  spot: number,
  gexResult: GEXResult
): 'CALL_WRITER_SL' | 'PUT_WRITER_SL' {
  // Strike above spot → call writers are under pressure when spot approaches
  if (strike > spot) return 'CALL_WRITER_SL';
  // Strike below spot → put writers are under pressure when spot approaches
  if (strike < spot) return 'PUT_WRITER_SL';

  // At spot — use gamma wall type or default to nearest side
  const wall = gexResult.gammaWalls.find((w) => w.strike === strike);
  if (wall) {
    return wall.type === 'CE' ? 'CALL_WRITER_SL' : 'PUT_WRITER_SL';
  }

  // Fallback: use GEX sign at this strike
  const gexStrike = gexResult.gexProfile.find((g) => g.strike === strike);
  if (gexStrike) {
    return gexStrike.callGEX > Math.abs(gexStrike.putGEX)
      ? 'CALL_WRITER_SL'
      : 'PUT_WRITER_SL';
  }

  return strike >= spot ? 'CALL_WRITER_SL' : 'PUT_WRITER_SL';
}

// ─── Step 4: Stop-Hunt Zone Detection ─────────────────────────────
// A level is a stop-hunt zone if:
//   - Price wick went >0.5% beyond the level
//   - But close was within 0.2% of the level

function detectStopHuntZone(
  strike: number,
  spot: number,
  optionChain: SDMOptionStrike[]
): boolean {
  // We use the strike's LTP as a proxy for recent price action.
  // If LTP exceeds the strike but close is near the strike, it's a stop-hunt pattern.
  // In practice, this would use candle data; here we infer from option pricing.
  //
  // For a CALL_WRITER_SL at strike K:
  //   If CE LTP shows price briefly pushed above K (high IV, high delta) but
  //   oi didn't confirm, it's a stop-hunt.
  // For a PUT_WRITER_SL at strike K:
  //   If PE LTP shows price briefly dipped below K but oi didn't confirm.

  const match = optionChain.find((s) => s.strike === strike);
  if (!match) return false;

  // Heuristic: if bid-ask spread is wide relative to LTP, it suggests
  // volatile wicking. We use (ask - bid) / mid as a proxy.
  if (strike > spot && match.ce) {
    const mid = match.ce.ltp;
    const bid = match.ce.bid ?? mid;
    const ask = match.ce.ask ?? mid;
    if (mid > 0) {
      const spreadPct = ((ask - bid) / mid) * 100;
      // Wide spread with low OI change suggests stop-hunt wicking
      if (spreadPct > 1.5 && Math.abs(match.ce.oiChg) < match.ce.oi * 0.05) {
        return true;
      }
    }
  }

  if (strike < spot && match.pe) {
    const mid = match.pe.ltp;
    const bid = match.pe.bid ?? mid;
    const ask = match.pe.ask ?? mid;
    if (mid > 0) {
      const spreadPct = ((ask - bid) / mid) * 100;
      if (spreadPct > 1.5 && Math.abs(match.pe.oiChg) < match.pe.oi * 0.05) {
        return true;
      }
    }
  }

  return false;
}

// ─── Step 5: Determine Active Status ──────────────────────────────

function determineStatus(
  strike: number,
  spot: number,
  optionChain: SDMOptionStrike[],
  marketStructure: MarketStructure
): 'ACTIVE' | 'INACTIVE' {
  const match = optionChain.find((s) => s.strike === strike);
  if (!match) return 'INACTIVE';

  // For CALL_WRITER_SL above spot: active if spot is moving toward it (uptrend or ranging)
  // For PUT_WRITER_SL below spot: active if spot is moving toward it (downtrend or ranging)
  const dist = Math.abs(strike - spot);

  // If too far away (>5% of spot), consider inactive
  if (spot > 0 && dist / spot > 0.05) return 'INACTIVE';

  // If market structure is trending toward the level, it's active
  if (strike > spot) {
    // Call writer SL above spot
    if (marketStructure.trend === 'UPTREND') return 'ACTIVE';
    if (marketStructure.trend === 'RANGING') return 'ACTIVE';
    // Downtrend but price bouncing off support → still relevant
    if (marketStructure.trend === 'DOWNTREND') {
      const hasSupport = marketStructure.supportLevels.some(
        (s) => Math.abs(s - spot) < dist * 0.5
      );
      return hasSupport ? 'ACTIVE' : 'INACTIVE';
    }
  }

  if (strike < spot) {
    // Put writer SL below spot
    if (marketStructure.trend === 'DOWNTREND') return 'ACTIVE';
    if (marketStructure.trend === 'RANGING') return 'ACTIVE';
    if (marketStructure.trend === 'UPTREND') {
      const hasResistance = marketStructure.resistanceLevels.some(
        (r) => Math.abs(r - spot) < dist * 0.5
      );
      return hasResistance ? 'ACTIVE' : 'INACTIVE';
    }
  }

  // At spot
  return 'ACTIVE';
}

// ─── Main Entry Point ─────────────────────────────────────────────

export function findSellerSLLevels(
  optionChain: SDMOptionStrike[],
  spot: number,
  gexResult: GEXResult,
  marketStructure: MarketStructure,
  volumeAnalysis: VolumeAnalysis,
  oiAnalysis: OIAnalysis
): SellerSLResult {
  // Gather candidate levels from all sources
  const candidates = gatherCandidateLevels(
    optionChain, spot, gexResult, marketStructure, oiAnalysis
  );

  // Find max OI across all strikes for normalization
  let maxOI = 0;
  for (const strike of optionChain) {
    if (strike.ce && strike.ce.oi > maxOI) maxOI = strike.ce.oi;
    if (strike.pe && strike.pe.oi > maxOI) maxOI = strike.pe.oi;
  }

  // Score each candidate and build final levels
  const levels: SellerSLLevel[] = [];

  for (const candidate of candidates) {
    const { score, factors } = computeCompositeScore(
      candidate.strike,
      spot,
      optionChain,
      gexResult,
      marketStructure,
      volumeAnalysis,
      oiAnalysis,
      maxOI
    );

    // Merge source-based factors with scored factors
    const contributingFactors = [...new Set([...candidate.sources, ...factors])];

    const type = classifyLevel(candidate.strike, spot, gexResult);
    const stopHuntZone = detectStopHuntZone(candidate.strike, spot, optionChain);
    const status = determineStatus(
      candidate.strike, spot, optionChain, marketStructure
    );
    const distanceFromSpot = Math.abs(candidate.strike - spot);

    levels.push({
      level: candidate.strike,
      type,
      score,
      status,
      contributingFactors,
      stopHuntZone,
      distanceFromSpot,
    });
  }

  // Sort by distance from spot (nearest first)
  levels.sort((a, b) => a.distanceFromSpot - b.distanceFromSpot);

  // Find nearest CE and PE SL
  let nearestCESL: SellerSLLevel | null = null;
  let nearestPESL: SellerSLLevel | null = null;

  for (const level of levels) {
    if (level.type === 'CALL_WRITER_SL' && !nearestCESL) {
      nearestCESL = level;
    }
    if (level.type === 'PUT_WRITER_SL' && !nearestPESL) {
      nearestPESL = level;
    }
    if (nearestCESL && nearestPESL) break;
  }

  // Determine overall status
  const validLevels = levels.filter((l) => l.status === 'ACTIVE');
  const overallStatus: 'OK' | 'DEGRADED' = validLevels.length >= 3 ? 'OK' : 'DEGRADED';

  return {
    levels,
    nearestCESL,
    nearestPESL,
    status: overallStatus,
  };
}
