// ─── VolumeAnalyzer — Volume Pattern Detection ────────────────────
// Analyzes call/put volume, detects spikes, institutional activity.

import type { OptionData, VolumeResult } from "./types";
import { VOLUME_CONFIG } from "./config";

/**
 * Analyze option chain volume for institutional activity signals.
 * High volume + OI increase = fresh position.
 * High volume + OI decrease = short covering/unwinding.
 */
export function analyzeVolume(
  chain: OptionData[],
  candles: { volume: number }[]
): VolumeResult {
  let totalCallVolume = 0;
  let totalPutVolume = 0;

  for (const strike of chain) {
    totalCallVolume += strike.callVolume;
    totalPutVolume += strike.putVolume;
  }

  const totalVolume = totalCallVolume + totalPutVolume;

  // Relative volume: compare current to average
  const avgVolume = candles.length > 0
    ? candles.slice(-VOLUME_CONFIG.averagePeriods).reduce((s, c) => s + c.volume, 0) /
      Math.min(candles.length, VOLUME_CONFIG.averagePeriods)
    : totalVolume;
  const relativeVolume = avgVolume > 0 ? totalVolume / avgVolume : 1;

  // Institutional volume: absolute threshold
  const institutionalVolume = totalVolume > VOLUME_CONFIG.institutionalThreshold;

  // Volume spike: relative to average
  const volumeSpike = relativeVolume >= VOLUME_CONFIG.spikeMultiplier;

  // Score
  let score = 0;
  if (volumeSpike) score += 40;
  if (institutionalVolume) score += 30;
  if (relativeVolume > 1.5) score += 15;
  if (totalPutVolume > totalCallVolume * 1.3) score += 10; // Put-heavy = potential reversal signal
  if (totalCallVolume > totalPutVolume * 1.3) score += 10; // Call-heavy = momentum signal
  score = Math.min(100, score);

  const details = [
    volumeSpike ? `Volume spike ${relativeVolume.toFixed(1)}x avg` : null,
    institutionalVolume ? `Institutional volume ₹${(totalVolume / 1000).toFixed(0)}K` : null,
    `Call: ${totalCallVolume.toLocaleString()} | Put: ${totalPutVolume.toLocaleString()}`,
  ].filter(Boolean).join(" · ");

  return {
    totalCallVolume,
    totalPutVolume,
    relativeVolume,
    institutionalVolume,
    volumeSpike,
    score,
    details,
  };
}
