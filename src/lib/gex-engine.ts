/**
 * Gamma Exposure (GEX) Engine
 * Computes per-strike GEX to identify dealer positioning and structural levels.
 *
 * UNITS AND FORMULAS (all values are in raw, unscaled units):
 *
 * Per-strike GEX (computeStrikeGEX):
 *   spotSquared = spot × spot                                    (index points²)
 *   callGEX   = callGamma × callOI × spotSquared × 0.01         (index points × contracts × 0.01)
 *   putGEX    = -(putGamma × putOI × spotSquared × 0.01)        (negative = put side)
 *   netGEX    = callGEX + putGEX
 *
 * Notes:
 *   - Gamma is per 1-point index move per contract (standard exchange gamma).
 *   - OI is number of open contracts.
 *   - spotSquared converts gamma (per index point) to rupee exposure per contract.
 *   - The ×0.01 factor converts gamma from "per 100 index points" to "per 1 index point".
 *   - Put GEX is negated because put gamma exposure has opposite sign to call gamma.
 *   - DEX (Delta Exposure) is computed separately in seller-intelligence.ts:
 *       contracts = OI × lotSize
 *       deltaExposure = contracts × delta × spotPrice   (₹ rupees)
 *
 * Gamma Flip (findGammaFlip):
 *   Cumulative netGEX across strikes sorted ascending. The flip is the strike
 *   where cumulative netGEX crosses from negative to positive (or vice versa),
 *   linearly interpolated between adjacent strikes.
 *
 * Dealer Regime (calculateGEX):
 *   spot > gammaFlip  → LONG_GAMMA   (dealers are net long gamma)
 *   spot <= gammaFlip → SHORT_GAMMA  (dealers are net short gamma)
 *
 * Dealer Bias (calculateGEX):
 *   Nearest gamma wall within 3% of spot determines bias:
 *     CE wall closer → dealers hedge upside → SELL rallies → BEARISH
 *     PE wall closer → dealers hedge downside → BUY dips  → BULLISH
 *   If no wall within threshold, falls back to totalGEX sign:
 *     totalGEX > 0 → BULLISH (dealers provide liquidity)
 *     totalGEX < 0 → BEARISH (dealers remove liquidity)
 *
 * UNVERIFIED: The exact rupee magnitude of DEX/GEX depends on lot sizes,
 * gamma values from Black-Scholes, and whether OI is in contracts or lots.
 * These values have NOT been independently reconciled against exchange
 * published figures. Treat as indicative only.
 */
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

  // Derive dealer bias from gamma wall proximity (institutional method):
  // The nearest gamma wall reveals where dealer hedging pressure concentrates.
  // CE wall closer → dealers hedge upside risk → they SELL rallies → bearish
  // PE wall closer → dealers hedge downside risk → they BUY dips → bullish
  if (gammaWalls.length >= 2) {
    const ceDist = Math.min(
      ...gammaWalls.filter(w => w.type === 'CE').map(w => Math.abs(w.strike - spot)),
      Infinity
    );
    const peDist = Math.min(
      ...gammaWalls.filter(w => w.type === 'PE').map(w => Math.abs(w.strike - spot)),
      Infinity
    );
    const threshold = spot * 0.03; // within 3% of spot
    if (ceDist < peDist && ceDist < threshold) {
      dealerBias = 'BEARISH';
    } else if (peDist < ceDist && peDist < threshold) {
      dealerBias = 'BULLISH';
    }
  }

  // When no clear dealer bias from walls, use regime-level heuristic
  if (dealerBias === 'NEUTRAL') {
    if (totalGEX > 0) {
      dealerBias = 'BULLISH';  // Long gamma = dealers provide liquidity
    } else if (totalGEX < 0) {
      dealerBias = 'BEARISH';  // Short gamma = dealers remove liquidity
    }
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
