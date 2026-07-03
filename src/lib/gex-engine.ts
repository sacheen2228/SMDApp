// Gamma Exposure (GEX) Engine
// Computes per-strike GEX to identify dealer positioning and structural levels

import { SDMOptionStrike, GEXStrike, GammaWall, GEXResult } from '@/types/sdm';

function computeStrikeGEX(strike: SDMOptionStrike, spot: number): GEXStrike | null {
  const callGamma = strike.ce?.gamma ?? null;
  const callOI = strike.ce?.oi ?? null;
  const putGamma = strike.pe?.gamma ?? null;
  const putOI = strike.pe?.oi ?? null;

  if (callGamma === null || callOI === null || putGamma === null || putOI === null) {
    return null;
  }

  const spotSquared = spot * spot;
  const callGEX = callGamma * callOI * spotSquared * 0.01;
  const putGEX = -(putGamma * putOI * spotSquared * 0.01);

  return {
    strike: strike.strike,
    callGEX,
    putGEX,
    netGEX: callGEX + putGEX,
  };
}

export function findGammaFlip(
  optionChain: SDMOptionStrike[],
  spot: number
): number {
  const sorted = [...optionChain].sort((a, b) => a.strike - b.strike);

  let cumulativeGEX = 0;
  let prevStrike: number | null = null;
  let prevCumGEX = 0;

  for (const strike of sorted) {
    const gex = computeStrikeGEX(strike, spot);
    if (!gex) {
      prevStrike = strike.strike;
      continue;
    }

    cumulativeGEX += gex.netGEX;

    if (prevStrike !== null && prevCumGEX < 0 && cumulativeGEX >= 0) {
      return prevStrike + (strike.strike - prevStrike) * (-prevCumGEX / (cumulativeGEX - prevCumGEX || 1));
    }
    if (prevStrike !== null && prevCumGEX > 0 && cumulativeGEX <= 0) {
      return prevStrike + (strike.strike - prevStrike) * (prevCumGEX / (prevCumGEX - cumulativeGEX || 1));
    }

    prevStrike = strike.strike;
    prevCumGEX = cumulativeGEX;
  }

  return spot;
}

export function findGammaWalls(
  optionChain: SDMOptionStrike[],
  spot: number,
  count: number = 3
): GammaWall[] {
  const walls: { strike: number; type: 'CE' | 'PE'; gex: number; oi: number }[] = [];

  for (const strike of optionChain) {
    if (strike.ce?.gamma != null && strike.ce?.oi != null) {
      const spotSquared = spot * spot;
      const gex = strike.ce.gamma * strike.ce.oi * spotSquared * 0.01;
      walls.push({ strike: strike.strike, type: 'CE', gex: Math.abs(gex), oi: strike.ce.oi });
    }
    if (strike.pe?.gamma != null && strike.pe?.oi != null) {
      const spotSquared = spot * spot;
      const gex = strike.pe.gamma * strike.pe.oi * spotSquared * 0.01;
      walls.push({ strike: strike.strike, type: 'PE', gex: Math.abs(gex), oi: strike.pe.oi });
    }
  }

  walls.sort((a, b) => b.gex - a.gex);
  return walls.slice(0, count);
}

export function calculateGEX(
  optionChain: SDMOptionStrike[],
  spot: number
): GEXResult {
  const gexProfile: GEXStrike[] = [];
  let totalGEX = 0;
  let validStrikes = 0;

  for (const strike of optionChain) {
    const gex = computeStrikeGEX(strike, spot);
    if (gex) {
      gexProfile.push(gex);
      totalGEX += gex.netGEX;
      validStrikes++;
    }
  }

  gexProfile.sort((a, b) => a.strike - b.strike);

  const gammaFlip = findGammaFlip(optionChain, spot);
  const gammaWalls = findGammaWalls(optionChain, spot);
  const dealerRegime = spot > gammaFlip ? 'LONG_GAMMA' : 'SHORT_GAMMA';

  let dealerBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (totalGEX > 0) {
    dealerBias = 'BULLISH';
  } else if (totalGEX < 0) {
    dealerBias = 'BEARISH';
  }

  const status = validStrikes >= 3 ? 'OK' : 'DEGRADED';

  return {
    gexProfile,
    totalGEX,
    gammaFlip,
    gammaWalls,
    dealerRegime,
    dealerBias,
    status,
  };
}
