// Gamma Blast Engine
// Specialized module for detecting gamma squeeze conditions
// Estimates dealer positioning and momentum acceleration

import type { SDMOptionStrike, GammaBlastSignals } from '@/types/sdm';

export interface GammaBlastResult {
  detected: boolean;
  confidence: number;
  signals: GammaBlastSignals;
  estimatedGEX: number;
  gammaWallStrike: number;
  gammaWallType: 'CE' | 'PE';
  dealerBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  squeezePotential: number;  // 0-100
  reasons: string[];
  warnings: string[];
}

// ─── Detect Gamma Blast Conditions ──────────────────────────────
export function detectGammaBlast(
  optionChain: SDMOptionStrike[],
  spot: number,
  vix: number,
  recentCandles?: { open: number; high: number; low: number; close: number; volume: number }[]
): GammaBlastResult {
  const result: GammaBlastResult = {
    detected: false,
    confidence: 0,
    signals: {
      lowVix: false,
      flatThenBreakout: false,
      volumeSpike: false,
      ivSpike: false,
      extremePCR: false,
    },
    estimatedGEX: 0,
    gammaWallStrike: 0,
    gammaWallType: 'CE',
    dealerBias: 'NEUTRAL',
    squeezePotential: 0,
    reasons: [],
    warnings: [],
  };

  // 1. Low VIX check (gamma squeeze more likely with low VIX)
  result.signals.lowVix = vix < 12;
  if (result.signals.lowVix) {
    result.reasons.push(`Low VIX (${vix.toFixed(1)}) — dealers less hedged`);
  }

  // 2. Volume spike detection
  if (recentCandles && recentCandles.length >= 5) {
    const recentVolumes = recentCandles.slice(-5).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const latestVolume = recentCandles[recentCandles.length - 1].volume;
    result.signals.volumeSpike = latestVolume > avgVolume * 2;
    if (result.signals.volumeSpike) {
      result.reasons.push(`Volume spike: ${(latestVolume / avgVolume).toFixed(1)}x average`);
    }

    // 3. Flat then breakout detection
    const last5 = recentCandles.slice(-5);
    const range = Math.max(...last5.map(c => c.high)) - Math.min(...last5.map(c => c.low));
    const avgPrice = last5.reduce((a, c) => a + c.close, 0) / 5;
    const flatness = range / avgPrice;
    const latestCandle = recentCandles[recentCandles.length - 1];
    const prevCandle = recentCandles[recentCandles.length - 2];
    result.signals.flatThenBreakout = flatness < 0.005 && 
      Math.abs(latestCandle.close - prevCandle.close) > range * 0.5;
    if (result.signals.flatThenBreakout) {
      result.reasons.push('Flat consolidation followed by breakout');
    }
  }

  // 4. Extreme PCR (put-heavy = dealers short puts = bullish gamma)
  let totalCEOI = 0;
  let totalPEOI = 0;
  for (const s of optionChain) {
    totalCEOI += s.ce?.oi || 0;
    totalPEOI += s.pe?.oi || 0;
  }
  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : 1;
  result.signals.extremePCR = pcr > 1.5 || pcr < 0.5;
  if (result.signals.extremePCR) {
    result.reasons.push(`Extreme PCR (${pcr.toFixed(2)}) — asymmetric positioning`);
  }

  // 5. IV spike detection (compare ATM IV to average)
  const atmStrike = optionChain.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
  if (atmStrike) {
    const avgIV = optionChain.reduce((sum, s) => sum + (s.ce?.iv || 0) + (s.pe?.iv || 0), 0) / 
      (optionChain.length * 2 || 1);
    const atmIV = ((atmStrike.ce?.iv || 0) + (atmStrike.pe?.iv || 0)) / 2;
    result.signals.ivSpike = atmIV > avgIV * 1.3;
    if (result.signals.ivSpike) {
      result.reasons.push(`ATM IV (${atmIV.toFixed(1)}%) elevated vs avg (${avgIV.toFixed(1)}%)`);
    }
  }

  // Estimate GEX (Gamma Exposure)
  let totalGEX = 0;
  let maxGEXStrike = 0;
  let maxGEX = 0;
  for (const s of optionChain) {
    const callGEX = (s.ce?.gamma || 0) * (s.ce?.oi || 0) * spot * 0.01;
    const putGEX = (s.pe?.gamma || 0) * (s.pe?.oi || 0) * spot * 0.01;
    const netGEX = callGEX - putGEX;
    totalGEX += netGEX;
    if (Math.abs(netGEX) > Math.abs(maxGEX)) {
      maxGEX = netGEX;
      maxGEXStrike = s.strike;
    }
  }
  result.estimatedGEX = totalGEX;
  result.gammaWallStrike = maxGEXStrike;
  result.gammaWallType = maxGEX > 0 ? 'CE' : 'PE';
  result.dealerBias = totalGEX > 0 ? 'BULLISH' : totalGEX < 0 ? 'BEARISH' : 'NEUTRAL';

  // Calculate squeeze potential
  let signalCount = 0;
  if (result.signals.lowVix) signalCount++;
  if (result.signals.flatThenBreakout) signalCount++;
  if (result.signals.volumeSpike) signalCount++;
  if (result.signals.ivSpike) signalCount++;
  if (result.signals.extremePCR) signalCount++;

  result.squeezePotential = Math.min(100, signalCount * 25);
  result.confidence = Math.min(90, signalCount * 18 + 10);

  // Final detection
  result.detected = signalCount >= 3; // Need at least 3 signals

  if (result.detected) {
    result.reasons.unshift(`GAMMA BLAST DETECTED: ${signalCount}/5 signals active`);
  }

  // Warnings
  result.warnings.push('Gamma blast estimates are model-based, not confirmed');
  result.warnings.push('Dealer positioning is inferred, not observed');

  return result;
}

// ─── Get Gamma Blast Confidence Boost ────────────────────────────
export function getGammaBlastBoost(result: GammaBlastResult): number {
  if (!result.detected) return 0;
  return Math.min(15, Math.round(result.confidence * 0.2));
}
